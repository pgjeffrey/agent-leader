import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  BUILTIN_PROVIDER_CATALOG,
  normalizeProviderId,
  type CustomProviderConfig,
  type ProviderCatalogDefinition,
  type ProviderModelOption,
  type ProviderRuntimeSnapshot,
} from "@agent-leader/protocol";
import type { AgentClient } from "../contracts/agent-sdk-types.js";
import {
  execCrossPlatform,
  findExecutableSync,
  type ProcessLedgerStore,
} from "../process/process-supervisor.js";
import { GenericAcpProviderClient } from "./acp-provider.js";
import { ClaudeStreamProviderClient } from "./claude-provider.js";
import { CodexProviderClient } from "./codex-provider.js";
import { JsonlRpcProviderClient } from "./jsonl-rpc-provider.js";
import { MockProviderClient } from "./mock-provider.js";

interface CachedProbe {
  installed: boolean;
  executablePath: string | null;
  detectedVersion: string | null;
  checkedAt: number;
}

const PROBE_CACHE_TTL_MS = 30_000;

/**
 * 统一 Provider 注册表与本机可用性快照管理器
 * - 精准探测本机真实安装的智能体二进制（不因仅装有 npx 误判未安装的智能体）
 * - 默认将本机已找到（installed=true）的智能体排在前面并自动勾选启用，未找到的排在后面不勾选
 */
export class ProviderRegistry {
  private readonly probeCache = new Map<string, CachedProbe>();
  private readonly modelsCache = new Map<
    string,
    { defaultModel?: string; models: ProviderModelOption[]; checkedAt: number }
  >();
  private readonly healthCache = new Map<string, { status: "ok" | "error"; message: string }>();
  private userOverrides: Record<string, boolean> = {};
  private customProviders: CustomProviderConfig[] = [];

  constructor(private readonly ledger?: ProcessLedgerStore) {}

  /**
   * 记录某个智能体最近一次主动连通性测试结果（通过 -> ok，报错 -> error 无法指挥）
   */
  setHealthResult(providerId: string, ok: boolean, message: string): void {
    const normalized = normalizeProviderId(providerId);
    this.healthCache.set(normalized, {
      status: ok ? "ok" : "error",
      message,
    });
  }

  /**
   * 同步系统设置中的用户手动勾选覆盖记录、自定义 Provider 配置与持久化的历史测试状态（热重载，无需重启进程）
   */
  applySettings(
    _enabledIds: readonly string[],
    customProviders: readonly CustomProviderConfig[],
    userOverrides: Record<string, boolean> = {},
    persistedHealth?: Record<string, "ok" | "error">,
  ): void {
    this.userOverrides = { ...userOverrides };
    this.customProviders = [...customProviders];
    if (persistedHealth) {
      this.healthCache.clear();
      for (const [id, status] of Object.entries(persistedHealth)) {
        this.healthCache.set(normalizeProviderId(id), { status, message: "" });
      }
    }
  }

  /**
   * 根据 Provider ID 与项目执行模式解析对应的 AgentClient 实例
   */
  resolveClient(providerId: string, forceMock = false): AgentClient {
    if (forceMock || providerId === "mock") {
      return new MockProviderClient(providerId);
    }

    const normalized = normalizeProviderId(providerId);
    const custom = this.customProviders.find((c) => c.id === normalized);
    if (custom) {
      return this.buildCustomClient(custom);
    }

    const def = BUILTIN_PROVIDER_CATALOG.find((p) => p.id === normalized);
    if (!def) {
      throw new Error(`未注册的执行智能体 Provider: ${providerId}`);
    }

    return this.buildBuiltinClient(def);
  }

