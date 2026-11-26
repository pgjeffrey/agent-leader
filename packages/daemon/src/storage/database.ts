import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BUILTIN_PROVIDER_CATALOG,
  type BrainConfig,
  type ProjectedTimelineEntry,
  type Project,
  type Role,
  type SystemSettings,
} from "@agent-leader/protocol";
import type { ManagedProcessRecord } from "../runtime/contracts/agent-sdk-types.js";
import {
  findExecutableSync,
  type ProcessLedgerStore,
} from "../runtime/process/process-supervisor.js";
import type {
  FinishSubscriptionRecord,
  FinishSubscriptionStore,
} from "../runtime/return-channels/finish-subscriptions.js";
import { TimelineProjection } from "../runtime/return-channels/timeline-projection.js";
import { getAgentLeaderHomeDir } from "../workspace/worktree-manager.js";
import { DEFAULT_SEED_PROJECTS } from "./seed-projects.js";

/** 默认后台指挥官 CLI 探测优先级 */
const PREFERRED_BRAIN_CLI_IDS = ["codex", "claude", "antigravity", "cursor", "opencode"] as const;

/**
 * 自动探测本机最优先可用的已安装 CLI 作为默认后台指挥官；未找到则回退本地规则模式
 */
function detectDefaultBrainCliProviderId(): string {
  for (const id of PREFERRED_BRAIN_CLI_IDS) {
    const def = BUILTIN_PROVIDER_CATALOG.find((p) => p.id === id);
    if (!def) continue;
    const bin = def.probeBinary ?? def.defaultCommand[0];
    if (findExecutableSync(bin)) {
      return id;
    }
  }
  return "heuristic";
}

/**
 * 归一化后台指挥官配置（兼容平滑迁移旧版 HTTP API 配置结构）
 */
function normalizeBrainConfig(raw: Partial<BrainConfig> & Record<string, unknown>): BrainConfig {
  const hasCliId = typeof raw.cliProviderId === "string" && raw.cliProviderId.trim().length > 0;
  const cliProviderId = hasCliId ? raw.cliProviderId!.trim() : detectDefaultBrainCliProviderId();
  // 从旧版 HTTP 接口配置迁移时清空旧模型名，避免把第三方接口模型 ID 误传给本地 CLI
  const model = hasCliId && typeof raw.model === "string" ? raw.model.trim() : "";

  return {
    cliProviderId,
    model,
    autoDispatch: typeof raw.autoDispatch === "boolean" ? raw.autoDispatch : true,
    maxReworkCount:
      typeof raw.maxReworkCount === "number" && raw.maxReworkCount >= 1 ? raw.maxReworkCount : 3,
    maxConcurrency:
      typeof raw.maxConcurrency === "number" && raw.maxConcurrency >= 1 ? raw.maxConcurrency : 4,
  };
}

/**
 * 生成全局默认角色分工与执行智能体绑定（优先选用本机已就绪 CLI）
 */
function createDefaultRoles(): Role[] {
  const defaultExec = detectDefaultBrainCliProviderId();
  const fallback = defaultExec === "heuristic" ? "codex" : defaultExec;
  const pick = (preferred: readonly string[]): string => {
    for (const id of preferred) {
      const def = BUILTIN_PROVIDER_CATALOG.find((p) => p.id === id);
      if (!def) continue;
      if (findExecutableSync(def.probeBinary ?? def.defaultCommand[0])) {
        return id;
      }
    }
    return fallback;
  };

  return [
    {
      id: "plan",
      name: "规划 Agent",
      duty: "需求梳理与技术方案",
      executorId: pick(["antigravity", "claude", "codex", "cursor", "opencode"]),
    },
    {
      id: "impl",
      name: "实现 Agent",
      duty: "核心代码实现与自测",
      executorId: pick(["codex", "claude", "cursor", "antigravity", "opencode"]),
    },
    {
      id: "test",
      name: "测试 Agent",
      duty: "自动化测试与验收核验",
      executorId: pick(["claude", "codex", "antigravity", "cursor", "opencode"]),
    },
  ];
}

/**
 * 归一化全局角色分工配置（兼容旧数据库自动补齐）
 */
function normalizeDefaultRoles(raw: unknown): Role[] {
  if (Array.isArray(raw) && raw.length > 0) {
    return raw
      .filter((r): r is Role => Boolean(r && typeof r === "object" && "id" in r && "executorId" in r))
      .map((r) => ({
        id: String(r.id),
        name: String(r.name ?? r.id),
        duty: String(r.duty ?? ""),
        executorId: String(r.executorId),
        ...(r.model ? { model: String(r.model) } : {}),
        ...(r.permissionMode ? { permissionMode: r.permissionMode } : {}),
      }));
  }
  return createDefaultRoles();
}

/**
 * 构建初始默认系统设置（优先自动选用本机已安装的 CLI 担任后台指挥官）
 */
