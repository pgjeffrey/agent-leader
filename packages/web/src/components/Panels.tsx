import { useEffect, useRef, useState } from "react";
import { useProject } from "../store";
import {
  FACT_STATUS_META,
  INSTANCE_STATUS_LABEL,
  executorName,
  taskExecutor,
  type ProviderModelOption,
  type SystemSettings,
} from "../types";
import { StatusPill, TonePill } from "./ui";

/**
 * 运行实例监控列表面板
 */
export function InstancesPanel() {
  const { project, settings, dispatch } = useProject();
  if (!project.instances.length) {
    return <div className="empty">当前项目尚无运行实例。可点击「继续推进」或在任务详情中派工。</div>;
  }
  return (
    <div className="panel-block">
      {project.instances.map((i) => {
        const task = project.tasks.find((t) => t.id === i.taskId);
        const tone =
          i.status === "accepted"
            ? "ok"
            : i.status === "isolated" || i.status === "failed"
              ? "rework"
              : i.status === "reported" || i.status === "awaiting-confirm"
                ? "warn"
                : i.status === "running"
                  ? "info"
                  : "neutral";
        return (
          <button
            key={i.id}
            className="row-card"
            onClick={() => dispatch({ type: "SELECT_TASK", id: i.taskId })}
          >
            <strong>{i.id}</strong>
            <div>
              <h3>
                {executorName(i.executorId, settings.customProviders)} · {task?.name}
              </h3>
              <div className="meta">
                {i.label}　写权限：{i.writeAccess ? "有效（持有写锁）" : "无 / 已撤销"}
                　会话：
                {i.sessionMode === "handoff-import"
                  ? "新会话 + 导入交接包"
                  : i.sessionMode === "hosted"
                    ? "恢复本地会话"
                    : "新会话"}
              </div>
              {i.worktreePath && (
                <div className="meta">
                  工作区：{i.worktreePath}
                  {i.branchName ? ` (${i.branchName})` : ""}
                </div>
              )}
              {i.note && <div className="meta">{i.note}</div>}
              {i.status === "running" && (
                <div className="progress">
                  <span style={{ width: `${i.progress}%` }} />
                </div>
              )}
            </div>
            <TonePill tone={tone}>{INSTANCE_STATUS_LABEL[i.status]}</TonePill>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 共享项目事实库面板（严格区分已确认现行事实 vs 失败教训/已废弃方案）
 */
export function FactsPanel() {
  const { project } = useProject();
  if (!project.facts.length) {
    return <div className="empty">还没有项目事实。任务通过客观证据验收后会自动沉淀已确认事实。</div>;
  }
  return (
    <div className="panel-block">
      <div className="fact-grid">
        {project.facts.map((f) => {
          const meta = FACT_STATUS_META[f.status];
          return (
            <article key={f.id} className="fact-card">
              <TonePill tone={meta.tone}>{meta.label}</TonePill>
              <p>{f.content}</p>
              <div className="meta" style={{ marginTop: 8 }}>
                版本 {f.version}　来源 {f.source}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 验收与客观证据核对面板
 */
export function ReviewPanel() {
  const { project, settings, dispatch } = useProject();
  const pending = project.tasks.filter((t) => t.status === "reported");
  const accepted = project.tasks.filter((t) => t.status === "accepted");
  return (
    <div className="panel-block">
      {!pending.length && <div className="empty">当前没有待人工验收裁决的任务。</div>}
      {pending.map((t) => {
        const inst = project.instances.filter((i) => i.taskId === t.id && i.report).at(-1);
        const exec = inst
          ? executorName(inst.executorId, settings.customProviders)
          : executorName(taskExecutor(t, project.roles), settings.customProviders);
        return (
          <article key={t.id} className="card" style={{ padding: 16 }}>
            <div className="ov-head">
              <h3 style={{ margin: 0 }}>{t.name}</h3>
              <StatusPill status="reported" />
            </div>
            <div className="meta">
              回报来自 {exec}
              {inst ? `（${inst.id}）` : ""}
            </div>
            <div className="section-k">预设客观验收标准</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {t.acceptance.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
            {inst?.report && (
              <>
                <div className="section-k">客观证据</div>
                <p style={{ margin: 0 }}>{inst.report.evidence}</p>
                <div className="section-k">模型意见（仅作参考）</div>
                <p style={{ margin: 0 }}>{inst.report.opinion}</p>
                <div className="section-k">产物与真实版本</div>
                <p style={{ margin: 0 }}>
                  {inst.report.artifacts.map((a) => `${a.path} · ${a.version}`).join("；")}
                </p>
              </>
            )}
            <div className="drawer-foot" style={{ border: 0, padding: "16px 0 0" }}>
              <button
                className="btn-danger"
                onClick={() =>
                  dispatch({
                    type: "REJECT_TASK",
                    taskId: t.id,
                    reason: "缺少约定的测试或运行结果证据，退回返工。",
                  })
                }
              >
                退回返工
              </button>
              <button
                className="btn-primary"
                onClick={() => dispatch({ type: "ACCEPT_TASK", taskId: t.id })}
              >
                验收通过
              </button>
            </div>
          </article>
        );
      })}
      {accepted.length > 0 && (
        <p className="muted">累计已验收通过 {accepted.length} 项子任务。</p>
      )}
    </div>
  );
}

/**
 * 待办、高风险权限审批与人工阻塞介入面板
 */
export function InboxPanel() {
  const { project, dispatch, respondPermission } = useProject();
  const items = project.inbox.slice().reverse();
  if (!items.length) {
    return <div className="empty">没有待办事项。高风险权限审批、待验收、换人确认与阻塞请示会汇总于此。</div>;
  }
  return (
    <div className="panel-block">
      {items.map((it) => (
        <div
          key={it.id}
          className="row-card"
          style={{ opacity: it.done ? 0.55 : 1, cursor: "default" }}
        >
          <TonePill
            tone={
              it.done
                ? "neutral"
                : it.kind === "permission" || it.kind === "intervene"
                  ? "rework"
                  : it.kind === "accept"
                    ? "warn"
                    : "info"
            }
          >
            {it.done
              ? "已处理"
              : it.kind === "permission"
                ? "高危待批"
                : it.kind === "accept"
                  ? "待验收"
                  : it.kind === "handoff"
                    ? "待确认"
                    : "待介入"}
          </TonePill>
          <div>
            <h3>{it.title}</h3>
            <div className="meta">{it.body}</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {!it.done && it.kind === "permission" && it.instanceId && it.permissionRequestId ? (
              <>
                <button
                  className="btn-danger"
                  onClick={() =>
                    respondPermission(it.instanceId!, it.permissionRequestId!, {
                      behavior: "deny",
                    })
                  }
                >
                  拒绝拦截
                </button>
                <button
                  className="btn-primary"
                  onClick={() =>
                    respondPermission(it.instanceId!, it.permissionRequestId!, {
                      behavior: "allow",
                    })
                  }
                >
                  批准执行
                </button>
              </>
            ) : (
              <button
                className="btn-ghost"
                onClick={() => {
                  if (it.handoffId && it.taskId) {
                    dispatch({ type: "OPEN_HANDOFF", taskId: it.taskId });
                  } else if (it.kind === "accept") {
                    dispatch({ type: "SET_SURFACE", surface: "review" });
                    if (it.taskId) dispatch({ type: "SELECT_TASK", id: it.taskId });
                  } else if (it.taskId) {
                    dispatch({ type: "SELECT_TASK", id: it.taskId });
                  }
                }}
              >
                查看处理
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 标准交接包历史列表面板
 */
export function HandoffList() {
  const { project, settings, dispatch } = useProject();
  if (!project.handoffs.length) {
    return (
      <div className="empty">
        还没有交接记录。在任务详情中选择「换人接手」会自动回收旧实例写权限、保存检查点并生成 10 字段标准交接包。
      </div>
    );
  }
  return (
    <div className="panel-block">
      {project.handoffs.map((h) => {
        const task = project.tasks.find((t) => t.id === h.taskId);
        return (
          <button
            key={h.id}
            className="row-card"
            onClick={() => dispatch({ type: "SET_OPEN_HANDOFF_ID", handoffId: h.id })}
          >
            <strong>{h.id}</strong>
            <div>
              <h3>
                {task?.name}　{h.fromInstanceId}
                {h.toInstanceId
                  ? ` → ${h.toInstanceId}`
                  : h.toExecutorId
                    ? ` → ${executorName(h.toExecutorId, settings.customProviders)}`
                    : " → 待指定"}
              </h3>
              <div className="meta">
                {h.reason}
                {h.checkpointRef ? ` · 检查点 ${h.checkpointRef}` : ""}
              </div>
            </div>
            <TonePill tone={h.confirmed ? "ok" : "warn"}>
              {h.confirmed ? "已确认并授权" : "待确认（只读门控）"}
            </TonePill>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 全局配置中心面板（所有设置适用于全部项目）：
 * 1) Agent 指挥官配置与连通性检测
 * 2) 可指挥执行的智能体管理、单智能体可用性测试与自定义扩展
 */
export function ConfigPanel() {
  const {
    settings,
    providers,
    saveSystemSettings,
    testBrainConnection,
    testProviderConnection,
    listProviderModels,
    refreshProviders,
  } = useProject();

  const [brainForm, setBrainForm] = useState<SystemSettings["brain"]>(settings.brain);
  const [testResult, setTestResult] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [testingProviderIds, setTestingProviderIds] = useState<Record<string, boolean>>({});
  const [modelOptions, setModelOptions] = useState<ProviderModelOption[]>([]);
  const [defaultCliModel, setDefaultCliModel] = useState<string | undefined>(undefined);
  const [loadingModels, setLoadingModels] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [customId, setCustomId] = useState("");
  const [customName, setCustomName] = useState("");
  const [customCmd, setCustomCmd] = useState("");

  /**
   * 锁定本次打开弹窗时的展示顺序：
   * - 每次打开弹窗（或重新探测）时按「已勾选在前 -> 本机就绪次之 -> 未找到在后」排好序
   * - 弹窗打开期间勾选/取消/测试时保持卡片位置稳定不乱跳，关闭重开后再按最新勾选状态重排
   */
  const initialOrderRef = useRef<Map<string, number> | null>(null);
  if (initialOrderRef.current === null && providers.length > 0) {
    const ordered = providers.slice().sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      if (a.installed !== b.installed) return a.installed ? -1 : 1;
      return 0;
    });
    initialOrderRef.current = new Map(ordered.map((p, idx) => [p.id, idx]));
  }

  useEffect(() => {
    setBrainForm(settings.brain);
  }, [
    settings.brain.cliProviderId,
    settings.brain.model,
    settings.brain.autoDispatch,
    settings.brain.maxReworkCount,
    settings.brain.maxConcurrency,
  ]);

  useEffect(() => {
    const cliId = brainForm.cliProviderId;
    if (!cliId || cliId === "heuristic") {
      setModelOptions([]);
      setDefaultCliModel(undefined);
      setLoadingModels(false);
      return;
    }

    let cancelled = false;
    setLoadingModels(true);
    void listProviderModels(cliId)
      .then((res) => {
        if (cancelled) return;
        setModelOptions(res.models);
        setDefaultCliModel(res.defaultModel);
      })
      .catch(() => {
        if (cancelled) return;
        setModelOptions([]);
        setDefaultCliModel(undefined);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });

    return () => {
      cancelled = true;
    };
  }, [brainForm.cliProviderId, listProviderModels]);

  async function handleSaveBrain() {
    setSaving(true);
    try {
      await saveSystemSettings({ ...settings, brain: brainForm });
      setTestResult("已保存后台指挥官 CLI 与调度阈值配置。");
    } catch (err) {
      setTestResult(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleTestBrain() {
    setTestResult("正在拉起只读 CLI 测试指挥官连通性…");
    const res = await testBrainConnection(brainForm);
    setTestResult(res.detail);
  }

  async function handleTestProvider(providerId: string) {
    setTestingProviderIds((prev) => ({ ...prev, [providerId]: true }));
    try {
      await testProviderConnection(providerId);
    } finally {
      setTestingProviderIds((prev) => ({ ...prev, [providerId]: false }));
    }
  }

  async function toggleProviderEnabled(id: string, enabled: boolean) {
    const overrides = {
      ...(settings.userProviderOverrides ?? {}),
      [id]: enabled,
    };
    const nextEnabledIds = providers
      .filter((p) => (p.id === id ? enabled : p.enabled))
      .map((p) => p.id);

    await saveSystemSettings({
      ...settings,
      enabledProviderIds: nextEnabledIds,
      userProviderOverrides: overrides,
    });
  }

  async function handleAddCustomProvider(e: React.FormEvent) {
    e.preventDefault();
    const id = customId.trim().toLowerCase();
    const name = customName.trim();
    const cmdParts = customCmd
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!id || !name || cmdParts.length === 0) return;

    await saveSystemSettings({
      ...settings,
      enabledProviderIds: [...new Set([...settings.enabledProviderIds, id])],
      userProviderOverrides: {
        ...(settings.userProviderOverrides ?? {}),
        [id]: true,
      },
      customProviders: [
        ...settings.customProviders.filter((c) => c.id !== id),
        { id, name, extends: "acp", command: cmdParts, enabled: true },
      ],
    });
    setCustomId("");
    setCustomName("");
    setCustomCmd("");
  }

  const q = searchQuery.trim().toLowerCase();
  const orderMap = initialOrderRef.current;
  const filteredProviders = (
    q
      ? providers.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.id.toLowerCase().includes(q) ||
            p.vendor.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q),
        )
      : providers
  )
    .slice()
    .sort((a, b) => {
      const rankA = orderMap?.get(a.id);
      const rankB = orderMap?.get(b.id);
      if (rankA !== undefined && rankB !== undefined) {
        return rankA - rankB;
      }
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      if (a.installed !== b.installed) return a.installed ? -1 : 1;
      return 0;
    });

  const installedProviders = providers.filter((p) => p.installed);
  const installedCount = installedProviders.length;
  const brainCliOptions = [
    ...installedProviders,
    ...providers.filter(
      (p) => !p.installed && p.id === brainForm.cliProviderId && brainForm.cliProviderId !== "heuristic",
    ),
  ];

  return (
    <div className="panel-block" style={{ gap: 18 }}>
      {/* 1. 后台指挥官 CLI 配置（方案 A：直接选用本机已安装 CLI） */}
      <section className="card">
        <h3 style={{ margin: "0 0 14px" }}>1. Agent 指挥官配置</h3>

        <div className="config-grid">
          <div>
            <div className="field-label">选择本机已安装的指挥官</div>
            <select
              className="input"
              value={brainForm.cliProviderId}
              onChange={(e) =>
                setBrainForm({
                  ...brainForm,
                  cliProviderId: e.target.value,
                  model: "",
                })
              }
            >
              {brainCliOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.installed ? "（本机就绪）" : "（未找到）"}
                </option>
              ))}
              <option value="heuristic">本地启发式调度规则（离线兜底）</option>
            </select>
          </div>

          <div>
            <div className="field-label">指定模型（可选，留空使用默认模型）</div>
            <select
              className="input"
              value={brainForm.model ?? ""}
              disabled={brainForm.cliProviderId === "heuristic" || loadingModels}
              onChange={(e) => setBrainForm({ ...brainForm, model: e.target.value })}
            >
              {brainForm.cliProviderId === "heuristic" ? (
                <option value="">本地规则模式无需选择模型</option>
              ) : loadingModels ? (
                <option value="">正在读取指挥官可用模型…</option>
              ) : (
                <>
                  <option value="">
                    {defaultCliModel ? `使用默认模型（${defaultCliModel}）` : "使用默认模型"}
                  </option>
                  {brainForm.model &&
                    !modelOptions.some((m) => m.id === brainForm.model) && (
                      <option value={brainForm.model}>{brainForm.model}</option>
                    )}
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </>
              )}
            </select>
          </div>

          <div>
            <div className="field-label">单任务最大自动返工次数</div>
            <input
              type="number"
              min={1}
              max={10}
              className="input"
              value={brainForm.maxReworkCount}
              onChange={(e) =>
                setBrainForm({ ...brainForm, maxReworkCount: Number(e.target.value) || 3 })
              }
            />
          </div>

          <div>
            <div className="field-label">单项目最大并行实例上限</div>
            <input
              type="number"
              min={1}
              max={12}
              className="input"
              value={brainForm.maxConcurrency}
              onChange={(e) =>
                setBrainForm({ ...brainForm, maxConcurrency: Number(e.target.value) || 4 })
              }
            />
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 12 }}>
            <input
              type="checkbox"
              checked={brainForm.autoDispatch}
              onChange={(e) => setBrainForm({ ...brainForm, autoDispatch: e.target.checked })}
            />
            <span>前置依赖验收通过后自动派发下游任务</span>
          </label>
          <button type="button" className="btn-ghost" onClick={() => void handleTestBrain()}>
            测试连通性
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={saving}
            onClick={() => void handleSaveBrain()}
          >
            保存配置
          </button>
        </div>
        {testResult && (
          <div className="callout" style={{ marginTop: 12, marginBottom: 0 }}>
            {testResult}
          </div>
        )}
      </section>

      {/* 2. 可指挥执行智能体统一列表（适用于所有项目） */}
      <section className="card">
        <div className="ov-head" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>
            2. 可指挥执行的智能体（已在本机找到 {installedCount} 款 / 共 {providers.length} 款）
          </h3>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              initialOrderRef.current = null;
              void refreshProviders();
            }}
          >
            重新探测本机 CLI
          </button>
        </div>

        <input
          className="input"
          style={{ marginBottom: 14 }}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索智能体名称、ID 或厂商（如 codex、claude、antigravity、cursor、trae、qwen…）"
        />

        <div className="provider-grid" style={{ marginBottom: 16 }}>
          {filteredProviders.map((p) => {
            const isTesting = Boolean(testingProviderIds[p.id]);
            const isFailed = p.installed && p.healthStatus === "error";
            return (
              <div
                key={p.id}
                className="provider-card"
                style={{ opacity: p.installed || p.enabled ? 1 : 0.72 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      onChange={(e) => void toggleProviderEnabled(p.id, e.target.checked)}
                    />
                    <span>{p.name}</span>
                  </label>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    {p.installed && (
                      <button
                        type="button"
                        className={`icon-btn-test${isTesting ? " is-testing" : ""}`}
                        disabled={isTesting}
                        onClick={() => void handleTestProvider(p.id)}
                        title={isTesting ? "正在测试连通性…" : "测试智能体是否可用"}
                        aria-label={isTesting ? "正在测试连通性" : `测试 ${p.name} 是否可用`}
                      >
                        {isTesting ? (
                          <svg
                            className="spin-icon"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                          </svg>
                        ) : (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <polygon points="6 4 20 12 6 20 6 4" />
                          </svg>
                        )}
                      </button>
                    )}
                    <TonePill
                      tone={!p.installed ? "neutral" : isFailed ? "rework" : "ok"}
                    >
                      {!p.installed ? "未找到" : isFailed ? "无法指挥" : "本机就绪"}
                    </TonePill>
                  </div>
                </div>
                <div className="meta">{p.description}</div>
                <div className="meta" style={{ fontSize: 12 }}>
                  命令：<code>{p.probeBinary ?? p.defaultCommand[0]}</code>
                  {p.detectedVersion ? ` · ${p.detectedVersion}` : ""}
                </div>
              </div>
            );
          })}
        </div>

        <form
          onSubmit={(e) => void handleAddCustomProvider(e)}
          style={{ borderTop: "1px solid var(--line)", paddingTop: 14, marginTop: 8 }}
        >
          <div className="field-label">添加自定义 ACP 智能体（任意支持 stdio ACP 的外部 CLI）</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr auto", gap: 8 }}>
            <input
              className="input"
              value={customId}
              onChange={(e) => setCustomId(e.target.value)}
              placeholder="ID（如 my-agent）"
            />
            <input
              className="input"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="展示名称"
            />
            <input
              className="input"
              value={customCmd}
              onChange={(e) => setCustomCmd(e.target.value)}
              placeholder="启动命令（如 my-agent --acp）"
            />
            <button type="submit" className="btn-primary">
              添加并启用
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

/**
 * 配置中心弹出窗口（点击侧边栏底部齿轮图标打开）
 */
export function ConfigModal() {
  const { ui, dispatch } = useProject();

  useEffect(() => {
    if (!ui.configModalOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dispatch({ type: "CLOSE_CONFIG_MODAL" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ui.configModalOpen, dispatch]);

  if (!ui.configModalOpen) return null;

  return (
    <div className="overlay" onClick={() => dispatch({ type: "CLOSE_CONFIG_MODAL" })}>
      <div className="modal-wrap">
        <div
          className="modal"
          style={{ width: "min(1040px, 94vw)", maxHeight: "90vh" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal-head">
            <h2>系统与智能体配置</h2>
            <button
              type="button"
              className="close-x"
              onClick={() => dispatch({ type: "CLOSE_CONFIG_MODAL" })}
            >
              关闭
            </button>
          </div>
          <div className="modal-body" style={{ background: "var(--bg)" }}>
            <ConfigPanel />
          </div>
        </div>
      </div>
    </div>
  );
}
