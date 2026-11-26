import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";

/**
 * Electron 跨平台桌面端宿主启动器（支持 macOS 与 Windows）
 * 职责：
 * 1) 结合 daemon.lock.json 与 /api/health 专属身份指纹，复用已运行的 Agent Leader Daemon（不误连占用 6868 的无关软件）
 * 2) 未运行时自动以无黑框模式拉起 Daemon，支持端口冲突自动顺延/动态分配后自动发现实际端口
 */
export interface DesktopBootstrapOptions {
  daemonEntryScript: string;
  daemonPort?: number;
  homeDir?: string;
  webUrl?: string;
}

interface DaemonLockRecord {
  app?: string;
  pid?: number;
  port?: number;
}

/**
 * 解析跨平台默认数据目录（与 Daemon 侧保持完全一致）
 */
function resolveHomeDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.AGENT_LEADER_HOME) return resolve(process.env.AGENT_LEADER_HOME);
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(os.homedir(), "AppData", "Roaming");
    return join(appData, "AgentLeader");
  }
  return join(os.homedir(), ".agent-leader");
}

/**
 * 读取本地 daemon.lock.json 获取上次/当前绑定的真实端口
 */
function readDaemonLock(homeDir: string): DaemonLockRecord | null {
  const lockPath = join(homeDir, "daemon.lock.json");
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as DaemonLockRecord;
  } catch {
    return null;
  }
}

/**
 * 校验目标端口上运行的是否确实为 Agent Leader Daemon（比对专属 app 身份指纹）
 */
async function checkAgentLeaderHealth(port: number): Promise<boolean> {
  if (!port || port <= 0) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean; app?: string };
    return data.ok === true && data.app === "agent-leader-daemon";
  } catch {
    return false;
  }
}

/**
 * 探测或拉起本地 Daemon 守护进程并等待健康检查就绪，自动处理端口冲突后的动态端口发现
 */
export async function ensureLocalDaemonRunning(
  options: DesktopBootstrapOptions,
): Promise<{ port: number; child: ChildProcess | null }> {
  const preferredPort = options.daemonPort ?? Number(process.env.AGENT_LEADER_PORT || 6868);
  const homeDir = resolveHomeDir(options.homeDir);

  // 1. 先检查锁文件中记录的真实端口和首选端口，若已运行本应用 Daemon 则直接复用
  const existingLock = readDaemonLock(homeDir);
  const initialCandidates = [...new Set([existingLock?.port, preferredPort].filter((p): p is number => Boolean(p && p > 0)))];
  for (const candidatePort of initialCandidates) {
    if (await checkAgentLeaderHealth(candidatePort)) {
      return { port: candidatePort, child: null };
    }
  }

  // 2. 拉起本地 Daemon（若首选端口被其他软件占用，Daemon 会自动切换空闲端口并更新 daemon.lock.json）
  const child = spawn(process.execPath, [resolve(options.daemonEntryScript)], {
    env: {
      ...process.env,
      AGENT_LEADER_PORT: String(preferredPort),
      AGENT_LEADER_HOME: homeDir,
    },
    stdio: "ignore",
    detached: false,
    windowsHide: true,
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const lock = readDaemonLock(homeDir);
    const probePorts = [...new Set([lock?.port, preferredPort].filter((p): p is number => Boolean(p && p > 0)))];
    for (const p of probePorts) {
      if (await checkAgentLeaderHealth(p)) {
        return { port: p, child };
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(`本地 Agent Leader Daemon 未能在 10 秒内就绪（首选端口 ${preferredPort}）`);
}