function createDefaultSettings(): SystemSettings {
  return {
    brain: {
      cliProviderId: detectDefaultBrainCliProviderId(),
      model: "",
      autoDispatch: true,
      maxReworkCount: 3,
      maxConcurrency: 4,
    },
    defaultRoles: createDefaultRoles(),
    enabledProviderIds: BUILTIN_PROVIDER_CATALOG.filter((p) => p.enabledByDefault).map((p) => p.id),
    customProviders: [],
    hardDisabledByRole: {},
  };
}

/**
 * 本地单文件 SQLite 持久化数据库（基于 Node 22+ 原生 node:sqlite DatabaseSync，零 C++ 编译负担）
 * 同时实现进程台账存储（ProcessLedgerStore）与完成订阅存储（FinishSubscriptionStore）
 */
export class LocalDatabase implements ProcessLedgerStore, FinishSubscriptionStore {
  private readonly db: DatabaseSync;

  constructor(dbFilePath = join(getAgentLeaderHomeDir(), "agent-leader.sqlite")) {
    mkdirSync(dirname(dbFilePath), { recursive: true });
    this.db = new DatabaseSync(dbFilePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.initSchema();
    this.seedIfNeeded();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        sort_order INTEGER NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS timelines (
        instance_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        head_seq INTEGER NOT NULL,
        entries_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finish_subscriptions (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS managed_processes (
        pid INTEGER PRIMARY KEY,
        instance_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        command TEXT NOT NULL,
        started_at INTEGER NOT NULL
      );
    `);
  }

  private seedIfNeeded(): void {
    const seededRow = this.db
      .prepare("SELECT value FROM kv_meta WHERE key = 'projects_seeded'")
      .get() as { value?: string } | undefined;
    const countRow = this.db.prepare("SELECT COUNT(*) as cnt FROM projects").get() as { cnt: number };
    if (!seededRow && countRow.cnt === 0) {
      DEFAULT_SEED_PROJECTS.forEach((proj, idx) => {
        this.saveProject(proj, idx);
      });
      this.setActiveProjectId(DEFAULT_SEED_PROJECTS[0].id);
    }
    if (!seededRow) {
      this.db
        .prepare(
          "INSERT INTO kv_meta (key, value) VALUES ('projects_seeded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
        )
        .run();
    }

    const settingsRow = this.db
      .prepare("SELECT value FROM kv_meta WHERE key = 'system_settings'")
      .get() as { value?: string } | undefined;
    if (!settingsRow) {
      this.saveSettings(createDefaultSettings());
    }
  }

  /** 读取全部项目列表（按顺序排列） */
  listProjects(): Project[] {
    const rows = this.db
      .prepare("SELECT data FROM projects ORDER BY sort_order ASC, updated_at DESC")
      .all() as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as Project);
  }

  /** 读取单个项目 */
  getProject(id: string): Project | null {
    const row = this.db.prepare("SELECT data FROM projects WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Project) : null;
  }

  /** 保存或更新项目状态 */
  saveProject(project: Project, sortOrder?: number): void {
    const existing = this.db
      .prepare("SELECT sort_order FROM projects WHERE id = ?")
      .get(project.id) as { sort_order: number } | undefined;
    const order = sortOrder ?? existing?.sort_order ?? 0;
    this.db
      .prepare(
        `INSERT INTO projects (id, sort_order, data, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(project.id, order, JSON.stringify(project), Date.now());
  }

  /** 将新建项目置顶插入 */
  insertProjectAtTop(project: Project): void {
    this.db.exec("UPDATE projects SET sort_order = sort_order + 1");
    this.saveProject(project, 0);
    this.setActiveProjectId(project.id);
  }

  /** 删除单个项目记录及其关联的时间线与完成订阅（绝不删除本地磁盘项目目录） */
  deleteProject(projectId: string): void {
    const existing = this.getProject(projectId);
    if (existing) {
      const delTimeline = this.db.prepare("DELETE FROM timelines WHERE instance_id = ?");
      const delSub = this.db.prepare("DELETE FROM finish_subscriptions WHERE instance_id = ?");
      for (const inst of existing.instances) {
        delTimeline.run(inst.id);
        delSub.run(inst.id);
      }
    }
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  }

  /** 获取当前选中激活的项目 ID */
  getActiveProjectId(): string {
    const row = this.db
      .prepare("SELECT value FROM kv_meta WHERE key = 'active_project_id'")
      .get() as { value: string } | undefined;
    if (row?.value) return row.value;
    const first = this.listProjects()[0];
    return first?.id ?? "p-login";
  }

  /** 记录当前激活的项目 ID */
  setActiveProjectId(projectId: string): void {
    this.db
      .prepare(
        "INSERT INTO kv_meta (key, value) VALUES ('active_project_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(projectId);
  }

  /** 读取完整系统设置（自动兼容并迁移旧版 HTTP API 配置结构） */
  getRawSettings(): SystemSettings {
    const row = this.db
      .prepare("SELECT value FROM kv_meta WHERE key = 'system_settings'")
      .get() as { value: string } | undefined;
    if (!row) return createDefaultSettings();
    const parsed = JSON.parse(row.value) as SystemSettings & {
      brain?: Partial<BrainConfig> & Record<string, unknown>;
    };
    return {
      ...parsed,
      brain: normalizeBrainConfig(parsed.brain ?? {}),
      defaultRoles: normalizeDefaultRoles(parsed.defaultRoles),
      enabledProviderIds: Array.isArray(parsed.enabledProviderIds)
        ? parsed.enabledProviderIds
        : [],
      customProviders: Array.isArray(parsed.customProviders) ? parsed.customProviders : [],
      userProviderOverrides: parsed.userProviderOverrides ?? {},
      providerHealth: parsed.providerHealth ?? {},
      hardDisabledByRole: parsed.hardDisabledByRole ?? {},
    };
  }

  /** 读取供前端展示的系统设置快照 */
  getPublicSettings(): SystemSettings {
    return this.getRawSettings();
  }

  /** 更新系统设置 */
  saveSettings(next: SystemSettings): SystemSettings {
    const prev = this.getRawSettings();
    const merged: SystemSettings = {
      ...next,
      brain: normalizeBrainConfig(next.brain as Partial<BrainConfig> & Record<string, unknown>),
      defaultRoles: normalizeDefaultRoles(next.defaultRoles),
      enabledProviderIds: Array.isArray(next.enabledProviderIds) ? next.enabledProviderIds : [],
      customProviders: Array.isArray(next.customProviders) ? next.customProviders : [],
      userProviderOverrides: next.userProviderOverrides ?? prev.userProviderOverrides ?? {},
      providerHealth: next.providerHealth ?? prev.providerHealth ?? {},
      hardDisabledByRole: next.hardDisabledByRole ?? prev.hardDisabledByRole ?? {},
    };
    this.db
      .prepare(
        "INSERT INTO kv_meta (key, value) VALUES ('system_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(merged));
    return merged;
  }

  /** 持久化保存实例时间线投影 */
  saveProjection(instanceId: string, projection: TimelineProjection): void {
    const { epoch, headSeq } = projection.cursor();
    const entries = projection.getAllEntries();
    this.db
      .prepare(
        `INSERT INTO timelines (instance_id, epoch, head_seq, entries_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           epoch = excluded.epoch,
           head_seq = excluded.head_seq,
           entries_json = excluded.entries_json,
           updated_at = excluded.updated_at`,
      )
      .run(instanceId, epoch, headSeq, JSON.stringify(entries), Date.now());
  }

  /** 恢复实例持久化的时间线投影 */
  loadProjection(instanceId: string): TimelineProjection | undefined {
    const row = this.db
      .prepare("SELECT epoch, head_seq, entries_json FROM timelines WHERE instance_id = ?")
      .get(instanceId) as { epoch: number; head_seq: number; entries_json: string } | undefined;
    if (!row) return undefined;
    const entries = JSON.parse(row.entries_json) as ProjectedTimelineEntry[];
    return new TimelineProjection(instanceId, {
      epoch: row.epoch,
      headSeq: row.head_seq,
      entries,
    });
  }

  // ==================== FinishSubscriptionStore 实现 ====================
  saveSubscription(record: FinishSubscriptionRecord): void {
    this.db
      .prepare(
        "INSERT INTO finish_subscriptions (id, instance_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      )
      .run(record.id, record.instanceId, JSON.stringify(record));
  }

  deleteSubscription(id: string): void {
    this.db.prepare("DELETE FROM finish_subscriptions WHERE id = ?").run(id);
  }

  listSubscriptions(): FinishSubscriptionRecord[] {
    const rows = this.db.prepare("SELECT data FROM finish_subscriptions").all() as Array<{
      data: string;
    }>;
    return rows.map((r) => JSON.parse(r.data) as FinishSubscriptionRecord);
  }

  // ==================== ProcessLedgerStore 实现 ====================
  saveProcess(record: ManagedProcessRecord): void {
    this.db
      .prepare(
        `INSERT INTO managed_processes (pid, instance_id, provider, command, started_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pid) DO UPDATE SET
           instance_id = excluded.instance_id,
           provider = excluded.provider,
           command = excluded.command,
           started_at = excluded.started_at`,
      )
      .run(record.pid, record.instanceId, record.provider, record.command, record.startedAt);
  }

  removeProcess(pid: number): void {
    this.db.prepare("DELETE FROM managed_processes WHERE pid = ?").run(pid);
  }

  listProcesses(): ManagedProcessRecord[] {
    const rows = this.db
      .prepare("SELECT pid, instance_id, provider, command, started_at FROM managed_processes")
      .all() as Array<{
      pid: number;
      instance_id: string;
      provider: string;
      command: string;
      started_at: number;
    }>;
    return rows.map((r) => ({
      pid: r.pid,
      instanceId: r.instance_id,
      provider: r.provider,
      command: r.command,
      startedAt: r.started_at,
    }));
  }

  /** 关闭数据库连接 */
  close(): void {
    this.db.close();
  }
}
