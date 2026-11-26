import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
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

const CODEX_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsMidTurnSteer: true,
};

interface PendingRpc {
  resolve: (val: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Codex App-Server JSONL RPC 传输客户端（参考 Paseo CodexAppServerClient）
 * 严格仅按 LF (\n) 切分帧，避免 JSON 内部的 U+2028/U+2029 破坏消息边界
 */
class CodexRpcTransport {
  private buffer = "";
  private stderrTail = "";
  private nextId = 1;
  private disposed = false;
  private readonly pending = new Map<number, PendingRpc>();
  private onNotification: ((method: string, params: unknown) => void) | null = null;
  private onServerRequest:
    | ((method: string, params: unknown, id: number) => Promise<unknown>)
    | null = null;
  private onExit: ((err: Error) => void) | null = null;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.buffer += chunk.toString("utf8");
      let nlIdx = this.buffer.indexOf("\n");
      while (nlIdx >= 0) {
        const line = this.buffer.slice(0, nlIdx).replace(/\r$/, "");
        this.buffer = this.buffer.slice(nlIdx + 1);
        if (line.trim()) {
          this.handleLine(line);
        }
        nlIdx = this.buffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
    });

    child.on("exit", (code, signal) => {
      const err = new Error(
        `Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}) ${this.stderrTail}`.trim(),
      );
      this.failAll(err);
      this.onExit?.(err);
    });

    child.on("error", (err) => {
      this.failAll(err);
      this.onExit?.(err);
    });
  }

  setHandlers(handlers: {
    onNotification: (method: string, params: unknown) => void;
    onServerRequest: (method: string, params: unknown, id: number) => Promise<unknown>;
    onExit: (err: Error) => void;
  }): void {
    this.onNotification = handlers.onNotification;
    this.onServerRequest = handlers.onServerRequest;
    this.onExit = handlers.onExit;
  }

  request(method: string, params?: unknown, timeoutMs = 60_000): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("Codex app-server transport is disposed"));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC timeout on ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeFrame({ id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) return;
    this.writeFrame({ method, ...(params !== undefined ? { params } : {}) });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.failAll(new Error("Codex session closed"));
    await terminateProcessTree(this.child);
  }

  private writeFrame(payload: Record<string, unknown>): void {
    if (!this.child.stdin.writable || this.child.stdin.destroyed) return;
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof parsed.id === "number" && typeof parsed.method !== "string") {
      const entry = this.pending.get(parsed.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(parsed.id);
      if (parsed.error && typeof parsed.error === "object") {
        const errObj = parsed.error as { message?: string };
        entry.reject(new Error(errObj.message ?? "Codex RPC error"));
      } else {
        entry.resolve(parsed.result);
      }
      return;
    }

    if (typeof parsed.id === "number" && typeof parsed.method === "string") {
      const reqId = parsed.id;
      const method = parsed.method;
      if (!this.onServerRequest) {
        this.writeFrame({ id: reqId, error: { code: -32601, message: "Unhandled request" } });
        return;
      }
      void this.onServerRequest(method, parsed.params, reqId)
        .then((result) => this.writeFrame({ id: reqId, result }))
        .catch((err: unknown) =>
          this.writeFrame({
            id: reqId,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          }),
        );
      return;
    }

    if (typeof parsed.method === "string") {
      this.onNotification?.(parsed.method, parsed.params);
    }
  }

  private failAll(err: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(err);
    }
    this.pending.clear();
  }
}

/**
 * Codex 原生 App-Server 会话运行时
 * 支持实时文本/思考流、命令与文件变更工具卡片、运行中转向（turn/steer）、中断（turn/interrupt）及审批桥接
 */
class CodexAgentSession implements AgentSession {
  readonly provider = "codex";
  readonly capabilities = CODEX_CAPABILITIES;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private nativeTurnId: string | null = null;
  private transport: CodexRpcTransport | null = null;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly pendingPermissions = new Map<
    string,
    { request: AgentPermissionRequest; resolve: (decision: { decision: "accept" | "decline" }) => void }
  >();

  constructor(
    private readonly config: AgentSessionConfig,
    private readonly command: readonly [string, ...string[]],
    private readonly ledger?: ProcessLedgerStore,
    resumeThreadId?: string,
  ) {
    this.threadId = resumeThreadId ?? null;
  }

  get id(): string | null {
    return this.threadId;
  }

