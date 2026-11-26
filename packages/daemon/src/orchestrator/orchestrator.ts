import { randomUUID } from "node:crypto";
import {
  executorName,
  normalizeProviderId,
  taskExecutor,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentStreamEvent,
  type BrainEvaluationDecision,
  type Fact,
  type HandoffPackage,
  type Instance,
  type PlannedTaskSpec,
  type ProjectedTimelineEntry,
  type Project,
  type ProjectExecutionMode,
  type Role,
  type StructuredReport,
  type Task,
} from "@agent-leader/protocol";
import { EvidenceCollector } from "../acceptance/evidence-collector.js";
import { deriveProjectName, LeaderBrain } from "../brain/leader-brain.js";
import { redactSecrets } from "../facts/secret-redactor.js";
import { AgentManager } from "../runtime/control/agent-manager.js";
import { ProviderRegistry } from "../runtime/providers/provider-registry.js";
import { curateAgentActivity } from "../runtime/return-channels/activity-curator.js";
import { FinishSubscriptions } from "../runtime/return-channels/finish-subscriptions.js";
import { LocalDatabase } from "../storage/database.js";
import {
  ensureDefaultDocumentsProjectDir,
  WorktreeManager,
} from "../workspace/worktree-manager.js";

/** 动态二次拆分最大允许深度（防无限递归拆任务护栏） */
const MAX_SPLIT_DEPTH = 3;

