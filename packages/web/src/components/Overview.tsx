import { overviewColumns, projectCounts, useProject } from "../store";
import type { TaskStatus } from "../types";
import { TASK_STATUS_META } from "../types";

const FILTERS: TaskStatus[] = ["accepted", "reported", "running", "rework", "pending"];

export function ProjectHead() {
  const { project, ui, dispatch } = useProject();
  return (
    <section className="card project-head">
      <button className="fold-btn" onClick={() => dispatch({ type: "TOGGLE_SUMMARY" })}>
        {ui.summaryOpen ? "收起摘要" : "展开摘要"}
      </button>
      <h1>{project.name}</h1>
      {ui.summaryOpen && (
        <>
          <p className="goal-line">目标：{project.goal}</p>
          {project.background && <p className="goal-more">背景：{project.background}</p>}
        </>
      )}
    </section>
  );
}

export function Overview() {
  const { project, ui, dispatch } = useProject();
  const c = projectCounts(project);
  const pct = c.total ? Math.round((c.accepted / c.total) * 100) : 0;
  const cols = overviewColumns(project);
  const done = c.accepted === c.total && c.total > 0;

  return (
    <section className="card">
      <div className="ov-head">
        <div className="ov-title">项目概况</div>
        <span className={`pill ${done ? "ok" : "warn"}`}>
          {done ? "已完成" : "进行中，尚未完成"}
        </span>
      </div>
      <div className="rate-label">
        任务验收完成率
        <span className="info-i" tabIndex={0}>
          i
          <span className="tip">
            按计划任务数计验收完成率。待验收与返工不计入完成。单项或某执行器完成，都不等于项目完成。测试通过前，项目不得标为完成。
          </span>
        </span>
      </div>
      <div className="rate-row">
        <span className="rate-k">已验收</span>
        <span className="rate-n">
          {c.accepted} / {c.total}
        </span>
        <span className="rate-pct">·　{pct}%</span>
      </div>
      <div className="bar">
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="dist-label">状态分布</div>
      <div className="dist-row">
        {FILTERS.map((s) => {
          const meta = TASK_STATUS_META[s];
          const on = ui.statusFilter === s;
          return (
            <button
              key={s}
              className={`chip-btn pill ${meta.tone} ${meta.tone}-line${on ? " is-on" : ""}`}
              onClick={() => dispatch({ type: "FILTER_STATUS", status: s })}
            >
              {meta.label}　{c[s]}
              <span className="caret">▼</span>
            </button>
          );
        })}
      </div>
      <hr className="ov-rule" />
      <div className="ov-cols">
        {cols.map((col) => (
          <div className="ov-col" key={col.title}>
            <h3 className={col.tone}>
              <span className={`dot ${col.tone}`} />
              {col.title}
            </h3>
            <ul>
              {col.items.map((it) => (
                <li key={it}>·　{it}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
