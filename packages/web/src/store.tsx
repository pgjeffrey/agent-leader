import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from "react";
import {
  BUILTIN_PROVIDER_CATALOG,
  type ActiveTurnBehavior,
  type AgentPermissionResponse,
  type AppUi,
  type ClientToServerWsMessage,
  type ExecutorId,
  type ProjectedTimelineEntry,
  type Project,
  type ProjectExecutionMode,
  type ProviderModelOption,
  type ProviderRuntimeSnapshot,
  type ServerToClientWsMessage,
  type Surface,
  type SystemSettings,
  type TaskStatus,
} from "./types";
import { seedProjects } from "./data/seed";

/**
 * 前端全局 Store 状态结构（与本地 127.0.0.1 Daemon 实时双向同步）
 */
export interface AppState {
  connected: boolean;
  platform: string;
  projects: Project[];
  activeProjectId: string;
  settings: SystemSettings;
  providers: ProviderRuntimeSnapshot[];
  /** 实例权威时间线本地投影缓存 instanceId -> entries */
  timelines: Record<string, ProjectedTimelineEntry[]>;
  brainStatus: {
    projectId?: string;
    phase: "idle" | "planning" | "evaluating" | "chatting";
    detail?: string;
  };
  busyCreating: boolean;
  ui: AppUi;
}

/**
 * UI 本地交互与服务端状态合并 Action
 */
export type Action =
  | { type: "DAEMON_HELLO"; payload: Extract<ServerToClientWsMessage, { type: "daemon.hello" }> }
  | { type: "WS_DISCONNECTED" }
  | { type: "PROJECT_UPDATED"; project: Project }
  | { type: "PROJECTS_LIST"; projects: Project[]; activeProjectId: string }
  | {
      type: "SETTINGS_UPDATED";
      settings: SystemSettings;
      providers: ProviderRuntimeSnapshot[];
    }
  | { type: "TIMELINE_PAGE"; instanceId: string; entries: ProjectedTimelineEntry[] }
  | { type: "TIMELINE_UPSERT"; instanceId: string; entry: ProjectedTimelineEntry }
  | {
      type: "BRAIN_STATUS";
      projectId: string;
      phase: "idle" | "planning" | "evaluating" | "chatting";
      detail?: string;
    }
  | { type: "SET_BUSY_CREATING"; busy: boolean }
  | { type: "OPEN_NEW_PROJECT" }
  | { type: "CANCEL_NEW_PROJECT" }
  | {
      type: "SET_DRAFT";
      field: "draftName" | "draftBackground" | "draftGoal" | "draftRepoPath";
      value: string;
    }
  | { type: "SET_DRAFT_MODE"; mode: ProjectExecutionMode }
  | { type: "SET_DRAFT_WORKTREE"; value: boolean }
  | { type: "CREATE_PROJECT" }
  | { type: "SELECT_PROJECT"; id: string }
  | { type: "SET_SURFACE"; surface: Surface }
  | { type: "SET_STAGE"; stageId: string | null }
  | { type: "SET_TASK_VIEW"; mode: "tasks" | "team" }
  | { type: "SELECT_TASK"; id: string | null }
  | { type: "TOGGLE_SUMMARY" }
  | { type: "FILTER_STATUS"; status: TaskStatus | null }
  | { type: "SEND_MESSAGE"; text: string }
  | { type: "REBIND_ROLE"; roleId: string; executorId: ExecutorId }
  | { type: "REBIND_TASK"; taskId: string; executorId: ExecutorId }
  | { type: "ACCEPT_TASK"; taskId: string }
  | { type: "REJECT_TASK"; taskId: string; reason: string }
  | { type: "OPEN_HANDOFF"; taskId: string; toExecutorId?: ExecutorId }
  | { type: "SET_HANDOFF_TARGET"; handoffId: string; executorId: ExecutorId }
  | { type: "CONFIRM_HANDOFF"; handoffId: string }
  | { type: "CLOSE_HANDOFF" }
  | { type: "SET_OPEN_HANDOFF_ID"; handoffId: string | null }
  | { type: "OPEN_CONFIG_MODAL" }
  | { type: "CLOSE_CONFIG_MODAL" }
  | { type: "DISPATCH_TASK"; taskId?: string };

