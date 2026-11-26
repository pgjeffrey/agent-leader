import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { promisify } from "node:util";
import type { ManagedProcessRecord } from "../contracts/agent-sdk-types.js";

const execFileAsync = promisify(execFile);

/**
 * 进程台账存储回调接口（由 SQLite 存储层实现注入）
 */
export interface ProcessLedgerStore {
  saveProcess(record: ManagedProcessRecord): void;
  removeProcess(pid: number): void;
  listProcesses(): ManagedProcessRecord[];
}

/**
 * 判断路径是否包含目录分隔符
 */
function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

/**
 * 判断是否为 Windows 批处理包装脚本（.cmd / .bat）
 * 参考 Paseo process-internal/windows-command.ts
 */
export function isWindowsCommandScript(executablePath: string): boolean {
  const ext = extname(executablePath).toLowerCase();
  return process.platform === "win32" && (ext === ".cmd" || ext === ".bat");
}

/**
 * 安全转义 Windows cmd.exe 命令行参数，防止空格或元字符截断
 */
export function escapeWindowsCmdValue(value: string): string {
  if (process.platform !== "win32") return value;
  const isQuoted = value.startsWith('"') && value.endsWith('"');
  const unquoted = isQuoted ? value.slice(1, -1) : value;
  const escaped = unquoted.replace(/([&|^<>()!])/g, "^$1");
  if (isQuoted || /[\s"]/u.test(unquoted)) {
    const quoted = escaped
      .replace(/(\\*)"/g, (_m, slashes: string) => `${slashes}${slashes}\\"`)
      .replace(/\\+$/u, (slashes) => `${slashes}${slashes}`);
    return `"${quoted}"`;
  }
  return escaped;
}

/**
 * 在 macOS 与 Windows 上查找可执行文件绝对路径
 * 支持 PATH、PATHEXT（.exe/.cmd/.bat）以及 Windows WinGet Packages 目录探测
 */
export function findExecutableSync(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const isWin = process.platform === "win32";
  const exts = isWin
    ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .filter(Boolean)
        .map((e) => e.toLowerCase())
    : [""];

  const expandCandidates = (base: string): string[] => {
    if (!isWin) return [base];
    if (extname(base)) return [base];
    return [base, ...exts.map((ext) => `${base}${ext}`)];
  };

  if (hasPathSeparator(command)) {
    for (const candidate of expandCandidates(command)) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  const pathVar = env.PATH || env.Path || "";
  const dirs = pathVar.split(delimiter).filter(Boolean);
  // 补充 macOS 常见用户级 CLI 安装目录（桌面壳启动时可能缺失 shell PATH）
  if (!isWin && env.HOME) {
    dirs.push(
      join(env.HOME, ".local", "bin"),
      join(env.HOME, ".opencode", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    );
  }

  for (const dir of dirs) {
    for (const candidate of expandCandidates(join(dir, command))) {
      if (existsSync(candidate)) return candidate;
    }
  }

  // Windows WinGet Packages 兜底探测（参考 Paseo executable-resolution/windows.ts）
  if (isWin && env.LOCALAPPDATA) {
    const wingetRoot = join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
    try {
      const pkgDirs = readdirSync(wingetRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const pkg of pkgDirs) {
        const candidate = join(wingetRoot, pkg.name, `${command}.exe`);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // 忽略不存在目录
    }
  }

  return null;
}

/**
 * 构建统一的跨平台子进程环境变量（强制 UTF-8 编码，防止 Windows 中文乱码与交互弹窗）
 */
export function buildCrossPlatformEnv(
  overlay?: Record<string, string>,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    PYTHONUTF8: "1",
    LANG: baseEnv.LANG || "en_US.UTF-8",
    NO_BROWSER: "true",
    ...overlay,
  };
}

/**
 * 跨平台安全启动 CLI 子进程（强制 windowsHide: true，自动处理 Windows .cmd/.bat 参数转义）
 */
export function spawnManagedChild(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    instanceId?: string;
    provider?: string;
    ledger?: ProcessLedgerStore;
    detachedPosixGroup?: boolean;
  },
): ChildProcessWithoutNullStreams {
  const childEnv = buildCrossPlatformEnv(options.env);
  const resolvedBin = findExecutableSync(command, childEnv) ?? command;
  const isWin = process.platform === "win32";
  const useShell =
    isWindowsCommandScript(resolvedBin) ||
    (isWin && !hasPathSeparator(resolvedBin) && !extname(resolvedBin));

  const finalCommand = isWin && useShell ? escapeWindowsCmdValue(resolvedBin) : resolvedBin;
  const finalArgs = isWin && useShell ? args.map(escapeWindowsCmdValue) : [...args];

  const spawnOpts: SpawnOptions = {
    cwd: options.cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    shell: useShell,
    windowsHide: true,
    // POSIX 下开启独立进程组以便终止整棵子进程树
    detached: !isWin && (options.detachedPosixGroup ?? true),
  };

  const child = spawn(finalCommand, finalArgs, spawnOpts);
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error(`Failed to open stdio pipes for command: ${command}`);
  }

  const typedChild = child as ChildProcessWithoutNullStreams;
  if (typedChild.pid && options.ledger) {
    const pid = typedChild.pid;
    options.ledger.saveProcess({
      pid,
      instanceId: options.instanceId ?? "helper",
      provider: options.provider ?? "unknown",
      command: `${resolvedBin} ${args.join(" ")}`.slice(0, 500),
      startedAt: Date.now(),
    });
    typedChild.once("exit", () => {
      options.ledger?.removeProcess(pid);
    });
  }

  return typedChild;
}

/**
 * 执行短时外部命令并收集 stdout/stderr（如 git status / --version 探测）
 */
export async function execCrossPlatform(
  command: string,
  args: readonly string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const childEnv = buildCrossPlatformEnv(options?.env);
  const resolvedBin = findExecutableSync(command, childEnv) ?? command;
  const isWin = process.platform === "win32";
  const useShell =
    isWindowsCommandScript(resolvedBin) ||
    (isWin && !hasPathSeparator(resolvedBin) && !extname(resolvedBin));

  const finalCommand = isWin && useShell ? escapeWindowsCmdValue(resolvedBin) : resolvedBin;
  const finalArgs = isWin && useShell ? args.map(escapeWindowsCmdValue) : [...args];

  try {
    const { stdout, stderr } = await execFileAsync(finalCommand, finalArgs, {
      cwd: options?.cwd,
      env: childEnv,
      shell: useShell,
      windowsHide: true,
      timeout: options?.timeoutMs ?? 15_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    });
    return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; message?: string };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : (e.message ?? String(err)),
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

/**
 * 跨平台彻底终止子进程及其派生的整棵子进程树（优雅 SIGTERM -> 超时强制 SIGKILL / taskkill）
 */
export async function terminateProcessTree(
  child: ChildProcess,
  options: { gracefulTimeoutMs?: number; forceTimeoutMs?: number } = {},
): Promise<"already-exited" | "terminated" | "killed" | "kill-timeout"> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return "already-exited";
  }

  const gracefulMs = options.gracefulTimeoutMs ?? 2_000;
  const forceMs = options.forceTimeoutMs ?? 1_500;
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  await killPidTree(child.pid, "SIGTERM", child);
  if (await raceTimeout(exitPromise, gracefulMs)) {
    return "terminated";
  }

  await killPidTree(child.pid, "SIGKILL", child);
  return (await raceTimeout(exitPromise, forceMs)) ? "killed" : "kill-timeout";
}

/**
 * 按平台向 PID 及其子孙进程树发送终止信号
 */
async function killPidTree(
  pid: number | undefined,
  signal: "SIGTERM" | "SIGKILL",
  fallbackChild?: ChildProcess,
): Promise<void> {
  if (!pid || pid <= 0) {
    try {
      fallbackChild?.kill(signal);
    } catch {
      // 忽略已退出竞争
    }
    return;
  }

  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 4_000,
      });
    } catch {
      try {
        fallbackChild?.kill(signal);
      } catch {
        // 忽略已退出进程
      }
    }
    return;
  }

  // POSIX: 优先杀负 PID 进程组，失败再回退单 PID
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 进程已退出
    }
  }
}

/**
 * Daemon 启动时扫描进程台账，安全回收上次异常崩溃遗留的孤儿进程（核对命令行指纹，绝不盲目 killall）
 */
export async function reapOrphanProcesses(ledger: ProcessLedgerStore): Promise<number> {
  const records = ledger.listProcesses();
  let reaped = 0;
  for (const rec of records) {
    const binName = rec.command.split(/\s+/)[0]?.split(/[/\\]/).pop()?.toLowerCase() ?? "";
    const aliveMatch = await verifyProcessIdentity(rec.pid, binName);
    if (aliveMatch) {
      await killPidTree(rec.pid, "SIGKILL");
      reaped += 1;
    }
    ledger.removeProcess(rec.pid);
  }
  return reaped;
}

/**
 * 校验给定 PID 当前是否仍然存活且命令名与当初记录一致，防止误杀复用 PID 的无关系统进程
 */
async function verifyProcessIdentity(pid: number, expectedBinFragment: string): Promise<boolean> {
  if (!expectedBinFragment) return false;
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "tasklist.exe",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { windowsHide: true, timeout: 3_000 },
      );
      return stdout.toLowerCase().includes(expectedBinFragment);
    }
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
      timeout: 3_000,
    });
    return stdout.toLowerCase().includes(expectedBinFragment);
  } catch {
    return false;
  }
}

function raceTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