  /**
   * 获取全部可指挥智能体的本机安装探测快照（统一大列表：本机已就绪排在前面并默认勾选，未找到排在后面）
   */
  async getSnapshots(forceRefresh = false): Promise<ProviderRuntimeSnapshot[]> {
    if (forceRefresh) {
      this.healthCache.clear();
    }
    const allDefs: Array<ProviderCatalogDefinition & { isCustom?: boolean }> = [
      ...BUILTIN_PROVIDER_CATALOG.filter((p) => p.id !== "mock"),
      ...this.customProviders.map(
        (c): ProviderCatalogDefinition & { isCustom: boolean } => ({
          id: c.id,
          name: c.name,
          short: c.name,
          category: "custom",
          vendor: `Custom (${c.extends})`,
          description: `用户自定义扩展（基于 ${c.extends}）`,
          transport:
            c.extends === "codex"
              ? "codex-app-server"
              : c.extends === "claude"
                ? "claude-stream"
                : "acp",
          defaultCommand: (c.command as [string, ...string[]] | undefined) ?? [c.id, "--acp"],
          defaultEnv: c.env,
          installUrl: "custom://local",
          enabledByDefault: c.enabled,
          isCustom: true,
        }),
      ),
    ];

    const snapshots = await Promise.all(
      allDefs.map(async (def, idx) => {
        const probe = await this.probeDefinition(def, forceRefresh);
        const enabled =
          def.id in this.userOverrides
            ? Boolean(this.userOverrides[def.id])
            : def.isCustom
              ? Boolean(def.enabledByDefault ?? true)
              : probe.installed;

        const health = this.healthCache.get(def.id);
        return {
          snapshot: {
            ...def,
            enabled,
            installed: probe.installed,
            executablePath: probe.executablePath,
            detectedVersion: probe.detectedVersion,
            healthStatus: health?.status ?? "untested",
            healthMessage: health?.message ?? null,
            isCustom: def.isCustom,
          } satisfies ProviderRuntimeSnapshot,
          idx,
        };
      }),
    );

    // 排序规则：已勾选排在最前面 -> 本机已就绪但未勾选次之 -> 未找到排后面（组内保持目录自然顺序）
    snapshots.sort((a, b) => {
      if (a.snapshot.enabled !== b.snapshot.enabled) {
        return a.snapshot.enabled ? -1 : 1;
      }
      if (a.snapshot.installed !== b.snapshot.installed) {
        return a.snapshot.installed ? -1 : 1;
      }
      return a.idx - b.idx;
    });

    return snapshots.map((entry) => entry.snapshot);
  }

  private buildBuiltinClient(def: ProviderCatalogDefinition): AgentClient {
    switch (def.transport) {
      case "codex-app-server":
        return new CodexProviderClient(def.defaultCommand, this.ledger);
      case "claude-stream":
        return new ClaudeStreamProviderClient(def.defaultCommand, this.ledger);
      case "jsonl-rpc":
        return new JsonlRpcProviderClient(def.id, def.defaultCommand, this.ledger);
      case "mock":
        return new MockProviderClient("mock");
      case "acp":
      case "opencode-http":
      case "muse-msp": {
        // 若用户本机已全局安装对应二进制（如 gemini / qwen），优先直接调用本地二进制，否则按默认命令运行
        const localBin = def.probeBinary ? findExecutableSync(def.probeBinary) : null;
        const cmd: readonly [string, ...string[]] = localBin
          ? [localBin, "--acp"]
          : def.defaultCommand;
        return new GenericAcpProviderClient(def.id, cmd, def.defaultEnv, this.ledger);
      }
    }
  }

  private buildCustomClient(custom: CustomProviderConfig): AgentClient {
    const base = BUILTIN_PROVIDER_CATALOG.find((p) => p.id === custom.extends);
    const cmd = (custom.command as [string, ...string[]] | undefined) ??
      base?.defaultCommand ?? [custom.id, "--acp"];

    if (custom.extends === "codex") {
      return new CodexProviderClient(cmd, this.ledger);
    }
    if (custom.extends === "claude") {
      return new ClaudeStreamProviderClient(cmd, this.ledger);
    }
    return new GenericAcpProviderClient(custom.id, cmd, custom.env, this.ledger);
  }

  private async probeDefinition(
    def: ProviderCatalogDefinition,
    forceRefresh: boolean,
  ): Promise<CachedProbe> {
    const cached = this.probeCache.get(def.id);
    if (!forceRefresh && cached && Date.now() - cached.checkedAt < PROBE_CACHE_TTL_MS) {
      return cached;
    }

    const targetBinary = def.probeBinary ?? def.defaultCommand[0];
    const execPath = findExecutableSync(targetBinary);
    if (!execPath) {
      const miss: CachedProbe = {
        installed: false,
        executablePath: null,
        detectedVersion: null,
        checkedAt: Date.now(),
      };
      this.probeCache.set(def.id, miss);
      return miss;
    }

    let version: string | null = null;
    const res = await execCrossPlatform(execPath, ["--version"], { timeoutMs: 2_000 });
    const line = (res.stdout || res.stderr).split(/\r?\n/).find((l) => l.trim());
    if (res.exitCode === 0 && line) {
      version = line.trim().slice(0, 64);
    }

    const hit: CachedProbe = {
      installed: true,
      executablePath: execPath,
      detectedVersion: version,
      checkedAt: Date.now(),
    };
    this.probeCache.set(def.id, hit);
    return hit;
  }