const defaultSettings: SystemSettings = {
  brain: {
    cliProviderId: "codex",
    model: "",
    autoDispatch: true,
    maxReworkCount: 3,
    maxConcurrency: 4,
  },
  defaultRoles: [
    { id: "plan", name: "规划 Agent", duty: "需求梳理与技术方案", executorId: "antigravity" },
    { id: "impl", name: "实现 Agent", duty: "核心代码实现与自测", executorId: "codex" },
    { id: "test", name: "测试 Agent", duty: "自动化测试与验收核验", executorId: "claude" },
  ],
  enabledProviderIds: BUILTIN_PROVIDER_CATALOG.filter((p) => p.enabledByDefault).map((p) => p.id),
  customProviders: [],
};

const defaultProviders: ProviderRuntimeSnapshot[] = BUILTIN_PROVIDER_CATALOG.map((p) => ({
  ...p,
  enabled: Boolean(p.enabledByDefault),
  installed: p.id === "mock",
  executablePath: null,
  detectedVersion: null,
}));

const initialUi: AppUi = {
  view: "workbench",
  surface: "tasks",
  viewingStageId: null,
  taskViewMode: "tasks",
  selectedTaskId: null,
  openHandoffId: null,
  configModalOpen: false,
  summaryOpen: true,
  statusFilter: null,
  draftName: "",
  draftBackground: "",
  draftGoal: "",
  draftRepoPath: "",
  draftExecutionMode: "real",
  draftUseWorktree: false,
};

const initialState: AppState = {
  connected: false,
  platform: "local",
  projects: seedProjects,
  activeProjectId: seedProjects[0].id,
  settings: defaultSettings,
  providers: defaultProviders,
  timelines: {},
  brainStatus: { phase: "idle" },
  busyCreating: false,
  ui: initialUi,
};

/**
 * 利用 sourceSeqRange 原地替换已流式接收的半截文本或旧工具卡片，杜绝重复追加（通道三客户端对齐算法）
 */
function mergeProjectedEntry(
  existing: readonly ProjectedTimelineEntry[],
  incoming: ProjectedTimelineEntry,
): ProjectedTimelineEntry[] {
  const [minSeq, maxSeq] = incoming.sourceSeqRange;
  const filtered = existing.filter((item) => {
    const [iMin, iMax] = item.sourceSeqRange;
    const overlaps = iMin <= maxSeq && minSeq <= iMax;
    return !overlaps;
  });
  return [...filtered, incoming].sort((a, b) => a.seq - b.seq);
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "DAEMON_HELLO": {
      const hasProjects = action.payload.projects.length > 0;
      return {
        ...state,
        connected: true,
        platform: action.payload.platform,
        projects: action.payload.projects,
        activeProjectId: action.payload.activeProjectId,
        settings: action.payload.settings,
        providers: action.payload.providers,
        ui: hasProjects
          ? state.ui
          : { ...state.ui, view: "new-project", selectedTaskId: null, openHandoffId: null },
      };
    }
    case "WS_DISCONNECTED":
      return { ...state, connected: false };
    case "PROJECT_UPDATED": {
      const exists = state.projects.some((p) => p.id === action.project.id);
      const projects = exists
        ? state.projects.map((p) => (p.id === action.project.id ? action.project : p))
        : [action.project, ...state.projects];
      return { ...state, projects };
    }
    case "PROJECTS_LIST": {
      const hasProjects = action.projects.length > 0;
      return {
        ...state,
        projects: action.projects,
        activeProjectId: action.activeProjectId,
        ui: hasProjects
          ? state.ui
          : { ...state.ui, view: "new-project", selectedTaskId: null, openHandoffId: null },
      };
    }
    case "SETTINGS_UPDATED":
      return {
        ...state,
        settings: action.settings,
        providers: action.providers,
      };
    case "TIMELINE_PAGE": {
      const cur = state.timelines[action.instanceId] ?? [];
      let merged = [...cur];
      for (const entry of action.entries) {
        merged = mergeProjectedEntry(merged, entry);
      }
      return {
        ...state,
        timelines: { ...state.timelines, [action.instanceId]: merged },
      };
    }
    case "TIMELINE_UPSERT": {
      const cur = state.timelines[action.instanceId] ?? [];
      return {
        ...state,
        timelines: {
          ...state.timelines,
          [action.instanceId]: mergeProjectedEntry(cur, action.entry),
        },
      };
    }
    case "BRAIN_STATUS":
      return {
        ...state,
        brainStatus: {
          projectId: action.projectId,
          phase: action.phase,
          detail: action.detail,
        },
      };
    case "SET_BUSY_CREATING":
      return { ...state, busyCreating: action.busy };
    case "OPEN_NEW_PROJECT":
      return {
        ...state,
        ui: { ...state.ui, view: "new-project", selectedTaskId: null, openHandoffId: null },
      };
    case "CANCEL_NEW_PROJECT":
      return { ...state, ui: { ...state.ui, view: "workbench" } };
    case "SET_DRAFT":
      return { ...state, ui: { ...state.ui, [action.field]: action.value } };
    case "SET_DRAFT_MODE":
      return { ...state, ui: { ...state.ui, draftExecutionMode: action.mode } };
    case "SET_DRAFT_WORKTREE":
      return { ...state, ui: { ...state.ui, draftUseWorktree: action.value } };
    case "SELECT_PROJECT":
      return {
        ...state,
        activeProjectId: action.id,
        ui: {
          ...state.ui,
          view: "workbench",
          surface: "tasks",
          viewingStageId: null,
          selectedTaskId: null,
          openHandoffId: null,
          statusFilter: null,
        },
      };
    case "SET_SURFACE":
      return { ...state, ui: { ...state.ui, surface: action.surface } };
    case "SET_STAGE":
      return { ...state, ui: { ...state.ui, viewingStageId: action.stageId, surface: "tasks" } };
    case "SET_TASK_VIEW":
      return { ...state, ui: { ...state.ui, taskViewMode: action.mode, surface: "tasks" } };
    case "SELECT_TASK":
      return { ...state, ui: { ...state.ui, selectedTaskId: action.id } };
    case "TOGGLE_SUMMARY":
      return { ...state, ui: { ...state.ui, summaryOpen: !state.ui.summaryOpen } };
    case "FILTER_STATUS":
      return {
        ...state,
        ui: {
          ...state.ui,
          statusFilter: state.ui.statusFilter === action.status ? null : action.status,
        },
      };
    case "SET_OPEN_HANDOFF_ID":
      return { ...state, ui: { ...state.ui, openHandoffId: action.handoffId } };
    case "CLOSE_HANDOFF":
      return { ...state, ui: { ...state.ui, openHandoffId: null } };
    case "OPEN_CONFIG_MODAL":
      return { ...state, ui: { ...state.ui, configModalOpen: true } };
    case "CLOSE_CONFIG_MODAL":
      return { ...state, ui: { ...state.ui, configModalOpen: false } };
    default:
      return state;
  }
}

