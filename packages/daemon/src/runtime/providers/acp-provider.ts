import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client as ACPClient,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream as ACPStream,
} from "@agentclientprotocol/sdk";
import type {
  AgentCapabilityFlags,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentStreamEvent,
} from "@agent-leader/protocol";
import type {
  AgentClient,
  AgentRunOptions,
  AgentSession,
  AgentSessionConfig,
} from "../contracts/agent-sdk-types.js";
import {
  findExecutableSync,
  spawnManagedChild,
  terminateProcessTree,
  type ProcessLedgerStore,
} from "../process/process-supervisor.js";

const ACP_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsMidTurnSteer: false,
};

/**
 * 标准 ACP（Agent Client Protocol）通用会话实现
 * 一套实现打通 Antigravity、GitHub Copilot、Gemini CLI、Cursor、TRAE、Qwen Code、Kimi 等 36+ 款目录与自定义智能体
 */
class AcpAgentSession implements AgentSession {
  readonly capabilities = ACP_CAPABILITIES;
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientSideConnection | null = null;
  private acpSessionId: string | null = null;
  private activeTurnId: string | null = null;
  private stderrTail = "";
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly pendingPermissions = new Map<
    string,
    {
      request: AgentPermissionRequest;
      options: Array<{ optionId: string; kind: string }>;
      resolve: (resp: RequestPermissionResponse) => void;
    }
  >();

  constructor(
    readonly provider: string,
    private readonly command: readonly [string, ...string[]],
    private readonly defaultEnv: Readonly<Record<string, string>> | undefined,
    private readonly config: AgentSessionConfig,
    private readonly ledger?: ProcessLedgerStore,
    resumeId?: string,
  ) {
    this.acpSessionId = resumeId ?? null;
  }

  get id(): string | null {
    return this.acpSessionId;
  }

