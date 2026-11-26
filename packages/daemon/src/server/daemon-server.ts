import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  CustomProviderConfigSchema,
  normalizeProviderId,
  type ClientToServerWsMessage,
  type ServerToClientWsMessage,
  type SystemSettings,
} from "@agent-leader/protocol";
import { LeaderBrain } from "../brain/leader-brain.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { reapOrphanProcesses } from "../runtime/process/process-supervisor.js";
import { ProviderRegistry } from "../runtime/providers/provider-registry.js";
import { LocalDatabase } from "../storage/database.js";
import {
  getAgentLeaderHomeDir,
  pickLocalDirectory,
  WorktreeManager,
} from "../workspace/worktree-manager.js";

/**
 * 判断请求来源是否为安全的本机回环客户端（防御 DNS Rebinding 与局域网跨站请求）
 */
function isAllowedLocalRequest(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  if (
    host &&
    !host.startsWith("127.0.0.1:") &&
    !host.startsWith("localhost:") &&
    host !== "127.0.0.1" &&
    host !== "localhost"
  ) {
    return false;
  }
  const origin = (req.headers.origin ?? "").toLowerCase();
  if (
    origin &&
    !origin.startsWith("http://127.0.0.1:") &&
    !origin.startsWith("http://localhost:") &&
    !origin.startsWith("file://")
  ) {
    return false;
  }
  return true;
}

/**
 * Agent Leader 本地守护服务实例（严格仅绑定 127.0.0.1）
 */
export class AgentLeaderDaemonServer {
  readonly db: LocalDatabase;
  readonly registry: ProviderRegistry;
  readonly brain: LeaderBrain;
  readonly worktrees: WorktreeManager;
  readonly orchestrator: Orchestrator;
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private seq = 0;
  private boundPort = 0;
  private lockFilePath: string | null = null;

  constructor(private readonly homeDir = getAgentLeaderHomeDir()) {
    this.db = new LocalDatabase(join(homeDir, "agent-leader.sqlite"));
    this.registry = new ProviderRegistry(this.db);
    const initialSettings = this.db.getRawSettings();
    this.registry.applySettings(
      initialSettings.enabledProviderIds,
      initialSettings.customProviders,
      initialSettings.userProviderOverrides ?? {},
      initialSettings.providerHealth ?? {},
    );

    this.brain = new LeaderBrain(() => this.db.getRawSettings().brain, this.registry, this.db);
    this.worktrees = new WorktreeManager(homeDir);
    this.orchestrator = new Orchestrator(this.db, this.registry, this.brain, this.worktrees, {
      onProjectUpdated: (project) => {
        this.broadcastWs({ type: "project.updated", seq: ++this.seq, project });
      },
      onAgentStream: ({ projectId, instanceId, event, projectedEntry, epoch }) => {
        this.broadcastWs({
          type: "agent.stream",
          seq: ++this.seq,
          projectId,
          instanceId,
          event,
          projectedEntry,
          epoch,
        });
      },
      onBrainStatus: ({ projectId, phase, detail }) => {
        this.broadcastWs({
          type: "brain.status",
          seq: ++this.seq,
          projectId,
          phase,
          detail,
        });
      },
    });
  }