/**
 * 计算项目五种核心展示状态统计与总数
 */
export function projectCounts(project: Project) {
  const c = {
    accepted: 0,
    reported: 0,
    running: 0,
    rework: 0,
    pending: 0,
    blocked: 0,
    canceled: 0,
  };
  for (const t of project.tasks) {
    c[t.status] = (c[t.status] ?? 0) + 1;
  }
  return {
    accepted: c.accepted,
    reported: c.reported,
    running: c.running,
    rework: c.rework + c.blocked,
    pending: c.pending,
    blocked: c.blocked,
    canceled: c.canceled,
    total: project.tasks.filter((t) => t.status !== "canceled").length,
  };
}

/**
 * 生成项目概况卡片底部的三栏文字清单（已完成 / 正在做 / 尚未做）
 */
export function overviewColumns(
  project: Project,
): { title: string; tone: "ok" | "info" | "neutral"; items: string[] }[] {
  const accepted = project.tasks.filter((t) => t.status === "accepted");
  const doing = project.tasks.filter((t) =>
    ["running", "reported", "rework", "blocked"].includes(t.status),
  );
  const pending = project.tasks.filter((t) => t.status === "pending");

  return [
    {
      title: "已完成",
      tone: "ok",
      items: accepted.length ? accepted.slice(0, 6).map((t) => t.name) : ["—"],
    },
    {
      title: "正在做",
      tone: "info",
      items: doing.length ? doing.slice(0, 6).map((t) => t.name) : ["—"],
    },
    {
      title: "尚未做",
      tone: "neutral",
      items: pending.length ? pending.slice(0, 6).map((t) => t.name) : ["—"],
    },
  ];
}

