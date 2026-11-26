import { spawn } from "node:child_process";
import net from "node:net";

/**
 * 探测从 preferredPort 开始的第一个 127.0.0.1 空闲端口（若被占用则自动顺延或回退系统随机空闲端口）
 */
async function findAvailablePort(preferredPort, maxRange = 20) {
  const candidates = [
    ...Array.from({ length: maxRange + 1 }, (_, i) => preferredPort + i),
    0,
  ];
  for (const port of candidates) {
    const freePort = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.unref();
      srv.once("error", () => resolve(null));
      srv.listen(port, "127.0.0.1", () => {
        const addr = srv.address();
        const actual = typeof addr === "object" && addr ? addr.port : port;
        srv.close(() => resolve(actual));
      });
    });
    if (freePort) return freePort;
  }
  return preferredPort;
}

/**
 * 跨平台本地双进程开发启动脚本（自动避开端口冲突并将统一真实端口同步给 Daemon 与 Vite 代理）
 */
const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";
const preferredPort = Number(process.env.AGENT_LEADER_PORT || 6868);
const resolvedDaemonPort = await findAvailablePort(preferredPort);

if (resolvedDaemonPort !== preferredPort) {
  console.warn(
    `[dev] 端口 ${preferredPort} 已被其他进程占用，自动切换本地 Daemon 与代理端口至 ${resolvedDaemonPort}`,
  );
}

const sharedEnv = {
  ...process.env,
  AGENT_LEADER_PORT: String(resolvedDaemonPort),
};

function startProc(label, args) {
  const child = spawn(npmCmd, args, {
    stdio: "inherit",
    shell: isWin,
    windowsHide: true,
    env: sharedEnv,
  });
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`[${label}] exited with code ${code}`);
    }
  });
  return child;
}

const daemon = startProc("daemon", ["--workspace", "@agent-leader/daemon", "run", "dev"]);
const web = startProc("web", ["--workspace", "@agent-leader/web", "run", "dev"]);

function shutdown() {
  daemon.kill("SIGTERM");
  web.kill("SIGTERM");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
