import type { AgentPermissionRequest, AgentPersistenceHandle } from "./runtime.js";
import { getProviderDisplayName, type CustomProviderConfig } from "./providers.js";

/** 执行器标识符（支持 48 款内置及任意自定义 Provider ID） */
export type ExecutorId = string;

/**
 * 任务展示与引擎主状态（顶栏五种互斥统计主态 + 阻塞/取消扩展态）
 */
export type TaskStatus =
  | "accepted"
  | "reported"
  | "running"
  | "rework"
  | "pending"
  | "blocked"
  | "canceled";

/**
 * 运行实例生命周期状态（与任务状态严格分离）
 */
export type InstanceStatus =
  | "starting"
  | "running"
  | "paused"
  | "awaiting-confirm"
  | "reported"
  | "accepted"
  | "failed"
  | "isolated"
  | "canceled"
  | "closed";

/**
 * 项目事实状态：仅 confirmed 会作为现行事实下发给后续实例
 */
export type FactStatus = "confirmed" | "unverified" | "deprecated" | "lesson";

/** 阶段视觉状态类型 */
export type StageKind = "done" | "current" | "parallel" | "idle";

/** 工作台切换子面板类型 */
export type Surface =
  | "tasks"
  | "instances"
  | "facts"
  | "review"
  | "inbox"
  | "handoff"
  | "config";

/** 页面级视图类型 */
export type PageView = "workbench" | "new-project";

/**
 * 角色配置定义（用户可增删改并自由改绑任意执行器）
 */
export interface Role {
  id: string;
  name: string;
  duty: string;
  executorId: ExecutorId;
  model?: string;
  /** 允许的权限级别：readonly（仅规划阅读） | workspace-write（工作区读写） */
  permissionMode?: "readonly" | "workspace-write";
}

/** 软件工程阶段定义 */
export interface Stage {
  id: string;
  name: string;
  statusLabel: string;
  kind: StageKind;
}

/** 可核对的任务产物及真实版本标识 */
export interface Artifact {
  path: string;
  version: string;
  verified: boolean;
}

/**
 * 结构化回报与客观验收记录（客观证据与模型意见严格分栏）
 */
export interface StructuredReport {
  done: string;
  artifacts: Artifact[];
  verification: string;
  /** Daemon 实测采集的客观证据（Git Diff、退出码、文件校验） */
  evidence: string;
  /** 执行器或指挥模型的主观意见（仅供参考，不替代证据） */
  opinion: string;
  basis: string;
  leftovers: string;
  failures?: string;
  /** 指挥大模型的综合裁决结论说明 */
  leaderDecisionNote?: string;
}

/**
 * 带 DAG 前置依赖与明确验收标准的子任务定义
 */
export interface Task {
  id: string;
  name: string;
  stageId: string;
  roleId: string;
  status: TaskStatus;
  doing: string;
  /** 下发给执行智能体的详细工程指令 */
  instruction?: string;
  artifact: string;
  artifactVersion?: string;
  deps: string[];
  acceptance: string[];
  /** 可自动运行的验证命令白名单（如 npm test） */
  verificationCommands?: string[];
  /** 预期修改的文件或模块路径，用于并行冲突预检 */
  targetPaths?: string[];
  /** 单任务临时指定的执行器覆盖 */
  executorOverride?: ExecutorId;
  /** 当前已自动返工次数 */
  reworkCount?: number;
  /** 动态二次拆分的派生深度（防无限递归护栏） */
  splitDepth?: number;
  /** 绑定的隔离工作目录（主目录或独立 Git Worktree 路径） */
  worktreePath?: string;
  /** 绑定的独立 Git 分支名称 */
  branchName?: string;
}

/**
 * 单个执行智能体运行实例记录
 */
export interface Instance {
  id: string;
  taskId: string;
  roleId: string;
  executorId: ExecutorId;
  status: InstanceStatus;
  /** 当前是否持有该任务工作区的有效写权限（防双写核心标记） */
  writeAccess: boolean;
  progress: number;
  sessionMode: "new" | "hosted" | "handoff-import";
  label?: string;
  note?: string;
  report?: StructuredReport;
  frozen?: boolean;
  worktreePath?: string;
  branchName?: string;
  persistence?: AgentPersistenceHandle | null;
  pendingPermissions?: AgentPermissionRequest[];
  startedAt?: string;
  updatedAt?: string;
}

/** 共享项目事实条目 */
export interface Fact {
  id: string;
  content: string;
  version: string;
  source: string;
  status: FactStatus;
}

/**
 * 标准 10 字段交接包（接收方显式确认前不授予写权限）
 */
export interface HandoffPackage {
  id: string;
  taskId: string;
  fromInstanceId: string;
  toInstanceId?: string;
  toExecutorId?: ExecutorId;
  reason: string;
  /** 1. 目标与成功标准 */
  goal: string;
  /** 2. 约束与硬性要求 */
  constraints: string;
  /** 3. 已完成工作摘要 */
  completed: string;
  /** 4. 关键决策及依据 */
  decisions: string;
  /** 5. 产物清单与真实版本（含 Git 检查点标识） */
  artifacts: string;
  /** 6. 当前验收结果与客观证据 */
  acceptance: string;
  /** 7. 未解决问题与风险 */
  leftovers: string;
  /** 8. 已废弃或失败方案（避坑警示） */
  failures: string;
  /** 9. 建议下一步（仅供参考，非既定事实） */
  nextSteps?: string;
  /** 会话能力缺口诚实披露 */
  hostGap: string;
  /** 10. 接收者开工前待确认清单 */
  confirmItems: string[];
  checkpointRef?: string;
  confirmed: boolean;
  created: boolean;
}

