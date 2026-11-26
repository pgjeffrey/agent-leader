import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import { join, normalize, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Task } from "@agent-leader/protocol";
import { execCrossPlatform } from "../runtime/process/process-supervisor.js";

/**
 * 获取跨平台（macOS / Windows）应用本地数据根目录
 */
export function getAgentLeaderHomeDir(): string {
  if (process.env.AGENT_LEADER_HOME) {
    return resolve(process.env.AGENT_LEADER_HOME);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(os.homedir(), "AppData", "Roaming");
    return join(appData, "AgentLeader");
  }
  return join(os.homedir(), ".agent-leader");
}

/**
 * 获取跨平台（macOS / Windows）用户「文档（Documents）」目录路径
 */
export function getUserDocumentsDir(): string {
  const docs = join(os.homedir(), "Documents");
  mkdirSync(docs, { recursive: true });
  return docs;
}

/**
 * 当用户新建项目未指定项目目录时，在系统「文档」目录下创建专属项目工作目录（兼容 macOS 与 Windows）
 */
export function ensureDefaultDocumentsProjectDir(projectName: string, projectId: string): string {
  const docsRoot = getUserDocumentsDir();
  const safeBase = projectName
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\.+$/g, "")
    .slice(0, 40)
    .trim();
  const folderName = safeBase ? `${safeBase}-${projectId.slice(-4)}` : projectId;
  const targetDir = join(docsRoot, folderName);
  mkdirSync(targetDir, { recursive: true });
  return targetDir;
}

/**
 * 弹出操作系统原生文件夹选择框（macOS 使用 AppleScript Finder 对话框，Windows 使用 PowerShell FolderBrowserDialog）
 */
export async function pickLocalDirectory(): Promise<{ canceled: boolean; path?: string }> {
  if (process.platform === "darwin") {
    const script = 'POSIX path of (choose folder with prompt "选择项目目录")';
    const res = await execCrossPlatform("osascript", ["-e", script], {
      timeoutMs: 120_000,
    });
    if (res.exitCode !== 0) {
      // 用户点击取消时 osascript 会返回 -128
      return { canceled: true };
    }
    const chosen = res.stdout.trim().replace(/\/+$/, "");
    return chosen ? { canceled: false, path: chosen } : { canceled: true };
  }

  if (process.platform === "win32") {
    const psScript = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = '选择项目目录'",
      "$dialog.UseDescriptionForTitle = $true",
      "$dialog.SelectedPath = [Environment]::GetFolderPath('MyDocuments')",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
    ].join("; ");
    const res = await execCrossPlatform(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", psScript],
      { timeoutMs: 120_000 },
    );
    if (res.exitCode !== 0) {
      return { canceled: true };
    }
    const chosen = res.stdout.trim();
    return chosen ? { canceled: false, path: chosen } : { canceled: true };
  }

  return { canceled: true };
}

/**
 * 工作区与 Git Worktree 隔离管理器
 * 支持独立分支 Worktree 创建、换人前检查点快照采集、并行目标路径冲突预检与安全清理
 */
export class WorktreeManager {
  private readonly worktreesRoot: string;

  constructor(homeDir = getAgentLeaderHomeDir()) {
    this.worktreesRoot = join(homeDir, "worktrees");
    mkdirSync(this.worktreesRoot, { recursive: true });
  }

  /**
   * 检测给定目录是否为合法 Git 仓库并返回仓库根目录
   */
  async resolveGitRepoRoot(dirPath: string): Promise<string | null> {
    if (!dirPath || !existsSync(dirPath)) return null;
    const res = await execCrossPlatform("git", ["rev-parse", "--show-toplevel"], {
      cwd: dirPath,
      timeoutMs: 5_000,
    });
    if (res.exitCode !== 0 || !res.stdout.trim()) return null;
    return res.stdout.trim();
  }

