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

const JSONL_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

/**
 * 通用 JSONL Stdio RPC 会话实现（适配 Pi `--mode rpc` 与 Oh My Pi `--mode rpc-ui`）
 */
class JsonlRpcSession implements AgentSession {
  readonly capabilities = JSONL_CAPABILITIES;
  private child: ChildProcessWithoutNullStreams | null = null;
  private activeTurnId: string | null = null;
  private readonly sessionId = `rpc_${randomUUID().slice(0, 8)}`;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(
    readonly provider: string,
    private readonly command: readonly [string, ...string[]],
    private readonly config: AgentSessionConfig,
    private readonly ledger?: ProcessLedgerStore,
  ) {}

  get id(): string | null {
    return this.sessionId;
  }

  async startTurn(prompt: string, _options?: AgentRunOptions): Promise<{ turnId: string }> {
    if (!this.child) {
      const [bin, ...args] = this.command;
      const child = spawnManagedChild(bin, args, {
        cwd: this.config.cwd,
        env: this.config.env,
        instanceId: this.config.instanceId,
        provider: this.provider,
        ledger: this.ledger,
      });
      this.child = child;

      let buf = "";
      child.stdout.on("data", (chunk: Buffer | string) => {
        buf += chunk.toString("utf8");
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.handleFrame(line);
          nl = buf.indexOf("\n");
        }
      });

      child.on("exit", (code) => {
        this.child = null;
        if (this.activeTurnId) {
          const t = this.activeTurnId;
          this.activeTurnId = null;
          this.emit({
            type: "turn_failed",
            provider: this.provider,
            turnId: t,
            error: `${this.provider} RPC exited with code ${code ?? "null"}`,
          });
        }
      });
    }

    const turnId = `jrpc_turn_${randomUUID().slice(0, 8)}`;
    this.activeTurnId = turnId;
    this.emit({ type: "turn_started", provider: this.provider, turnId });
    this.child.stdin.write(`${JSON.stringify({ id: turnId, type: "prompt", message: prompt })}\n`);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(_requestId: string, _response: AgentPermissionResponse): Promise<void> {
    // 默认空操作
  }

  async interrupt(): Promise<void> {
    if (this.child && this.activeTurnId) {
      const turnId = this.activeTurnId;
      this.activeTurnId = null;
      this.child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
      this.emit({ type: "turn_canceled", provider: this.provider, turnId, reason: "Interrupted" });
    }
  }

  describePersistence(): AgentPersistenceHandle | null {
    return null;
  }

  async close(): Promise<void> {
    if (this.child) {
      await terminateProcessTree(this.child);
      this.child = null;
    }
  }

  private handleFrame(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const turnId = this.activeTurnId ?? undefined;
    if (msg.type === "message_update" || msg.type === "text_delta") {
      const text = String(msg.delta ?? msg.text ?? "");
      if (text) {
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "assistant_message", text },
        });
      }
      return;
    }
    if (msg.type === "agent_end" || msg.type === "turn_end") {
      this.activeTurnId = null;
      this.emit({ type: "turn_completed", provider: this.provider, turnId });
    }
  }

  private emit(event: AgentStreamEvent): void {
    for (const cb of this.subscribers) {
      cb(event);
    }
  }
}

/**
 * JSONL Stdio RPC Provider 客户端工厂
 */
export class JsonlRpcProviderClient implements AgentClient {
  readonly capabilities = JSONL_CAPABILITIES;

  constructor(
    readonly provider: string,
    private readonly command: readonly [string, ...string[]],
    private readonly ledger?: ProcessLedgerStore,
  ) {}

  async isAvailable(): Promise<boolean> {
    return findExecutableSync(this.command[0]) !== null;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new JsonlRpcSession(this.provider, this.command, config, this.ledger);
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    config: AgentSessionConfig,
  ): Promise<AgentSession> {
    return new JsonlRpcSession(this.provider, this.command, config, this.ledger);
  }
}
