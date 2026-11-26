import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  BrainChatReplySchema,
  BrainEvaluationDecisionSchema,
  ProjectPlanResultSchema,
  executorName,
  normalizeProviderId,
  taskExecutor,
  type AgentStreamEvent,
  type BrainChatReply,
  type BrainConfig,
  type BrainEvaluationDecision,
  type Project,
  type ProjectPlanResult,
  type Task,
} from "@agent-leader/protocol";
import type { CollectedObjectiveEvidence } from "../acceptance/evidence-collector.js";
import { redactSecrets } from "../facts/secret-redactor.js";
import {
  findExecutableSync,
  spawnManagedChild,
  terminateProcessTree,
  type ProcessLedgerStore,
} from "../runtime/process/process-supervisor.js";
import type { ProviderRegistry } from "../runtime/providers/provider-registry.js";
import { generateStructuredWithRetry } from "../runtime/return-channels/structured-response.js";

/**
 * 后台指挥官（Leader Brain）核心引擎
 * 直接调用本机已安装的 CLI（在严格只读隔离模式下）负责任务阶段拆解、结果裁决、动态再拆分与用户对话，无需配置 HTTP API/Key
 */
export class LeaderBrain {
  constructor(
    private readonly getConfig: () => BrainConfig,
    private readonly registry: ProviderRegistry,
    private readonly ledger?: ProcessLedgerStore,
  ) {}

  /** 判断当前是否已选用真实本机 CLI 担任指挥官 */
  isRealCliConfigured(): boolean {
    const cfg = this.getConfig();
    const id = (cfg.cliProviderId ?? "").trim();
    return Boolean(id && id !== "heuristic" && id !== "mock");
  }

  /**
   * 测试当前选定的后台指挥官 CLI 连通性（真实拉起只读 CLI 验证回复）
   */
  async testConnection(): Promise<{ ok: boolean; detail: string }> {
    const cfg = this.getConfig();
    const cliId = (cfg.cliProviderId ?? "heuristic").trim();
    if (!cliId || cliId === "heuristic") {
      return {
        ok: true,
        detail:
          "当前处于「本地启发式调度规则」模式（离线可用；在下拉框选择本机已安装的指挥官即可启用智能体指挥）。",
      };
    }

    return this.testProviderCli(cliId, cfg.model);
  }

