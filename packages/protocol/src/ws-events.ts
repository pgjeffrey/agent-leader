import type { Project, SystemSettings } from "./entities.js";
import type { ProviderRuntimeSnapshot } from "./providers.js";
import type {
  ActiveTurnBehavior,
  AgentPermissionResponse,
  AgentStreamEvent,
  ProjectedTimelineEntry,
  TimelinePage,
} from "./runtime.js";

/**
 * Daemon 向客户端推送的 WebSocket 实时消息联合类型
 */
export type ServerToClientWsMessage =
  | {
      type: "daemon.hello";
      seq: number;
      daemonVersion: string;
      platform: string;
      projects: Project[];
      activeProjectId: string;
      settings: SystemSettings;
      providers: ProviderRuntimeSnapshot[];
    }
  | {
      type: "project.updated";
      seq: number;
      project: Project;
    }
  | {
      type: "projects.list";
      seq: number;
      projects: Project[];
      activeProjectId: string;
    }
  | {
      type: "settings.updated";
      seq: number;
      settings: SystemSettings;
      providers: ProviderRuntimeSnapshot[];
    }
  | {
      type: "agent.stream";
      seq: number;
      projectId: string;
      instanceId: string;
      event: AgentStreamEvent;
      projectedEntry?: ProjectedTimelineEntry;
      epoch: number;
    }
  | {
      type: "timeline.page";
      requestId: string;
      page: TimelinePage;
    }
  | {
      type: "brain.status";
      seq: number;
      projectId: string;
      phase: "idle" | "planning" | "evaluating" | "chatting";
      detail?: string;
    }
  | {
      type: "daemon.error";
      message: string;
    };

/**
 * 客户端向 Daemon 发送的 WebSocket 请求消息联合类型
 */
export type ClientToServerWsMessage =
  | {
      type: "timeline.fetch";
      requestId: string;
      instanceId: string;
      afterSeq?: number;
      limit?: number;
    }
  | {
      type: "instance.prompt";
      projectId: string;
      instanceId: string;
      text: string;
      behavior?: ActiveTurnBehavior;
    }
  | {
      type: "instance.interrupt";
      projectId: string;
      instanceId: string;
    }
  | {
      type: "permission.respond";
      projectId: string;
      instanceId: string;
      requestId: string;
      response: AgentPermissionResponse;
    };