  /**
   * 启动本地守护进程：
   * - 清理上次异常残留孤儿进程并严格绑定 127.0.0.1
   * - 首选端口被占用时自动顺延尝试相邻端口，仍冲突则交由操作系统分配空闲端口
   * - 原子写入 daemon.lock.json 供桌面端与客户端自动发现实际端口
   */
  async start(
    preferredPort = Number(process.env.AGENT_LEADER_PORT || 6868),
    options?: { allowPortFallback?: boolean; maxFallbackRange?: number },
  ): Promise<{ port: number }> {
    const reaped = await reapOrphanProcesses(this.db);
    if (reaped > 0) {
      console.log(`[AgentLeader Daemon] 已清理上次残留的孤儿执行进程: ${reaped} 个`);
    }

    const server = createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      if (!isAllowedLocalRequest(req)) {
        socket.destroy();
        return;
      }
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname !== "/ws") {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });

    wss.on("connection", (ws) => {
      void this.onWsConnection(ws);
    });

    const allowFallback = options?.allowPortFallback ?? true;
    const maxRange = options?.maxFallbackRange ?? 20;
    const boundPort = await listenWithPortFallback(server, preferredPort, allowFallback, maxRange);

    this.httpServer = server;
    this.wss = wss;
    this.boundPort = boundPort;

    this.lockFilePath = join(this.homeDir, "daemon.lock.json");
    const tmpLockPath = `${this.lockFilePath}.${process.pid}.tmp`;
    writeFileSync(
      tmpLockPath,
      JSON.stringify(
        {
          app: "agent-leader-daemon",
          version: "0.2.0",
          pid: process.pid,
          port: boundPort,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    renameSync(tmpLockPath, this.lockFilePath);

    return { port: boundPort };
  }

  /**
   * 优雅关闭服务并回收全部活跃子进程
   */
  async stop(): Promise<void> {
    if (this.lockFilePath) {
      try {
        unlinkSync(this.lockFilePath);
      } catch {
        // 忽略已删除锁文件
      }
      this.lockFilePath = null;
    }
    await this.orchestrator.agentManager.shutdown();
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close();
      }
      this.wss.close();
      this.wss = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
    this.db.close();
  }

  private async onWsConnection(ws: WebSocket): Promise<void> {
    const providers = await this.registry.getSnapshots();
    const hello: ServerToClientWsMessage = {
      type: "daemon.hello",
      seq: ++this.seq,
      daemonVersion: "0.2.0",
      platform: process.platform,
      projects: this.db.listProjects(),
      activeProjectId: this.db.getActiveProjectId(),
      settings: this.db.getPublicSettings(),
      providers,
    };
    this.sendWs(ws, hello);

    ws.on("message", (raw) => {
      void this.handleWsMessage(ws, raw.toString("utf8"));
    });
  }

  private async handleWsMessage(ws: WebSocket, text: string): Promise<void> {
    let msg: ClientToServerWsMessage;
    try {
      msg = JSON.parse(text) as ClientToServerWsMessage;
    } catch {
      return;
    }

    try {
      if (msg.type === "timeline.fetch") {
        const page = this.orchestrator.agentManager.getTimelinePage(
          msg.instanceId,
          msg.afterSeq ?? 0,
          msg.limit ?? 200,
        );
        this.sendWs(ws, { type: "timeline.page", requestId: msg.requestId, page });
        return;
      }

      if (msg.type === "instance.prompt") {
        await this.orchestrator.agentManager.sendPrompt(
          msg.instanceId,
          msg.text,
          msg.behavior ?? "steer",
        );
        return;
      }

      if (msg.type === "instance.interrupt") {
        await this.orchestrator.agentManager.stopInstance(msg.instanceId);
        return;
      }

      if (msg.type === "permission.respond") {
        await this.orchestrator.resolvePermissionFromUi({
          projectId: msg.projectId,
          instanceId: msg.instanceId,
          requestId: msg.requestId,
          response: msg.response,
        });
      }
    } catch (err) {
      this.sendWs(ws, {
        type: "daemon.error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAllowedLocalRequest(req)) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Forbidden: Localhost access only" }));
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "http://127.0.0.1:5173");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    try {
      if (req.method === "GET" && path === "/api/health") {
        this.sendJson(res, 200, {
          ok: true,
          app: "agent-leader-daemon",
          version: "0.2.0",
          pid: process.pid,
          port: this.boundPort,
          platform: process.platform,
        });
        return;
      }

      if (req.method === "GET" && path === "/api/bootstrap") {
        const providers = await this.registry.getSnapshots();
        this.sendJson(res, 200, {
          daemonVersion: "0.2.0",
          platform: process.platform,
          projects: this.db.listProjects(),
          activeProjectId: this.db.getActiveProjectId(),
          settings: this.db.getPublicSettings(),
          providers,
        });
        return;
      }

      if (req.method === "GET" && path === "/api/providers/refresh") {
        const cur = this.db.getRawSettings();
        this.db.saveSettings({
          ...cur,
          providerHealth: {},
        });
        const providers = await this.registry.getSnapshots(true);
        const settings = this.db.getPublicSettings();
        this.broadcastWs({ type: "settings.updated", seq: ++this.seq, settings, providers });
        this.sendJson(res, 200, { providers });
        return;
      }

      const providerModelsMatch = path.match(/^\/api\/providers\/([^/]+)\/models$/);
      if (req.method === "GET" && providerModelsMatch) {
        const providerId = decodeURIComponent(providerModelsMatch[1]);
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const data = await this.registry.listModels(providerId, forceRefresh);
        this.sendJson(res, 200, data);
        return;
      }

      const providerTestMatch = path.match(/^\/api\/providers\/([^/]+)\/test$/);
      if (req.method === "POST" && providerTestMatch) {
        const providerId = decodeURIComponent(providerTestMatch[1]);
        const normalizedId = normalizeProviderId(providerId);
        const result = await this.brain.testProviderCli(normalizedId);
        this.registry.setHealthResult(normalizedId, result.ok, result.detail);

        // 持久化保存本次测试结果：无法指挥时自动取消勾选，测试通过时恢复勾选启用
        const cur = this.db.getRawSettings();
        const nextOverrides = {
          ...(cur.userProviderOverrides ?? {}),
          [normalizedId]: result.ok,
        };
        const nextHealth: Record<string, "ok" | "error"> = {
          ...(cur.providerHealth ?? {}),
          [normalizedId]: result.ok ? "ok" : "error",
        };
        const nextEnabledIds = result.ok
          ? [...new Set([...cur.enabledProviderIds, normalizedId])]
          : cur.enabledProviderIds.filter((id) => id !== normalizedId);
        const saved = this.db.saveSettings({
          ...cur,
          enabledProviderIds: nextEnabledIds,
          userProviderOverrides: nextOverrides,
          providerHealth: nextHealth,
        });
        this.registry.applySettings(
          saved.enabledProviderIds,
          saved.customProviders,
          saved.userProviderOverrides ?? {},
          saved.providerHealth ?? {},
        );

        const providers = await this.registry.getSnapshots();
        const settings = this.db.getPublicSettings();
        this.broadcastWs({ type: "settings.updated", seq: ++this.seq, settings, providers });
        this.sendJson(res, 200, { ...result, settings, providers });
        return;
      }

      if (req.method === "POST" && path === "/api/brain/test") {
        const body = (await readJsonBody(req)) as Partial<SystemSettings["brain"]> | undefined;
        if (body && typeof body.cliProviderId === "string" && body.cliProviderId.trim()) {
          const cur = this.db.getRawSettings();
          this.db.saveSettings({
            ...cur,
            brain: {
              ...cur.brain,
              ...body,
            },
          });
        }
        const result = await this.brain.testConnection();
        this.sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && path === "/api/settings") {
        const body = (await readJsonBody(req)) as SystemSettings;
        const customParsed = (body.customProviders ?? []).map((c) =>
          CustomProviderConfigSchema.parse(c),
        );
        const saved = this.db.saveSettings({
          ...body,
          customProviders: customParsed,
        });
        this.registry.applySettings(
          saved.enabledProviderIds,
          saved.customProviders,
          saved.userProviderOverrides ?? {},
          saved.providerHealth ?? {},
        );
        // 全局设置中的角色分工绑定同步应用到所有项目
        const updatedProjects = this.orchestrator.syncGlobalRolesToProjects(saved.defaultRoles);
        const publicSettings = this.db.getPublicSettings();
        const providers = await this.registry.getSnapshots();
        this.broadcastWs({
          type: "settings.updated",
          seq: ++this.seq,
          settings: publicSettings,
          providers,
        });
        this.broadcastWs({
          type: "projects.list",
          seq: ++this.seq,
          projects: updatedProjects,
          activeProjectId: this.db.getActiveProjectId(),
        });
        this.sendJson(res, 200, { settings: publicSettings, providers });
        return;
      }

      if (req.method === "POST" && path === "/api/fs/pick-directory") {
        const result = await pickLocalDirectory();
        this.sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && path === "/api/projects") {
        const body = (await readJsonBody(req)) as {
          name?: string;
          background: string;
          goal: string;
          repoPath?: string;
          executionMode?: "real" | "mock";
          useWorktreeIsolation?: boolean;
        };
        const project = await this.orchestrator.createProject(body);
        this.broadcastWs({
          type: "projects.list",
          seq: ++this.seq,
          projects: this.db.listProjects(),
          activeProjectId: project.id,
        });
        this.sendJson(res, 201, { project });
        return;
      }

      if (req.method === "POST" && path === "/api/projects/select") {
        const body = (await readJsonBody(req)) as { id: string };
        this.db.setActiveProjectId(body.id);
        this.sendJson(res, 200, { activeProjectId: body.id });
        return;
      }

      const projMatch = path.match(/^\/api\/projects\/([^/]+)\/(.+)$/);
      if (req.method === "POST" && projMatch) {
        const projectId = decodeURIComponent(projMatch[1]);
        const subRoute = projMatch[2];
        const body = (await readJsonBody(req)) as Record<string, unknown>;

        if (subRoute === "rename") {
          const project = this.orchestrator.renameProject(projectId, String(body.name ?? ""));
          this.broadcastWs({
            type: "projects.list",
            seq: ++this.seq,
            projects: this.db.listProjects(),
            activeProjectId: this.db.getActiveProjectId(),
          });
          this.sendJson(res, 200, { project });
          return;
        }

        if (subRoute === "delete") {
          const result = await this.orchestrator.deleteProject(projectId);
          this.broadcastWs({
            type: "projects.list",
            seq: ++this.seq,
            projects: result.projects,
            activeProjectId: result.activeProjectId,
          });
          this.sendJson(res, 200, result);
          return;
        }

        if (subRoute === "chat") {
          const result = await this.orchestrator.handleChatMessage(
            projectId,
            String(body.text ?? ""),
          );
          this.sendJson(res, 200, result);
          return;
        }

        if (subRoute === "dispatch") {
          const project = await this.orchestrator.dispatchReadyTasks(
            projectId,
            typeof body.taskId === "string" ? body.taskId : undefined,
          );
          this.sendJson(res, 200, { project });
          return;
        }

        const taskAction = subRoute.match(/^tasks\/([^/]+)\/(accept|reject|rebind)$/);
        if (taskAction) {
          const taskId = decodeURIComponent(taskAction[1]);
          const act = taskAction[2];
          if (act === "accept") {
            const project = await this.orchestrator.manualAcceptTask(projectId, taskId);
            this.sendJson(res, 200, { project });
            return;
          }
          if (act === "reject") {
            const project = await this.orchestrator.manualRejectTask(
              projectId,
              taskId,
              String(body.reason ?? ""),
            );
            this.sendJson(res, 200, { project });
            return;
          }
          if (act === "rebind") {
            const project = this.orchestrator.rebindTask(
              projectId,
              taskId,
              String(body.executorId ?? "codex"),
            );
            this.sendJson(res, 200, { project });
            return;
          }
        }

        const roleRebind = subRoute.match(/^roles\/([^/]+)\/rebind$/);
        if (roleRebind) {
          const roleId = decodeURIComponent(roleRebind[1]);
          const project = this.orchestrator.rebindRole(
            projectId,
            roleId,
            String(body.executorId ?? "codex"),
          );
          this.sendJson(res, 200, { project });
          return;
        }

        if (subRoute === "handoff/initiate") {
          const result = await this.orchestrator.initiateHandoff(
            projectId,
            String(body.taskId ?? ""),
            typeof body.toExecutorId === "string" ? body.toExecutorId : undefined,
          );
          this.sendJson(res, 200, result);
          return;
        }

        const handoffAction = subRoute.match(/^handoff\/([^/]+)\/(target|confirm)$/);
        if (handoffAction) {
          const handoffId = decodeURIComponent(handoffAction[1]);
          if (handoffAction[2] === "target") {
            const project = this.orchestrator.setHandoffTarget(
              projectId,
              handoffId,
              String(body.executorId ?? "codex"),
            );
            this.sendJson(res, 200, { project });
            return;
          }
          const project = await this.orchestrator.confirmHandoff(projectId, handoffId);
          this.sendJson(res, 200, { project });
          return;
        }
      }

      const timelineMatch = path.match(/^\/api\/instances\/([^/]+)\/timeline$/);
      if (req.method === "GET" && timelineMatch) {
        const instanceId = decodeURIComponent(timelineMatch[1]);
        const afterSeq = Number(url.searchParams.get("afterSeq") || 0);
        const limit = Number(url.searchParams.get("limit") || 200);
        const page = this.orchestrator.agentManager.getTimelinePage(instanceId, afterSeq, limit);
        this.sendJson(res, 200, { page });
        return;
      }

      this.sendJson(res, 404, { error: `Unknown endpoint: ${req.method} ${path}` });
    } catch (err) {
      this.sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  }

  private sendWs(ws: WebSocket, msg: ServerToClientWsMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcastWs(msg: ServerToClientWsMessage): void {
    if (!this.wss) return;
    const raw = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

/**
 * 尝试在 127.0.0.1 上监听端口；遇 EADDRINUSE 时按序顺延探测空闲端口，最终兜底由系统内核分配随机空闲端口
 */
async function listenWithPortFallback(
  server: Server,
  preferredPort: number,
  allowFallback: boolean,
  maxRange: number,
): Promise<number> {
  const candidates: number[] =
    preferredPort === 0
      ? [0]
      : allowFallback
        ? [
            ...Array.from({ length: maxRange + 1 }, (_, i) => preferredPort + i),
            0,
          ]
        : [preferredPort];

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    try {
      const boundPort = await new Promise<number>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : candidate);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(candidate, "127.0.0.1");
      });

      if (preferredPort > 0 && boundPort !== preferredPort) {
        console.warn(
          `[AgentLeader Daemon] 首选端口 ${preferredPort} 已被占用，已自动切换至空闲端口 ${boundPort}`,
        );
      }
      return boundPort;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const isLast = i === candidates.length - 1;
      if (code === "EADDRINUSE" && !isLast) {
        continue;
      }
      throw err;
    }
  }

  throw new Error(`无法绑定本地端口（首选 ${preferredPort}）`);
}