  async initialize(): Promise<void> {
    const [bin, ...args] = this.command;
    const child = spawnManagedChild(bin, args, {
      cwd: this.config.cwd,
      env: this.config.env,
      instanceId: this.config.instanceId,
      provider: "codex",
      ledger: this.ledger,
    });

    const transport = new CodexRpcTransport(child);
    transport.setHandlers({
      onNotification: (method, params) => this.handleNotification(method, params),
      onServerRequest: (method, params) => this.handleServerRequest(method, params),
      onExit: (err) => {
        if (this.activeTurnId) {
          const turnId = this.activeTurnId;
          this.activeTurnId = null;
          this.nativeTurnId = null;
          this.emit({ type: "turn_failed", provider: "codex", error: err.message, turnId });
        }
      },
    });

    await transport.request(
      "initialize",
      {
        clientInfo: {
          name: "codex_app_server_daemon",
          title: "Codex App Server Daemon",
          version: "0.0.0",
        },
        capabilities: {
          experimentalApi: true,
          mcpServerOpenaiFormElicitation: true,
        },
      },
      30_000,
    );
    transport.notify("initialized", {});
    this.transport = transport;

    if (!this.threadId) {
      const startParams: Record<string, unknown> = {
        cwd: this.config.cwd,
        approvalPolicy: "on-request",
        sandbox: this.config.writeAccess ? "workspace-write" : "read-only",
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.systemPrompt ? { developerInstructions: this.config.systemPrompt } : {}),
      };
      const resp = (await transport.request("thread/start", startParams, 30_000)) as {
        thread?: { id?: string };
      };
      this.threadId = resp?.thread?.id ?? `codex_${randomUUID().slice(0, 8)}`;
      this.emit({ type: "thread_started", provider: "codex", sessionId: this.threadId });
    }
  }

  async startTurn(prompt: string, _options?: AgentRunOptions): Promise<{ turnId: string }> {
    if (!this.transport || !this.threadId) {
      await this.initialize();
    }
    const turnId = `codex_turn_${randomUUID().slice(0, 8)}`;
    this.activeTurnId = turnId;
    this.nativeTurnId = null;

    await this.transport!.request(
      "turn/start",
      {
        threadId: this.threadId,
        cwd: this.config.cwd,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        ...(this.config.model ? { model: this.config.model } : {}),
      },
      90_000,
    );

    return { turnId };
  }

  async steerActiveTurn(
    prompt: string,
    options: { expectedTurnId: string },
  ): Promise<{ status: "accepted" } | { status: "unavailable" }> {
    if (
      !this.transport ||
      !this.threadId ||
      !this.nativeTurnId ||
      this.activeTurnId !== options.expectedTurnId
    ) {
      return { status: "unavailable" };
    }
    try {
      await this.transport.request(
        "turn/steer",
        {
          threadId: this.threadId,
          expectedTurnId: this.nativeTurnId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
        },
        30_000,
      );
      return { status: "accepted" };
    } catch {
      return { status: "unavailable" };
    }
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [...this.pendingPermissions.values()].map((p) => p.request);
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    this.emit({
      type: "permission_resolved",
      provider: "codex",
      requestId,
      resolution: response,
      turnId: this.activeTurnId ?? undefined,
    });
    pending.resolve({ decision: response.behavior === "allow" ? "accept" : "decline" });
  }

  async setWriteAccess(allowed: boolean): Promise<void> {
    this.config.writeAccess = allowed;
  }

  async interrupt(): Promise<void> {
    if (!this.transport || !this.activeTurnId) return;
    const turnId = this.activeTurnId;
    if (this.threadId && this.nativeTurnId) {
      await this.transport
        .request("turn/interrupt", { threadId: this.threadId, turnId: this.nativeTurnId }, 5_000)
        .catch(() => undefined);
    }
    this.activeTurnId = null;
    this.nativeTurnId = null;
    this.emit({ type: "turn_canceled", provider: "codex", reason: "Interrupted", turnId });
  }

  describePersistence(): AgentPersistenceHandle | null {
    if (!this.threadId) return null;
    return {
      provider: "codex",
      sessionId: this.threadId,
      nativeHandle: this.threadId,
    };
  }

  async close(): Promise<void> {
    for (const [reqId, p] of this.pendingPermissions.entries()) {
      this.pendingPermissions.delete(reqId);
      p.resolve({ decision: "decline" });
    }
    if (this.transport) {
      await this.transport.dispose();
      this.transport = null;
    }
  }

  private handleNotification(method: string, rawParams: unknown): void {
    const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Record<
      string,
      unknown
    >;
    const turnId = this.activeTurnId ?? undefined;

    if (method === "turn/started") {
      const turn = params.turn as { id?: string } | undefined;
      if (turn?.id) {
        this.nativeTurnId = turn.id;
      }
      this.emit({ type: "turn_started", provider: "codex", turnId });
      return;
    }

    if (method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
      if (delta) {
        this.emit({
          type: "timeline",
          provider: "codex",
          turnId,
          item: { type: "assistant_message", text: delta, messageId: itemId },
        });
      }
      return;
    }

    if (method === "item/reasoning/summaryTextDelta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (delta) {
        this.emit({
          type: "timeline",
          provider: "codex",
          turnId,
          item: { type: "reasoning", text: delta },
        });
      }
      return;
    }

    if (method === "codex/event/exec_command_begin") {
      const msg = (params.msg ?? {}) as Record<string, unknown>;
      const callId = String(msg.call_id ?? randomUUID().slice(0, 8));
      const cmd = Array.isArray(msg.command)
        ? msg.command.join(" ")
        : String(msg.command ?? "command");
      this.emit({
        type: "timeline",
        provider: "codex",
        turnId,
        item: {
          type: "tool_call",
          callId,
          name: "Bash",
          status: "running",
          error: null,
          detail: { type: "shell", command: cmd, cwd: String(msg.cwd ?? this.config.cwd) },
        },
      });
      return;
    }

    if (method === "codex/event/exec_command_end") {
      const msg = (params.msg ?? {}) as Record<string, unknown>;
      const callId = String(msg.call_id ?? randomUUID().slice(0, 8));
      const cmd = Array.isArray(msg.command)
        ? msg.command.join(" ")
        : String(msg.command ?? "command");
      const exitCode = typeof msg.exit_code === "number" ? msg.exit_code : 0;
      const out = String(msg.aggregated_output ?? msg.stdout ?? "");
      this.emit({
        type: "timeline",
        provider: "codex",
        turnId,
        item: {
          type: "tool_call",
          callId,
          name: "Bash",
          status: exitCode === 0 ? "completed" : "failed",
          error: exitCode === 0 ? null : `Exit code ${exitCode}`,
          detail: { type: "shell", command: cmd, exitCode, output: out },
        },
      });
      return;
    }

    if (method === "item/completed") {
      const item = (params.item ?? {}) as Record<string, unknown>;
      if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        this.emit({
          type: "timeline",
          provider: "codex",
          turnId,
          item: {
            type: "assistant_message",
            text: item.text,
            messageId: typeof item.id === "string" ? item.id : undefined,
          },
        });
      } else if (item.type === "fileChange") {
        const callId = String(item.id ?? randomUUID().slice(0, 8));
        this.emit({
          type: "timeline",
          provider: "codex",
          turnId,
          item: {
            type: "tool_call",
            callId,
            name: "EditFile",
            status: "completed",
            error: null,
            detail: { type: "edit", path: String(item.path ?? "workspace files") },
          },
        });
      }
      return;
    }

    if (method === "turn/completed") {
      const turn = (params.turn ?? {}) as { status?: string; error?: { message?: string } };
      const finishedTurnId = this.activeTurnId ?? undefined;
      this.activeTurnId = null;
      this.nativeTurnId = null;

      if (turn.status === "failed") {
        this.emit({
          type: "turn_failed",
          provider: "codex",
          turnId: finishedTurnId,
          error: turn.error?.message ?? "Codex turn failed",
        });
      } else if (turn.status === "interrupted" || turn.status === "cancelled") {
        this.emit({
          type: "turn_canceled",
          provider: "codex",
          turnId: finishedTurnId,
          reason: "Interrupted",
        });
      } else {
        this.emit({ type: "turn_completed", provider: "codex", turnId: finishedTurnId });
      }
    }
  }

  private handleServerRequest(method: string, rawParams: unknown): Promise<unknown> {
    const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Record<
      string,
      unknown
    >;

    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      // 未授权写权限时一律直接拒绝文件修改或越权命令
      if (!this.config.writeAccess && method === "item/fileChange/requestApproval") {
        return Promise.resolve({ decision: "decline" });
      }
      const reqId = `perm_${String(params.approvalId ?? params.itemId ?? randomUUID().slice(0, 8))}`;
      const cmdText = typeof params.command === "string" ? params.command : "";
      const request: AgentPermissionRequest = {
        id: reqId,
        provider: "codex",
        name: method.includes("fileChange") ? "FileWrite" : "Bash",
        kind: "tool",
        title: cmdText ? `请求执行命令: ${cmdText}` : "请求执行受控文件/命令操作",
        description: typeof params.reason === "string" ? params.reason : undefined,
        detail: cmdText ? { type: "shell", command: cmdText } : undefined,
      };
      this.emit({
        type: "permission_requested",
        provider: "codex",
        request,
        turnId: this.activeTurnId ?? undefined,
      });
      return new Promise((resolve) => {
        this.pendingPermissions.set(reqId, { request, resolve });
      });
    }

    return Promise.resolve({});
  }

  private emit(event: AgentStreamEvent): void {
    for (const cb of this.subscribers) {
      cb(event);
    }
  }
}

/**
 * Codex 原生 Provider 客户端工厂
 */
export class CodexProviderClient implements AgentClient {
  readonly provider = "codex";
  readonly capabilities = CODEX_CAPABILITIES;

  constructor(
    private readonly command: readonly [string, ...string[]] = ["codex", "app-server"],
    private readonly ledger?: ProcessLedgerStore,
  ) {}

  async isAvailable(): Promise<boolean> {
    return findExecutableSync(this.command[0]) !== null;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session = new CodexAgentSession(config, this.command, this.ledger);
    await session.initialize();
    return session;
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    config: AgentSessionConfig,
  ): Promise<AgentSession> {
    const session = new CodexAgentSession(
      config,
      this.command,
      this.ledger,
      handle.nativeHandle ?? handle.sessionId,
    );
    await session.initialize();
    return session;
  }
}
