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

const CLAUDE_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsMidTurnSteer: false,
};

/**
 * Claude Code CLI 原生流式 JSON 会话适配器
 * 使用 claude -p --verbose --output-format stream-json 驱动，支持 --resume 恢复与只读 Plan 门控
 */
class ClaudeStreamSession implements AgentSession {
  readonly provider = "claude";
  readonly capabilities = CLAUDE_CAPABILITIES;
  private claudeSessionId: string | null = null;
  private activeTurnId: string | null = null;
  private activeChild: ChildProcessWithoutNullStreams | null = null;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(
    private readonly config: AgentSessionConfig,
    private readonly command: readonly [string, ...string[]],
    private readonly ledger?: ProcessLedgerStore,
    resumeSessionId?: string,
  ) {
    this.claudeSessionId = resumeSessionId ?? null;
  }

  get id(): string | null {
    return this.claudeSessionId;
  }

  async startTurn(prompt: string, _options?: AgentRunOptions): Promise<{ turnId: string }> {
    const turnId = `claude_turn_${randomUUID().slice(0, 8)}`;
    this.activeTurnId = turnId;
    this.emit({ type: "turn_started", provider: "claude", turnId });

    const [bin, ...baseArgs] = this.command;
    const permMode = this.config.writeAccess ? "acceptEdits" : "plan";
    const args = [
      ...baseArgs,
      "-p",
      prompt,
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      permMode,
      ...(this.config.model ? ["--model", this.config.model] : []),
      ...(this.claudeSessionId ? ["--resume", this.claudeSessionId] : []),
    ];

    const child = spawnManagedChild(bin, args, {
      cwd: this.config.cwd,
      env: this.config.env,
      instanceId: this.config.instanceId,
      provider: "claude",
      ledger: this.ledger,
    });
    this.activeChild = child;
    child.stdin.end();

    let buf = "";
    let stderrTail = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.handleStreamJsonLine(line, turnId);
        nl = buf.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4096);
    });

    child.on("exit", (code) => {
      if (this.activeChild === child) {
        this.activeChild = null;
      }
      if (this.activeTurnId !== turnId) return;
      this.activeTurnId = null;
      if (code === 0) {
        this.emit({ type: "turn_completed", provider: "claude", turnId });
      } else {
        this.emit({
          type: "turn_failed",
          provider: "claude",
          turnId,
          error: `Claude CLI exited with code ${code ?? "null"}: ${stderrTail}`.trim(),
        });
      }
    });

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
    // stream-json 单轮模式通过 permission-mode 控制
  }

  async setWriteAccess(allowed: boolean): Promise<void> {
    this.config.writeAccess = allowed;
  }

  async interrupt(): Promise<void> {
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    if (this.activeChild) {
      const child = this.activeChild;
      this.activeChild = null;
      await terminateProcessTree(child);
    }
    if (turnId) {
      this.emit({ type: "turn_canceled", provider: "claude", turnId, reason: "Interrupted" });
    }
  }

  describePersistence(): AgentPersistenceHandle | null {
    if (!this.claudeSessionId) return null;
    return {
      provider: "claude",
      sessionId: this.claudeSessionId,
      nativeHandle: this.claudeSessionId,
    };
  }

  async close(): Promise<void> {
    await this.interrupt();
  }

  private handleStreamJsonLine(line: string, turnId: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof frame.session_id === "string" && !this.claudeSessionId) {
      this.claudeSessionId = frame.session_id;
      this.emit({
        type: "thread_started",
        provider: "claude",
        sessionId: this.claudeSessionId,
        turnId,
      });
    }

    if (frame.type === "assistant" && frame.message && typeof frame.message === "object") {
      const msg = frame.message as { content?: Array<Record<string, unknown>> };
      for (const block of msg.content ?? []) {
        if (block.type === "text" && typeof block.text === "string") {
          this.emit({
            type: "timeline",
            provider: "claude",
            turnId,
            item: { type: "assistant_message", text: block.text },
          });
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          this.emit({
            type: "timeline",
            provider: "claude",
            turnId,
            item: { type: "reasoning", text: block.thinking },
          });
        } else if (block.type === "tool_use") {
          const callId = String(block.id ?? randomUUID().slice(0, 8));
          const name = String(block.name ?? "Tool");
          const input = (block.input ?? {}) as Record<string, unknown>;
          this.emit({
            type: "timeline",
            provider: "claude",
            turnId,
            item: {
              type: "tool_call",
              callId,
              name,
              status: "completed",
              error: null,
              detail:
                name === "Bash" && typeof input.command === "string"
                  ? { type: "shell", command: input.command }
                  : typeof input.file_path === "string"
                    ? { type: "edit", path: input.file_path }
                    : { type: "unknown", input },
            },
          });
        }
      }
      return;
    }

    if (frame.type === "result" && typeof frame.result === "string" && frame.result.trim()) {
      this.emit({
        type: "timeline",
        provider: "claude",
        turnId,
        item: { type: "assistant_message", text: frame.result },
      });
    }
  }

  private emit(event: AgentStreamEvent): void {
    for (const cb of this.subscribers) {
      cb(event);
    }
  }
}

/**
 * Claude Code 原生 Provider 客户端工厂
 */
export class ClaudeStreamProviderClient implements AgentClient {
  readonly provider = "claude";
  readonly capabilities = CLAUDE_CAPABILITIES;

  constructor(
    private readonly command: readonly [string, ...string[]] = ["claude"],
    private readonly ledger?: ProcessLedgerStore,
  ) {}

  async isAvailable(): Promise<boolean> {
    return findExecutableSync(this.command[0]) !== null;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new ClaudeStreamSession(config, this.command, this.ledger);
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    config: AgentSessionConfig,
  ): Promise<AgentSession> {
    return new ClaudeStreamSession(
      config,
      this.command,
      this.ledger,
      handle.nativeHandle ?? handle.sessionId,
    );
  }
}
