/**
 * 运行时控制与四通道数据回传共享协议契约
 * 严格对齐 docs/multi_agent_control_and_data_return_plan.md
 */

/**
 * Agent 能力声明标志位，决定上层如何向其注入工具与展示控制项
 */
export interface AgentCapabilityFlags {
  supportsStreaming: boolean;
  supportsSessionPersistence: boolean;
  supportsDynamicModes: boolean;
  supportsMcpServers: boolean;
  supportsReasoningStream: boolean;
  supportsToolInvocations: boolean;
  supportsMidTurnSteer?: boolean;
}

/**
 * 跨进程重启可恢复的持久化句柄
 */
export interface AgentPersistenceHandle {
  provider: string;
  sessionId: string;
  /** Provider 原生句柄（如 Thread ID、Session File Path、Resume Token） */
  nativeHandle?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 归一化工具调用详情：屏蔽不同 CLI 的工具参数格式差异
 */
export type ToolCallDetail =
  | {
      type: "shell";
      command: string;
      cwd?: string | null;
      exitCode?: number | null;
      output?: string | null;
    }
  | {
      type: "edit" | "write";
      path: string;
      diffPreview?: string | null;
    }
  | {
      type: "read" | "search";
      target: string;
      outputPreview?: string | null;
    }
  | {
      type: "plan";
      text: string;
    }
  | {
      type: "unknown";
      input: unknown;
      output?: unknown;
    };

/**
 * 权限请求分类（高危命令、文件写入、计划确认或追问）
 */
export type AgentPermissionRequestKind = "tool" | "plan" | "question" | "mode" | "other";

/**
 * 标准化的交互式权限或追问请求对象
 */
export interface AgentPermissionRequest {
  id: string;
  provider: string;
  name: string;
  kind: AgentPermissionRequestKind;
  title: string;
  description?: string;
  options?: Array<{ id: string; label: string; allow: boolean }>;
  detail?: ToolCallDetail;
  metadata?: Record<string, unknown>;
}

/**
 * 权限审批响应载荷
 */
export interface AgentPermissionResponse {
  behavior: "allow" | "deny";
  optionId?: string;
  message?: string;
  interrupt?: boolean;
}

/**
 * 统一时间线数据项：涵盖对话、思考、归一化工具调用、待办与错误
 */
export type AgentTimelineItem =
  | { type: "user_message"; text: string; messageId?: string; clientMessageId?: string }
  | { type: "assistant_message"; text: string; messageId?: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      status: "running" | "completed" | "failed" | "canceled";
      detail: ToolCallDetail;
      error: string | null;
    }
  | { type: "todo"; items: Array<{ id?: string; text: string; completed: boolean }> }
  | { type: "error"; message: string }
  | { type: "compaction"; status: "loading" | "completed" };

/**
 * Token 与成本用量统计
 */
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * 归一化实时生命周期与流事件
 */
export type AgentStreamEvent =
  | { type: "thread_started"; sessionId: string; provider: string; turnId?: string }
  | { type: "turn_started"; provider: string; turnId?: string }
  | {
      type: "timeline";
      provider: string;
      item: AgentTimelineItem;
      turnId?: string;
      timestamp?: string;
    }
  | {
      type: "permission_requested";
      provider: string;
      request: AgentPermissionRequest;
      turnId?: string;
    }
  | {
      type: "permission_resolved";
      provider: string;
      requestId: string;
      resolution: AgentPermissionResponse;
      turnId?: string;
    }
  | { type: "usage_updated"; provider: string; usage: AgentUsage; turnId?: string }
  | { type: "turn_completed"; provider: string; usage?: AgentUsage; turnId?: string }
  | {
      type: "turn_failed";
      provider: string;
      error: string;
      code?: string;
      diagnostic?: string;
      turnId?: string;
    }
  | { type: "turn_canceled"; provider: string; reason: string; turnId?: string };

/**
 * 经 TimelineProjection 折叠后的单条权威时间线投影记录
 * 携带 sourceSeqRanges 供客户端原地替换流式半截文本，杜绝重复拼接
 */
export interface ProjectedTimelineEntry {
  /** 所属投影纪元 */
  epoch: number;
  /** 本条记录覆盖的最大源事件序号 */
  seq: number;
  /** 合并覆盖的源事件闭区间 [minSeq, maxSeq] */
  sourceSeqRange: readonly [number, number];
  /** 关联轮次 ID */
  turnId?: string;
  /** ISO 时间戳 */
  timestamp: string;
  /** 折叠并经过容量裁剪后的标准时间线项 */
  item: AgentTimelineItem;
}

/**
 * 面向 UI 客户端的权威时间线游标分页响应（通道三权威历史轨）
 */
export interface TimelinePage {
  instanceId: string;
  epoch: number;
  headSeq: number;
  entries: ProjectedTimelineEntry[];
  hasMore: boolean;
}

/**
 * 消息投递并发控制策略（对齐 AgentMessageDelivery）
 */
export type ActiveTurnBehavior = "queue" | "steer" | "interrupt";
