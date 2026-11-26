import { AgentLeaderDaemonServer } from "./server/daemon-server.js";

export * from "./server/daemon-server.js";
export * from "./orchestrator/orchestrator.js";
export * from "./brain/leader-brain.js";
export * from "./storage/database.js";
export * from "./workspace/worktree-manager.js";
export * from "./acceptance/evidence-collector.js";
export * from "./facts/secret-redactor.js";
export * from "./runtime/contracts/agent-sdk-types.js";
export * from "./runtime/control/agent-manager.js";
export * from "./runtime/control/message-delivery.js";
export * from "./runtime/process/process-supervisor.js";
export * from "./runtime/providers/provider-registry.js";
export * from "./runtime/return-channels/timeline-projection.js";
export * from "./runtime/return-channels/finish-subscriptions.js";
export * from "./runtime/return-channels/structured-response.js";
export * from "./runtime/return-channels/message-envelope.js";
export * from "./runtime/return-channels/activity-curator.js";

/**
 * 当直接作为独立本地守护进程启动时，绑定 127.0.0.1 并监听退出信号优雅回收
 */
const isDirectMain =
  process.argv[1] &&
  (process.argv[1].endsWith("/daemon/src/index.ts") ||
    process.argv[1].endsWith("\\daemon\\src\\index.ts") ||
    process.argv[1].endsWith("/daemon/dist/index.js") ||
    process.argv[1].endsWith("\\daemon\\dist\\index.js"));

if (isDirectMain) {
  const daemon = new AgentLeaderDaemonServer();
  const desiredPort = Number(process.env.AGENT_LEADER_PORT || 6868);

  daemon
    .start(desiredPort)
    .then(({ port }) => {
      console.log(
        `[AgentLeader Daemon] 本地守护进程已就绪 -> http://127.0.0.1:${port} (OS: ${process.platform})`,
      );
    })
    .catch((err) => {
      console.error("[AgentLeader Daemon] 启动失败:", err);
      process.exit(1);
    });

  const gracefulExit = () => {
    void daemon.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", gracefulExit);
  process.on("SIGTERM", gracefulExit);
}
