export * from "@agent-leader/protocol";
import type { ProjectExecutionMode, Surface, TaskStatus } from "@agent-leader/protocol";

/**
 * 工作台前端本地 UI 视图状态
 */
export interface AppUi {
  view: "workbench" | "new-project";
  surface: Surface;
  viewingStageId: string | null;
  taskViewMode: "tasks" | "team";
  selectedTaskId: string | null;
  openHandoffId: string | null;
  configModalOpen: boolean;
  summaryOpen: boolean;
  statusFilter: TaskStatus | null;
  draftName: string;
  draftBackground: string;
  draftGoal: string;
  draftRepoPath: string;
  draftExecutionMode: ProjectExecutionMode;
  draftUseWorktree: boolean;
}