  /**
   * 为子任务准备执行工作区：
   * - 若启用 Worktree 隔离且目标目录为有效 Git 仓库，则创建或复用独立分支 Worktree
   * - 否则回退使用项目配置目录（若未配置则分配受管沙箱目录）
   */
  async prepareTaskWorkspace(params: {
    projectId: string;
    taskId: string;
    repoPath?: string;
    isolateWorktree?: boolean;
  }): Promise<{ cwd: string; branchName?: string; isWorktree: boolean }> {
    const baseDir = params.repoPath?.trim();
    if (!baseDir || !existsSync(baseDir)) {
      const sandboxDir = join(this.worktreesRoot, params.projectId, "sandbox");
      mkdirSync(sandboxDir, { recursive: true });
      return { cwd: sandboxDir, isWorktree: false };
    }

    if (!params.isolateWorktree) {
      return { cwd: resolve(baseDir), isWorktree: false };
    }

    const gitRoot = await this.resolveGitRepoRoot(baseDir);
    if (!gitRoot) {
      return { cwd: resolve(baseDir), isWorktree: false };
    }

    const safeProj = params.projectId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const safeTask = params.taskId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const branchName = `al/${safeProj}/${safeTask}`;
    const targetDir = join(this.worktreesRoot, safeProj, safeTask);

    if (existsSync(targetDir)) {
      return { cwd: targetDir, branchName, isWorktree: true };
    }

    mkdirSync(join(this.worktreesRoot, safeProj), { recursive: true });
    const addRes = await execCrossPlatform(
      "git",
      ["worktree", "add", "-B", branchName, targetDir, "HEAD"],
      { cwd: gitRoot, timeoutMs: 15_000 },
    );

    if (addRes.exitCode === 0 && existsSync(targetDir)) {
      return { cwd: targetDir, branchName, isWorktree: true };
    }

    // 若空仓库尚无初始 HEAD commit 导致 worktree 创建失败，平滑回退主目录
    return { cwd: gitRoot, isWorktree: false };
  }

  /**
   * 换人或中断前采集当前工作区检查点标识（Git HEAD SHA + 未提交变更摘要 Hash）
   */
  async captureCheckpoint(cwd: string): Promise<{ checkpointRef: string; statusSummary: string }> {
    if (!cwd || !existsSync(cwd)) {
      return { checkpointRef: "ckpt-empty", statusSummary: "工作区尚无磁盘变更" };
    }

    const headRes = await execCrossPlatform("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      timeoutMs: 4_000,
    });
    const statusRes = await execCrossPlatform("git", ["status", "--short"], {
      cwd,
      timeoutMs: 4_000,
    });
    const diffRes = await execCrossPlatform("git", ["diff", "HEAD"], {
      cwd,
      timeoutMs: 6_000,
    });

    if (headRes.exitCode !== 0) {
      return { checkpointRef: `fs-snap-${Date.now().toString(36)}`, statusSummary: "非 Git 目录快照" };
    }

    const headSha = headRes.stdout.trim() || "unborn";
    const dirtyHash = diffRes.stdout.trim()
      ? createHash("sha256").update(diffRes.stdout).digest("hex").slice(0, 7)
      : "clean";
    const statusLines = statusRes.stdout.trim();

    return {
      checkpointRef: `${headSha}:${dirtyHash}`,
      statusSummary: statusLines || "工作树干净（无未提交修改）",
    };
  }

  /**
   * 检测待派工任务与当前正在运行任务之间是否存在目标文件或目录重叠风险（PRD FR-14）
   */
  detectTargetConflicts(candidate: Task, runningTasks: readonly Task[]): string[] {
    const candidatePaths = (candidate.targetPaths ?? []).map(normalizeComparePath).filter(Boolean);
    if (candidatePaths.length === 0) return [];

    const conflicts: string[] = [];
    for (const active of runningTasks) {
      if (active.id === candidate.id) continue;
      for (const activePath of (active.targetPaths ?? []).map(normalizeComparePath)) {
        if (!activePath) continue;
        const overlaps = candidatePaths.some(
          (cp) =>
            cp === activePath ||
            cp.startsWith(`${activePath}/`) ||
            activePath.startsWith(`${cp}/`),
        );
        if (overlaps) {
          conflicts.push(`与正在执行的「${active.name}」共享目标路径 ${activePath}`);
        }
      }
    }
    return conflicts;
  }

  /**
   * 清理项目归档后的受管 Git Worktree
   */
  async removeManagedWorktree(repoPath: string, worktreePath: string): Promise<void> {
    if (!worktreePath.startsWith(this.worktreesRoot)) return;
    await execCrossPlatform("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoPath,
      timeoutMs: 10_000,
    });
  }
}

function normalizeComparePath(p: string): string {
  return normalize(p).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}