interface CtxValue {
  state: AppState;
  projects: Project[];
  project: Project;
  ui: AppUi;
  settings: SystemSettings;
  providers: ProviderRuntimeSnapshot[];
  enabledProviders: ProviderRuntimeSnapshot[];
  dispatch: Dispatch<Action>;
  /** 请求指定实例的权威历史时间线 */
  requestTimeline: (instanceId: string) => void;
  /** 向运行中实例发送引导（Steer）或追加指令 */
  sendInstancePrompt: (instanceId: string, text: string, behavior?: ActiveTurnBehavior) => void;
  /** 中断正在运行的实例当前轮次 */
  interruptInstance: (instanceId: string) => void;
  /** 审批高风险权限请求 */
  respondPermission: (
    instanceId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ) => void;
  /** 保存全局配置 */
  saveSystemSettings: (next: SystemSettings) => Promise<void>;
  /** 测试指挥官连通性 */
  testBrainConnection: (draftBrain: SystemSettings["brain"]) => Promise<{ ok: boolean; detail: string }>;
  /** 测试指定可指挥执行智能体是否可用 */
  testProviderConnection: (providerId: string) => Promise<{ ok: boolean; detail: string }>;
  /** 从本机指定指挥官 CLI 读取真实可用模型列表 */
  listProviderModels: (
    providerId: string,
  ) => Promise<{ providerId: string; defaultModel?: string; models: ProviderModelOption[] }>;
  /** 弹出本机系统原生文件夹选择框选择项目目录 */
  pickDirectory: () => Promise<{ canceled: boolean; path?: string }>;
  /** 重命名项目记录 */
  renameProject: (projectId: string, name: string) => Promise<void>;
  /** 删除项目记录（不删除本地文件夹） */
  deleteProject: (projectId: string) => Promise<void>;
  /** 重新探测本机安装的 48 款 CLI */
  refreshProviders: () => Promise<void>;
}

const StoreCtx = createContext<CtxValue | null>(null);

async function postApi<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

/**
 * 全局状态与本地 Daemon WebSocket/HTTP 同步容器
 */
