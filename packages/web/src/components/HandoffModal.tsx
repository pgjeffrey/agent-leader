import { useProject } from "../store";
import { executorName, type ExecutorId } from "../types";
import { ExecutorSelect, TonePill } from "./ui";

/**
 * 标准 10 字段交接包查看与确认授权弹窗
 */
export function HandoffModal() {
  const { project, ui, settings, dispatch } = useProject();
  const pack = project.handoffs.find((h) => h.id === ui.openHandoffId);
  if (!pack) return null;
  const task = project.tasks.find((t) => t.id === pack.taskId);
  const from = project.instances.find((i) => i.id === pack.fromInstanceId);
  const canConfirm = Boolean(pack.toExecutorId) && !pack.confirmed;

  return (
    <div className="overlay" onClick={() => dispatch({ type: "CLOSE_HANDOFF" })}>
      <div className="modal-wrap">
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head">
            <div>
              <h2>交接与防双写记录　·　标准交接包 {pack.id}</h2>
              <div className="meta">
                {task?.name}　原实例 {pack.fromInstanceId}
                {from ? `（${executorName(from.executorId, settings.customProviders)}）` : ""}
                {pack.toInstanceId
                  ? ` → ${pack.toInstanceId}`
                  : pack.toExecutorId
                    ? ` → ${executorName(pack.toExecutorId, settings.customProviders)}`
                    : " → 待指定接手执行器"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <TonePill tone={pack.confirmed ? "ok" : "warn"}>
                {pack.confirmed ? "已确认并授权写锁" : "待确认（写权限锁定中）"}
              </TonePill>
              <button className="close-x" onClick={() => dispatch({ type: "CLOSE_HANDOFF" })}>
                关闭
              </button>
            </div>
          </div>

          <div className="modal-body">
            <div className="callout danger">
              已撤销原实例 {pack.fromInstanceId} 的写权限
              {from?.status === "isolated" ? "，原进程已安全隔离。" : "。"}
              {pack.checkpointRef ? ` 工作区检查点：${pack.checkpointRef}。` : ""}
              旧实例的任何迟到输出均已被拦截，不会污染新任务状态。
            </div>
            <div className="handoff-grid">
              <div>
                <Field k="1. 目标与成功标准" v={pack.goal} />
                <Field k="2. 约束与硬性要求" v={pack.constraints} />
                <Field k="3. 已完成工作摘要" v={pack.completed} />
                <Field k="4. 关键决策及依据（仅现行已确认事实）" v={pack.decisions} />
                <Field k="5. 产物清单与工作区检查点" v={pack.artifacts} />
              </div>
              <div>
                <Field k="6. 验收结果" v={pack.acceptance} />
                <Field k="7. 未解决遗留问题" v={pack.leftovers} />
                <Field k="8. 已废弃或失败方案（避坑警示，非现行事实）" v={pack.failures} />
                {pack.nextSteps && <Field k="9. 建议下一步（仅供参考）" v={pack.nextSteps} />}
                <Field k="会话托管能力边界披露" v={pack.hostGap} />
                <div className="handoff-field">
                  <div className="k">选择接手执行智能体（支持全部已启用 Provider）</div>
                  {pack.confirmed ? (
                    <div className="v">
                      {pack.toExecutorId
                        ? executorName(pack.toExecutorId, settings.customProviders)
                        : "—"}
                    </div>
                  ) : (
                    <ExecutorSelect
                      value={(pack.toExecutorId ?? "codex") as ExecutorId}
                      onChange={(executorId) =>
                        dispatch({ type: "SET_HANDOFF_TARGET", handoffId: pack.id, executorId })
                      }
                    />
                  )}
                </div>
                <div className="handoff-field">
                  <div className="k">10. 接收者开工前待确认项</div>
                  <ul className="check-list">
                    {pack.confirmItems.map((c) => (
                      <li key={c}>
                        {pack.confirmed ? "☑" : "☐"} {c}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>

          <div className="modal-foot">
            <button className="btn-ghost" onClick={() => dispatch({ type: "CLOSE_HANDOFF" })}>
              {pack.confirmed ? "关闭" : "暂不授权写权限"}
            </button>
            {!pack.confirmed && (
              <button
                className="btn-primary"
                disabled={!canConfirm}
                onClick={() => dispatch({ type: "CONFIRM_HANDOFF", handoffId: pack.id })}
              >
                确认交接包并授予唯一写权限启动接力
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="handoff-field">
      <div className="k">{k}</div>
      <div className="v" style={{ whiteSpace: "pre-wrap" }}>
        {v}
      </div>
    </div>
  );
}
