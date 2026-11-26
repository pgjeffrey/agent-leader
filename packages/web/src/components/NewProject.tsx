import { useState } from "react";
import { useProject } from "../store";

/**
 * 新建项目表单页面：
 * - 无需手动填写项目名称，启动后自动根据背景与目标生成并展示在左侧项目列表
 * - 支持点击按钮弹出本机原生文件夹选择框选择项目目录；未选时默认在系统「文档」目录下创建
 */
export function NewProject() {
  const { state, projects, ui, dispatch, pickDirectory } = useProject();
  const [pickingDir, setPickingDir] = useState(false);

  const ready =
    Boolean(ui.draftBackground.trim() && ui.draftGoal.trim()) && !state.busyCreating;

  async function handlePickDirectory() {
    setPickingDir(true);
    try {
      const res = await pickDirectory();
      if (!res.canceled && res.path) {
        dispatch({ type: "SET_DRAFT", field: "draftRepoPath", value: res.path });
      }
    } finally {
      setPickingDir(false);
    }
  }

  return (
    <div className="new-page">
      <h1 style={{ marginBottom: 18 }}>新建项目</h1>

      <div className="form-block">
        <div className="field-label">项目背景、现有情况与约束</div>
        <textarea
          className="textarea"
          value={ui.draftBackground}
          onChange={(e) =>
            dispatch({ type: "SET_DRAFT", field: "draftBackground", value: e.target.value })
          }
          placeholder="现在的问题是什么，有哪些技术栈约束或已有材料。"
        />
      </div>

      <div className="form-block">
        <div className="field-label">项目要达成的目标与证据要求</div>
        <textarea
          className="textarea"
          value={ui.draftGoal}
          onChange={(e) => dispatch({ type: "SET_DRAFT", field: "draftGoal", value: e.target.value })}
          placeholder="要达成什么结果，怎样才算验收完成（如单测通过、类型检查通过）。"
        />
      </div>

      <div className="form-block">
        <div className="field-label">项目目录（选填）</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            className="input"
            value={ui.draftRepoPath}
            onChange={(e) =>
              dispatch({ type: "SET_DRAFT", field: "draftRepoPath", value: e.target.value })
            }
            placeholder="未选择时默认在系统「文档」目录下自动创建项目文件夹"
          />
          <button
            type="button"
            className="btn-ghost"
            style={{ whiteSpace: "nowrap", flexShrink: 0 }}
            disabled={pickingDir}
            onClick={() => void handlePickDirectory()}
          >
            {pickingDir ? "正在选择…" : "选择文件夹"}
          </button>
          {ui.draftRepoPath && (
            <button
              type="button"
              className="btn-ghost"
              style={{ whiteSpace: "nowrap", flexShrink: 0 }}
              onClick={() => dispatch({ type: "SET_DRAFT", field: "draftRepoPath", value: "" })}
            >
              清空
            </button>
          )}
        </div>
      </div>

      <div className="new-actions">
        {projects.length > 0 && (
          <button
            className="btn-ghost"
            style={{ marginRight: 8 }}
            disabled={state.busyCreating}
            onClick={() => dispatch({ type: "CANCEL_NEW_PROJECT" })}
          >
            取消
          </button>
        )}
        <button
          className="btn-primary"
          disabled={!ready}
          onClick={() => dispatch({ type: "CREATE_PROJECT" })}
        >
          {state.busyCreating ? "指挥官正在自动命名并拆解任务…" : "开始拆解并组建团队"}
        </button>
      </div>
    </div>
  );
}