/**
 * 待办与审批中心条目（涵盖验收、交接确认、高风险命令审批与人工阻塞介入）
 */
export interface InboxItem {
  id: string;
  kind: "accept" | "handoff" | "intervene" | "suggest-switch" | "permission";
  title: string;
  body: string;
  taskId?: string;
  instanceId?: string;
  handoffId?: string;
  permissionRequestId?: string;
  options?: string[];
  done?: boolean;
}

/** 底部常驻指挥对话消息 */
export interface ChatMessage {
  id: string;
  speaker: "user" | "leader" | "system";
  text: string;
  at: string;
}

/** 项目执行模式：real 调用真实本地 CLI 子进程，mock 使用内置模拟器演示 */
export type ProjectExecutionMode = "real" | "mock";

/**
 * 完整项目聚合状态根对象
 */
export interface Project {
  id: string;
  name: string;
  isExample: boolean;
  /** 绑定的本地代码仓库目录路径 */
  repoPath?: string;
  /** 执行模式：真实 CLI 执行或本地模拟 */
  executionMode?: ProjectExecutionMode;
  /** 是否为并行任务自动启用独立 Git Worktree 隔离 */
  useWorktreeIsolation?: boolean;
  background: string;
  goal: string;
  /** 当前持有各任务写锁的活跃实例映射 taskId -> instanceId */
  activeWriters?: Record<string, string>;
  currentStageId: string;
  stages: Stage[];
  roles: Role[];
  tasks: Task[];
  instances: Instance[];
  facts: Fact[];
  handoffs: HandoffPackage[];
  inbox: InboxItem[];
  messages: ChatMessage[];
  justCreated?: boolean;
}

/**
 * 后台指挥官（Leader Brain）配置结构
 * 直接选用本机已安装的 CLI 担任后台指挥调度官（只读规划与裁决，无需配置 HTTP API / Key）
 */
export interface BrainConfig {
  /** 担任后台指挥官的本机 CLI Provider ID（如 codex / claude / antigravity / cursor / opencode，或 heuristic 离线规则） */
  cliProviderId: ExecutorId;
  /** 可选指定模型名称（留空则使用该 CLI 默认配置） */
  model?: string;
  /** 前置依赖验收通过后是否由调度引擎自动派发下游任务 */
  autoDispatch: boolean;
  /** 单任务自动打回返工上限，超出后转人工阻塞 */
  maxReworkCount: number;
  /** 单项目最大并行运行实例上限 */
  maxConcurrency: number;
}

/**
 * 全局系统设置快照（供配置中心读写）
 */
export interface SystemSettings {
  brain: BrainConfig;
  /** 全局角色分工与默认执行智能体绑定（适用于所有现有与新建项目） */
  defaultRoles: Role[];
  enabledProviderIds: string[];
  /** 用户手动勾选或取消勾选的显式覆盖记录；未手动覆盖的项默认跟随本机 installed 状态自动打勾 */
  userProviderOverrides?: Record<string, boolean>;
  /** 持久化记录各智能体最近一次主动连通性测试状态（ok 可用 | error 无法指挥） */
  providerHealth?: Record<string, "ok" | "error">;
  customProviders: CustomProviderConfig[];
  /** 硬约束：禁止用于特定角色的 Provider ID 列表 roleId -> providerIds */
  hardDisabledByRole?: Record<string, string[]>;
}

/** 任务状态展示文案与色调映射 */
export const TASK_STATUS_META: Record<
  TaskStatus,
  { label: string; tone: "ok" | "warn" | "info" | "rework" | "neutral" }
> = {
  accepted: { label: "已验收", tone: "ok" },
  reported: { label: "待验收", tone: "warn" },
  running: { label: "执行中", tone: "info" },
  rework: { label: "返工中", tone: "rework" },
  pending: { label: "未开始", tone: "neutral" },
  blocked: { label: "人工阻塞", tone: "rework" },
  canceled: { label: "已取消", tone: "neutral" },
};

/** 运行实例状态中文文案映射 */
export const INSTANCE_STATUS_LABEL: Record<InstanceStatus, string> = {
  starting: "启动中",
  running: "执行中",
  paused: "已暂停",
  "awaiting-confirm": "待确认交接包",
  reported: "已回报",
  accepted: "已验收",
  failed: "失败",
  isolated: "已隔离",
  canceled: "已取消",
  closed: "已回收",
};

/** 项目事实状态展示文案映射 */
export const FACT_STATUS_META: Record<
  FactStatus,
  { label: string; tone: "ok" | "warn" | "neutral" | "rework" }
> = {
  confirmed: { label: "已确认", tone: "ok" },
  unverified: { label: "待验证", tone: "warn" },
  deprecated: { label: "已废弃", tone: "neutral" },
  lesson: { label: "失败教训", tone: "rework" },
};

/**
 * 解析执行器展示名称
 */
export function executorName(
  id: ExecutorId,
  customProviders: readonly CustomProviderConfig[] = [],
): string {
  return getProviderDisplayName(id, customProviders);
}

/**
 * 计算某个任务当前生效的执行器 ID（单任务覆盖优先于角色默认绑定）
 */
export function taskExecutor(task: Task, roles: readonly Role[]): ExecutorId {
  if (task.executorOverride) return task.executorOverride;
  const role = roles.find((r) => r.id === task.roleId);
  return role?.executorId ?? "codex";
}
