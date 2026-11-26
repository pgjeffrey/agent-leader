import { useProject } from "../store";

export function StageFlow() {
  const { project, ui, dispatch } = useProject();
  const hasRework = project.tasks.some((t) => t.status === "rework");
  const n = project.stages.length;
  const devIdx = project.stages.findIndex((s) => s.id === "dev" || s.name === "开发实现");
  const testIdx = project.stages.findIndex((s) => s.id === "test" || s.name === "测试验收");

  return (
    <section className="card">
      <div className="stage-head">阶段流程</div>
      <div className="stage-rail">
        {project.stages.map((st, i) => {
          const viewing = (ui.viewingStageId ?? project.currentStageId) === st.id;
          const current =
            st.kind === "current" ||
            (st.kind !== "done" && st.id === project.currentStageId && st.kind !== "parallel");
          const slotCls = [
            "stage-slot",
            current ? "is-current" : "",
            viewing ? "is-viewing" : "",
          ].join(" ");
          const cls = [
            "stage-item",
            `is-${st.kind}`,
            current ? "is-current" : "",
            viewing ? "is-viewing" : "",
          ].join(" ");
          return (
            <div className={slotCls} key={st.id}>
              {current && <span className="flag">项目当前阶段</span>}
              {!current && viewing && st.id !== project.currentStageId && (
                <span className="flag view">正在查看（历史阶段）</span>
              )}
              <button
                className={cls}
                onClick={() =>
                  dispatch({
                    type: "SET_STAGE",
                    stageId: ui.viewingStageId === st.id ? null : st.id,
                  })
                }
              >
                <span className="stage-icon">{st.kind === "done" ? "✓" : i + 1}</span>
                <span>
                  <span className="stage-name">{st.name}</span>
                  <span className="stage-status">{st.statusLabel}</span>
                </span>
              </button>
            </div>
          );
        })}
      </div>
      {hasRework && devIdx >= 0 && testIdx >= 0 && (
        <div className="rework-loop">
          <svg viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden>
            {(() => {
              const x1 = ((devIdx + 0.55) / n) * 1000;
              const x2 = ((testIdx + 0.45) / n) * 1000;
              return (
                <>
                  <path
                    d={`M ${x2} 2 C ${x2} 28, ${x1} 28, ${x1} 6`}
                    fill="none"
                    stroke="#8a3b2f"
                    strokeWidth="1.7"
                  />
                  <polygon points={`${x1-7},10 ${x1+7},10 ${x1},1`} fill="#8a3b2f" />
                </>
              );
            })()}
          </svg>
          <div className="rework-tag">测试不通过　·　失败提示退回</div>
        </div>
      )}
    </section>
  );
}