export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const sendWs = useCallback((msg: ClientToServerWsMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  // 建立并自动重连本地 Daemon WebSocket
  useEffect(() => {
    let closed = false;
    let retryTimer: number | null = null;

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as ServerToClientWsMessage;
          if (msg.type === "daemon.hello") {
            rawDispatch({ type: "DAEMON_HELLO", payload: msg });
          } else if (msg.type === "project.updated") {
            rawDispatch({ type: "PROJECT_UPDATED", project: msg.project });
          } else if (msg.type === "projects.list") {
            rawDispatch({
              type: "PROJECTS_LIST",
              projects: msg.projects,
              activeProjectId: msg.activeProjectId,
            });
          } else if (msg.type === "settings.updated") {
            rawDispatch({
              type: "SETTINGS_UPDATED",
              settings: msg.settings,
              providers: msg.providers,
            });
          } else if (msg.type === "agent.stream" && msg.projectedEntry) {
            rawDispatch({
              type: "TIMELINE_UPSERT",
              instanceId: msg.instanceId,
              entry: msg.projectedEntry,
            });
          } else if (msg.type === "timeline.page") {
            rawDispatch({
              type: "TIMELINE_PAGE",
              instanceId: msg.page.instanceId,
              entries: msg.page.entries,
            });
          } else if (msg.type === "brain.status") {
            rawDispatch({
              type: "BRAIN_STATUS",
              projectId: msg.projectId,
              phase: msg.phase,
              detail: msg.detail,
            });
          }
        } catch {
          // 忽略格式异常帧
        }
      };

      ws.onclose = () => {
        rawDispatch({ type: "WS_DISCONNECTED" });
        if (!closed) {
          retryTimer = window.setTimeout(connect, 1500);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, []);

  /**
   * 拦截业务型 Action 转发至本地 Daemon REST 接口，纯视图型 Action 直接更新本地 Reducer
   */
  const dispatch: Dispatch<Action> = useCallback((action: Action) => {
    const cur = stateRef.current;
    const pid = cur.activeProjectId;

    switch (action.type) {
      case "CREATE_PROJECT": {
        rawDispatch({ type: "SET_BUSY_CREATING", busy: true });
        void postApi<{ project: Project }>("/api/projects", {
          background: cur.ui.draftBackground,
          goal: cur.ui.draftGoal,
          repoPath: cur.ui.draftRepoPath,
          executionMode: cur.ui.draftExecutionMode,
          useWorktreeIsolation: cur.ui.draftUseWorktree,
        })
          .then(({ project }) => {
            rawDispatch({ type: "PROJECT_UPDATED", project });
            rawDispatch({ type: "SELECT_PROJECT", id: project.id });
            rawDispatch({ type: "SET_DRAFT", field: "draftName", value: "" });
            rawDispatch({ type: "SET_DRAFT", field: "draftRepoPath", value: "" });
            rawDispatch({ type: "SET_DRAFT", field: "draftBackground", value: "" });
            rawDispatch({ type: "SET_DRAFT", field: "draftGoal", value: "" });
          })
          .finally(() => {
            rawDispatch({ type: "SET_BUSY_CREATING", busy: false });
          });
        return;
      }
      case "SELECT_PROJECT": {
        rawDispatch(action);
        void postApi("/api/projects/select", { id: action.id });
        return;
      }
      case "SEND_MESSAGE": {
        void postApi<{ project: Project; openHandoffId?: string }>(
          `/api/projects/${encodeURIComponent(pid)}/chat`,
          { text: action.text },
        ).then((res) => {
          rawDispatch({ type: "PROJECT_UPDATED", project: res.project });
          if (res.openHandoffId) {
            rawDispatch({ type: "SET_OPEN_HANDOFF_ID", handoffId: res.openHandoffId });
          }
        });
        return;
      }
      case "DISPATCH_TASK": {
        void postApi<{ project: Project }>(`/api/projects/${encodeURIComponent(pid)}/dispatch`, {
          taskId: action.taskId,
        }).then((res) => rawDispatch({ type: "PROJECT_UPDATED", project: res.project }));
        return;
      }
      case "REBIND_ROLE": {
        void postApi<{ project: Project }>(
          `/api/projects/${encodeURIComponent(pid)}/roles/${encodeURIComponent(action.roleId)}/rebind`,
          { executorId: action.executorId },
        ).then((res) => rawDispatch({ type: "PROJECT_UPDATED", project: res.project }));
        return;
      }
      case "REBIND_TASK": {
        void postApi<{ project: Project }>(
          `/api/projects/${encodeURIComponent(pid)}/tasks/${encodeURIComponent(action.taskId)}/rebind`,
          { executorId: action.executorId },
        ).then((res) => rawDispatch({ type: "PROJECT_UPDATED", project: res.project }));
        return;
      }
      case "ACCEPT_TASK": {
        void postApi<{ project: Project }>(
          `/api/projects/${encodeURIComponent(pid)}/tasks/${encodeURIComponent(action.taskId)}/accept`,
        ).then((res) => rawDispatch({ type: "PROJECT_UPDATED", project: res.project }));
        return;
      }
      case "REJECT_TASK": {
        void postApi<{ project: Project }>(
          `/api/projects/${encodeURIComponent(pid)}/tasks/${encodeURIComponent(action.taskId)}/reject`,
          { reason: action.reason },
        ).then((res) => rawDispatch({ type: "PROJECT_UPDATED", project: res.project }));
        return;
      }
      case "OPEN_HANDOFF": {
        void postApi<{ project: Project; handoffId: string }>(
          `/api/projects/${encodeURIComponent(pid)}/handoff/initiate`,
          { taskId: action.taskId, toExecutorId: action.toExecutorId },
        ).then((res) => {
          rawDispatch({ type: "PROJECT_UPDATED", project: res.project });
          rawDispatch({ type: "SET_OPEN_HANDOFF_ID", handoffId: res.handoffId });
        });
        return;
      }
      case "SET_HANDOFF_TARGET": {
        void postApi<{ project: Project }>(
          `/api/projects/${encodeURIComponent(pid)}/handoff/${encodeURIComponent(action.handoffId)}/target`,
          { executorId: action.executorId },
        ).then((res) => rawDispatch({ type: "PROJECT_UPDATED", project: res.project }));
        return;
      }
      case "CONFIRM_HANDOFF": {
        void postApi<{ project: Project }>(
          `/api/projects/${encodeURIComponent(pid)}/handoff/${encodeURIComponent(action.handoffId)}/confirm`,
        ).then((res) => {
          rawDispatch({ type: "PROJECT_UPDATED", project: res.project });
          rawDispatch({ type: "CLOSE_HANDOFF" });
        });
        return;
      }
      default:
        rawDispatch(action);
    }
  }, []);

  const requestTimeline = useCallback(
    (instanceId: string) => {
      const existing = stateRef.current.timelines[instanceId];
      const afterSeq = existing?.at(-1)?.seq ?? 0;
      sendWs({
        type: "timeline.fetch",
        requestId: `tl_${Date.now()}`,
        instanceId,
        afterSeq,
        limit: 200,
      });
    },
    [sendWs],
  );

  const sendInstancePrompt = useCallback(
    (instanceId: string, text: string, behavior: ActiveTurnBehavior = "steer") => {
      sendWs({
        type: "instance.prompt",
        projectId: stateRef.current.activeProjectId,
        instanceId,
        text,
        behavior,
      });
    },
    [sendWs],
  );

  const interruptInstance = useCallback(
    (instanceId: string) => {
      sendWs({
        type: "instance.interrupt",
        projectId: stateRef.current.activeProjectId,
        instanceId,
      });
    },
    [sendWs],
  );

  const respondPermission = useCallback(
    (instanceId: string, requestId: string, response: AgentPermissionResponse) => {
      sendWs({
        type: "permission.respond",
        projectId: stateRef.current.activeProjectId,
        instanceId,
        requestId,
        response,
      });
    },
    [sendWs],
  );

  const saveSystemSettings = useCallback(async (next: SystemSettings) => {
    const res = await postApi<{
      settings: SystemSettings;
      providers: ProviderRuntimeSnapshot[];
    }>("/api/settings", next);
    rawDispatch({
      type: "SETTINGS_UPDATED",
      settings: res.settings,
      providers: res.providers,
    });
  }, []);

  const testBrainConnection = useCallback(async (draftBrain: SystemSettings["brain"]) => {
    return postApi<{ ok: boolean; detail: string }>("/api/brain/test", draftBrain);
  }, []);

  const testProviderConnection = useCallback(async (providerId: string) => {
    const res = await postApi<{
      ok: boolean;
      detail: string;
      settings?: SystemSettings;
      providers: ProviderRuntimeSnapshot[];
    }>(`/api/providers/${encodeURIComponent(providerId)}/test`);
    rawDispatch({
      type: "SETTINGS_UPDATED",
      settings: res.settings ?? stateRef.current.settings,
      providers: res.providers,
    });
    return { ok: res.ok, detail: res.detail };
  }, []);

  const listProviderModels = useCallback(async (providerId: string) => {
    const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}/models`);
    if (!res.ok) {
      return { providerId, models: [] as ProviderModelOption[] };
    }
    return (await res.json()) as {
      providerId: string;
      defaultModel?: string;
      models: ProviderModelOption[];
    };
  }, []);

  const pickDirectory = useCallback(async () => {
    return postApi<{ canceled: boolean; path?: string }>("/api/fs/pick-directory");
  }, []);

  const renameProject = useCallback(async (projectId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await postApi<{ project: Project }>(
      `/api/projects/${encodeURIComponent(projectId)}/rename`,
      { name: trimmed },
    );
    rawDispatch({ type: "PROJECT_UPDATED", project: res.project });
  }, []);

  const deleteProject = useCallback(async (projectId: string) => {
    const res = await postApi<{ projects: Project[]; activeProjectId: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/delete`,
    );
    rawDispatch({
      type: "PROJECTS_LIST",
      projects: res.projects,
      activeProjectId: res.activeProjectId,
    });
  }, []);

  const refreshProviders = useCallback(async () => {
    const res = await fetch("/api/providers/refresh");
    if (res.ok) {
      const data = (await res.json()) as { providers: ProviderRuntimeSnapshot[] };
      rawDispatch({
        type: "SETTINGS_UPDATED",
        settings: stateRef.current.settings,
        providers: data.providers,
      });
    }
  }, []);

  const project = useMemo(
    () => state.projects.find((p) => p.id === state.activeProjectId) ?? state.projects[0],
    [state.projects, state.activeProjectId],
  );

  const enabledProviders = useMemo(
    () => state.providers.filter((p) => p.enabled),
    [state.providers],
  );

  const value = useMemo<CtxValue>(
    () => ({
      state,
      projects: state.projects,
      project,
      ui: state.ui,
      settings: state.settings,
      providers: state.providers,
      enabledProviders,
      dispatch,
      requestTimeline,
      sendInstancePrompt,
      interruptInstance,
      respondPermission,
      saveSystemSettings,
      testBrainConnection,
      testProviderConnection,
      listProviderModels,
      pickDirectory,
      renameProject,
      deleteProject,
      refreshProviders,
    }),
    [
      state,
      project,
      enabledProviders,
      dispatch,
      requestTimeline,
      sendInstancePrompt,
      interruptInstance,
      respondPermission,
      saveSystemSettings,
      testBrainConnection,
      testProviderConnection,
      listProviderModels,
      pickDirectory,
      renameProject,
      deleteProject,
      refreshProviders,
    ],
  );

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

/**
 * 获取当前项目与全局调度能力的 React Hook
 */
export function useProject(): CtxValue {
  const ctx = useContext(StoreCtx);
  if (!ctx) {
    throw new Error("useProject must be used inside StoreProvider");
  }
  return ctx;
}
