import { randomUUID } from "node:crypto";
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

const MOCK_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsMidTurnSteer: true,
};

/**
 * 内置确定性模拟执行器会话（用于离线演示、示例项目演练与自动化集成测试）
 * 严格发出真实的推理增量、工具调用生命周期与完成事件，完整穿过四通道数据流水线
 */
class MockAgentSession implements AgentSession {
  readonly capabilities = MOCK_CAPABILITIES;
  private readonly sessionId: string;
  private activeTurnId: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private steeredNotes: string[] = [];
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(
    readonly provider: string,
    private readonly config: AgentSessionConfig,
    resumeId?: string,
  ) {
    this.sessionId = resumeId ?? `mock_sess_${randomUUID().slice(0, 8)}`;
  }

  get id(): string | null {
    return this.sessionId;
  }

  async startTurn(prompt: string, _options?: AgentRunOptions): Promise<{ turnId: string }> {
    const turnId = `mock_turn_${randomUUID().slice(0, 8)}`;
    this.activeTurnId = turnId;
    this.steeredNotes = [];

    const firstLine = prompt.split("\n").find((l) => l.trim())?.slice(0, 80) ?? "执行任务";
    const callReadId = `call_${randomUUID().slice(0, 6)}`;
    const callBashId = `call_${randomUUID().slice(0, 6)}`;

    const steps: Array<() => void> = [
      () => this.emit({ type: "turn_started", provider: this.provider, turnId }),
      () =>
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: {
            type: "reasoning",
            text: `正在分析任务指令与现行项目事实：「${firstLine}」… 检查工作区写权限=${this.config.writeAccess}。`,
          },
        }),
      () =>
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: {
            type: "tool_call",
            callId: callReadId,
            name: "ReadContext",
            status: "completed",
            error: null,
            detail: {
              type: "read",
              target: this.config.cwd,
              outputPreview: "已扫描目标目录结构与上游确认产物版本。",
            },
          },
        }),
      () =>
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: {
            type: "tool_call",
            callId: callBashId,
            name: "VerifyCheck",
            status: "completed",
            error: null,
            detail: {
              type: "shell",
              command: "npm run typecheck --dry-run",
              cwd: this.config.cwd,
              exitCode: 0,
              output: "All checks passed (exit code 0).",
            },
          },
        }),
      () => {
        const steerExtra = this.steeredNotes.length
          ? `\n已合并运行中补充引导：${this.steeredNotes.join("；")}`
          : "";
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: {
            type: "assistant_message",
            text: [
              `已按局部现行事实与验收标准完成本轮任务执行。${steerExtra}`,
              `- 工作目录：${this.config.cwd}`,
              "- 验证结果：本地检查退出码 0，产物与约束已对齐，未发现冲突遗留项。",
            ].join("\n"),
          },
        });
      },
      () => {
        this.activeTurnId = null;
        this.emit({ type: "turn_completed", provider: this.provider, turnId });
      },
    ];

    let idx = 0;
    const runNext = () => {
      if (this.activeTurnId !== turnId) return;
      const fn = steps[idx++];
      if (fn) fn();
      if (idx < steps.length && this.activeTurnId === turnId) {
        this.timer = setTimeout(runNext, 160);
      }
    };
    this.timer = setTimeout(runNext, 60);

    return { turnId };
  }

  async steerActiveTurn(
    prompt: string,
    options: { expectedTurnId: string },
  ): Promise<{ status: "accepted" } | { status: "unavailable" }> {
    if (this.activeTurnId !== options.expectedTurnId) {
      return { status: "unavailable" };
    }
    this.steeredNotes.push(prompt);
    return { status: "accepted" };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(_requestId: string, _response: AgentPermissionResponse): Promise<void> {
    // 模拟器默认无需挂起
  }

  async setWriteAccess(allowed: boolean): Promise<void> {
    this.config.writeAccess = allowed;
  }

  async interrupt(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.activeTurnId) {
      const turnId = this.activeTurnId;
      this.activeTurnId = null;
      this.emit({ type: "turn_canceled", provider: this.provider, turnId, reason: "Interrupted" });
    }
  }

  describePersistence(): AgentPersistenceHandle | null {
    return { provider: this.provider, sessionId: this.sessionId, nativeHandle: this.sessionId };
  }

  async close(): Promise<void> {
    await this.interrupt();
  }

  private emit(event: AgentStreamEvent): void {
    for (const cb of this.subscribers) {
      cb(event);
    }
  }
}

/**
 * 本地模拟 Provider 客户端工厂
 */
export class MockProviderClient implements AgentClient {
  readonly capabilities = MOCK_CAPABILITIES;

  constructor(readonly provider = "mock") {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new MockAgentSession(this.provider, config);
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    config: AgentSessionConfig,
  ): Promise<AgentSession> {
    return new MockAgentSession(this.provider, config, handle.sessionId);
  }
}
