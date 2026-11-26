import { useEffect, useState } from "react";
import { useProject } from "../store";
import {
  INSTANCE_STATUS_LABEL,
  executorName,
  taskExecutor,
  type ProjectedTimelineEntry,
} from "../types";
import { ExecutorSelect, StatusPill, TonePill } from "./ui";

/**
 * 任务与实例实时执行详情抽屉
 * 包含：任务依赖与上下文、执行器改绑、实时流式过程监控（TimelineProjection）、运行中转向（Steer）、中断与验收裁决
 */
export function TaskDetail() {
  const {
    state,
    project,
    ui,
    settings,
    dispatch,
    requestTimeline,
    sendInstancePrompt,
    interruptInstance,
  } = useProject();

  const [steerInput, setSteerInput] = useState("");
  const task = project.tasks.find((t) => t.id === ui.selectedTaskId);

  const instances = task ? project.instances.filter((i) => i.taskId === task.id) : [];
  const latest = instances.at(-1);

  useEffect(() => {
    if (latest?.id) {
      requestTimeline(latest.id);
    }
  }, [latest?.id, requestTimeline]);

  if (!task) return null;

  const role = project.roles.find((r) => r.id === task.roleId);
  const exec = taskExecutor(task, project.roles);
  const report = [...instances].reverse().find((i) => i.report)?.report;
  const deps = task.deps.map((d) => project.tasks.find((t) => t.id === d)).filter(Boolean);
  const blockedByDeps = deps.some((d) => d && d.status !== "accepted");
  const timelineEntries: ProjectedTimelineEntry[] = latest
    ? (state.timelines[latest.id] ?? [])
    : [];

  return (
    <div className="overlay" onClick={() => dispatch({ type: "SELECT_TASK", id: null })}>
      <aside className="drawer" style={{ width: "min(580px, 48vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <h2>{task.name}</h2>
            <div className="meta">
              {role?.name} · {executorName(exec, settings.customProviders)}　
              <StatusPill status={task.status} />
              {(task.splitDepth ?? 0) > 0 && (
                <span className="pill info" style={{ marginLeft: 6 }}>
                  动态细化 L{task.splitDepth}
                </span>
              )}
            </div>
          </div>
          <button className="close-x" onClick={() => dispatch({ type: "SELECT_TASK", id: null })}>
            关闭
          </button>
        </div>

        <div className="drawer-body">
          <div className="section-k">当前任务与依赖关系</div>
          <p style={{ margin: 0 }}>{task.doing}</p>
          {task.instruction && (
            <p className="meta" style={{ margin: "6px 0 0" }}>
              派工指令：{task.instruction}
            </p>
          )}
          {task.worktreePath && (
            <div className="meta" style={{ marginTop: 6 }}>
              工作区目录：<code>{task.worktreePath}</code>
              {task.branchName ? `（分支 ${task.branchName}）` : ""}
            </div>
          )}
          {deps.length > 0 && (
            <div className="meta" style={{ marginTop: 8 }}>
              前置依赖：
              {deps.map((d) => `${d!.name}（${d!.status === "accepted" ? "已验收" : "未验收"}）`).join("、")}
              {blockedByDeps ? " —— 前置未全部验收，严禁提前开工。" : ""}
            </div>
          )}
          <div className="meta" style={{ marginTop: 8 }}>
            客观验收标准：{task.acceptance.join("；")}
          </div>

          <div className="section-k">执行器绑定（随时可改绑）</div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <ExecutorSelect
              value={exec}
              onChange={(executorId) =>
                dispatch({ type: "REBIND_TASK", taskId: task.id, executorId })
              }
            />
            {!blockedByDeps && (task.status === "pending" || task.status === "rework") && (
              <button
                className="btn-primary"
                onClick={() => dispatch({ type: "DISPATCH_TASK", taskId: task.id })}
              >
                立即派工给 {executorName(exec, settings.customProviders)}
              </button>
            )}
          </div>

          <div className="section-k">运行实例记录</div>
          <p className="meta" style={{ margin: "0 0 6px" }}>
            目标产物：{task.artifact}
            {task.artifactVersion ? ` · 版本 ${task.artifactVersion}` : " · 待核验版本"}
          </p>
          {instances.length === 0 && <div className="meta">尚未启动运行实例。</div>}
          {instances.map((i) => (
            <div key={i.id} className="meta" style={{ marginTop: 6 }}>
              <strong>{i.id}</strong> · {executorName(i.executorId, settings.customProviders)} ·{" "}
              {INSTANCE_STATUS_LABEL[i.status]} · 写权限：{i.writeAccess ? "有效（持有写锁）" : "已回收/只读"}
              {i.note ? ` —— ${i.note}` : ""}
            </div>
          ))}

          {latest && (
            <>
              <div className="section-k">
                实时过程监控（{latest.id} · {executorName(latest.executorId, settings.customProviders)}）
              </div>
              <div className="timeline-box">
                {timelineEntries.length === 0 ? (
                  <div className="meta">
                    {latest.frozen
                      ? "示例预置实例处于冻结展示态。在底部对话输入「继续推进」即可唤醒流式执行。"
                      : "等待执行智能体回传实时流事件…"}
                  </div>
                ) : (
                  timelineEntries.map((entry) => (
                    <TimelineRow key={`${entry.epoch}-${entry.seq}`} entry={entry} />
                  ))
                )}
              </div>

              {latest.status === "running" && !latest.frozen && (
                <form
                  style={{ display: "flex", gap: 8, marginTop: 8 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!steerInput.trim()) return;
                    sendInstancePrompt(latest.id, steerInput.trim(), "steer");
                    setSteerInput("");
                  }}
                >
                  <input
                    className="input"
                    style={{ padding: "7px 10px" }}
                    value={steerInput}
                    onChange={(e) => setSteerInput(e.target.value)}
                    placeholder="运行中实时转向引导（Steer）：补充约束或微调方向…"
                  />
                  <button className="btn-ghost" type="submit" disabled={!steerInput.trim()}>
                    注入引导
                  </button>
                  <button
                    className="btn-danger"
                    type="button"
                    onClick={() => interruptInstance(latest.id)}
                  >
                    中断
                  </button>
                </form>
              )}
            </>
          )}

          {report && (
            <>
              <div className="section-k">结构化回报与客观验收依据</div>
              <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{report.done}</p>
              <div className="handoff-field" style={{ marginTop: 10 }}>
                <div className="k">产物与真实版本标识</div>
                <div className="v">
                  {report.artifacts
                    .map((a) => `${a.path} · ${a.version}${a.verified ? "（已核实）" : "（未找到实体）"}`)
                    .join("；")}
                </div>
              </div>
              <div className="handoff-field">
                <div className="k">Daemon 实测客观证据</div>
                <div className="v">{report.evidence}</div>
              </div>
              <div className="handoff-field">
                <div className="k">模型意见（仅作参考，不替代证据）</div>
                <div className="v">{report.opinion}</div>
              </div>
              {report.leaderDecisionNote && (
                <div className="handoff-field">
                  <div className="k">指挥大模型裁决说明</div>
                  <div className="v">{report.leaderDecisionNote}</div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="drawer-foot">
          {instances.length > 0 &&
            (task.status === "running" ||
              task.status === "rework" ||
              task.status === "reported" ||
              task.status === "blocked") && (
              <button
                className="btn-ghost"
                onClick={() => dispatch({ type: "OPEN_HANDOFF", taskId: task.id })}
              >
                换人接手（生成交接包）
              </button>
            )}
          {task.status === "reported" && (
            <>
              <button
                className="btn-danger"
                onClick={() =>
                  dispatch({
                    type: "REJECT_TASK",
                    taskId: task.id,
                    reason: "缺少约定的测试或客观运行证据，退回返工。",
                  })
                }
              >
                退回返工
              </button>
              <button
                className="btn-primary"
                onClick={() => dispatch({ type: "ACCEPT_TASK", taskId: task.id })}
              >
                人工确认验收通过
              </button>
            </>
          )}
          {task.status === "running" && latest && (
            <TonePill tone="info">
              {executorName(latest.executorId, settings.customProviders)} 执行中
            </TonePill>
          )}
        </div>
      </aside>
    </div>
  );
}

function TimelineRow({ entry }: { entry: ProjectedTimelineEntry }) {
  const { item } = entry;
  if (item.type === "reasoning") {
    return (
      <div className="tl-item tl-thought">
        <span className="tl-tag">思考</span>
        <span>{item.text}</span>
      </div>
    );
  }
  if (item.type === "assistant_message") {
    return (
      <div className="tl-item tl-assistant">
        <span className="tl-tag">输出</span>
        <span style={{ whiteSpace: "pre-wrap" }}>{item.text}</span>
      </div>
    );
  }
  if (item.type === "user_message") {
    return (
      <div className="tl-item tl-user">
        <span className="tl-tag">派工指令</span>
        <span>{item.text.split("\n")[0]?.slice(0, 120)}</span>
      </div>
    );
  }
  if (item.type === "tool_call") {
    const summary =
      item.detail.type === "shell"
        ? item.detail.command
        : item.detail.type === "edit" || item.detail.type === "write"
          ? item.detail.path
          : item.detail.type === "read" || item.detail.type === "search"
            ? item.detail.target
            : item.name;
    return (
      <div className="tl-item tl-tool">
        <span className="tl-tag">
          工具:{item.name} ({item.status})
        </span>
        <code>{summary}</code>
      </div>
    );
  }
  if (item.type === "error") {
    return (
      <div className="tl-item tl-err">
        <span className="tl-tag">错误</span>
        <span>{item.message}</span>
      </div>
    );
  }
  return null;
}