  /**
   * 从本机已安装的指定 CLI 中读取真实可用的模型列表（供配置中心模型下拉框选择）
   */
  async listModels(
    providerId: string,
    forceRefresh = false,
  ): Promise<{ providerId: string; defaultModel?: string; models: ProviderModelOption[] }> {
    const normalized = normalizeProviderId(providerId);
    if (!normalized || normalized === "heuristic" || normalized === "mock") {
      return { providerId: normalized, models: [] };
    }

    const cached = this.modelsCache.get(normalized);
    if (!forceRefresh && cached && Date.now() - cached.checkedAt < PROBE_CACHE_TTL_MS) {
      return {
        providerId: normalized,
        defaultModel: cached.defaultModel,
        models: cached.models,
      };
    }

    let result: { defaultModel?: string; models: ProviderModelOption[] } = { models: [] };
    if (normalized === "antigravity") {
      result = await readAntigravityModels();
    } else if (normalized === "codex") {
      result = readCodexModels();
    } else if (normalized === "claude") {
      result = readClaudeModels();
    } else if (normalized === "opencode") {
      result = await readOpenCodeModels();
    } else if (normalized === "cursor") {
      result = await readCursorModels();
    } else {
      const custom = this.customProviders.find((c) => c.id === normalized);
      if (custom?.models?.length) {
        result = {
          models: custom.models.map((m) => ({ id: m, label: m })),
        };
      }
    }

    this.modelsCache.set(normalized, { ...result, checkedAt: Date.now() });
    return {
      providerId: normalized,
      defaultModel: result.defaultModel,
      models: result.models,
    };
  }
}

/** 去除 CLI 输出中的 ANSI 颜色/控制转义字符 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
}

/**
 * 读取 Antigravity CLI 可用模型列表（agy models）
 */
async function readAntigravityModels(): Promise<{
  defaultModel?: string;
  models: ProviderModelOption[];
}> {
  const bin = findExecutableSync("agy");
  if (!bin) return { models: [] };

  const res = await execCrossPlatform(bin, ["models"], { timeoutMs: 8_000 });
  if (res.exitCode !== 0) return { models: [] };

  const models: ProviderModelOption[] = [];
  const seen = new Set<string>();
  for (const rawLine of stripAnsi(res.stdout).split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("warning:") || line.startsWith("Error:")) continue;
    const match = line.match(/^([a-zA-Z0-9._:/-]+)\s+(.+)$/);
    const id = match ? match[1].trim() : line.split(/\s+/)[0]?.trim();
    const label = match ? match[2].trim() : id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: label && label !== id ? `${label} (${id})` : id });
  }
  return { models };
}

/**
 * 读取 Codex CLI 本地模型目录缓存（~/.codex/models_cache.json）与默认模型（~/.codex/config.toml）
 */
function readCodexModels(): { defaultModel?: string; models: ProviderModelOption[] } {
  const codexHome = process.env.CODEX_HOME || join(os.homedir(), ".codex");
  let defaultModel: string | undefined;

  const configPath = join(codexHome, "config.toml");
  if (existsSync(configPath)) {
    try {
      const toml = readFileSync(configPath, "utf8");
      const m = toml.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
      if (m?.[1]) defaultModel = m[1].trim();
    } catch {
      // 忽略配置文件读取异常
    }
  }

  const models: ProviderModelOption[] = [];
  const seen = new Set<string>();
  const cachePath = join(codexHome, "models_cache.json");
  if (existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as {
        models?: Array<{
          slug?: string;
          display_name?: string;
          visibility?: string;
          priority?: number;
        }>;
      };
      const visible = (parsed.models ?? [])
        .filter((m) => Boolean(m.slug) && m.visibility !== "hide")
        .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

      for (const item of visible) {
        const id = item.slug!.trim();
        if (seen.has(id)) continue;
        seen.add(id);
        const name = item.display_name?.trim();
        models.push({ id, label: name && name !== id ? `${name} (${id})` : id });
      }
    } catch {
      // 忽略缓存解析异常
    }
  }

  if (defaultModel && !seen.has(defaultModel)) {
    models.unshift({ id: defaultModel, label: defaultModel });
  }

  return { defaultModel, models };
}

