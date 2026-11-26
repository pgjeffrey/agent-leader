import type {
  AgentCapabilityFlags,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
} from "@agent-leader/protocol";

/**
 * 创建底层执行智能体会话时的启动配置
 */
export interface AgentSessionConfig {
  /** 运行实例唯一 ID */
  instanceId: string;
  /** 工作区绝对目录 */
  cwd: string;
  /** 指定模型名称（可选，留空走 CLI 默认） */
  model?: string;
  /** 系统/开发者附加指令 */
  systemPrompt?: string;
  /** 是否允许工作区写操作（false 时强制只读/Plan 沙箱模式，防止双写或未确认交接前修改文件） */
  writeAccess: boolean;
  /** 附加环境变量（独立秘密渠道注入，不落盘至事实库或交接包） */
  env?: Record<string, string>;
}

/**
 * 启动单轮推理的可选参数
 */
export interface AgentRunOptions {
  clientMessageId?: string;
  signal?: AbortSignal;
}

/**
 * 同步/阻塞式运行单轮任务后的聚合返回对象（通道二）
 */
export interface AgentRunResult {
  sessionId: string;
  finalText: string;
  usage?: AgentUsage;
  timeline: AgentTimelineItem[];
  canceled?: boolean;
}

/**
 * 跨平台托管子进程持久化台账记录（防孤儿进程泄漏）
 */
export interface ManagedProcessRecord {
  pid: number;
  instanceId: string;
  provider: string;
  command: string;
  startedAt: number;
}

/**
 * Provider 工厂契约：负责本机环境探测与会话创建/恢复（屏蔽底层异构差异）
 */
export interface AgentClient {
  readonly provider: string;
  readonly capabilities: AgentCapabilityFlags;

  /** 检测本机可执行文件与环境是否可用 */
  isAvailable(): Promise<boolean>;

  /** 创建全新底层会话 */
  createSession(config: AgentSessionConfig): Promise<AgentSession>;

  /** 从持久化句柄按需热恢复会话 */
  resumeSession(
    handle: AgentPersistenceHandle,
    config: AgentSessionConfig,
  ): Promise<AgentSession>;
}

/**
 * 运行中单实例会话契约：所有异构 Agent 控制动作均收敛至此接口
 */
export interface AgentSession {
  readonly provider: string;
  readonly id: string | null;
  readonly capabilities: AgentCapabilityFlags;

  /** 启动一轮新的前台推理，返回唯一 turnId */
  startTurn(prompt: string, options?: AgentRunOptions): Promise<{ turnId: string }>;

  /**
   * 向正在运行的指定 Turn 实时注入引导消息（Steer）
   * 若底层不支持或当前 Turn 不匹配，返回 unavailable 由上层自动降级为 interrupt
   */
  steerActiveTurn?(
    prompt: string,
    options: { expectedTurnId: string; clearPendingPermissions?: boolean; clientMessageId?: string },
  ): Promise<{ status: "accepted" } | { status: "unavailable" }>;

  /** 订阅归一化后的实时事件流 */
  subscribe(callback: (event: AgentStreamEvent) => void): () => void;

  /** 获取当前挂起的权限请求 */
  getPendingPermissions(): AgentPermissionRequest[];

  /** 响应权限审批或追问 */
  respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void>;

  /** 动态更新写权限状态（用于交接包确认后原地升级权限，或换人时降级） */
  setWriteAccess?(allowed: boolean): Promise<void>;

  /**
   * 幂等中断契约：
   * 仅当确认前台 Turn 已彻底停止时 resolve；超时或拒绝时必须 reject 防止双写脑裂
   */
  interrupt(): Promise<void>;

  /** 空闲进程回收安全否决：返回 false 表示内部仍有未完后台操作 */
  canStopRuntime?(): Promise<boolean>;

  /** 获取跨重启恢复用的持久化句柄 */
  describePersistence(): AgentPersistenceHandle | null;

  /** 释放底层子进程/连接资源（保留持久化历史） */
  close(): Promise<void>;
}
