import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Artifact, Task } from "@agent-leader/protocol";
import { classifyHighRiskCommand } from "../facts/secret-redactor.js";
import { execCrossPlatform } from "../runtime/process/process-supervisor.js";

/**
 * Daemon 自动采集的不可伪造客观工程证据包（送交指挥大模型做验收裁决）
 */
export interface CollectedObjectiveEvidence {
  cwd: string;
  gitRevision: string;
  gitStatusLines: string[];
  gitDiffStat: string;
  artifacts: Artifact[];
  verificationSummary: string;
  evidenceSummary: string;
  commandResults: Array<{
    command: string;
    exitCode: number;
    outputTail: string;
    skippedHighRisk?: string;
  }>;
  allChecksPassed: boolean;
}

/**
 * 客观证据采集与校验服务（EvidenceCollector）
 * 在执行智能体回报完成后，自动实测核验磁盘产物真实版本、Git Diff 与验证命令退出码
 */
export class EvidenceCollector {
  /**
   * 针对指定任务与工作目录采集完整客观证据
   */
  async collect(task: Task, cwd: string): Promise<CollectedObjectiveEvidence> {
    const gitRevRes = await execCrossPlatform("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      timeoutMs: 4_000,
    });
    const gitStatusRes = await execCrossPlatform("git", ["status", "--porcelain"], {
      cwd,
      timeoutMs: 4_000,
    });
    const gitDiffStatRes = await execCrossPlatform("git", ["diff", "--stat", "HEAD"], {
      cwd,
      timeoutMs: 5_000,
    });

    const headSha = gitRevRes.exitCode === 0 && gitRevRes.stdout.trim() ? gitRevRes.stdout.trim() : "local";
    const statusLines =
      gitStatusRes.exitCode === 0
        ? gitStatusRes.stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
        : [];
    const diffStat = gitDiffStatRes.exitCode === 0 ? gitDiffStatRes.stdout.trim() : "";

    // 1. 核对约定产物是否存在及真实文件指纹版本
    const artifacts: Artifact[] = [];
    const declaredTargets = task.artifact
      .split(/[、,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const target of declaredTargets) {
      const fullPath = isAbsolute(target) ? target : join(cwd, target);
      if (existsSync(fullPath)) {
        const st = statSync(fullPath);
        if (st.isFile()) {
          const contentHash = createHash("sha256")
            .update(readFileSync(fullPath))
            .digest("hex")
            .slice(0, 8);
          artifacts.push({
            path: target,
            version: `${headSha}-${contentHash}`,
            verified: st.size > 0,
          });
        } else {
          artifacts.push({ path: target, version: `${headSha}-dir`, verified: true });
        }
      } else {
        // 若填写的是抽象概念名称（如“接口改动”），结合 Git 变更文件补充真实改动列表
        if (statusLines.length > 0) {
          const touched = statusLines.slice(0, 4).map((l) => l.slice(3).trim());
          for (const file of touched) {
            artifacts.push({ path: file, version: `${headSha}-dirty`, verified: true });
          }
        } else {
          artifacts.push({ path: target, version: `${headSha}-missing`, verified: false });
        }
      }
    }

    // 2. 运行任务声明的自动验证命令（拦截高风险命令）
    const commandResults: CollectedObjectiveEvidence["commandResults"] = [];
    let allChecksPassed = true;

    for (const rawCmd of task.verificationCommands ?? []) {
      const risk = classifyHighRiskCommand(rawCmd);
      if (risk.isHighRisk) {
        allChecksPassed = false;
        commandResults.push({
          command: rawCmd,
          exitCode: -1,
          outputTail: "",
          skippedHighRisk: `高风险命令已拦截待批（${risk.reason}）`,
        });
        continue;
      }

      const shellBin = process.platform === "win32" ? "cmd.exe" : "sh";
      const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", rawCmd] : ["-c", rawCmd];
      const runRes = await execCrossPlatform(shellBin, shellArgs, {
        cwd,
        timeoutMs: 45_000,
      });

      if (runRes.exitCode !== 0) {
        allChecksPassed = false;
      }
      const combined = `${runRes.stdout}\n${runRes.stderr}`.trim();
      commandResults.push({
        command: rawCmd,
        exitCode: runRes.exitCode,
        outputTail: combined.slice(-800),
      });
    }

    const verificationSummary =
      commandResults.length > 0
        ? commandResults
            .map((c) =>
              c.skippedHighRisk
                ? `${c.command}: ${c.skippedHighRisk}`
                : `${c.command} -> exitCode=${c.exitCode}`,
            )
            .join("；")
        : "已执行 Git 工作区变更与磁盘产物存在性核验";

    const evidenceParts: string[] = [
      `Git 基准版本: ${headSha}，变更文件数: ${statusLines.length}`,
    ];
    if (diffStat) {
      evidenceParts.push(`Diff 统计: ${diffStat.replace(/\s+/g, " ").slice(0, 240)}`);
    }
    if (artifacts.length > 0) {
      evidenceParts.push(
        `产物校验: ${artifacts.map((a) => `${a.path}(${a.version}, ${a.verified ? "存在且已核实" : "未找到实体文件"})`).join("、")}`,
      );
    }
    for (const c of commandResults) {
      evidenceParts.push(
        c.skippedHighRisk
          ? `[拦截] ${c.command}: ${c.skippedHighRisk}`
          : `[命令验证] ${c.command} (exit=${c.exitCode}) ${c.outputTail ? `输出摘要: ${c.outputTail.slice(0, 220)}` : ""}`,
      );
    }

    return {
      cwd,
      gitRevision: headSha,
      gitStatusLines: statusLines,
      gitDiffStat: diffStat,
      artifacts,
      verificationSummary,
      evidenceSummary: evidenceParts.join(" ｜ "),
      commandResults,
      allChecksPassed,
    };
  }
}
