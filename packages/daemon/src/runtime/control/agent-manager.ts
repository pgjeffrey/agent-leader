import { randomUUID } from "node:crypto";
import type {
  ActiveTurnBehavior,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentStreamEvent,
  ProjectedTimelineEntry,
  TimelinePage,
} from "@agent-leader/protocol";
import type {
  AgentClient,
  AgentSession,
  AgentSessionConfig,
} from "../contracts/agent-sdk-types.js";
import { AgentStreamCoalescer } from "../return-channels/stream-coalescer.js";
import { TimelineProjection } from "../return-channels/timeline-projection.js";
import { AgentMessageDelivery } from "./message-delivery.js";

/** 默认空闲进程自动回收阈值：1 小时 */
const IDLE_CLEANUP_THRESHOLD_MS = 60 * 60 * 1000;

interface ManagedInstanceEntry {
  instanceId: string;
  projectId: string;
  taskId: string;
  providerId: string;
  config: AgentSessionConfig;
  persistence: AgentPersistenceHandle | null;
  session: AgentSession | null;
  unsubscribeSession: (() => void) | null;
  coalescer: AgentStreamCoalescer;
  projection: TimelineProjection;
  lifecycleState: "initializing" | "idle" | "running" | "error" | "closed" | "isolated";
  activeRunToken: string | null;
  activeTurnId: string | null;
  lastActivityAt: number;
  lifecycleLane: Promise<void>;
}

/**
 * AgentManager 事件订阅回调接口
 */
export interface AgentManagerHooks {
  resolveProviderClient(providerId: string): AgentClient;
  onStreamEvent(params: {
    projectId: string;
    instanceId: string;
    event: AgentStreamEvent;
    projectedEntry?: ProjectedTimelineEntry;
    epoch: number;
  }): void;
  onTurnSettled(params: {
    projectId: string;
    taskId: string;
    instanceId: string;
    outcome: "completed" | "failed" | "canceled";
    lastAssistantMessage: string;
    errorMessage?: string;
  }): void;
  onPermissionRequested(params: {
    projectId: string;
    taskId: string;
    instanceId: string;
    request: AgentPermissionRequest;
  }): void;
  hasPendingFinishSubscription?(instanceId: string): boolean;
  persistProjection?(instanceId: string, projection: TimelineProjection): void;
}

/**
 * 核心实例生命周期与运行时驻留管理器（AgentManager）
 * 对齐 docs/multi_agent_control_and_data_return_plan.md 第 2.3~2.5 节及十条防坑铁律：
 * - 逻辑记录与进程按需驻留（ensureAgentLoaded 热恢复 + 1 小时空闲回收与 canStopRuntime 否决）
 * - Run Token & turnId 隔离，彻底丢弃旧 Turn 或已隔离实例的迟到事件（防坑铁律 #4）
 * - 读取 closed 实例历史直接读内存/持久化投影，绝不无谓拉起子进程（防坑铁律 #10）
 */