  /**
   * 测试任意指定本机 CLI 智能体的真实可用性（强制只读模式，不修改工作区）
   */
  async testProviderCli(
    providerId: string,
    model?: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const displayName = executorName(providerId);
    try {
      const reply = await this.callCliText(
        "请仅回复 OK 两个字母，不要调用任何工具，也不要修改任何文件。",
        { providerId, model, timeoutMs: 45_000 },
      );
      const modelSuffix = model?.trim() ? ` · ${model.trim()}` : "";
      const clean = reply.trim().replace(/\s+/g, " ").slice(0, 80) || "(空回复)";
      return {
        ok: true,
        detail: `连通成功（${displayName}${modelSuffix}）：${clean}`,
      };
    } catch (err) {
      return {
        ok: false,
        detail: `${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 职责一：按软件开发模式（req -> design -> dev -> test -> release）将背景与目标拆分为带依赖的子任务图
   * 若未指定项目名称，同时自动根据背景与目标提炼一个简洁项目名称
   */
  async planProject(params: {
    name?: string;
    background: string;
    goal: string;
    repoPath?: string;
    preferredExecutors: { plan: string; impl: string; test: string };
  }): Promise<ProjectPlanResult> {
    const repoHint = scanRepoTopEntries(params.repoPath);
    const providedName = params.name?.trim() || "";

    if (!this.isRealCliConfigured()) {
      return this.heuristicPlanProject({ ...params, name: providedName }, repoHint);
    }

    const prompt = [
      "你是 Agent Leader（软件工程后台指挥官）。你的职责是拆解任务并调度外部执行智能体（如 Codex、Claude Code、Antigravity 等），你自己处于只读指挥模式，绝不直接编写或修改业务代码。",
      providedName ? `项目名称：${providedName}` : "项目名称：请根据下方项目背景与目标自动生成一个 6~16 字的简洁中文项目名称填入 projectName 字段",
      `项目背景：${params.background}`,
      `项目目标：${params.goal}`,
      repoHint ? `项目目录顶层文件概览：${repoHint}` : "项目目录：新建工作目录",
      `可用默认执行器偏好：规划=${params.preferredExecutors.plan}，实现=${params.preferredExecutors.impl}，测试=${params.preferredExecutors.test}`,
      "",
      "请按照软件开发标准五阶段（stageId 只能取 req / design / dev / test / release）拆解为 4~8 个粒度清晰、带 DAG 依赖的子任务：",
      "- 每个任务必须写明可客观验证的 acceptance 条件；",
      "- 未满足依赖的任务严禁提前开工，测试必须依赖实现任务完成；",
      "- 若知道验证命令（如 npm run typecheck / npm test），填入 verificationCommands（禁止填入高危删除或推送命令）。",
    ].join("\n");

    const schemaHint = JSON.stringify(
      {
        projectName: providedName || "6~16字简洁中文项目名称",
        leaderSummary: "向用户汇报拆解思路与角色分工的中文摘要",
        roles: [
          {
            id: "plan",
            name: "规划 Agent",
            duty: "需求与方案设计",
            executorId: params.preferredExecutors.plan,
          },
          {
            id: "impl",
            name: "实现 Agent",
            duty: "编码实现",
            executorId: params.preferredExecutors.impl,
          },
          {
            id: "test",
            name: "测试 Agent",
            duty: "自动化测试与回归验证",
            executorId: params.preferredExecutors.test,
          },
        ],
        tasks: [
          {
            tempId: "t1",
            name: "子任务短标题",
            stageId: "req | design | dev | test | release",
            roleId: "plan | impl | test",
            deps: [],
            doing: "一句话状态说明",
            instruction: "发给执行智能体（如 Codex）的详细操作指令",
            artifact: "预期产出的文件路径或文档名",
            acceptance: ["客观验收标准1"],
            verificationCommands: [],
            targetPaths: [],
          },
        ],
      },
      null,
      2,
    );

    try {
      return await generateStructuredWithRetry({
        schema: ProjectPlanResultSchema,
        schemaHint,
        initialPrompt: prompt,
        invokeModel: (p) =>
          this.callCliText(p, { cwd: params.repoPath, timeoutMs: 90_000 }),
        maxRetries: 1,
      });
    } catch (err) {
      const fallback = this.heuristicPlanProject({ ...params, name: providedName }, repoHint);
      const errMsg = err instanceof Error ? err.message : String(err);
      const cliName = executorName(this.getConfig().cliProviderId);
      return {
        ...fallback,
        leaderSummary: `${fallback.leaderSummary}\n（提示：指挥 CLI「${cliName}」本次调用未成功 [${errMsg.slice(0, 120)}]，已自动回退使用本地阶段拆解规则；可在配置窗口测试或切换指挥 CLI。）`,
      };
    }
  }

  /**
   * 职责二：确定性组装局部现行事实与防污染派工包（ContextAssembler）
   * 严格只下发 status === "confirmed" 的现行事实，将已废弃/失败教训隔离在避坑警示区，严禁倾倒全量聊天记录
   */
  assembleDispatchPrompt(project: Project, task: Task, extraReason?: string): string {
    const confirmedFacts = project.facts.filter((f) => f.status === "confirmed");
    const pitfalls = project.facts.filter((f) => f.status === "lesson" || f.status === "deprecated");
    const upstreamTasks = task.deps
      .map((depId) => project.tasks.find((t) => t.id === depId))
      .filter((t): t is Task => Boolean(t));

    const sections: string[] = [
      `# 任务委派单：${task.name}（${task.id}）`,
      "",
      "## 1. 项目总目标与你的具体职责",
      `- 项目目标：${project.goal}`,
      `- 项目背景：${project.background}`,
      `- 本项子任务指令：${task.instruction || task.doing}`,
      `- 预期交付产物：${task.artifact}`,
      extraReason ? `- 指挥官补充要求 / 返工指示：${extraReason}` : "",
      "",
      "## 2. 客观验收标准（必须全部满足方可结项）",
      ...task.acceptance.map((a, idx) => `${idx + 1}. ${a}`),
    ].filter(Boolean);

    if (upstreamTasks.length > 0) {
      sections.push(
        "",
        "## 3. 已验收通过的上游依赖产物版本",
        ...upstreamTasks.map(
          (u) => `- 「${u.name}」产物：${u.artifact}（已核验版本：${u.artifactVersion ?? "已确认"}）`,
        ),
      );
    }

    if (confirmedFacts.length > 0) {
      sections.push(
        "",
        "## 4. 现行已确认项目事实（接力权威依据）",
        ...confirmedFacts.map((f) => `- [${f.version}] ${f.content}（来源：${f.source}）`),
      );
    }

    if (pitfalls.length > 0) {
      sections.push(
        "",
        "## 5. 避坑警示（以下为已废弃方案或历史失败教训，严禁当作现行事实或重复踩坑）",
        ...pitfalls.map((p) => `- [禁止复现] ${p.content}`),
      );
    }

    sections.push(
      "",
      "## 6. 结项回报格式要求",
      "完成操作后，请在最终回复中清晰列出：",
      "1) 本轮实际完成的工作摘要；",
      "2) 新增或修改的具体文件路径；",
      "3) 你实际运行过的构建/测试命令及真实输出结论；",
      "4) 是否仍存在未解决的边界问题或需要拆分的后续事项。",
    );

    return redactSecrets(sections.join("\n"));
  }

  /**
   * 职责三：结合执行智能体（如 Codex）的回复内容 + Daemon 客观证据进行综合评判与动态再决策
   * 支持：ACCEPT（通过）、REWORK（返工）、SPLIT_TASKS（动态进一步拆分任务）、SUGGEST_SWITCH（建议换人）、BLOCK_FOR_HUMAN（人工介入）
   */
  async evaluateTurn(params: {
    project: Project;
    task: Task;
    executorReply: string;
    curatedActivity: string;
    evidence: CollectedObjectiveEvidence;
  }): Promise<BrainEvaluationDecision> {
    if (!this.isRealCliConfigured()) {
      return this.heuristicEvaluateTurn(params);
    }

    const prompt = [
      "你是 Agent Leader 的只读验收与动态调度裁决器（绝不修改任何文件或运行命令）。执行智能体刚刚完成了子任务的一轮执行，请结合它的回复与 Daemon 采集的不可伪造客观证据做出下一步决策。",
      "",
      `【当前任务】：${params.task.name}（阶段：${params.task.stageId}，已返工次数：${params.task.reworkCount ?? 0}，当前拆分深度：${params.task.splitDepth ?? 0}）`,
      `【约定产物】：${params.task.artifact}`,
      `【验收标准】：${params.task.acceptance.join("；")}`,
      "",
      "【执行智能体的最终回复】：",
      params.executorReply.slice(0, 3500) || "(无回复正文)",
      "",
      "【执行过程浓缩轨迹（ActivityCurator）】：",
      params.curatedActivity.slice(0, 2500) || "(无工具轨迹)",
      "",
      "【Daemon 实测采集的客观工程证据（最高权威）】：",
      `- 验证汇总：${params.evidence.verificationSummary}`,
      `- 证据明细：${params.evidence.evidenceSummary}`,
      `- 全部自动检查是否通过：${params.evidence.allChecksPassed}`,
      "",
      "裁决原则：",
      "1. 客观证据优先于执行器自述！若验证命令失败（exitCode != 0）或缺少关键证据，绝不可判 ACCEPT；",
      "2. 若满足要求且证据充分，选 ACCEPT 并提炼 1~2 条已确认事实写入 confirmedFacts；",
      "3. 若未达标但可由当前执行器修复，选 REWORK 并给出明确的 reworkInstruction；",
      "4. 若从执行器回复中发现任务需要进一步细化或衍生出新的必要子任务（且当前拆分深度 < 3），选 SPLIT_TASKS 动态拆出新子任务；",
      "5. 若多次返工仍失败，选 SUGGEST_SWITCH；若缺少客观依据无法判断或存在需求歧义，选 BLOCK_FOR_HUMAN 请用户拍板。",
    ].join("\n");

    const schemaHint = [
      "输出以下五种 JSON 结构之一：",
      '1) {"action":"ACCEPT","summary":"...","confirmedFacts":[{"content":"...","version":"..."}]}',
      '2) {"action":"REWORK","reason":"...","reworkInstruction":"...","lessonToRecord":"..."}',
      '3) {"action":"SPLIT_TASKS","reason":"...","currentTaskDisposition":"accept-and-extend","newTasks":[{"tempId":"sub1","name":"...","stageId":"dev","roleId":"impl","deps":[],"doing":"...","instruction":"...","artifact":"...","acceptance":["..."],"verificationCommands":[],"targetPaths":[]}],"rewireDownstreamDeps":[]}',
      '4) {"action":"SUGGEST_SWITCH","reason":"...","recommendedExecutorId":"claude"}',
      '5) {"action":"BLOCK_FOR_HUMAN","reason":"...","questionForUser":"...","options":["选项A","选项B"]}',
    ].join("\n");

    try {
      return await generateStructuredWithRetry({
        schema: BrainEvaluationDecisionSchema,
        schemaHint,
        initialPrompt: prompt,
        invokeModel: (p) =>
          this.callCliText(p, {
            cwd: params.task.worktreePath || params.project.repoPath,
            timeoutMs: 75_000,
          }),
        maxRetries: 1,
      });
    } catch {
      return this.heuristicEvaluateTurn(params);
    }
  }

  /**
   * 处理底部常驻指挥对话中的自然语言输入
   */
  async replyUserChat(project: Project, userText: string): Promise<BrainChatReply> {
    if (!this.isRealCliConfigured()) {
      return this.heuristicReplyChat(project, userText);
    }

    const taskBrief = project.tasks
      .map(
        (t) =>
          `- [${t.id}] ${t.name} | 阶段=${t.stageId} | 状态=${t.status} | 执行器=${executorName(taskExecutor(t, project.roles))}`,
      )
      .join("\n");

    const prompt = [
      "你是 Agent Leader（只读指挥官，不直接改文件或跑命令），用户正在工作台底部对话区向你下达指令或询问进展。",
      `项目名称：${project.name}`,
      `项目目标：${project.goal}`,
      "当前全部子任务状态：",
      taskBrief,
      "",
      `用户最新输入：「${userText}」`,
      "",
      "请用简洁中文回复用户，并判断意图 intent：",
      "- 若用户只是询问进度/测试/事实，intent 填 answer_only；",
      "- 若用户要求开始/继续推进/派工，intent 填 dispatch_ready；",
      "- 若用户要求对某任务换人接手，intent 填 open_handoff 并填 targetTaskId（及可选 targetExecutorId）；",
      "- 若用户要求拆分补充新任务，intent 填 split_new_tasks 并给出 newTasks。",
    ].join("\n");

    const schemaHint = JSON.stringify({
      replyText: "给用户的简洁中文回复",
      intent: "answer_only | dispatch_ready | open_handoff | accept_task | reject_task | split_new_tasks",
      targetTaskId: "可选任务ID",
      targetExecutorId: "可选执行器ID",
    });

    try {
      return await generateStructuredWithRetry({
        schema: BrainChatReplySchema,
        schemaHint,
        initialPrompt: prompt,
        invokeModel: (p) =>
          this.callCliText(p, { cwd: project.repoPath, timeoutMs: 60_000 }),
        maxRetries: 1,
      });
    } catch {
      return this.heuristicReplyChat(project, userText);
    }
  }

  // ==================== 本机只读 CLI 指挥执行层 ====================

  /**
   * 统一调用用户选定的本机 CLI（严格只读模式，不产生文件写操作）
   * - 对 codex / claude / antigravity / cursor 使用原生单次非交互只读模式，延迟低、输出纯净
   * - 对其他已安装 ACP / JSONL-RPC / 自定义 CLI 自动回退到 ProviderRegistry 只读会话驱动
   */
  private async callCliText(
    prompt: string,
    options: { providerId?: string; model?: string; cwd?: string; timeoutMs: number },
  ): Promise<string> {
    const cfg = this.getConfig();
    const providerId = normalizeProviderId(options.providerId ?? cfg.cliProviderId);
    const model = (options.model ?? cfg.model)?.trim() || undefined;
    const cwd = resolveSafeReadonlyCwd(options.cwd);

    if (providerId === "codex") {
      return this.invokeCodexReadonly(prompt, cwd, model, options.timeoutMs);
    }
    if (providerId === "claude") {
      return this.invokeClaudeReadonly(prompt, cwd, model, options.timeoutMs);
    }
    if (providerId === "antigravity") {
      return this.invokeAntigravityReadonly(prompt, cwd, model, options.timeoutMs);
    }
    if (providerId === "cursor") {
      return this.invokeCursorReadonly(prompt, cwd, model, options.timeoutMs);
    }

    return this.invokeViaProviderReadonlySession(providerId, prompt, cwd, model, options.timeoutMs);
  }

  /**
   * 通过 Codex 原生非交互只读沙箱执行一次指挥推理（codex exec --sandbox read-only --ephemeral）
   */
  private async invokeCodexReadonly(
    prompt: string,
    cwd: string,
    model: string | undefined,
    timeoutMs: number,
  ): Promise<string> {
    const bin = findExecutableSync("codex");
    if (!bin) {
      throw new Error("本机未找到 codex 命令，请先安装或在配置中切换其他已就绪 CLI");
    }

    const tmpOut = join(os.tmpdir(), `agent-leader-codex-brain-${randomUUID()}.txt`);
    const args = [
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--skip-git-repo-check",
      "--color",
      "never",
      "-o",
      tmpOut,
    ];
    if (model) {
      args.push("-m", model);
    }
    args.push("-");

    try {
      const res = await this.runOneShotCli({
        command: bin,
        args,
        cwd,
        stdinText: prompt,
        provider: "brain:codex",
        timeoutMs,
      });

      let output = "";
      if (existsSync(tmpOut)) {
        output = readFileSync(tmpOut, "utf8").trim();
      }
      if (!output) {
        output = res.stdout.trim();
      }
      if (res.exitCode !== 0) {
        throw new Error(res.stderr.trim() || res.stdout.trim() || `codex exec 退出码 ${res.exitCode}`);
      }
      if (!output) {
        throw new Error("codex exec 未返回有效文本内容");
      }
      return output;
    } finally {
      try {
        if (existsSync(tmpOut)) unlinkSync(tmpOut);
      } catch {
        // 忽略临时文件清理异常
      }
    }
  }

  /**
   * 通过 Claude Code 原生非交互只读模式执行一次指挥推理（claude -p --permission-mode plan --tools ""）
   */
  private async invokeClaudeReadonly(
    prompt: string,
    cwd: string,
    model: string | undefined,
    timeoutMs: number,
  ): Promise<string> {
    const bin = findExecutableSync("claude");
    if (!bin) {
      throw new Error("本机未找到 claude 命令，请先安装或在配置中切换其他已就绪 CLI");
    }

    const args = [
      "-p",
      "--output-format",
      "text",
      "--permission-mode",
      "plan",
      "--no-session-persistence",
      "--tools",
      "",
    ];
    if (model) {
      args.push("--model", model);
    }

    const res = await this.runOneShotCli({
      command: bin,
      args,
      cwd,
      stdinText: prompt,
      provider: "brain:claude",
      env: { CLAUDECODE: "" },
      timeoutMs,
    });

    const output = res.stdout.trim();
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || output || `claude -p 退出码 ${res.exitCode}`);
    }
    if (!output) {
      throw new Error("claude 未返回有效文本内容");
    }
    return output;
  }

  /**
   * 通过 Antigravity CLI 原生非交互只读规划模式执行一次指挥推理（agy --output-format text --mode plan -p <prompt>）
   */
  private async invokeAntigravityReadonly(
    prompt: string,
    cwd: string,
    model: string | undefined,
    timeoutMs: number,
  ): Promise<string> {
    const bin = findExecutableSync("agy");
    if (!bin) {
      throw new Error("本机未找到 agy 命令，请先安装或在配置中切换其他已就绪 CLI");
    }

    const args = ["--output-format", "text", "--mode", "plan"];
    if (model) {
      args.push("--model", model);
    }
    // agy 的 -p 为接收 prompt 字符串的参数，必须位于其余 flag 之后并紧跟 prompt
    args.push("-p", prompt);

    const res = await this.runOneShotCli({
      command: bin,
      args,
      cwd,
      provider: "brain:antigravity",
      timeoutMs,
    });

    const output = res.stdout.trim();
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || output || `agy -p 退出码 ${res.exitCode}`);
    }
    if (!output) {
      throw new Error("agy 未返回有效文本内容");
    }
    return output;
  }

  /**
   * 通过 Cursor Agent CLI 原生只读问答模式执行一次指挥推理（cursor-agent -p --mode ask）
   */
  private async invokeCursorReadonly(
    prompt: string,
    cwd: string,
    model: string | undefined,
    timeoutMs: number,
  ): Promise<string> {
    const bin = findExecutableSync("cursor-agent");
    if (!bin) {
      throw new Error("本机未找到 cursor-agent 命令，请先安装或在配置中切换其他已就绪 CLI");
    }

    const args = ["-p", "--output-format", "text", "--mode", "ask"];
    if (model) {
      args.push("--model", model);
    }

    const res = await this.runOneShotCli({
      command: bin,
      args,
      cwd,
      stdinText: prompt,
      provider: "brain:cursor",
      timeoutMs,
    });

    const output = res.stdout.trim();
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || output || `cursor-agent -p 退出码 ${res.exitCode}`);
    }
    if (!output) {
      throw new Error("cursor-agent 未返回有效文本内容");
    }
    return output;
  }

  /**
   * 通用兜底：通过 ProviderRegistry 拉起临时只读会话调用任意已安装 ACP / JSONL-RPC / 自定义 CLI
   * 权限门控自动拒绝全部写/命令请求，确保绝对只读
   */
  private async invokeViaProviderReadonlySession(
    providerId: string,
    prompt: string,
    cwd: string,
    model: string | undefined,
    timeoutMs: number,
  ): Promise<string> {
    const client = this.registry.resolveClient(providerId, false);
    const session = await client.createSession({
      instanceId: `brain-${randomUUID().slice(0, 6)}`,
      cwd,
      model,
      writeAccess: false,
    });

    const chunks: string[] = [];
    let settledError: string | null = null;
    let resolveDone!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const unsubscribe = session.subscribe((ev: AgentStreamEvent) => {
      if (ev.type === "permission_requested") {
        void session.respondToPermission(ev.request.id, {
          behavior: "deny",
          message: "后台指挥官处于严格只读模式，禁止修改文件或执行命令。",
        });
        return;
      }
      if (ev.type === "timeline" && ev.item.type === "assistant_message") {
        chunks.push(ev.item.text);
        return;
      }
      if (ev.type === "turn_failed") {
        settledError = ev.error;
        resolveDone();
        return;
      }
      if (ev.type === "turn_completed" || ev.type === "turn_canceled") {
        resolveDone();
      }
    });

    const timer = setTimeout(() => {
      settledError = `指挥 CLI (${providerId}) 执行超时 (${Math.round(timeoutMs / 1000)}s)`;
      void session.interrupt();
      resolveDone();
    }, timeoutMs);

    try {
      await session.startTurn(prompt);
      await donePromise;

      const text = chunks.join("").trim();
      if (settledError && !text) {
        throw new Error(settledError);
      }
      if (!text) {
        throw new Error(`指挥 CLI (${providerId}) 未返回文本回复`);
      }
      return text;
    } finally {
      clearTimeout(timer);
      unsubscribe();
      await session.close();
    }
  }

  /**
   * 跨平台执行单次只读 CLI 子进程（stdin 传入完整 prompt，防命令行长度限制与转义问题，超时强杀整棵进程树）
   */
  private runOneShotCli(params: {
    command: string;
    args: readonly string[];
    cwd: string;
    stdinText?: string;
    provider: string;
    env?: Record<string, string>;
    timeoutMs: number;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawnManagedChild(params.command, params.args, {
        cwd: params.cwd,
        env: params.env,
        instanceId: `brain-${randomUUID().slice(0, 6)}`,
        provider: params.provider,
        ledger: this.ledger,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let finished = false;

      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        void terminateProcessTree(child);
        reject(new Error(`指挥 CLI 执行超时 (${Math.round(params.timeoutMs / 1000)}s)`));
      }, params.timeoutMs);

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      child.once("error", (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(err);
      });

      child.once("exit", (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          exitCode: code ?? 1,
        });
      });

      try {
        if (params.stdinText !== undefined) {
          child.stdin.write(params.stdinText, "utf8");
        }
        child.stdin.end();
      } catch {
        // 忽略子进程提前退出导致的 EPIPE
      }
    });
  }

  // ==================== 本地启发式规则兜底（离线或未选 CLI 时立即可用） ====================

  private heuristicPlanProject(
    params: {
      name?: string;
      background: string;
      goal: string;
      repoPath?: string;
      preferredExecutors: { plan: string; impl: string; test: string };
    },
    repoHint: string,
  ): ProjectPlanResult {
    const autoName = params.name?.trim() || deriveProjectName(params.background, params.goal);
    const roles = [
      {
        id: "plan",
        name: "规划 Agent",
        duty: "需求梳理与技术方案",
        executorId: params.preferredExecutors.plan,
      },
      {
        id: "impl",
        name: "实现 Agent",
        duty: "核心代码实现与自测",
        executorId: params.preferredExecutors.impl,
      },
      {
        id: "test",
        name: "测试 Agent",
        duty: "自动化测试与验收核验",
        executorId: params.preferredExecutors.test,
      },
    ];

    return {
      projectName: autoName,
      leaderSummary: `已围绕目标按软件工程五阶段拆解出 5 个带依赖的子任务，并配置团队：规划 → ${executorName(params.preferredExecutors.plan)}，实现 → ${executorName(params.preferredExecutors.impl)}，测试 → ${executorName(params.preferredExecutors.test)}。${repoHint ? `已识别项目目录文件（${repoHint}）。` : ""}前置任务验收通过后将自动解锁下游任务。`,
      roles,
      tasks: [
        {
          tempId: "t-req",
          name: "梳理需求边界与客观验收标准",
          stageId: "req",
          roleId: "plan",
          deps: [],
          doing: "结合项目背景提炼边界约束与可检验的完成标准。",
          instruction: `请结合背景「${params.background}」与目标「${params.goal}」，梳理模块边界、风险点及可被命令/文件验证的客观验收标准。`,
          artifact: "docs/requirements-spec.md",
          acceptance: ["明确列出核心改动边界与验收判据"],
          verificationCommands: [],
          targetPaths: ["docs/requirements-spec.md"],
        },
        {
          tempId: "t-design",
          name: "技术与接口方案设计",
          stageId: "design",
          roleId: "plan",
          deps: ["t-req"],
          doing: "依赖需求梳理验收通过后编写实现方案。",
          instruction: `基于已验收的需求规格，设计具体模块改造方案与文件改动清单，确保能直接指导后续编码实现。`,
          artifact: "docs/technical-design.md",
          acceptance: ["给出清晰的文件级修改方案与异常分支策略"],
          verificationCommands: [],
          targetPaths: ["docs/technical-design.md"],
        },
        {
          tempId: "t-dev-core",
          name: "核心功能编码实现",
          stageId: "dev",
          roleId: "impl",
          deps: ["t-design"],
          doing: "按已确认方案完成代码实现。",
          instruction: `严格按照已确认的技术方案实现目标：「${params.goal}」，确保代码结构清晰并具备完整注释。`,
          artifact: "核心代码变更",
          acceptance: ["完成目标代码修改", "无编译或类型错误"],
          verificationCommands: [],
          targetPaths: ["src"],
        },
        {
          tempId: "t-test",
          name: "自动化测试与回归验证",
          stageId: "test",
          roleId: "test",
          deps: ["t-dev-core"],
          doing: "依赖核心实现验收通过后运行测试验证。",
          instruction: "针对本次核心改动补充并执行验证用例，输出真实测试结果与回归检查结论。",
          artifact: "测试验证报告",
          acceptance: ["测试全部通过且无回归破损"],
          verificationCommands: [],
          targetPaths: ["tests"],
        },
        {
          tempId: "t-release",
          name: "交付变更核对与归档",
          stageId: "release",
          roleId: "impl",
          deps: ["t-test"],
          doing: "依赖测试全部通过后整理交付摘要。",
          instruction: "核对最终 Git Diff、产物版本与验收记录，输出交付说明。",
          artifact: "交付说明",
          acceptance: ["前置测试均已通过且产物版本可追溯"],
          verificationCommands: [],
          targetPaths: [],
        },
      ],
    };
  }

  private heuristicEvaluateTurn(params: {
    project: Project;
    task: Task;
    executorReply: string;
    evidence: CollectedObjectiveEvidence;
  }): BrainEvaluationDecision {
    if (!params.evidence.allChecksPassed) {
      const failedCmd = params.evidence.commandResults.find((c) => c.exitCode !== 0);
      if (failedCmd?.skippedHighRisk) {
        return {
          action: "BLOCK_FOR_HUMAN",
          reason: failedCmd.skippedHighRisk,
          questionForUser: `验证过程包含高风险操作（${failedCmd.command}），是否允许放行或调整验收命令？`,
          options: ["人工确认通过", "打回返工"],
        };
      }
      return {
        action: "REWORK",
        reason: `客观验证命令未通过：${failedCmd?.command ?? "check"} (exitCode=${failedCmd?.exitCode})`,
        reworkInstruction: `请修复以下验证报错后重新提交：\n${failedCmd?.outputTail ?? ""}`,
        lessonToRecord: `任务「${params.task.name}」验证命令失败：${failedCmd?.command}`,
      };
    }

    if (!params.executorReply.trim()) {
      return {
        action: "REWORK",
        reason: "执行器未交回有效工作说明与验证摘要",
        reworkInstruction: "请补充本轮已完成的改动说明、产物路径及验证结论。",
      };
    }

    if (
      /需要进一步拆分|建议拆分子任务|\[SPLIT_TASK\]/.test(params.executorReply) &&
      (params.task.splitDepth ?? 0) < 3
    ) {
      return {
        action: "SPLIT_TASKS",
        reason: "根据执行器回报发现需补充专项跟进子任务",
        currentTaskDisposition: "accept-and-extend",
        newTasks: [
          {
            tempId: `sub-${Date.now().toString(36)}`,
            name: `${params.task.name} · 边界补充验证`,
            stageId: params.task.stageId as "req" | "design" | "dev" | "test" | "release",
            roleId: params.task.roleId,
            deps: [params.task.id],
            doing: "根据上一轮执行发现的边界项做专项补齐。",
            instruction: `请针对「${params.task.name}」执行中暴露的边界事项完成补充处理与验证。`,
            artifact: `${params.task.artifact}-补充`,
            acceptance: ["补充项验证通过"],
            verificationCommands: [],
            targetPaths: [],
          },
        ],
        rewireDownstreamDeps: [],
      };
    }

    const ver = params.evidence.artifacts[0]?.version ?? params.evidence.gitRevision;
    return {
      action: "ACCEPT",
      summary: `「${params.task.name}」客观核验通过（版本 ${ver}）。`,
      confirmedFacts: [
        {
          content: `任务「${params.task.name}」已完成并核验通过，产物 ${params.task.artifact}（${ver}）。`,
          version: ver,
        },
      ],
    };
  }

  private heuristicReplyChat(project: Project, text: string): BrainChatReply {
    const t = text.trim();
    const accepted = project.tasks.filter((x) => x.status === "accepted").length;
    const total = project.tasks.length;
    const pct = total ? Math.round((accepted / total) * 100) : 0;

    if (/换人|接手|换一个|换另一/.test(t)) {
      const target =
        project.tasks.find((x) => x.status === "rework") ??
        project.tasks.find((x) => x.status === "running") ??
        project.tasks.find((x) => x.status === "reported");
      if (target) {
        return {
          replyText: `收到。我将暂停/隔离「${target.name}」当前实例、保存检查点并撤销写权限，生成 10 字段标准交接包，无需你重复解释背景。请选择接手执行器并确认交接包。`,
          intent: "open_handoff",
          targetTaskId: target.id,
        };
      }
    }

    if (/继续|推进|开始|派工|执行|启动/.test(t)) {
      return {
        replyText: `好，我立即检查所有前置依赖已满足的子任务，并按当前角色绑定派发给对应的执行智能体（过程与输出将在实例面板实时流式同步）。`,
        intent: "dispatch_ready",
      };
    }

    if (/进度|怎样|怎么样|概况|现状/.test(t)) {
      return {
        replyText: `当前项目验收完成率 ${accepted} / ${total}（${pct}%）。\n角色分工：${project.roles.map((r) => `${r.name} → ${executorName(r.executorId)}`).join("，")}。\n前置任务经客观证据验收通过后才会解锁下游任务；如需立即推进就绪项，可直接说「继续推进」。`,
        intent: "answer_only",
      };
    }

    return {
      replyText: `已收到指令：「${t}」。当前完成率 ${accepted}/${total}（${pct}%）。你可以随时说「继续推进」派发就绪任务、「换另一个执行器接手」发起无损交接，或在配置窗口切换本机指挥官 CLI。`,
      intent: "answer_only",
    };
  }
}