  async initialize(): Promise<void> {
    const [bin, ...args] = this.command;
    const child = spawnManagedChild(bin, args, {
      cwd: this.config.cwd,
      env: { ...this.defaultEnv, ...this.config.env },
      instanceId: this.config.instanceId,
      provider: this.provider,
      ledger: this.ledger,
    });
    this.child = child;

    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
    });

    child.on("exit", (code, signal) => {
      if (this.activeTurnId) {
        const turnId = this.activeTurnId;
        this.activeTurnId = null;
        this.emit({
          type: "turn_failed",
          provider: this.provider,
          turnId,
          error: `ACP 进程退出 (code=${code ?? "null"}, signal=${signal ?? "null"}) ${this.stderrTail}`.trim(),
        });
      }
    });

    const stream: ACPStream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );

    const clientImpl: ACPClient = {
      sessionUpdate: async (notification: SessionNotification) => {
        this.handleSessionUpdate(notification);
      },
      requestPermission: async (req: RequestPermissionRequest) => {
        return this.handlePermissionRequest(req);
      },
    };

    const conn = new ClientSideConnection(() => clientImpl, stream);
    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "agent-leader", version: "0.2.0" },
    });
    this.connection = conn;

    if (this.acpSessionId && conn.loadSession) {
      try {
        await conn.loadSession({
          sessionId: this.acpSessionId,
          cwd: this.config.cwd,
          mcpServers: [],
        });
        return;
      } catch {
        // 若不支持恢复则平滑回退创建新会话
        this.acpSessionId = null;
      }
    }

    const created = await conn.newSession({
      cwd: this.config.cwd,
      mcpServers: [],
    });
    this.acpSessionId = created.sessionId;
    this.emit({
      type: "thread_started",
      provider: this.provider,
      sessionId: this.acpSessionId,
    });
  }

  async startTurn(prompt: string, _options?: AgentRunOptions): Promise<{ turnId: string }> {
    if (!this.connection || !this.acpSessionId) {
      await this.initialize();
    }
    const turnId = `acp_turn_${randomUUID().slice(0, 8)}`;
    this.activeTurnId = turnId;
    this.emit({ type: "turn_started", provider: this.provider, turnId });

    const effectivePrompt = this.config.writeAccess
      ? prompt
      : `[只读门控约束：当前未授予写权限，严禁修改任何磁盘文件，请仅做阅读分析与确认]\n\n${prompt}`;

    void this.connection!
      .prompt({
        sessionId: this.acpSessionId!,
        prompt: [{ type: "text", text: effectivePrompt }],
      })
      .then((res) => {
        if (this.activeTurnId !== turnId) return;
        this.activeTurnId = null;
        if (res.stopReason === "cancelled") {
          this.emit({
            type: "turn_canceled",
            provider: this.provider,
            turnId,
            reason: "Cancelled",
          });
        } else {
          this.emit({ type: "turn_completed", provider: this.provider, turnId });
        }
      })
      .catch((err: unknown) => {
        if (this.activeTurnId !== turnId) return;
        this.activeTurnId = null;
        this.emit({
          type: "turn_failed",
          provider: this.provider,
          turnId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [...this.pendingPermissions.values()].map((p) => p.request);
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return;
    this.pendingPermissions.delete(requestId);

    this.emit({
      type: "permission_resolved",
      provider: this.provider,
      requestId,
      resolution: response,
      turnId: this.activeTurnId ?? undefined,
    });

    if (response.behavior === "deny") {
      const rejectOpt = entry.options.find((o) => o.kind.includes("reject"));
      if (rejectOpt) {
        entry.resolve({ outcome: { outcome: "selected", optionId: rejectOpt.optionId } });
      } else {
        entry.resolve({ outcome: { outcome: "cancelled" } });
      }
      return;
    }

    const chosenId =
      response.optionId ??
      entry.options.find((o) => o.kind.includes("allow"))?.optionId ??
      entry.options[0]?.optionId;
    if (chosenId) {
      entry.resolve({ outcome: { outcome: "selected", optionId: chosenId } });
    } else {
      entry.resolve({ outcome: { outcome: "cancelled" } });
    }
  }

  async setWriteAccess(allowed: boolean): Promise<void> {
    this.config.writeAccess = allowed;
  }

  async interrupt(): Promise<void> {
    if (!this.connection || !this.acpSessionId || !this.activeTurnId) return;
    const turnId = this.activeTurnId;
    await this.connection.cancel({ sessionId: this.acpSessionId }).catch(() => undefined);
    this.activeTurnId = null;
    this.emit({ type: "turn_canceled", provider: this.provider, turnId, reason: "Interrupted" });
  }

  describePersistence(): AgentPersistenceHandle | null {
    if (!this.acpSessionId) return null;
    return {
      provider: this.provider,
      sessionId: this.acpSessionId,
      nativeHandle: this.acpSessionId,
    };
  }

  async close(): Promise<void> {
    for (const [id, pending] of this.pendingPermissions.entries()) {
      this.pendingPermissions.delete(id);
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    if (this.child) {
      await terminateProcessTree(this.child);
      this.child = null;
    }
    this.connection = null;
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update as Record<string, unknown>;
    const kind = String(update.sessionUpdate ?? "");
    const turnId = this.activeTurnId ?? undefined;

    if (kind === "agent_message_chunk") {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type === "text" && content.text) {
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "assistant_message", text: content.text },
        });
      }
      return;
    }

    if (kind === "agent_thought_chunk") {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type === "text" && content.text) {
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "reasoning", text: content.text },
        });
      }
      return;
    }

    if (kind === "tool_call" || kind === "tool_call_update") {
      const callId = String(update.toolCallId ?? randomUUID().slice(0, 8));
      const title = String(update.title ?? update.kind ?? "Tool");
      const rawStatus = String(update.status ?? "in_progress");
      const status =
        rawStatus === "completed"
          ? "completed"
          : rawStatus === "failed"
            ? "failed"
            : "running";
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: {
          type: "tool_call",
          callId,
          name: title,
          status,
          error: status === "failed" ? "Tool execution failed" : null,
          detail: { type: "unknown", input: update.rawInput ?? title, output: update.rawOutput },
        },
      });
      return;
    }

    if (kind === "plan" && Array.isArray(update.entries)) {
      const items = (update.entries as Array<{ content?: string; status?: string }>).map((e) => ({
        text: String(e.content ?? ""),
        completed: e.status === "completed",
      }));
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "todo", items },
      });
    }
  }

  private handlePermissionRequest(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (!this.config.writeAccess) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    const reqId = `acp_perm_${randomUUID().slice(0, 8)}`;
    const toolTitle = req.toolCall?.title ?? "ACP 工具操作请求";
    const mappedOptions = req.options.map((opt) => ({
      id: opt.optionId,
      label: opt.name,
      allow: opt.kind.includes("allow"),
    }));

    const permissionRequest: AgentPermissionRequest = {
      id: reqId,
      provider: this.provider,
      name: toolTitle,
      kind: "tool",
      title: `${this.provider} 请求权限: ${toolTitle}`,
      options: mappedOptions,
    };

    this.emit({
      type: "permission_requested",
      provider: this.provider,
      request: permissionRequest,
      turnId: this.activeTurnId ?? undefined,
    });

    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pendingPermissions.set(reqId, {
        request: permissionRequest,
        options: req.options.map((o) => ({ optionId: o.optionId, kind: o.kind })),
        resolve,
      });
    });
  }

  private emit(event: AgentStreamEvent): void {
    for (const cb of this.subscribers) {
      cb(event);
    }
  }
}

/**
 * 通用 ACP Provider 客户端工厂
 */
export class GenericAcpProviderClient implements AgentClient {
  readonly capabilities = ACP_CAPABILITIES;

  constructor(
    readonly provider: string,
    private readonly command: readonly [string, ...string[]],
    private readonly defaultEnv?: Readonly<Record<string, string>>,
    private readonly ledger?: ProcessLedgerStore,
  ) {}

  async isAvailable(): Promise<boolean> {
    return findExecutableSync(this.command[0]) !== null;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session = new AcpAgentSession(
      this.provider,
      this.command,
      this.defaultEnv,
      config,
      this.ledger,
    );
    await session.initialize();
    return session;
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    config: AgentSessionConfig,
  ): Promise<AgentSession> {
    const session = new AcpAgentSession(
      this.provider,
      this.command,
      this.defaultEnv,
      config,
      this.ledger,
      handle.nativeHandle ?? handle.sessionId,
    );
    await session.initialize();
    return session;
  }
}