export class AgentManager {
  private readonly entries = new Map<string, ManagedInstanceEntry>();
  private readonly delivery: AgentMessageDelivery;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly hooks: AgentManagerHooks) {
    this.delivery = new AgentMessageDelivery({
      isTurnActive: (id) => this.entries.get(id)?.lifecycleState === "running",
      getActiveTurnId: (id) => this.entries.get(id)?.activeTurnId ?? null,
      startTurn: (id, prompt) => this.internalStartTurn(id, prompt),
      steerTurn: (id, prompt, expectedTurnId) => this.internalSteerTurn(id, prompt, expectedTurnId),
      interruptTurn: (id) => this.internalInterruptTurn(id),
    });

    this.idleTimer = setInterval(() => {
      void this.sweepIdleRuntimes();
    }, 60_000);
    this.idleTimer.unref?.();
  }

  /**
   * 注册或预热一个运行实例逻辑记录（此时可按需延迟或立即启动进程）
   */
  registerInstance(params: {
    instanceId: string;
    projectId: string;
    taskId: string;
    providerId: string;
    config: AgentSessionConfig;
    persistence?: AgentPersistenceHandle | null;
    restoredProjection?: TimelineProjection;
  }): void {
    if (this.entries.has(params.instanceId)) return;

    const projection = params.restoredProjection ?? new TimelineProjection(params.instanceId);
    const entry: ManagedInstanceEntry = {
      instanceId: params.instanceId,
      projectId: params.projectId,
      taskId: params.taskId,
      providerId: params.providerId,
      config: params.config,
      persistence: params.persistence ?? null,
      session: null,
      unsubscribeSession: null,
      projection,
      coalescer: new AgentStreamCoalescer((ev) => this.handleCoalescedEvent(entry, ev)),
      lifecycleState: "closed",
      activeRunToken: null,
      activeTurnId: null,
      lastActivityAt: Date.now(),
      lifecycleLane: Promise.resolve(),
    };
    this.entries.set(params.instanceId, entry);
  }

  /**
   * 向指定实例投递提示词（自动按需唤醒已关闭的会话）
   */
  async sendPrompt(
    instanceId: string,
    prompt: string,
    behavior: ActiveTurnBehavior = "queue",
  ): Promise<void> {
    const entry = this.requireEntry(instanceId);
    if (entry.lifecycleState === "isolated") {
      throw new Error(`实例 ${instanceId} 已被强制隔离，禁止继续派发消息`);
    }
    // 记录用户输入到权威时间线
    this.handleCoalescedEvent(entry, {
      type: "timeline",
      provider: entry.providerId,
      timestamp: new Date().toISOString(),
      item: { type: "user_message", text: prompt },
    });
    await this.delivery.enqueue(instanceId, prompt, behavior);
  }

  /**
   * 用户主动停止当前轮次并挂起排队消息
   */
  async stopInstance(instanceId: string): Promise<void> {
    await this.delivery.stopAndHold(instanceId);
  }

  /**
   * 换人时的安全暂停或强制隔离：
   * 1. 先尝试优雅 interrupt()
   * 2. 若超时或报错，立即标记为 isolated 并销毁底层进程与收件箱，杜绝后续双写或迟到回报污染
   */
  async pauseOrIsolateForHandoff(
    instanceId: string,
  ): Promise<{ pausedCleanly: boolean; persistence: AgentPersistenceHandle | null }> {
    const entry = this.entries.get(instanceId);
    if (!entry) {
      return { pausedCleanly: true, persistence: null };
    }

    this.delivery.purge(instanceId, "Handoff initiated");
    let pausedCleanly = true;
    try {
      if (entry.session && entry.lifecycleState === "running") {
        await entry.session.interrupt();
      }
      if (entry.session?.setWriteAccess) {
        await entry.session.setWriteAccess(false);
      }
    } catch {
      pausedCleanly = false;
    }

    // 无论暂停是否成功，换人后原实例一律转为 isolated 封存态并释放底层写进程
    entry.lifecycleState = "isolated";
    entry.activeRunToken = null;
    entry.activeTurnId = null;
    entry.config.writeAccess = false;
    const persistence = entry.session?.describePersistence() ?? entry.persistence;
    entry.persistence = persistence;

    if (entry.unsubscribeSession) {
      entry.unsubscribeSession();
      entry.unsubscribeSession = null;
    }
    if (entry.session) {
      await entry.session.close().catch(() => undefined);
      entry.session = null;
    }

    return { pausedCleanly, persistence };
  }

  /**
   * 响应实例挂起的交互式权限审批
   */
  async respondToPermission(
    instanceId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void> {
    const entry = this.requireEntry(instanceId);
    if (!entry.session) {
      throw new Error(`实例 ${instanceId} 当前没有活跃会话处理审批请求`);
    }
    entry.lastActivityAt = Date.now();
    await entry.session.respondToPermission(requestId, response);
  }

  /**
   * 读取实例权威时间线分页（防坑铁律 #10：绝不为此唤醒已关闭的子进程）
   */
  getTimelinePage(instanceId: string, afterSeq = 0, limit = 200): TimelinePage {
    const entry = this.entries.get(instanceId);
    if (!entry) {
      return { instanceId, epoch: 1, headSeq: 0, entries: [], hasMore: false };
    }
    return entry.projection.getPage(afterSeq, limit);
  }

  /**
   * 读取实例全部投影记录（供 ActivityCurator 浓缩摘要使用，不唤醒子进程）
   */
  getProjectedEntries(instanceId: string): ProjectedTimelineEntry[] {
    return this.entries.get(instanceId)?.projection.getAllEntries() ?? [];
  }

  /**
   * 关闭整个管理器并释放全部活跃子进程
   */
  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        entry.unsubscribeSession?.();
        entry.unsubscribeSession = null;
        if (entry.session) {
          await entry.session.close().catch(() => undefined);
          entry.session = null;
        }
      }),
    );
  }

  private requireEntry(instanceId: string): ManagedInstanceEntry {
    const entry = this.entries.get(instanceId);
    if (!entry) {
      throw new Error(`未知的运行实例: ${instanceId}`);
    }
    return entry;
  }

  /**
   * 在单实例串行生命周期队列中按需创建或恢复底层进程会话（Lazy Resume）
   */
  private async ensureSessionLoaded(entry: ManagedInstanceEntry): Promise<AgentSession> {
    if (entry.lifecycleState === "isolated") {
      throw new Error(`实例 ${entry.instanceId} 已隔离`);
    }
    if (entry.session) {
      return entry.session;
    }

    return this.runInLifecycleLane(entry, async () => {
      if (entry.session) return entry.session;
      entry.lifecycleState = "initializing";
      const client = this.hooks.resolveProviderClient(entry.providerId);
      const session =
        entry.persistence && client.capabilities.supportsSessionPersistence
          ? await client.resumeSession(entry.persistence, entry.config)
          : await client.createSession(entry.config);

      entry.session = session;
      entry.persistence = session.describePersistence() ?? entry.persistence;
      entry.lifecycleState = "idle";
      entry.lastActivityAt = Date.now();

      entry.unsubscribeSession = session.subscribe((rawEvent) => {
        // 已隔离实例的迟到回调一律丢弃
        if (entry.lifecycleState === "isolated") return;
        entry.lastActivityAt = Date.now();
        entry.coalescer.push(rawEvent);
      });

      return session;
    });
  }

  private async internalStartTurn(instanceId: string, prompt: string): Promise<void> {
    const entry = this.requireEntry(instanceId);
    const session = await this.ensureSessionLoaded(entry);
    const runToken = `run_${randomUUID().slice(0, 8)}`;
    entry.activeRunToken = runToken;
    entry.lifecycleState = "running";
    entry.lastActivityAt = Date.now();

    try {
      const { turnId } = await session.startTurn(prompt);
      if (entry.activeRunToken === runToken) {
        entry.activeTurnId = turnId;
      }
      entry.persistence = session.describePersistence() ?? entry.persistence;
    } catch (err) {
      if (entry.activeRunToken === runToken) {
        entry.activeRunToken = null;
        entry.activeTurnId = null;
        entry.lifecycleState = "error";
      }
      throw err;
    }
  }

  private async internalSteerTurn(
    instanceId: string,
    prompt: string,
    expectedTurnId: string,
  ): Promise<boolean> {
    const entry = this.requireEntry(instanceId);
    if (!entry.session?.steerActiveTurn) return false;
    const res = await entry.session.steerActiveTurn(prompt, { expectedTurnId });
    return res.status === "accepted";
  }

  private async internalInterruptTurn(instanceId: string): Promise<void> {
    const entry = this.requireEntry(instanceId);
    if (!entry.session || entry.lifecycleState !== "running") return;
    // 防坑铁律 #3：必须等待底层 interrupt() 确认停止；若抛错则直接向上抛出阻止开启新 Turn
    await entry.session.interrupt();
    entry.coalescer.flush();
    entry.activeRunToken = null;
    entry.activeTurnId = null;
    entry.lifecycleState = "idle";
  }

  private handleCoalescedEvent(entry: ManagedInstanceEntry, event: AgentStreamEvent): void {
    if (entry.lifecycleState === "isolated") return;

    // 防坑铁律 #4：若事件携带旧 turnId 且与当前活跃 turnId 不匹配，忽略终态结算防止误关新 Turn
    if (
      (event.type === "turn_completed" ||
        event.type === "turn_failed" ||
        event.type === "turn_canceled") &&
      event.turnId &&
      entry.activeTurnId &&
      event.turnId !== entry.activeTurnId
    ) {
      return;
    }

    const projected = entry.projection.apply(event);
    this.hooks.persistProjection?.(entry.instanceId, entry.projection);
    const { epoch } = entry.projection.cursor();

    this.hooks.onStreamEvent({
      projectId: entry.projectId,
      instanceId: entry.instanceId,
      event,
      projectedEntry: projected,
      epoch,
    });

    if (event.type === "permission_requested") {
      this.hooks.onPermissionRequested({
        projectId: entry.projectId,
        taskId: entry.taskId,
        instanceId: entry.instanceId,
        request: event.request,
      });
      return;
    }

    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      entry.activeRunToken = null;
      entry.activeTurnId = null;
      entry.lifecycleState = event.type === "turn_failed" ? "error" : "idle";
      entry.persistence = entry.session?.describePersistence() ?? entry.persistence;

      const lastMsg = entry.projection.getLastAssistantMessage();
      this.hooks.onTurnSettled({
        projectId: entry.projectId,
        taskId: entry.taskId,
        instanceId: entry.instanceId,
        outcome:
          event.type === "turn_completed"
            ? "completed"
            : event.type === "turn_failed"
              ? "failed"
              : "canceled",
        lastAssistantMessage: lastMsg,
        errorMessage: event.type === "turn_failed" ? event.error : undefined,
      });

      this.delivery.onTurnSettled(entry.instanceId);
    }
  }

  /**
   * 空闲运行时自动回收扫描（带安全否决检查）
   */
  private async sweepIdleRuntimes(): Promise<void> {
    const now = Date.now();
    for (const entry of this.entries.values()) {
      if (!entry.session) continue;
      if (entry.lifecycleState === "running" || entry.lifecycleState === "initializing") continue;
      if (now - entry.lastActivityAt < IDLE_CLEANUP_THRESHOLD_MS) continue;
      if (entry.session.getPendingPermissions().length > 0) continue;
      if (this.delivery.hasPendingMessages(entry.instanceId)) continue;
      if (this.hooks.hasPendingFinishSubscription?.(entry.instanceId)) continue;

      if (entry.session.canStopRuntime) {
        const canStop = await entry.session.canStopRuntime().catch(() => false);
        if (!canStop) continue;
      }

      await this.runInLifecycleLane(entry, async () => {
        if (!entry.session || entry.lifecycleState === "running") return;
        entry.persistence = entry.session.describePersistence() ?? entry.persistence;
        entry.unsubscribeSession?.();
        entry.unsubscribeSession = null;
        await entry.session.close().catch(() => undefined);
        entry.session = null;
        entry.lifecycleState = "closed";
      });
    }
  }

  private runInLifecycleLane<T>(entry: ManagedInstanceEntry, fn: () => Promise<T>): Promise<T> {
    const next = entry.lifecycleLane.then(fn, fn);
    entry.lifecycleLane = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
