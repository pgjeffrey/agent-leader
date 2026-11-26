import { useProject } from "../store";
import type { Surface } from "../types";
import { INSTANCE_STATUS_LABEL, executorName, taskExecutor } from "../types";
import { StatusPill, TonePill } from "./ui";

export function SurfaceBar() {
  const { project, ui, dispatch } = useProject();
  const stageId = ui.viewingStageId ?? project.currentStageId;
  const stage = project.stages.find((s) => s.id === stageId);
  const inboxN = project.inbox.filter((i) => !i.done).length;
  const reviewN = project.tasks.filter((t) => t.status === "reported").length;
  const handoffN = project.handoffs.filter((h) => !h.confirmed).length;

  const tabs: { id: Surface; label: string; count?: number }[] = [
    { id: "tasks", label: ui.taskViewMode === "team" ? "团队视图" : "任务视图" },
    { id: "instances", label: "实例", count: project.instances.length },
    { id: "facts", label: "事实", count: project.facts.length },
    { id: "review", label: "验收", count: reviewN },
    { id: "inbox", label: "待办", count: inboxN },
    { id: "handoff", label: "交接", count: handoffN },
  ];

  const title =
    ui.surface === "tasks"
      ? `${stage?.name ?? ""}的任务`
      : tabs.find((t) => t.id === ui.surface)?.label ?? "";

  return (
    <div className="surface-row">
      <div className="surface-title">{title}</div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        {ui.surface === "tasks" && (
          <div className="tabs" aria-label="任务或团队">
            <button
              className={`tab${ui.taskViewMode === "tasks" ? " is-on" : ""}`}
              onClick={() => dispatch({ type: "SET_TASK_VIEW", mode: "tasks" })}
            >
              任务视图
            </button>
            <button
              className={`tab${ui.taskViewMode === "team" ? " is-on" : ""}`}
              onClick={() => dispatch({ type: "SET_TASK_VIEW", mode: "team" })}
            >
              团队视图
            </button>
          </div>
        )}
        <div className="tabs" aria-label="工作面">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`tab${ui.surface === t.id ? " is-on" : ""}`}
              onClick={() => {
                if (t.id === "tasks") dispatch({ type: "SET_TASK_VIEW", mode: ui.taskViewMode });
                dispatch({ type: "SET_SURFACE", surface: t.id });
              }}
            >
              {t.id === "tasks" ? "任务" : t.label}
              {t.count ? <span className="badge-n">{t.count}</span> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function TaskGrid() {
  const { project, ui, dispatch } = useProject();
  const stageId = ui.viewingStageId ?? project.currentStageId;
  let tasks = project.tasks.filter((t) => t.stageId === stageId);
  if (ui.statusFilter) tasks = project.tasks.filter((t) => t.status === ui.statusFilter);

  if (!tasks.length) {
    return <div className="empty">这一阶段暂无任务，或当前筛选下没有匹配项。</div>;
  }

  return (
    <div className="task-grid">
      {tasks.map((t) => {
        const role = project.roles.find((r) => r.id === t.roleId);
        const exec = taskExecutor(t, project.roles);
        return (
          <button
            key={t.id}
            className="task-card"
            onClick={() => dispatch({ type: "SELECT_TASK", id: t.id })}
          >
            <span className={`bar-l ${toneOf(t.status)}`} />
            <h3>{t.name}</h3>
            <div className="meta">
              负责　{role?.name ?? "未绑定"} · <span className="exec-tag">{executorName(exec)}</span>
            </div>
            <div className="doing">{t.doing}</div>
            <div className="meta">
              产物　{t.artifact}
              {t.artifactVersion ? ` · ${t.artifactVersion}` : ""}
            </div>
            <StatusPill status={t.status} />
          </button>
        );
      })}
    </div>
  );
}

function toneOf(s: string) {
  if (s === "accepted") return "ok";
  if (s === "reported") return "warn";
  if (s === "running") return "info";
  if (s === "rework") return "rework";
  return "neutral";
}

export function TeamView() {
  const { project, dispatch } = useProject();
  const cards = project.instances
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));

  if (!cards.length) return <div className="empty">还没有运行实例。</div>;

  return (
    <div className="team-grid">
      {cards.map((i) => {
        const task = project.tasks.find((t) => t.id === i.taskId);
        const role = project.roles.find((r) => r.id === i.roleId);
        const tone =
          i.status === "accepted"
            ? "ok"
            : i.status === "reported" || i.status === "awaiting-confirm"
              ? "warn"
              : i.status === "isolated" || i.status === "failed"
                ? "rework"
                : i.status === "running"
                  ? "info"
                  : "neutral";
        return (
          <button
            key={i.id}
            className="team-card"
            onClick={() => dispatch({ type: "SELECT_TASK", id: i.taskId })}
          >
            <span className={`bar-l ${tone}`} />
            <div className="who">{executorName(i.executorId)}</div>
            <div className="role">
              {role?.name} · {i.id}
              {i.sessionMode === "handoff-import" ? " · 接手" : ""}
            </div>
            <div className="doing">{task?.name ?? "—"}</div>
            <div className="meta">{i.note ?? i.label}</div>
            {i.status === "running" && (
              <div className="progress">
                <span style={{ width: `${i.progress}%` }} />
              </div>
            )}
            <TonePill tone={tone}>{INSTANCE_STATUS_LABEL[i.status]}</TonePill>
          </button>
        );
      })}
    </div>
  );
}