function uid(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 6)}`;
}

/**
 * 广播钩子：由 HTTP/WebSocket 服务层注入，将实时状态变化推送给所有连接的客户端
 */
export interface OrchestratorBroadcastHooks {
  onProjectUpdated(project: Project): void;
  onAgentStream(params: {
    projectId: string;
    instanceId: string;
    event: AgentStreamEvent;
    projectedEntry?: ProjectedTimelineEntry;
    epoch: number;
  }): void;
  onBrainStatus(params: {
    projectId: string;
    phase: "idle" | "planning" | "evaluating" | "chatting";
    detail?: string;
  }): void;
}

/**
 * 核心自治调度引擎（Orchestrator）
 * 串联：Leader Brain 拆解 -> DAG 依赖门控 -> Git Worktree 隔离 -> Provider Runtime 实时流式执行 ->
 *      FinishSubscriptions 异步唤醒 -> 客观证据采集 -> Leader Brain 综合评判（通过/返工/动态再拆分/换人/阻塞）
 */
export class Orchestrator {
  readonly agentManager: AgentManager;
  private readonly finishSubscriptions: FinishSubscriptions;
  private readonly evidenceCollector = new EvidenceCollector();
  /** 内存追踪每个实例归属的项目模式，供 ProviderRegistry 判断是否走 mock */
  private readonly instanceModeMap = new Map<string, ProjectExecutionMode>();

  constructor(
    private readonly db: LocalDatabase,
    private readonly registry: ProviderRegistry,
    private readonly brain: LeaderBrain,
    private readonly worktrees: WorktreeManager,
    private readonly broadcast: OrchestratorBroadcastHooks,
  ) {
    this.finishSubscriptions = new FinishSubscriptions(this.db, {
      onPermissionCheckpoint: async ({ subscription, request }) => {
        this.recordPermissionInbox(
          subscription.projectId,
          subscription.taskId,
          subscription.instanceId,
          request,
        );
      },
      onInstanceSettled: async ({
        subscription,
        outcome,
        lastAssistantMessage,
        errorMessage,
      }) => {
        await this.evaluateAndAdvanceAfterTurn({
          projectId: subscription.projectId,
          taskId: subscription.taskId,
          instanceId: subscription.instanceId,
          outcome,
          lastAssistantMessage,
          errorMessage,
        });
      },
    });

    this.agentManager = new AgentManager({
      resolveProviderClient: (providerId) => {
        return this.registry.resolveClient(providerId, false);
      },
      onStreamEvent: (payload) => {
        this.broadcast.onAgentStream(payload);
      },
      onPermissionRequested: ({ projectId, taskId, instanceId, request }) => {
        void this.finishSubscriptions.notifyPermissionCheckpoint(instanceId, request);
        this.recordPermissionInbox(projectId, taskId, instanceId, request);
      },
      onTurnSettled: ({
        projectId,
        instanceId,
        outcome,
        lastAssistantMessage,
        errorMessage,
      }) => {
        void this.finishSubscriptions.settleInstance({
          instanceId,
          outcome:
            outcome === "completed"
              ? "finished"
              : outcome === "failed"
                ? "errored"
                : "canceled",
          lastAssistantMessage,
          errorMessage,
        });
        // 同步刷新实例进度快照
        const proj = this.db.getProject(projectId);
        if (proj) {
          this.broadcast.onProjectUpdated(proj);
        }
      },
      hasPendingFinishSubscription: (instanceId) =>
        this.finishSubscriptions.hasPendingForInstance(instanceId),
      persistProjection: (instanceId, projection) => {
        this.db.saveProjection(instanceId, projection);
      },
    });

    // 启动时恢复已有实例的时间线投影记录（不拉起子进程，防坑铁律 #10）
    this.restoreExistingProjectInstances();
  }

  private restoreExistingProjectInstances(): void {
    for (const proj of this.db.listProjects()) {
      for (const inst of proj.instances) {
        const restored = this.db.loadProjection(inst.id);
        const useMock = proj.executionMode === "mock" || proj.isExample;
        const providerId = useMock ? "mock" : normalizeProviderId(inst.executorId);
        this.instanceModeMap.set(inst.id, useMock ? "mock" : "real");
        this.agentManager.registerInstance({
          instanceId: inst.id,
          projectId: proj.id,
          taskId: inst.taskId,
          providerId,
          config: {
            instanceId: inst.id,
            cwd: inst.worktreePath || proj.repoPath || process.cwd(),
            writeAccess: inst.writeAccess,
          },
          persistence: inst.persistence ?? null,
          restoredProjection: restored,
        });
      }
    }
  }

  /**
   * 新建项目：调用指挥官自动命名并按软件工程五阶段拆分子任务；未指定项目目录时默认在系统「文档」目录下创建工作目录
   */
  async createProject(params: {
    name?: string;
    background: string;
    goal: string;
    repoPath?: string;
    executionMode?: ProjectExecutionMode;
    useWorktreeIsolation?: boolean;
    autoStart?: boolean;
  }): Promise<Project> {
    const projectId = uid("p");
    this.broadcast.onBrainStatus({
      projectId,
      phase: "planning",
      detail: "指挥官正在提炼项目名称并按软件开发五阶段拆解子任务…",
    });

    try {
      const settings = this.db.getRawSettings();
      const snapshots = await this.registry.getSnapshots();
      const hasCodex = snapshots.find((s) => s.id === "codex")?.installed;
      const hasClaude = snapshots.find((s) => s.id === "claude")?.installed;
      const hasAgy = snapshots.find((s) => s.id === "antigravity")?.installed;

      const globalPlan = settings.defaultRoles.find((r) => r.id === "plan")?.executorId;
      const globalImpl = settings.defaultRoles.find((r) => r.id === "impl")?.executorId;
      const globalTest = settings.defaultRoles.find((r) => r.id === "test")?.executorId;

      const mode: ProjectExecutionMode = params.executionMode ?? "real";
      const planExec =
        mode === "mock"
          ? "mock"
          : (globalPlan ?? (hasAgy ? "antigravity" : hasClaude ? "claude" : "codex"));
      const implExec = mode === "mock" ? "mock" : (globalImpl ?? (hasCodex ? "codex" : "mock"));
      const testExec =
        mode === "mock"
          ? "mock"
          : (globalTest ?? (hasClaude ? "claude" : hasCodex ? "codex" : "mock"));

      const trimmedInputName = params.name?.trim() || "";
      const plan = await this.brain.planProject({
        name: trimmedInputName || undefined,
        background: params.background.trim(),
        goal: params.goal.trim(),
        repoPath: params.repoPath?.trim(),
        preferredExecutors: { plan: planExec, impl: implExec, test: testExec },
      });

      const resolvedName =
        trimmedInputName ||
        plan.projectName?.trim() ||
        deriveProjectName(params.background, params.goal);

      // 未选择项目目录时，跨平台统一默认在系统「文档（Documents）」目录下创建项目工作目录（mock 演练不污染用户文档目录）
      const resolvedRepoPath =
        params.repoPath?.trim() ||
        (mode === "mock" ? undefined : ensureDefaultDocumentsProjectDir(resolvedName, projectId));

      // 新建项目严格继承全局设置中的角色分工与绑定（mock 模式除外）
      const resolvedRoles: Role[] =
        mode === "mock"
          ? plan.roles
          : settings.defaultRoles.length > 0
            ? settings.defaultRoles.map((r) => ({ ...r }))
            : plan.roles;

      const idMap = new Map<string, string>();
      plan.tasks.forEach((t, i) => {
        idMap.set(t.tempId, `${projectId}-t${i + 1}`);
      });

      const tasks: Task[] = plan.tasks.map((spec) => ({
        id: idMap.get(spec.tempId)!,
        name: spec.name,
        stageId: spec.stageId,
        roleId: spec.roleId,
        status: "pending",
        doing: spec.doing,
        instruction: spec.instruction,
        artifact: spec.artifact,
        deps: spec.deps.map((d) => idMap.get(d) ?? d).filter((d) => d !== idMap.get(spec.tempId)),
        acceptance: spec.acceptance,
        verificationCommands: spec.verificationCommands ?? [],
        targetPaths: spec.targetPaths ?? [],
        reworkCount: 0,
        splitDepth: 0,
      }));

      let project: Project = refreshStages({
        id: projectId,
        name: resolvedName,
        isExample: false,
        repoPath: resolvedRepoPath,
        executionMode: mode,
        useWorktreeIsolation: params.useWorktreeIsolation ?? false,
        background: params.background.trim(),
        goal: params.goal.trim(),
        activeWriters: {},
        currentStageId: "req",
        stages: [
          { id: "req", name: "需求分析", statusLabel: "未开始", kind: "idle" },
          { id: "design", name: "方案设计", statusLabel: "未开始", kind: "idle" },
          { id: "dev", name: "开发实现", statusLabel: "未开始", kind: "idle" },
          { id: "test", name: "测试验收", statusLabel: "未开始", kind: "idle" },
          { id: "release", name: "发布交付", statusLabel: "未开始", kind: "idle" },
        ],
        roles: resolvedRoles,
        tasks,
        instances: [],
        facts: [],
        handoffs: [],
        inbox: [],
        justCreated: true,
        messages: [
          {
            id: uid("m"),
            speaker: "leader",
            text: plan.leaderSummary,
            at: nowTimeLabel(),
          },
        ],
      });

      this.db.insertProjectAtTop(project);
      this.broadcast.onProjectUpdated(project);

      if (params.autoStart !== false && this.db.getRawSettings().brain.autoDispatch) {
        project = await this.dispatchReadyTasks(project.id);
      }

      return project;
    } finally {
      this.broadcast.onBrainStatus({ projectId, phase: "idle" });
    }
  }

  /**
   * 扫描并派发项目内所有前置依赖已满足（deps 全部 accepted）的就绪任务
   */
  async dispatchReadyTasks(projectId: string, specificTaskId?: string): Promise<Project> {
    let project = this.requireProject(projectId);
    const settings = this.db.getRawSettings();
    const maxConcurrency = Math.max(1, settings.brain.maxConcurrency || 4);

    // 若是示例项目首次点击推进，解冻其预置运行态任务或为其补齐真实模拟运行流
    if (project.isExample && !specificTaskId) {
      const frozenRunning = project.instances.filter((i) => i.status === "running" && i.frozen);
      if (frozenRunning.length > 0) {
        for (const inst of frozenRunning) {
          inst.frozen = false;
          this.agentManager.registerInstance({
            instanceId: inst.id,
            projectId: project.id,
            taskId: inst.taskId,
            providerId: "mock",
            config: {
              instanceId: inst.id,
              cwd: project.repoPath || process.cwd(),
              writeAccess: inst.writeAccess,
            },
          });
          const task = project.tasks.find((t) => t.id === inst.taskId);
          if (task) {
            this.finishSubscriptions.registerBeforeDispatch({
              projectId: project.id,
              taskId: task.id,
              instanceId: inst.id,
              title: task.name,
            });
            const prompt = this.brain.assembleDispatchPrompt(project, task);
            void this.agentManager.sendPrompt(inst.id, prompt, "queue");
          }
        }
        project = appendLeaderMessage(
          project,
          `已唤醒 ${frozenRunning.length} 个执行中实例继续推进，结果回报后我将逐项核验客观证据。`,
        );
        this.saveAndBroadcast(project);
      }
    }

    const runningTasks = project.tasks.filter((t) => t.status === "running");
    let availableSlots = Math.max(0, maxConcurrency - runningTasks.length);
    if (specificTaskId) {
      availableSlots = Math.max(1, availableSlots);
    }

    const candidates = project.tasks.filter((t) => {
      if (specificTaskId) return t.id === specificTaskId;
      return t.status === "pending" && depsSatisfied(t, project.tasks);
    });

    const dispatchedLabels: string[] = [];

    for (const task of candidates) {
      if (availableSlots <= 0) break;
      if (!depsSatisfied(task, project.tasks)) continue;

      // 并行目标文件冲突预检（PRD FR-14）
      const activeTasksNow = project.tasks.filter((t) => t.status === "running");
      const conflicts = this.worktrees.detectTargetConflicts(task, activeTasksNow);
      if (conflicts.length > 0 && !specificTaskId) {
        task.doing = `暂缓并行派工（避免冲突：${conflicts[0]}）`;
        continue;
      }

      const rawExecId = this.enforceHardConstraints(
        project,
        task.roleId,
        taskExecutor(task, project.roles),
      );
      const useMock = project.executionMode === "mock" || rawExecId === "mock";
      const runtimeProviderId = useMock ? "mock" : normalizeProviderId(rawExecId);

      // 准备隔离工作区（并行开发阶段任务优先分配独立 Git Worktree）
      const shouldIsolate =
        Boolean(project.useWorktreeIsolation) &&
        !useMock &&
        (task.stageId === "dev" || activeTasksNow.length > 0);
      const ws = await this.worktrees.prepareTaskWorkspace({
        projectId: project.id,
        taskId: task.id,
        repoPath: project.repoPath,
        isolateWorktree: shouldIsolate,
      });

      const instId = nextInstanceId(project);
      const activeWriters = { ...(project.activeWriters ?? {}), [task.id]: instId };
      const instance: Instance = {
        id: instId,
        taskId: task.id,
        roleId: task.roleId,
        executorId: rawExecId,
        status: "running",
        writeAccess: true,
        progress: 15,
        sessionMode: "new",
        worktreePath: ws.cwd,
        branchName: ws.branchName,
        label: `${project.roles.find((r) => r.id === task.roleId)?.name ?? "执行"} · ${executorName(rawExecId)}`,
        note: ws.isWorktree
          ? `独立 Git Worktree (${ws.branchName}) · 仅注入局部现行事实`
          : `工作目录 ${ws.cwd} · 仅注入局部现行事实`,
        startedAt: new Date().toISOString(),
      };

      task.status = "running";
      task.worktreePath = ws.cwd;
      task.branchName = ws.branchName;
      task.doing = `已派给 ${executorName(rawExecId)}（${instId}），正在执行并实时回传过程流…`;

      project = {
        ...project,
        activeWriters,
        tasks: project.tasks.map((t) => (t.id === task.id ? { ...task } : t)),
        instances: [...project.instances, instance],
      };

      // 1. 注册实例运行时
      this.agentManager.registerInstance({
        instanceId: instId,
        projectId: project.id,
        taskId: task.id,
        providerId: runtimeProviderId,
        config: {
          instanceId: instId,
          cwd: ws.cwd,
          writeAccess: true,
        },
      });

      // 2. 防坑铁律 #1：向子智能体派发 Prompt 之前，必须先持久化落盘完成订阅！
      this.finishSubscriptions.registerBeforeDispatch({
        projectId: project.id,
        taskId: task.id,
        instanceId: instId,
        title: task.name,
      });

      const prompt = this.brain.assembleDispatchPrompt(project, task);
      dispatchedLabels.push(`「${task.name}」→ ${executorName(rawExecId)}（${instId}）`);
      availableSlots -= 1;

      void this.agentManager.sendPrompt(instId, prompt, "queue").catch((err: unknown) => {
        this.handleDispatchFailure(
          project.id,
          task.id,
          instId,
          err instanceof Error ? err.message : String(err),
        );
      });
    }

    if (dispatchedLabels.length > 0) {
      project = appendLeaderMessage(
        refreshStages(project),
        `前置依赖核验通过，已派发执行：${dispatchedLabels.join("；")}。点击任务或「实例」可实时查看输出与工具调用轨迹。`,
      );
      this.saveAndBroadcast(project);
    } else {
      project = refreshStages(project);
      this.saveAndBroadcast(project);
    }

    return project;
  }

  /**
   * 当执行器一轮运行结算后：采集客观工程证据 -> 送交指挥大模型裁决 -> 自动执行通过/返工/动态拆解/阻塞
   */
  private async evaluateAndAdvanceAfterTurn(params: {
    projectId: string;
    taskId: string;
    instanceId: string;
    outcome: "finished" | "errored" | "canceled";
    lastAssistantMessage: string;
    errorMessage?: string;
  }): Promise<void> {
    let project = this.db.getProject(params.projectId);
    if (!project) return;

    const inst = project.instances.find((i) => i.id === params.instanceId);
    const task = project.tasks.find((t) => t.id === params.taskId);
    if (!inst || !task) return;

    // 防双写与隔离校验：若该实例已非当前任务的合法写锁持有者（例如已被换人隔离），直接丢弃其旧回报（PRD FR-13）
    if (
      inst.status === "isolated" ||
      (project.activeWriters?.[task.id] && project.activeWriters[task.id] !== inst.id)
    ) {
      return;
    }

    if (params.outcome === "canceled") {
      inst.status = "paused";
      inst.note = "已手动暂停当前轮次。";
      this.saveAndBroadcast(refreshStages(project));
      return;
    }

    if (params.outcome === "errored") {
      const settings = this.db.getRawSettings();
      const reworkCount = (task.reworkCount ?? 0) + 1;
      task.reworkCount = reworkCount;
      inst.status = "failed";
      inst.note = params.errorMessage ?? "执行器进程运行异常";

      if (reworkCount > settings.brain.maxReworkCount) {
        task.status = "blocked";
        task.doing = `连续失败达上限（${reworkCount} 次）：${inst.note}`;
        project.inbox.push({
          id: uid("in"),
          kind: "intervene",
          title: `人工阻塞：${task.name}`,
          body: `${executorName(inst.executorId)} 执行报错：${inst.note}。建议检查本地 CLI 登录状态或换其他执行器接手。`,
          taskId: task.id,
          instanceId: inst.id,
        });
      } else {
        task.status = "rework";
        task.doing = `执行异常：${inst.note}`;
      }

      project = appendLeaderMessage(
        refreshStages(project),
        `「${task.name}」执行器（${executorName(inst.executorId)}）返回错误：${inst.note}。未达验收条件，已拦截下游任务。你可以修复环境后继续或一键换人接手。`,
      );
      this.saveAndBroadcast(project);
      return;
    }

    // 正常跑完一轮：先采集不可伪造的客观证据，再由指挥大模型做综合评判
    this.broadcast.onBrainStatus({
      projectId: project.id,
      phase: "evaluating",
      detail: `指挥大模型正在核验「${task.name}」的产物版本、Git Diff 与回复内容…`,
    });

    try {
      const cwd = inst.worktreePath || task.worktreePath || project.repoPath || process.cwd();
      const evidence = await this.evidenceCollector.collect(task, cwd);
      const curated = curateAgentActivity(this.agentManager.getProjectedEntries(inst.id), 30);

      const decision = await this.brain.evaluateTurn({
        project,
        task,
        executorReply: params.lastAssistantMessage,
        curatedActivity: curated,
        evidence,
      });

      const structuredReport: StructuredReport = {
        done: redactSecrets(params.lastAssistantMessage.slice(0, 600)),
        artifacts: evidence.artifacts,
        verification: evidence.verificationSummary,
        evidence: redactSecrets(evidence.evidenceSummary),
        opinion: `${executorName(inst.executorId)} 自述已完成本轮指令（仅供参考，不替代客观证据）。`,
        basis: "依据下发的已确认项目事实与预设验收标准。",
        leftovers: decision.action === "ACCEPT" ? "无阻塞遗留项。" : decision.reason,
        leaderDecisionNote:
          decision.action === "ACCEPT" ? decision.summary : decision.reason,
      };

      // 重新读取最新 project 引用防止并发覆盖
      project = this.requireProject(params.projectId);
      await this.applyBrainDecision(project, task.id, inst.id, structuredReport, decision);
    } finally {
      this.broadcast.onBrainStatus({ projectId: params.projectId, phase: "idle" });
    }
  }

  /**
   * 应用指挥大模型的五选一裁决结果
   */
  private async applyBrainDecision(
    project: Project,
    taskId: string,
    instanceId: string,
    report: StructuredReport,
    decision: BrainEvaluationDecision,
  ): Promise<void> {
    const settings = this.db.getRawSettings();
    const task = project.tasks.find((t) => t.id === taskId);
    const inst = project.instances.find((i) => i.id === instanceId);
    if (!task || !inst) return;

    inst.report = report;

    if (decision.action === "ACCEPT") {
      const version = report.artifacts[0]?.version ?? "verified";
      task.status = "accepted";
      task.artifactVersion = version;
      task.doing = decision.summary;
      inst.status = "accepted";
      inst.progress = 100;
      inst.writeAccess = false;

      const newFacts: Fact[] = (
        decision.confirmedFacts.length > 0
          ? decision.confirmedFacts
          : [{ content: `「${task.name}」已通过客观验收，产物 ${task.artifact}。`, version }]
      ).map((f) => ({
        id: uid("f"),
        content: redactSecrets(f.content),
        version: f.version || version,
        source: `${task.name} · ${inst.id} 客观验收`,
        status: "confirmed",
      }));

      project.facts = [...project.facts, ...newFacts];
      project = appendLeaderMessage(
        refreshStages(project),
        `验收通过：「${task.name}」（${executorName(inst.executorId)} · ${inst.id}）。${decision.summary}\n已写入现行项目事实，正在检查并推进后续依赖任务。`,
      );
      this.saveAndBroadcast(project);

      if (settings.brain.autoDispatch) {
        await this.dispatchReadyTasks(project.id);
      }
      return;
    }

    if (decision.action === "REWORK") {
      const nextCount = (task.reworkCount ?? 0) + 1;
      task.reworkCount = nextCount;

      if (decision.lessonToRecord) {
        project.facts.push({
          id: uid("f"),
          content: redactSecrets(decision.lessonToRecord),
          version: "—",
          source: `${task.name} · ${inst.id} 失败教训`,
          status: "lesson",
        });
      }

      if (nextCount > settings.brain.maxReworkCount) {
        task.status = "blocked";
        task.doing = `自动返工已达阈值（${settings.brain.maxReworkCount} 次）：${decision.reason}`;
        inst.status = "reported";
        inst.writeAccess = false;
        project.inbox.push({
          id: uid("in"),
          kind: "intervene",
          title: `返工超限待裁决：${task.name}`,
          body: `${decision.reason}。你可以人工介入调整要求，或点击「换人接手」切换其他智能体。`,
          taskId: task.id,
          instanceId: inst.id,
        });
        project = appendLeaderMessage(
          refreshStages(project),
          `「${task.name}」连续返工已达上限（${settings.brain.maxReworkCount} 次），原因：${decision.reason}。已暂停自动重试并转入待办请示。`,
        );
        this.saveAndBroadcast(project);
        return;
      }

      // 自动下发返工指令给同一实例继续修正
      task.status = "running";
      task.doing = `返工第 ${nextCount} 轮：${decision.reason}`;
      inst.status = "running";
      inst.progress = 45;
      inst.note = `指挥打回返工：${decision.reason}`;

      project = appendLeaderMessage(
        refreshStages(project),
        `「${task.name}」未通过验收（${decision.reason}），已向 ${executorName(inst.executorId)}（${inst.id}）下发第 ${nextCount} 轮返工指令。`,
      );
      this.saveAndBroadcast(project);

      this.finishSubscriptions.registerBeforeDispatch({
        projectId: project.id,
        taskId: task.id,
        instanceId: inst.id,
        title: task.name,
      });
      const reworkPrompt = this.brain.assembleDispatchPrompt(
        project,
        task,
        `上一轮未通过客观验收，原因：${decision.reason}\n请按以下要求立即修复：${decision.reworkInstruction}`,
      );
      void this.agentManager.sendPrompt(inst.id, reworkPrompt, "queue");
      return;
    }

    if (decision.action === "SPLIT_TASKS") {
      const nextDepth = (task.splitDepth ?? 0) + 1;
      if (nextDepth > MAX_SPLIT_DEPTH) {
        task.status = "reported";
        inst.status = "reported";
        inst.writeAccess = false;
        project.inbox.push({
          id: uid("in"),
          kind: "accept",
          title: `动态拆分达深度上限，请人工验收：${task.name}`,
          body: decision.reason,
          taskId: task.id,
        });
        this.saveAndBroadcast(refreshStages(project));
        return;
      }

      if (decision.currentTaskDisposition === "accept-and-extend") {
        const ver = report.artifacts[0]?.version ?? "verified";
        task.status = "accepted";
        task.artifactVersion = ver;
        task.doing = `已完成本阶段并派生 ${decision.newTasks.length} 项细化子任务`;
        inst.status = "accepted";
        inst.progress = 100;
        inst.writeAccess = false;
      } else {
        task.status = "reported";
        inst.status = "reported";
        inst.writeAccess = false;
      }

      project = this.mergeDynamicSubtasks(
        project,
        task,
        decision.newTasks,
        decision.rewireDownstreamDeps ?? [],
        nextDepth,
      );

      project = appendLeaderMessage(
        refreshStages(project),
        `根据「${task.name}」的执行结果，指挥大模型动态拆分新增了 ${decision.newTasks.length} 项子任务（原因：${decision.reason}），全局进度已同步重算。`,
      );
      this.saveAndBroadcast(project);

      if (settings.brain.autoDispatch) {
        await this.dispatchReadyTasks(project.id);
      }
      return;
    }

    if (decision.action === "SUGGEST_SWITCH") {
      task.status = "rework";
      task.doing = `建议换人接手：${decision.reason}`;
      inst.status = "failed";
      inst.writeAccess = false;
      project.inbox.push({
        id: uid("in"),
        kind: "suggest-switch",
        title: `建议换执行器接手：${task.name}`,
        body: `${decision.reason}${decision.recommendedExecutorId ? `（建议切换至 ${executorName(decision.recommendedExecutorId)}）` : ""}`,
        taskId: task.id,
      });
      project = appendLeaderMessage(
        refreshStages(project),
        `「${task.name}」当前执行受阻（${decision.reason}），建议切换执行器接手。你可以在任务详情或待办中一键发起标准交接包换人。`,
      );
      this.saveAndBroadcast(project);
      return;
    }

    // BLOCK_FOR_HUMAN
    task.status = "reported";
    task.doing = `待人工确认：${decision.reason}`;
    inst.status = "reported";
    inst.progress = 100;
    inst.writeAccess = false;
    project.inbox.push({
      id: uid("in"),
      kind: "accept",
      title: `需人工裁决验收：${task.name}`,
      body: `${decision.questionForUser}（原因：${decision.reason}）`,
      taskId: task.id,
      options: decision.options,
    });
    project = appendLeaderMessage(
      refreshStages(project),
      `「${task.name}」已回报，但需要你介入裁决：${decision.questionForUser}`,
    );
    this.saveAndBroadcast(project);
  }

  /**
   * 安全织入动态二次拆分的子任务（带拓扑无环校验 Cycle Detection 护栏）
   */
  private mergeDynamicSubtasks(
    project: Project,
    parentTask: Task,
    specs: readonly PlannedTaskSpec[],
    rewires: ReadonlyArray<{ taskId: string; addDepTempIds: string[] }>,
    splitDepth: number,
  ): Project {
    const tempMap = new Map<string, string>();
    specs.forEach((s, idx) => {
      tempMap.set(s.tempId, `${parentTask.id}-sub${idx + 1}-${randomUUID().slice(0, 3)}`);
    });

    const addedTasks: Task[] = specs.map((s) => {
      const mappedDeps = s.deps.map((d) => tempMap.get(d) ?? d);
      if (parentTask.status === "accepted" && !mappedDeps.includes(parentTask.id)) {
        mappedDeps.unshift(parentTask.id);
      }
      return {
        id: tempMap.get(s.tempId)!,
        name: s.name,
        stageId: s.stageId,
        roleId: project.roles.some((r) => r.id === s.roleId) ? s.roleId : parentTask.roleId,
        status: "pending",
        doing: s.doing,
        instruction: s.instruction,
        artifact: s.artifact,
        deps: [...new Set(mappedDeps)],
        acceptance: s.acceptance,
        verificationCommands: s.verificationCommands ?? [],
        targetPaths: s.targetPaths ?? [],
        reworkCount: 0,
        splitDepth,
      };
    });

    // 原先依赖 parentTask 的未开始下游任务自动追加对新叶子子任务的依赖
    const newIds = addedTasks.map((t) => t.id);
    const candidateTasks = project.tasks.map((existing) => {
      if (existing.status !== "pending") return existing;
      const explicitRewire = rewires.find((rw) => rw.taskId === existing.id);
      if (explicitRewire) {
        const extra = explicitRewire.addDepTempIds.map((tid) => tempMap.get(tid) ?? tid);
        return { ...existing, deps: [...new Set([...existing.deps, ...extra])] };
      }
      if (parentTask.status === "accepted" && existing.deps.includes(parentTask.id)) {
        return { ...existing, deps: [...new Set([...existing.deps, ...newIds])] };
      }
      return existing;
    });

    const combined = [...candidateTasks, ...addedTasks];
    if (hasDagCycle(combined)) {
      // 若产生环路则回退下游重定向，仅单向挂在 parentTask 之后保证绝对无环
      return { ...project, tasks: [...project.tasks, ...addedTasks] };
    }
    return { ...project, tasks: combined };
  }

  /**
   * 发起安全换人（PRD FR-12 / FR-13）：
   * 立即收回写令牌 -> 暂停/隔离旧实例进程 -> 保存 Git 检查点 -> 生成脱敏的 10 字段标准交接包
   */
  async initiateHandoff(
    projectId: string,
    taskId: string,
    toExecutorId?: string,
  ): Promise<{ project: Project; handoffId: string }> {
    let project = this.requireProject(projectId);
    const task = project.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("未找到对应任务");

    const existing = project.handoffs.find((h) => h.taskId === taskId && !h.confirmed);
    if (existing) {
      if (toExecutorId && toExecutorId !== existing.toExecutorId) {
        existing.toExecutorId = toExecutorId;
        this.saveAndBroadcast(project);
      }
      return { project, handoffId: existing.id };
    }

    const from =
      project.instances.find(
        (i) =>
          i.taskId === taskId &&
          (i.status === "running" || i.status === "failed" || i.status === "reported"),
      ) ?? project.instances.filter((i) => i.taskId === taskId).at(-1);

    if (!from) {
      throw new Error("该任务尚无运行实例，可直接修改任务绑定后派工");
    }

    // 1. 立即清空该任务写令牌（先关闸防双写）
    const activeWriters = { ...(project.activeWriters ?? {}) };
    delete activeWriters[taskId];
    project.activeWriters = activeWriters;

    // 2. 取消完成监听并暂停/强制隔离原实例
    this.finishSubscriptions.cancelForInstance(from.id);
    const { pausedCleanly } = await this.agentManager.pauseOrIsolateForHandoff(from.id);

    // 3. 采集工作区检查点快照
    const cwd = from.worktreePath || task.worktreePath || project.repoPath || process.cwd();
    const checkpoint = await this.worktrees.captureCheckpoint(cwd);

    const fallbackCandidates = ["codex", "claude", "antigravity", "gemini", "cursor", "mock"];
    const targetExec =
      toExecutorId ?? fallbackCandidates.find((c) => c !== from.executorId) ?? "codex";

    const confirmedFacts = project.facts.filter((f) => f.status === "confirmed");
    const lessons = project.facts.filter((f) => f.status === "lesson" || f.status === "deprecated");
    const curatedTrace = curateAgentActivity(this.agentManager.getProjectedEntries(from.id), 15);

    const hid = `H-${String(project.handoffs.length + 7).padStart(2, "0")}`;
    const pack: HandoffPackage = {
      id: hid,
      taskId,
      fromInstanceId: from.id,
      toExecutorId: targetExec,
      reason:
        task.status === "rework"
          ? "原执行器返工质量不达标，切换执行器接力"
          : "用户主动要求换另一执行智能体接手",
      goal: redactSecrets(`继续完成「${task.name}」并满足总目标：${project.goal}`),
      constraints: redactSecrets(
        `必须严格遵循现行已确认事实，不得混入未验证猜测；本交接包已脱敏不含任何密钥明文。验收标准：${task.acceptance.join("；")}`,
      ),
      completed: redactSecrets(
        from.report?.done ||
          (curatedTrace
            ? `原实例 ${from.id}（${executorName(from.executorId)}）已执行轨迹摘要：\n${curatedTrace}`
            : `原实例 ${from.id} 已暂停封存，工作区检查点 ${checkpoint.checkpointRef}。`),
      ),
      decisions: confirmedFacts.length
        ? confirmedFacts.map((f) => `[${f.version}] ${f.content}（来源：${f.source}）`).join("\n")
        : "暂无额外已确认架构变更，以项目初始目标与任务验收条件为准。",
      artifacts: `工作区检查点 ${checkpoint.checkpointRef}（${checkpoint.statusSummary}）；目标产物：${task.artifact}`,
      acceptance: `任务尚未通过最终客观验收。接收方完成后须提供测试/命令运行结果或可核对文件版本。`,
      leftovers: redactSecrets(from.report?.leftovers || task.doing),
      failures: redactSecrets(
        from.report?.failures ||
          lessons.map((l) => l.content).join("；") ||
          "暂无已记录失败路径。",
      ),
      nextSteps: `建议先核对工作区检查点 ${checkpoint.checkpointRef} 的现有改动，再继续补齐剩余功能与验证（仅供参考，非既定事实）。`,
      hostGap:
        "接手实例将以全新会话启动并导入本标准交接包，不会导入原提供方的私有会话记忆或隐藏思考链。",
      confirmItems: [
        "已完整阅读本交接包 10 项上下文与避坑警示",
        `已核对工作区检查点 ${checkpoint.checkpointRef}，知悉原实例 ${from.id} 写权限已撤销`,
        "知悉本会话为新会话导入交接包，不继承原执行器未导出私有上下文",
        "确认后方可获得工作区写权限并开始修改文件",
      ],
      checkpointRef: checkpoint.checkpointRef,
      confirmed: false,
      created: true,
    };

    project.instances = project.instances.map((i) =>
      i.id === from.id
        ? {
            ...i,
            status: "isolated",
            writeAccess: false,
            frozen: true,
            note: pausedCleanly
              ? `已暂停并隔离，检查点 ${checkpoint.checkpointRef} 已保存，写权限已回收。`
              : `暂停超时，已强制终止进程树并隔离（检查点 ${checkpoint.checkpointRef}），旧回报已作废。`,
          }
        : i,
    );

    project.handoffs = [...project.handoffs, pack];
    project.inbox = [
      ...project.inbox,
      {
        id: uid("in"),
        kind: "handoff",
        title: `待确认交接包 ${hid}：${task.name}`,
        body: `原实例 ${from.id} 已回收写权限。确认交接包后将授予新执行器写权限继续开发。`,
        taskId,
        handoffId: hid,
      },
    ];

    project = appendLeaderMessage(
      refreshStages(project),
      `已完成原实例 ${from.id}（${executorName(from.executorId)}）的写权限回收与进程隔离，保存检查点 ${checkpoint.checkpointRef}，并生成标准交接包 ${hid}。确认后新执行器即可无缝接力。`,
    );
    this.saveAndBroadcast(project);
    return { project, handoffId: hid };
  }

  /**
   * 修改待确认交接包的目标接手执行器
   */
  setHandoffTarget(projectId: string, handoffId: string, executorId: string): Project {
    const project = this.requireProject(projectId);
    project.handoffs = project.handoffs.map((h) =>
      h.id === handoffId && !h.confirmed ? { ...h, toExecutorId: executorId } : h,
    );
    this.saveAndBroadcast(project);
    return project;
  }

  /**
   * 确认交接包并授予新实例唯一写权限、立即派发接力任务
   */
  async confirmHandoff(projectId: string, handoffId: string): Promise<Project> {
    let project = this.requireProject(projectId);
    const pack = project.handoffs.find((h) => h.id === handoffId);
    if (!pack || pack.confirmed) return project;
    const task = project.tasks.find((t) => t.id === pack.taskId);
    if (!task) return project;

    const toExec = pack.toExecutorId ?? taskExecutor(task, project.roles);
    const useMock = project.executionMode === "mock" || toExec === "mock";
    const runtimeProviderId = useMock ? "mock" : normalizeProviderId(toExec);
    const cwd = task.worktreePath || project.repoPath || process.cwd();

    const newInstId = nextInstanceId(project);
    const newInst: Instance = {
      id: newInstId,
      taskId: task.id,
      roleId: task.roleId,
      executorId: toExec,
      status: "running",
      writeAccess: true,
      progress: 12,
      sessionMode: "handoff-import",
      worktreePath: cwd,
      branchName: task.branchName,
      label: `接手 · ${executorName(toExec)}`,
      note: `已确认交接包 ${pack.id}（检查点 ${pack.checkpointRef ?? "latest"}），已授予唯一写权限。`,
      startedAt: new Date().toISOString(),
    };

    project.activeWriters = { ...(project.activeWriters ?? {}), [task.id]: newInstId };
    project.handoffs = project.handoffs.map((h) =>
      h.id === handoffId
        ? { ...h, confirmed: true, toInstanceId: newInstId, toExecutorId: toExec }
        : h,
    );
    project.instances = [...project.instances, newInst];
    project.tasks = project.tasks.map((t) =>
      t.id === task.id
        ? {
            ...t,
            status: "running",
            executorOverride: toExec,
            doing: `已由 ${executorName(toExec)}（${newInstId}）确认交接包 ${pack.id} 并接力执行中…`,
          }
        : t,
    );
    project.inbox = project.inbox.map((item) =>
      item.handoffId === handoffId ? { ...item, done: true } : item,
    );

    this.agentManager.registerInstance({
      instanceId: newInstId,
      projectId: project.id,
      taskId: task.id,
      providerId: runtimeProviderId,
      config: {
        instanceId: newInstId,
        cwd,
        writeAccess: true,
      },
    });

    this.finishSubscriptions.registerBeforeDispatch({
      projectId: project.id,
      taskId: task.id,
      instanceId: newInstId,
      title: `${task.name} (接力)`,
    });

    const handoffPrompt = [
      `# 标准接力交接包（${pack.id} · 已授权写权限）`,
      `- 接力目标：${pack.goal}`,
      `- 硬性约束：${pack.constraints}`,
      `- 前序已完成摘要：${pack.completed}`,
      `- 已确认关键决策：\n${pack.decisions}`,
      `- 产物与工作区检查点：${pack.artifacts}`,
      `- 待解决遗留问题：${pack.leftovers}`,
      `- 避坑警示（失败或废弃路径，禁止复现）：${pack.failures}`,
      `- 参考下一步：${pack.nextSteps ?? "继续完成目标并提交验证证据"}`,
      "",
      "请先在回复开头简短确认你已核对上述交接包与工作区状态，然后直接完成剩余开发与验证工作。",
    ].join("\n");

    project = appendLeaderMessage(
      refreshStages(project),
      `新实例 ${newInstId}（${executorName(toExec)}）已确认交接包 ${pack.id} 并获得工作区唯一写权限，正在接着原检查点继续执行。`,
    );
    this.saveAndBroadcast(project);

    void this.agentManager.sendPrompt(newInstId, handoffPrompt, "queue").catch((err: unknown) => {
      this.handleDispatchFailure(
        project.id,
        task.id,
        newInstId,
        err instanceof Error ? err.message : String(err),
      );
    });

    return project;
  }

  /**
   * 人工手动验收通过任务，写入确认事实并自动推进下游依赖任务
   */
  async manualAcceptTask(projectId: string, taskId: string): Promise<Project> {
    let project = this.requireProject(projectId);
    const task = project.tasks.find((t) => t.id === taskId);
    if (!task || task.status === "accepted") return project;

    const latestInst = project.instances.filter((i) => i.taskId === taskId).at(-1);
    if (!latestInst?.report && project.isExample) {
      return appendLeaderMessage(project, `「${task.name}」尚无结构化回报记录，无法标记为已验收。`);
    }

    const version =
      latestInst?.report?.artifacts[0]?.version ?? task.artifactVersion ?? "manual-verified";
    task.status = "accepted";
    task.artifactVersion = version;
    task.doing = `已验收通过（版本 ${version}）。`;

    project.instances = project.instances.map((i) =>
      i.taskId === taskId && (i.status === "reported" || i.status === "running")
        ? { ...i, status: "accepted", writeAccess: false, progress: 100, frozen: true }
        : i,
    );

    project.facts = [
      ...project.facts.map((f) =>
        f.source.includes(task.name) && f.status === "unverified"
          ? { ...f, status: "confirmed" as const, version }
          : f,
      ),
      {
        id: uid("f"),
        content: `「${task.name}」已验收确认，产物 ${task.artifact}（版本 ${version}）。`,
        version,
        source: `${task.name} 验收确认`,
        status: "confirmed",
      },
    ];

    project.inbox = project.inbox.map((it) =>
      it.taskId === taskId && it.kind === "accept" ? { ...it, done: true } : it,
    );

    project = appendLeaderMessage(
      refreshStages(project),
      `「${task.name}」已验收通过，产物版本 ${version} 已沉淀为现行项目事实。正在检查解除依赖的后续任务。`,
    );
    this.saveAndBroadcast(project);

    if (this.db.getRawSettings().brain.autoDispatch) {
      project = await this.dispatchReadyTasks(project.id);
    }
    return project;
  }

  /**
   * 人工退回任务返工
   */
  async manualRejectTask(projectId: string, taskId: string, reason: string): Promise<Project> {
    let project = this.requireProject(projectId);
    const task = project.tasks.find((t) => t.id === taskId);
    if (!task) return project;

    const latestInst = project.instances.filter((i) => i.taskId === taskId).at(-1);
    task.status = "rework";
    task.doing = reason || "验收未通过，已退回返工。";

    if (latestInst) {
      latestInst.status = "failed";
      latestInst.note = task.doing;
    }

    project.facts.push({
      id: uid("f"),
      content: `「${task.name}」退回返工：${task.doing}`,
      version: "—",
      source: `${task.name} 人工退回`,
      status: "lesson",
    });

    project.inbox = project.inbox.map((it) =>
      it.taskId === taskId && it.kind === "accept" ? { ...it, done: true } : it,
    );

    project = appendLeaderMessage(
      refreshStages(project),
      `「${task.name}」已退回返工：${task.doing}。下游依赖任务继续保持锁定；可点击「重新派工」或「换人接手」。`,
    );
    this.saveAndBroadcast(project);
    return project;
  }

  /**
   * 重命名项目显示名称（仅更新本地数据库记录，不修改磁盘目录名）
   */
  renameProject(projectId: string, nextName: string): Project {
    const trimmed = nextName.trim();
    const project = this.requireProject(projectId);
    if (!trimmed || trimmed === project.name) {
      return project;
    }
    const updated: Project = { ...project, name: trimmed };
    this.saveAndBroadcast(updated);
    return updated;
  }

  /**
   * 删除项目记录（先停止该项目下仍在运行的子进程，仅移除数据库记录，绝不删除本地磁盘目录）
   */
  async deleteProject(
    projectId: string,
  ): Promise<{ projects: Project[]; activeProjectId: string }> {
    const existing = this.db.getProject(projectId);
    if (existing) {
      for (const inst of existing.instances) {
        try {
          await this.agentManager.stopInstance(inst.id);
        } catch {
          // 忽略已停止或未注册实例
        }
      }
      this.db.deleteProject(projectId);
    }

    const remaining = this.db.listProjects();
    let nextActive = this.db.getActiveProjectId();
    if (!remaining.some((p) => p.id === nextActive)) {
      nextActive = remaining[0]?.id ?? "";
      this.db.setActiveProjectId(nextActive);
    }
    return { projects: remaining, activeProjectId: nextActive };
  }

  /**
   * 将全局设置中的角色分工与绑定同步应用到所有现有项目（运行中实例保持不中断，仅影响后续新派发任务）
   */
  syncGlobalRolesToProjects(defaultRoles: readonly Role[]): Project[] {
    const roleMap = new Map(defaultRoles.map((r) => [r.id, r]));
    const updatedProjects: Project[] = [];

    for (const proj of this.db.listProjects()) {
      let changed = false;
      const nextRoles = proj.roles.map((r) => {
        const globalRole = roleMap.get(r.id);
        if (globalRole && globalRole.executorId !== r.executorId) {
          changed = true;
          return { ...r, executorId: globalRole.executorId };
        }
        return r;
      });

      if (changed) {
        const updated: Project = { ...proj, roles: nextRoles };
        this.db.saveProject(updated);
        this.broadcast.onProjectUpdated(updated);
        updatedProjects.push(updated);
      } else {
        updatedProjects.push(proj);
      }
    }

    return updatedProjects;
  }

  /**
   * 修改角色默认绑定的执行器（遵循 D6 规则：新派工立即生效，运行中实例不强行中断）
   */
  rebindRole(projectId: string, roleId: string, executorId: string): Project {
    let project = this.requireProject(projectId);
    const role = project.roles.find((r) => r.id === roleId);
    if (!role || role.executorId === executorId) return project;
    const prev = role.executorId;
    role.executorId = executorId;
    project = appendLeaderMessage(
      project,
      `已将角色「${role.name}」从 ${executorName(prev)} 改绑至 ${executorName(executorId)}。后续新派发任务按新绑定执行；运行中实例保持不中断，如需立即切换请在对应任务发起「换人接手」。`,
    );
    this.saveAndBroadcast(project);
    return project;
  }

  /**
   * 修改单个任务的执行器覆盖配置
   */
  rebindTask(projectId: string, taskId: string, executorId: string): Project {
    let project = this.requireProject(projectId);
    const task = project.tasks.find((t) => t.id === taskId);
    if (!task) return project;
    task.executorOverride = executorId;
    project = appendLeaderMessage(
      project,
      `已将任务「${task.name}」单独指定为 ${executorName(executorId)}。`,
    );
    this.saveAndBroadcast(project);
    return project;
  }

  /**
   * 处理底部常驻指挥对话消息并联动调度动作
   */
  async handleChatMessage(
    projectId: string,
    text: string,
  ): Promise<{ project: Project; openHandoffId?: string }> {
    let project = this.requireProject(projectId);
    project.messages.push({
      id: uid("m"),
      speaker: "user",
      text: text.trim(),
      at: nowTimeLabel(),
    });
    this.saveAndBroadcast(project);

    this.broadcast.onBrainStatus({
      projectId,
      phase: "chatting",
      detail: "Agent Leader 正在分析指令…",
    });

    try {
      const chatDecision = await this.brain.replyUserChat(project, text.trim());
      project = this.requireProject(projectId);
      project = appendLeaderMessage(project, chatDecision.replyText);
      this.saveAndBroadcast(project);

      if (chatDecision.intent === "dispatch_ready") {
        project = await this.dispatchReadyTasks(projectId);
      } else if (chatDecision.intent === "open_handoff" && chatDecision.targetTaskId) {
        const res = await this.initiateHandoff(
          projectId,
          chatDecision.targetTaskId,
          chatDecision.targetExecutorId,
        );
        return { project: res.project, openHandoffId: res.handoffId };
      } else if (chatDecision.intent === "accept_task" && chatDecision.targetTaskId) {
        project = await this.manualAcceptTask(projectId, chatDecision.targetTaskId);
      } else if (chatDecision.intent === "reject_task" && chatDecision.targetTaskId) {
        project = await this.manualRejectTask(
          projectId,
          chatDecision.targetTaskId,
          chatDecision.replyText,
        );
      } else if (chatDecision.intent === "split_new_tasks" && chatDecision.newTasks?.length) {
        const anchor = project.tasks.at(-1) ?? project.tasks[0];
        if (anchor) {
          project = this.mergeDynamicSubtasks(project, anchor, chatDecision.newTasks, [], 1);
          this.saveAndBroadcast(refreshStages(project));
        }
      }

      return { project };
    } finally {
      this.broadcast.onBrainStatus({ projectId, phase: "idle" });
    }
  }

  /**
   * 处理用户在待办面板中对高风险权限请求的批准/拒绝
   */
  async resolvePermissionFromUi(params: {
    projectId: string;
    instanceId: string;
    requestId: string;
    response: AgentPermissionResponse;
  }): Promise<Project> {
    await this.agentManager.respondToPermission(
      params.instanceId,
      params.requestId,
      params.response,
    );
    let project = this.requireProject(params.projectId);
    project.inbox = project.inbox.map((it) =>
      it.permissionRequestId === params.requestId ? { ...it, done: true } : it,
    );
    project = appendLeaderMessage(
      project,
      `已${params.response.behavior === "allow" ? "批准" : "拒绝"}实例 ${params.instanceId} 的权限请求（${params.requestId}）。`,
    );
    this.saveAndBroadcast(project);
    return project;
  }

  private recordPermissionInbox(
    projectId: string,
    taskId: string,
    instanceId: string,
    request: AgentPermissionRequest,
  ): void {
    const project = this.db.getProject(projectId);
    if (!project) return;
    if (project.inbox.some((i) => i.permissionRequestId === request.id)) return;

    project.inbox.push({
      id: uid("in"),
      kind: "permission",
      title: `高风险操作待批准：${request.title}`,
      body: `实例 ${instanceId}（${request.provider}）请求权限${request.description ? `：${request.description}` : ""}。未经批准不会放行。`,
      taskId,
      instanceId,
      permissionRequestId: request.id,
      options: request.options?.map((o) => o.label),
    });
    this.saveAndBroadcast(project);
  }

  private handleDispatchFailure(
    projectId: string,
    taskId: string,
    instanceId: string,
    errMsg: string,
  ): void {
    this.finishSubscriptions.cancelForInstance(instanceId);
    let project = this.db.getProject(projectId);
    if (!project) return;
    project.tasks = project.tasks.map((t) =>
      t.id === taskId ? { ...t, status: "rework", doing: `启动执行器失败：${errMsg}` } : t,
    );
    project.instances = project.instances.map((i) =>
      i.id === instanceId ? { ...i, status: "failed", writeAccess: false, note: errMsg } : i,
    );
    project = appendLeaderMessage(
      refreshStages(project),
      `启动执行智能体失败（${instanceId}）：${errMsg}。请检查对应 CLI 是否已安装登录，或切换其他执行器（也可切为 Mock 模拟模式体验）。`,
    );
    this.saveAndBroadcast(project);
  }

  private enforceHardConstraints(_project: Project, roleId: string, candidateId: string): string {
    const disabled = this.db.getRawSettings().hardDisabledByRole?.[roleId] ?? [];
    if (!disabled.includes(candidateId)) return candidateId;
    const fallback = ["codex", "claude", "antigravity", "gemini", "mock"].find(
      (id) => !disabled.includes(id),
    );
    return fallback ?? "mock";
  }

  private requireProject(projectId: string): Project {
    const p = this.db.getProject(projectId);
    if (!p) throw new Error(`项目不存在: ${projectId}`);
    return p;
  }

  private saveAndBroadcast(project: Project): void {
    this.db.saveProject(project);
    this.broadcast.onProjectUpdated(project);
  }
}

