import { useState } from "react";
import { useProject } from "../store";
import { executorName } from "../types";

/**
 * 顶部全局状态栏：显示当前项目、当前指挥官与可指挥 Agent 摘要
 */
export function TopBar() {
  const { state, project, ui, settings, providers, dispatch } = useProject();
  const title = ui.view === "new-project" || !project ? "新建项目" : project.name;

  const brainLabel =
    !settings.brain.cliProviderId || settings.brain.cliProviderId === "heuristic"
      ? "本地规则"
      : executorName(settings.brain.cliProviderId, settings.customProviders);

  const commandableAgents = providers
    .filter((p) => p.enabled && p.healthStatus !== "error")
    .map((p) => p.short);
  const agentsSummary =
    commandableAgents.length === 0
      ? "暂无"
      : commandableAgents.length <= 5
        ? commandableAgents.join(" · ")
        : `${commandableAgents.slice(0, 5).join(" · ")} 等 ${commandableAgents.length} 个`;

  return (
    <header className="topbar">
      <div className="brand">Agent Leader</div>
      <span className="crumb-sep">|</span>
      <div className="crumb">{title}</div>
      {state.brainStatus.phase !== "idle" && (
        <span className="pill info">
          指挥官：{state.brainStatus.detail || state.brainStatus.phase}
        </span>
      )}
      <div className="topbar-spacer" />
      <button
        type="button"
        className="badge"
        style={{ border: 0 }}
        onClick={() => dispatch({ type: "OPEN_CONFIG_MODAL" })}
        title={`指挥官：${brainLabel}；可指挥 Agent：${commandableAgents.join("、") || "暂无"}（点击打开配置）`}
      >
        指挥官：{brainLabel} ｜ 可指挥：{agentsSummary}
      </button>
      {!state.connected && (
        <div className="pill warn" style={{ fontSize: 12 }}>
          本地服务重连中…
        </div>
      )}
    </header>
  );
}

/**
 * 左侧项目导航栏：
 * - 鼠标悬停到项目条目上时，在左侧平滑展开重命名与删除（仅删记录不删磁盘目录）两个图标按钮
 * - 底部右侧配备线性齿轮配置按钮
 */
export function Sidebar() {
  const { projects, project, ui, dispatch, renameProject, deleteProject } = useProject();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  function startRename(id: string, currentName: string) {
    setEditingId(id);
    setEditingName(currentName);
  }

  async function commitRename(id: string) {
    const trimmed = editingName.trim();
    setEditingId(null);
    if (!trimmed) return;
    await renameProject(id, trimmed);
  }

  async function handleDelete(id: string, name: string) {
    const confirmed = window.confirm(
      `确认从列表中删除项目「${name}」吗？\n（仅删除项目记录，不会删除本地磁盘目录与文件）`,
    );
    if (!confirmed) return;
    if (editingId === id) {
      setEditingId(null);
    }
    await deleteProject(id);
  }

  return (
    <aside className="sidebar">
      <button
        className={`btn-new${ui.view === "new-project" ? " is-active" : ""}`}
        onClick={() => dispatch({ type: "OPEN_NEW_PROJECT" })}
      >
        +　新建项目
      </button>
      <div className="side-label">本地项目列表</div>
      <div className="side-projects">
        {projects.map((p) => {
          const isActive = project?.id === p.id && ui.view === "workbench";
          const isEditing = editingId === p.id;
          return (
            <div
              key={p.id}
              className={`project-item${isActive ? " is-active" : ""}${isEditing ? " is-editing" : ""}`}
              onClick={() => {
                if (!isEditing) {
                  dispatch({ type: "SELECT_PROJECT", id: p.id });
                }
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (!isEditing && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  dispatch({ type: "SELECT_PROJECT", id: p.id });
                }
              }}
            >
              <div className="project-info">
                {isEditing ? (
                  <input
                    className="project-rename-input"
                    value={editingName}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={() => void commitRename(p.id)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        void commitRename(p.id);
                      } else if (e.key === "Escape") {
                        setEditingId(null);
                      }
                    }}
                  />
                ) : (
                  <span className="name">{p.name}</span>
                )}
                <span className="sub">
                  {p.isExample
                    ? "示例项目 · 本地模拟"
                    : p.executionMode === "mock"
                      ? "自建项目 · 模拟演练"
                      : p.repoPath
                        ? p.repoPath.split(/[/\\]/).pop()
                        : "本地项目"}
                </span>
              </div>

              <div
                className="project-actions"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="icon-btn-proj"
                  title="重命名项目"
                  aria-label={`重命名 ${p.name}`}
                  onClick={() => startRename(p.id, p.name)}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="icon-btn-proj is-danger"
                  title="删除项目记录（不删本地目录）"
                  aria-label={`删除 ${p.name}`}
                  onClick={() => void handleDelete(p.id, p.name)}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 6h18" />
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="side-bottom-bar">
        <button
          type="button"
          className={`icon-btn-gear${ui.configModalOpen ? " is-active" : ""}`}
          onClick={() => dispatch({ type: "OPEN_CONFIG_MODAL" })}
          aria-label="打开配置窗口"
          title="系统与智能体配置"
        >
          <svg
            width="19"
            height="19"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