/**
 * 读取 Claude Code 本地配置模型（~/.claude/settings.json）及内置标准模型别名
 */
function readClaudeModels(): { defaultModel?: string; models: ProviderModelOption[] } {
  const settingsPath = join(os.homedir(), ".claude", "settings.json");
  const models: ProviderModelOption[] = [];
  const seen = new Set<string>();
  let defaultModel: string | undefined;

  const pushUnique = (id: string, label?: string) => {
    const clean = id.trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    models.push({ id: clean, label: label ? `${label} (${clean})` : clean });
  };

  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        model?: string;
        env?: Record<string, string>;
      };
      if (typeof parsed.model === "string" && parsed.model.trim()) {
        defaultModel = parsed.model.trim();
        pushUnique(defaultModel);
      }
      const env = parsed.env ?? {};
      const envModelKeys = [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      ];
      for (const key of envModelKeys) {
        const val = env[key];
        if (typeof val === "string" && val.trim()) {
          if (!defaultModel && key === "ANTHROPIC_MODEL") {
            defaultModel = val.trim();
          }
          pushUnique(val);
        }
      }
    } catch {
      // 忽略配置文件解析异常
    }
  }

  pushUnique("sonnet", "Claude Sonnet");
  pushUnique("opus", "Claude Opus");
  pushUnique("haiku", "Claude Haiku");

  return { defaultModel, models };
}

/**
 * 读取 OpenCode 本地配置与 CLI 可用模型（~/.config/opencode/config.json 及 opencode models）
 */
async function readOpenCodeModels(): Promise<{
  defaultModel?: string;
  models: ProviderModelOption[];
}> {
  const models: ProviderModelOption[] = [];
  const seen = new Set<string>();
  let defaultModel: string | undefined;

  const pushUnique = (id: string, label?: string) => {
    const clean = id.trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    models.push({ id: clean, label: label && label !== clean ? `${label} (${clean})` : clean });
  };

  const configCandidates = [
    join(os.homedir(), ".config", "opencode", "config.json"),
    join(os.homedir(), ".config", "opencode", "opencode.json"),
  ];
  for (const cfgPath of configCandidates) {
    if (!existsSync(cfgPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as {
        model?: string;
        provider?: Record<string, { models?: Record<string, { name?: string }> }>;
      };
      if (typeof parsed.model === "string" && parsed.model.trim()) {
        defaultModel = parsed.model.trim();
        pushUnique(defaultModel);
      }
      for (const [providerName, providerDef] of Object.entries(parsed.provider ?? {})) {
        for (const [modelId, modelMeta] of Object.entries(providerDef?.models ?? {})) {
          const fullId = modelId.includes("/") ? modelId : `${providerName}/${modelId}`;
          pushUnique(fullId, modelMeta?.name);
        }
      }
    } catch {
      // 忽略配置解析异常
    }
  }

  const bin = findExecutableSync("opencode");
  if (bin) {
    const res = await execCrossPlatform(bin, ["models"], { timeoutMs: 4_000 });
    if (res.exitCode === 0) {
      for (const rawLine of stripAnsi(res.stdout).split("\n")) {
        const line = rawLine.trim();
        if (!line || /\s/.test(line) || line.startsWith("Error")) continue;
        pushUnique(line);
      }
    }
  }

  return { defaultModel, models };
}

/**
 * 读取 Cursor Agent CLI 可用模型列表（cursor-agent --list-models）
 */
async function readCursorModels(): Promise<{
  defaultModel?: string;
  models: ProviderModelOption[];
}> {
  const bin = findExecutableSync("cursor-agent");
  if (!bin) return { models: [] };

  const res = await execCrossPlatform(bin, ["--list-models"], { timeoutMs: 6_000 });
  if (res.exitCode !== 0) return { models: [] };

  const models: ProviderModelOption[] = [];
  const seen = new Set<string>();
  for (const rawLine of stripAnsi(res.stdout).split("\n")) {
    const line = rawLine.trim();
    if (
      !line ||
      line.startsWith("No models") ||
      line.startsWith("Tip:") ||
      line.startsWith("Error:") ||
      line.startsWith("Available")
    ) {
      continue;
    }
    const match = line.match(/^([a-zA-Z0-9._:/-]+)(?:\s+[-–—]\s+|\s+)(.+)$/);
    const id = match ? match[1].trim() : line.split(/\s+/)[0]?.trim();
    const label = match ? match[2].trim() : id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: label && label !== id ? `${label} (${id})` : id });
  }
  return { models };
}
