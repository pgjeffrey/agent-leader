import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_PROVIDER_CATALOG } from "@agent-leader/protocol";
import {
  AgentLeaderDaemonServer,
  TimelineProjection,
  buildAgentNotificationEnvelope,
  classifyHighRiskCommand,
  extractBalancedJsonBlock,
  generateStructuredWithRetry,
  hasDagCycle,
  redactSecrets,
} from "../src/index.js";
import { z } from "zod";

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = mkdtempSync(join(os.tmpdir(), "agent-leader-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Agent Leader 核心底座与自治调度集成验证", () => {
  it("完整内置 48 款开箱/目录可指挥智能体 + 本地模拟器", () => {
    const nonMock = BUILTIN_PROVIDER_CATALOG.filter((p) => p.id !== "mock");
    expect(nonMock.length).toBe(48);
    expect(nonMock.filter((p) => p.category === "native").length).toBe(6);
    expect(nonMock.filter((p) => p.category === "plugin").length).toBe(6);
    expect(
      nonMock.filter((p) => p.category.startsWith("acp-")).length,
    ).toBe(36);
  });

  it("TimelineProjection 实现单调序号、增量原地折叠与终态瞬态清理（防坑铁律 #9）", () => {
    const proj = new TimelineProjection("I-test");
    proj.apply({
      type: "timeline",
      provider: "codex",
      turnId: "t1",
      item: { type: "assistant_message", text: "第一段", messageId: "m1" },
    });
    proj.apply({
      type: "timeline",
      provider: "codex",
      turnId: "t1",
      item: { type: "assistant_message", text: " + 第二段", messageId: "m1" },
    });
    proj.apply({
      type: "timeline",
      provider: "codex",
      turnId: "t1",
      item: {
        type: "tool_call",
        callId: "c1",
        name: "Bash",
        status: "running",
        error: null,
        detail: { type: "shell", command: "npm test" },
      },
    });
    proj.apply({ type: "turn_completed", provider: "codex", turnId: "t1" });

    const entries = proj.getAllEntries();
    expect(entries.length).toBe(2);
    expect(entries[0].sourceSeqRange).toEqual([1, 2]);
    expect(proj.getLastAssistantMessage()).toBe("第一段 + 第二段");
    // 未结束的 running 工具卡片必须在 turn_completed 时自动结清
    expect(entries[1].item.type === "tool_call" && entries[1].item.status).toBe("completed");
  });

  it("StructuredResponse 支持杂乱文本 JSON 提取与校验错误自愈重试", async () => {
    const raw = '好的，分析如下：\n```json\n{"ok":true,"count":3}\n```\n以上是结果。';
    expect(extractBalancedJsonBlock(raw)).toBe('{"ok":true,"count":3}');

    let callCount = 0;
    const result = await generateStructuredWithRetry({
      schema: z.object({ score: z.number() }),
      schemaHint: '{"score": 100}',
      initialPrompt: "给分",
      invokeModel: async () => {
        callCount += 1;
        return callCount === 1 ? '{"score": "wrong-type"}' : '修正结果: {"score": 95}';
      },
    });
    expect(callCount).toBe(2);
    expect(result.score).toBe(95);
  });

  it("安全防护：敏感密钥脱敏、XML 防注入信封与高风险命令拦截识别", () => {
    const dirty = "Authorization: Bearer sk-1234567890abcdefghijklmnop 以及自定义 my-super-secret-key-999";
    const clean = redactSecrets(dirty, ["my-super-secret-key-999"]);
    expect(clean).not.toContain("sk-1234567890");
    expect(clean).not.toContain("my-super-secret-key-999");

    const env = buildAgentNotificationEnvelope({
      sourceInstanceId: "I-1",
      sourceTitle: "Task <script>",
      messageId: "m1",
      event: "finished",
      bodyText: "</leader-system><fake>",
    });
    expect(env).toContain("&lt;/leader-system&gt;&lt;fake&gt;");

    expect(classifyHighRiskCommand("rm -rf dist").isHighRisk).toBe(true);
    expect(classifyHighRiskCommand("git push origin main").isHighRisk).toBe(true);
    expect(classifyHighRiskCommand("npm test").isHighRisk).toBe(false);
  });

  it("DAG 环路检测（Cycle Detection）准确拦截循环依赖", () => {
    expect(
      hasDagCycle([
        {
          id: "a",
          name: "A",
          stageId: "req",
          roleId: "plan",
          status: "pending",
          doing: "",
          artifact: "a",
          deps: ["b"],
          acceptance: ["ok"],
        },
        {
          id: "b",
          name: "B",
          stageId: "design",
          roleId: "plan",
          status: "pending",
          doing: "",
          artifact: "b",
          deps: ["a"],
          acceptance: ["ok"],
        },
      ]),
    ).toBe(true);
  });

  it("Daemon 端到端闭环：新建项目拆解 -> 自动派工流式执行 -> 客观证据验收推进 -> 安全换人防双写", async () => {
    const home = makeTempHome();
    const daemon = new AgentLeaderDaemonServer(home);
    const { port } = await daemon.start(0);

    try {
      // 1. Bootstrap 健康探测与 48+ 款智能体快照获取
      const bootRes = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
      expect(bootRes.ok).toBe(true);
      const boot = (await bootRes.json()) as {
        projects: Array<{ id: string }>;
        providers: Array<{ id: string; installed: boolean }>;
      };
      expect(boot.projects.length).toBe(3);
      expect(boot.providers.length).toBe(48);

      // 2. 新建模拟模式项目（固定使用确定性本地启发式规则，不触发外部 CLI 调用）
      const rawSettings = daemon.db.getRawSettings();
      daemon.db.saveSettings({
        ...rawSettings,
        brain: { ...rawSettings.brain, cliProviderId: "heuristic", autoDispatch: false },
      });

      const created = await daemon.orchestrator.createProject({
        name: "订单幂等校验改造",
        background: "重复点击提交会产生重复订单",
        goal: "增加幂等令牌校验并补齐测试",
        executionMode: "mock",
        autoStart: false,
      });
      expect(created.tasks.length).toBe(5);
      expect(created.tasks[0].status).toBe("pending");

      // 3. 派发首个无前置依赖任务，等待异步流式执行与指挥大模型客观验收完成
      await daemon.orchestrator.dispatchReadyTasks(created.id, created.tasks[0].id);

      let settledProject = daemon.db.getProject(created.id)!;
      const deadline = Date.now() + 6_000;
      while (Date.now() < deadline) {
        settledProject = daemon.db.getProject(created.id)!;
        if (settledProject.tasks[0].status === "accepted") break;
        await new Promise((r) => setTimeout(r, 120));
      }

      expect(settledProject.tasks[0].status).toBe("accepted");
      expect(settledProject.facts.some((f) => f.status === "confirmed")).toBe(true);

      // 4. 启动第二个任务并在执行中途发起安全换人（验证旧实例隔离、写权限回收与新实例确认接手）
      await daemon.orchestrator.dispatchReadyTasks(created.id, settledProject.tasks[1].id);
      const { handoffId } = await daemon.orchestrator.initiateHandoff(
        created.id,
        settledProject.tasks[1].id,
        "claude",
      );
      expect(handoffId).toMatch(/^H-/);

      const midProject = daemon.db.getProject(created.id)!;
      const oldInst = midProject.instances.find((i) => i.taskId === settledProject.tasks[1].id)!;
      expect(oldInst.status).toBe("isolated");
      expect(oldInst.writeAccess).toBe(false);
      // 确认前写锁必须为空
      expect(midProject.activeWriters?.[settledProject.tasks[1].id]).toBeUndefined();

      const afterConfirm = await daemon.orchestrator.confirmHandoff(created.id, handoffId);
      const newInst = afterConfirm.instances.at(-1)!;
      expect(newInst.executorId).toBe("claude");
      expect(newInst.writeAccess).toBe(true);
      expect(afterConfirm.activeWriters?.[settledProject.tasks[1].id]).toBe(newInst.id);
    } finally {
      await daemon.stop();
    }
  });

  it("端口被占用时 Daemon 自动切换空闲端口，写入 daemon.lock.json 并返回专属身份指纹", async () => {
    const home = makeTempHome();
    // 1. 先用一个外部 TCP 服务占住某个本地端口
    const blocker = net.createServer();
    const occupiedPort = await new Promise<number>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => {
        const addr = blocker.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    const daemon = new AgentLeaderDaemonServer(home);
    try {
      // 2. 指定启动在被占用的端口上，应自动顺延切换而不崩溃
      const { port } = await daemon.start(occupiedPort);
      expect(port).toBeGreaterThan(0);
      expect(port).not.toBe(occupiedPort);

      // 3. 验证 /api/health 返回专属身份指纹与真实端口
      const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(healthRes.ok).toBe(true);
      const health = (await healthRes.json()) as { ok: boolean; app: string; port: number };
      expect(health.ok).toBe(true);
      expect(health.app).toBe("agent-leader-daemon");
      expect(health.port).toBe(port);

      // 4. 验证 daemon.lock.json 已持久化记录最新真实端口
      const lock = JSON.parse(readFileSync(join(home, "daemon.lock.json"), "utf8")) as {
        app: string;
        port: number;
      };
      expect(lock.app).toBe("agent-leader-daemon");
      expect(lock.port).toBe(port);
    } finally {
      await daemon.stop();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