// ==================== 纯函数辅助工具 ====================

function depsSatisfied(task: Task, allTasks: readonly Task[]): boolean {
  return task.deps.every((depId) => allTasks.find((t) => t.id === depId)?.status === "accepted");
}

function nextInstanceId(project: Project): string {
  const nums = project.instances
    .map((i) => Number((i.id.match(/\d+/) || ["0"])[0]))
    .filter((n) => !Number.isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `I-${next}`;
}

function nowTimeLabel(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function appendLeaderMessage(project: Project, text: string): Project {
  return {
    ...project,
    messages: [
      ...project.messages,
      {
        id: uid("m"),
        speaker: "leader",
        text,
        at: nowTimeLabel(),
      },
    ],
  };
}

/**
 * 拓扑排序环路检测（确保动态插入子任务后 DAG 绝对无环）
 */
export function hasDagCycle(tasks: readonly Task[]): boolean {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const ids = new Set(tasks.map((t) => t.id));

  for (const t of tasks) {
    inDegree.set(t.id, 0);
    adj.set(t.id, []);
  }
  for (const t of tasks) {
    for (const dep of t.deps) {
      if (!ids.has(dep)) continue;
      adj.get(dep)!.push(t.id);
      inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    visited += 1;
    for (const nxt of adj.get(cur) ?? []) {
      const deg = (inDegree.get(nxt) ?? 1) - 1;
      inDegree.set(nxt, deg);
      if (deg === 0) queue.push(nxt);
    }
  }

  return visited !== tasks.length;
}

/**
 * 根据子任务最新状态重新推导五阶段状态条与当前主阶段
 */
export function refreshStages(project: Project): Project {
  const byStage: Record<string, Task[]> = {};
  for (const t of project.tasks) {
    (byStage[t.stageId] ??= []).push(t);
  }

  const stages = project.stages.map((s) => {
    const list = byStage[s.id] ?? [];
    if (!list.length) return { ...s, kind: "idle" as const, statusLabel: "无任务" };
    const allAccepted = list.every((t) => t.status === "accepted");
    const anyActive = list.some(
      (t) =>
        t.status === "running" ||
        t.status === "reported" ||
        t.status === "rework" ||
        t.status === "blocked",
    );
    const anyAccepted = list.some((t) => t.status === "accepted");

    if (allAccepted) {
      return { ...s, kind: "done" as const, statusLabel: "已完成" };
    }
    if (anyActive) {
      const isParallelTest = s.id === "test" && project.currentStageId !== "test";
      return {
        ...s,
        kind: isParallelTest ? ("parallel" as const) : ("current" as const),
        statusLabel: isParallelTest ? "并行准备中" : "进行中",
      };
    }
    if (anyAccepted) {
      return { ...s, kind: "current" as const, statusLabel: "进行中" };
    }
    return { ...s, kind: "idle" as const, statusLabel: "未开始" };
  });

  const currentStageId =
    stages.find((s) => s.kind === "current")?.id ??
    stages.find((s) => s.kind === "parallel")?.id ??
    stages.find((s) => s.kind !== "done")?.id ??
    project.currentStageId;

  return { ...project, stages, currentStageId };
}
