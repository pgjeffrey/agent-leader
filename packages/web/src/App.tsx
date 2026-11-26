import { ChatPanel } from "./components/ChatPanel";
import { Sidebar, TopBar } from "./components/Chrome";
import { HandoffModal } from "./components/HandoffModal";
import { NewProject } from "./components/NewProject";
import { Overview, ProjectHead } from "./components/Overview";
import {
  ConfigModal,
  ConfigPanel,
  FactsPanel,
  HandoffList,
  InboxPanel,
  InstancesPanel,
  ReviewPanel,
} from "./components/Panels";
import { StageFlow } from "./components/StageFlow";
import { SurfaceBar, TaskGrid, TeamView } from "./components/TaskBoard";
import { TaskDetail } from "./components/TaskDetail";
import { StoreProvider, useProject } from "./store";

/**
 * 工作台主区域视图
 */
function Workbench() {
  const { ui } = useProject();
  return (
    <>
      <div className="main-scroll">
        <ProjectHead />
        <Overview />
        <StageFlow />
        <SurfaceBar />
        {ui.surface === "tasks" && (ui.taskViewMode === "team" ? <TeamView /> : <TaskGrid />)}
        {ui.surface === "instances" && <InstancesPanel />}
        {ui.surface === "facts" && <FactsPanel />}
        {ui.surface === "review" && <ReviewPanel />}
        {ui.surface === "inbox" && <InboxPanel />}
        {ui.surface === "handoff" && <HandoffList />}
        {ui.surface === "config" && <ConfigPanel />}
      </div>
      <ChatPanel />
    </>
  );
}

/**
 * 应用顶层布局骨架
 */
function Shell() {
  const { ui, project } = useProject();
  const showNewProject = ui.view === "new-project" || !project;
  return (
    <div className="app">
      <TopBar />
      <div className="shell">
        <Sidebar />
        <main className="main">
          {showNewProject ? (
            <div className="main-scroll">
              <NewProject />
            </div>
          ) : (
            <Workbench />
          )}
        </main>
      </div>
      {project && <TaskDetail />}
      {project && <HandoffModal />}
      <ConfigModal />
    </div>
  );
}

/**
 * 应用根组件
 */
export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