/**
 * 解析指挥官 CLI 使用的安全只读工作目录
 */
function resolveSafeReadonlyCwd(preferredDir?: string): string {
  const candidate = preferredDir?.trim();
  if (candidate && existsSync(candidate)) {
    try {
      if (statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // 回退临时目录
    }
  }
  return os.tmpdir();
}

/**
 * 根据项目背景与目标自动提炼 6~18 字的简洁项目名称（兜底与离线模式共用）
 */
export function deriveProjectName(background: string, goal: string): string {
  const source = (goal || background || "").trim().replace(/\s+/g, " ");
  if (!source) return "新建智能体项目";

  // 优先截取第一个完整意群，并去掉常见动词/引导前缀
  const firstClause = source.split(/[。！？；\n]/)[0]?.trim() || source;
  const cleaned = firstClause
    .replace(/^(我们需要|我希望|希望|需要|请帮我|请帮忙|帮我|为了|目标是|要达成|补齐|实现|开发|构建|优化|改造|修复|新增|创建|设计)/, "")
    .replace(/^[，,、：:的]+/, "")
    .trim();

  const candidate = cleaned.length >= 4 ? cleaned : firstClause;
  if (candidate.length <= 18) {
    return candidate;
  }
  return `${candidate.slice(0, 16)}…`;
}

/**
 * 扫描本地仓库顶层目录名称作为拆解提示
 */
function scanRepoTopEntries(repoPath?: string): string {
  if (!repoPath?.trim()) return "";
  try {
    return readdirSync(repoPath.trim())
      .filter((name) => !name.startsWith("."))
      .slice(0, 18)
      .join(", ");
  } catch {
    return "";
  }
}
