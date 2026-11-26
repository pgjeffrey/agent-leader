import { z } from "zod";

/**
 * 执行器接入分类：
 * - native: 核心原生直连支持（6 款）
 * - plugin: 官方内置扩展支持（6 款）
 * - acp-intl: ACP 目录国际主流智能体（16 款）
 * - acp-cn: ACP 目录国内主流智能体（8 款）
 * - acp-community: ACP 目录垂直与社区智能体（12 款）
 * - custom: 用户自定义扩展或本地模拟器
 */
export type ProviderCategory =
  | "native"
  | "plugin"
  | "acp-intl"
  | "acp-cn"
  | "acp-community"
  | "custom";

/**
 * 底层传输与进程控制协议类型，对应运行时五种异构驱动模式及本地模拟器
 */
export type ProviderTransportKind =
  | "codex-app-server"
  | "claude-stream"
  | "acp"
  | "opencode-http"
  | "jsonl-rpc"
  | "muse-msp"
  | "mock";

/**
 * 单个可指挥执行智能体的静态目录元数据定义
 */
export interface ProviderCatalogDefinition {
  /** 全局唯一 Provider ID（小写字母、数字、连字符） */
  id: string;
  /** 界面展示名称 */
  name: string;
  /** 短标签名称 */
  short: string;
  /** 所属目录分类 */
  category: ProviderCategory;
  /** 供应商或来源说明 */
  vendor: string;
  /** 能力与定位简介 */
  description: string;
  /** 底层控制传输协议 */
  transport: ProviderTransportKind;
  /** 默认启动命令与参数数组 */
  defaultCommand: readonly [string, ...string[]];
  /** 用于探测本机是否真实已安装该智能体的二进制命令名（针对 npx/uvx 启动项，避免把仅装了 npx 误判为已安装该智能体） */
  probeBinary?: string;
  /** 官方安装与配置文档地址 */
  installUrl: string;
  /** 默认注入的环境变量 */
  defaultEnv?: Readonly<Record<string, string>>;
  /** 是否默认在选择器中启用 */
  enabledByDefault?: boolean;
}

/**
 * 用户自定义扩展或覆盖内置 Provider 的配置结构
 */
export const CustomProviderConfigSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  extends: z.string().default("acp"),
  command: z.array(z.string().min(1)).min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  models: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
});

/** 用户自定义 Provider 配置类型 */
export type CustomProviderConfig = z.infer<typeof CustomProviderConfigSchema>;

/**
 * 单个指挥官/执行器可用的模型选项（从本机 CLI 实时读取）
 */
export interface ProviderModelOption {
  /** 传递给 CLI --model / -m 参数的模型 ID */
  id: string;
  /** 下拉列表展示名称 */
  label: string;
}

/**
 * 结合本机探测结果后的 Provider 实时快照状态
 */
export interface ProviderRuntimeSnapshot extends ProviderCatalogDefinition {
  /** 当前在工作台中是否已启用 */
  enabled: boolean;
  /** 本机是否检测到对应可执行程序（或 npx/uvx 启动器） */
  installed: boolean;
  /** 本机探测到的可执行文件绝对路径 */
  executablePath: string | null;
  /** CLI 版本号文本（若已探测） */
  detectedVersion: string | null;
  /** 最近一次主动连通性测试状态：untested 未测 | ok 正常 | error 无法指挥 */
  healthStatus?: "untested" | "ok" | "error";
  /** 最近一次主动连通性测试的返回摘要或错误详情 */
  healthMessage?: string | null;
  /** 是否为用户自定义条目 */
  isCustom?: boolean;
}

/**
 * PRD v0.2 第 6 章确立的完整 48 款开箱/目录可指挥执行智能体清单（外加本地演示模拟器 mock）
 */
export const BUILTIN_PROVIDER_CATALOG: readonly ProviderCatalogDefinition[] = [
  // ==================== A. 核心原生支持（6 款） ====================
  {
    id: "codex",
    name: "Codex",
    short: "Codex",
    category: "native",
    vendor: "OpenAI",
    description: "OpenAI 工作区编程智能体，支持 App-Server 原生协议、沙箱控制、转向与中断",
    transport: "codex-app-server",
    defaultCommand: ["codex", "app-server"],
    installUrl: "https://github.com/openai/codex",
    enabledByDefault: true,
  },
  {
    id: "claude",
    name: "Claude Code",
    short: "Claude Code",
    category: "native",
    vendor: "Anthropic",
    description: "Anthropic 官方终端编程智能体，支持流式 JSON 协议、多档权限模式与会话恢复",
    transport: "claude-stream",
    defaultCommand: ["claude"],
    installUrl: "https://docs.anthropic.com/en/docs/claude-code",
    enabledByDefault: true,
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    short: "Copilot",
    category: "native",
    vendor: "GitHub",
    description: "GitHub Copilot CLI，通过标准 ACP 协议提供 Agent / Plan / Allow All 模式",
    transport: "acp",
    defaultCommand: ["copilot", "--acp"],
    installUrl: "https://github.com/features/copilot/cli/",
    enabledByDefault: true,
  },
  {
    id: "opencode",
    name: "OpenCode",
    short: "OpenCode",
    category: "native",
    vendor: "OpenCode",
    description: "开源多模型编程智能体，支持 Build / Plan 双模式与多服务商路由",
    transport: "acp",
    defaultCommand: ["opencode", "acp"],
    installUrl: "https://github.com/anomalyco/opencode",
    enabledByDefault: true,
  },
  {
    id: "pi",
    name: "Pi",
    short: "Pi",
    category: "native",
    vendor: "Pi.dev",
    description: "极简终端多模型编程智能体，通过 JSONL Stdio RPC 通信",
    transport: "jsonl-rpc",
    defaultCommand: ["pi", "--mode", "rpc"],
    installUrl: "https://pi.dev",
    enabledByDefault: true,
  },
  {
    id: "omp",
    name: "Oh My Pi (OMP)",
    short: "OMP",
    category: "native",
    vendor: "OMP Community",
    description: "支持多 Provider、原生审批桥接与子会话管理的增强编程 Agent",
    transport: "jsonl-rpc",
    defaultCommand: ["omp", "--mode", "rpc-ui"],
    installUrl: "https://paseo.sh/docs/supported-providers/omp",
    enabledByDefault: false,
  },

  // ==================== B. 官方内置扩展支持（6 款） ====================
  {
    id: "antigravity",
    name: "Antigravity",
    short: "Antigravity",
    category: "plugin",
    vendor: "Google DeepMind",
    description: "通过已安装的 agy CLI 经由标准 ACP 协议驱动 Google Antigravity",
    transport: "acp",
    defaultCommand: ["agy", "acp"],
    installUrl: "https://paseo.sh/docs/supported-providers/antigravity",
    enabledByDefault: true,
  },
  {
    id: "muse",
    name: "Muse Code",
    short: "Muse",
    category: "plugin",
    vendor: "Meta",
    description: "Meta 终端编程智能体，按会话启动服务",
    transport: "muse-msp",
    defaultCommand: ["muse", "serve"],
    installUrl: "https://paseo.sh/docs/supported-providers/muse-code",
    enabledByDefault: false,
  },
  {
    id: "fx",
    name: "fx",
    short: "fx",
    category: "plugin",
    vendor: "Vercel Labs",
    description: "Vercel Labs 轻量开源原生编程智能体",
    transport: "acp",
    defaultCommand: ["fx", "acp"],
    installUrl: "https://fx.sh/docs/getting-started/installation",
    enabledByDefault: false,
  },
  {
    id: "hoplite",
    name: "Hoplite",
    short: "Hoplite",
    category: "plugin",
    vendor: "Hoplite",
    description: "通过本地 hoplite acp 桥接驱动的云端编程 Agent",
    transport: "acp",
    defaultCommand: ["hoplite", "acp"],
    installUrl: "https://hoplite.sh/docs/cli#install",
    enabledByDefault: false,
  },
  {
    id: "goose",
    name: "goose",
    short: "goose",
    category: "plugin",
    vendor: "Block",
    description: "Block 开源本地可扩展工程自动化 Agent，支持多模型清单发现",
    transport: "acp",
    defaultCommand: ["goose", "acp"],
    installUrl: "https://block.github.io/goose/",
    enabledByDefault: false,
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    short: "Hermes",
    category: "plugin",
    vendor: "Nous Research",
    description: "Nous Research 自我改进型编程智能体",
    transport: "acp",
    defaultCommand: ["hermes", "acp"],
    installUrl: "https://hermes-agent.nousresearch.com/docs/user-guide/features/acp",
    enabledByDefault: false,
  },

  // ==================== C1. ACP 国际主流编程智能体（16 款） ====================
  {
    id: "cursor",
    name: "Cursor",
    short: "Cursor",
    category: "acp-intl",
    vendor: "Cursor",
    description: "Cursor 官方 CLI 编程智能体",
    transport: "acp",
    defaultCommand: ["cursor-agent", "acp"],
    installUrl: "https://docs.cursor.com/en/cli/overview",
    enabledByDefault: true,
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    short: "Gemini",
    category: "acp-intl",
    vendor: "Google",
    description: "Google 官方 Gemini CLI（ACP 模式）",
    transport: "acp",
    defaultCommand: ["npx", "-y", "@google/gemini-cli@0.65.0", "--acp"],
    probeBinary: "gemini",
    installUrl: "https://geminicli.com",
    enabledByDefault: false,
  },
  {
    id: "devin",
    name: "Devin CLI",
    short: "Devin",
    category: "acp-intl",
    vendor: "Cognition",
    description: "Cognition 面向终端的 Devin 自主工程师",
    transport: "acp",
    defaultCommand: ["devin", "acp"],
    installUrl: "https://cli.devin.ai/docs",
    enabledByDefault: false,
  },
  {
    id: "cline",
    name: "Cline",
    short: "Cline",
    category: "acp-intl",
    vendor: "Cline",
    description: "自主编程 Agent CLI，支持文件编辑、命令与浏览器工具",
    transport: "acp",
    defaultCommand: ["npx", "-y", "cline@3.0.73", "--acp"],
    probeBinary: "cline",
    installUrl: "https://cline.bot/cli",
    enabledByDefault: false,
  },
  {
    id: "grok",
    name: "Grok",
    short: "Grok",
    category: "acp-intl",
    vendor: "xAI",
    description: "xAI Grok Build 编程智能体 CLI",
    transport: "acp",
    defaultCommand: ["grok", "agent", "stdio"],
    installUrl: "https://docs.x.ai/build/overview",
    enabledByDefault: false,
  },
  {
    id: "junie",
    name: "Junie",
    short: "Junie",
    category: "acp-intl",
    vendor: "JetBrains",
    description: "JetBrains 官方 AI 编程智能体",
    transport: "acp",
    defaultCommand: ["junie", "--acp", "true"],
    installUrl: "https://junie.jetbrains.com/docs/junie-cli-acp.html",
    enabledByDefault: false,
  },
  {
    id: "kiro",
    name: "Kiro CLI",
    short: "Kiro",
    category: "acp-intl",
    vendor: "Amazon",
    description: "Amazon 原生支持 ACP 的 AI 编程智能体",
    transport: "acp",
    defaultCommand: ["kiro-cli", "acp"],
    installUrl: "https://kiro.dev/docs/cli/acp/",
    enabledByDefault: false,
  },
  {
    id: "factory-droid",
    name: "Factory Droid",
    short: "Droid",
    category: "acp-intl",
    vendor: "Factory AI",
    description: "Factory AI 工程编程智能体",
    transport: "acp",
    defaultCommand: ["npx", "-y", "droid@0.249.0", "exec", "--output-format", "acp-daemon"],
    probeBinary: "droid",
    defaultEnv: { DROID_DISABLE_AUTO_UPDATE: "true", FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
    installUrl: "https://factory.ai/product/cli",
    enabledByDefault: false,
  },
  {
    id: "auggie",
    name: "Auggie CLI",
    short: "Auggie",
    category: "acp-intl",
    vendor: "Augment Code",
    description: "Augment Code 深度代码库上下文引擎驱动的编程 Agent",
    transport: "acp",
    defaultCommand: ["npx", "-y", "@augmentcode/auggie@0.36.0", "--acp"],
    probeBinary: "auggie",
    defaultEnv: { AUGMENT_DISABLE_AUTO_UPDATE: "1" },
    installUrl: "https://www.augmentcode.com/",
    enabledByDefault: false,
  },
  {
    id: "amp-acp",
    name: "Amp",
    short: "Amp",
    category: "acp-intl",
    vendor: "Amp",
    description: "Amp 前沿编程智能体 ACP 封装",
    transport: "acp",
    defaultCommand: ["amp-acp"],
    installUrl: "https://github.com/tao12345666333/amp-acp",
    enabledByDefault: false,
  },
  {
    id: "mistral-vibe",
    name: "Mistral Vibe",
    short: "Vibe",
    category: "acp-intl",
    vendor: "Mistral AI",
    description: "Mistral 开源终端编程助手",
    transport: "acp",
    defaultCommand: ["vibe-acp"],
    installUrl: "https://github.com/mistralai/mistral-vibe",
    enabledByDefault: false,
  },
  {
    id: "deepagents",
    name: "DeepAgents",
    short: "DeepAgents",
    category: "acp-intl",
    vendor: "LangChain",
    description: "基于 LangChain 构建的全功能编程与通用 Agent",
    transport: "acp",
    defaultCommand: ["npx", "-y", "deepagents-acp@0.1.36"],
    probeBinary: "deepagents-acp",
    installUrl: "https://docs.langchain.com/oss/javascript/deepagents/overview",
    enabledByDefault: false,
  },
  {
    id: "poolside",
    name: "Poolside",
    short: "Poolside",
    category: "acp-intl",
    vendor: "Poolside",
    description: "Poolside 编程智能体 CLI",
    transport: "acp",
    defaultCommand: ["pool", "acp"],
    installUrl: "https://docs.poolside.ai/cli/pool",
    enabledByDefault: false,
  },
  {
    id: "cortex-code",
    name: "Cortex Code",
    short: "Cortex",
    category: "acp-intl",
    vendor: "Snowflake",
    description: "Snowflake Cortex Code 编程智能体",
    transport: "acp",
    defaultCommand: ["cortex", "acp", "serve"],
    installUrl: "https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli",
    enabledByDefault: false,
  },
  {
    id: "kilo",
    name: "Kilo Code",
    short: "Kilo",
    category: "acp-intl",
    vendor: "Kilo",
    description: "Kilo 开源终端编程智能体",
    transport: "acp",
    defaultCommand: ["kilo", "acp"],
    installUrl: "https://kilo.ai/docs/code-with-ai/platforms/cli",
    enabledByDefault: false,
  },
  {
    id: "fast-agent",
    name: "fast-agent",
    short: "fast-agent",
    category: "acp-intl",
    vendor: "fast-agent",
    description: "支持多服务商编排的编程智能体",
    transport: "acp",
    defaultCommand: ["uvx", "--from", "fast-agent-acp==0.10.47", "fast-agent-acp", "-x"],
    probeBinary: "fast-agent-acp",
    installUrl: "https://fast-agent.ai/acp/",
    enabledByDefault: false,
  },

  // ==================== C2. ACP 国内主流编程智能体（8 款） ====================
  {
    id: "traecli",
    name: "TRAE CLI",
    short: "TRAE",
    category: "acp-cn",
    vendor: "字节跳动",
    description: "字节跳动官方 TRAE 编程智能体（原生 ACP 支持）",
    transport: "acp",
    defaultCommand: ["traecli", "acp", "serve"],
    installUrl: "https://docs.trae.cn/cli_get-started-with-trae-cli",
    enabledByDefault: false,
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    short: "Qwen Code",
    category: "acp-cn",
    vendor: "阿里巴巴",
    description: "阿里巴巴通义千问官方编程助手 CLI",
    transport: "acp",
    defaultCommand: ["npx", "-y", "@qwen-code/qwen-code@0.26.0", "--acp", "--experimental-skills"],
    probeBinary: "qwen",
    installUrl: "https://qwenlm.github.io/qwen-code-docs/en/users/overview",
    enabledByDefault: false,
  },
  {
    id: "kimi",
    name: "Kimi Code CLI",
    short: "Kimi",
    category: "acp-cn",
    vendor: "月之暗面",
    description: "Moonshot AI 开源终端编程智能体",
    transport: "acp",
    defaultCommand: ["kimi", "acp"],
    installUrl: "https://github.com/MoonshotAI/kimi-code",
    enabledByDefault: false,
  },
  {
    id: "glm-acp-agent",
    name: "GLM Agent",
    short: "GLM",
    category: "acp-cn",
    vendor: "智谱 AI",
    description: "智谱 AI GLM Coding Plan 驱动的编程智能体",
    transport: "acp",
    defaultCommand: ["npx", "-y", "glm-acp-agent@1.15.0"],
    probeBinary: "glm-acp-agent",
    installUrl: "https://github.com/stefandevo/glm-acp-agent",
    enabledByDefault: false,
  },
  {
    id: "minimax-code",
    name: "MiniMax Code",
    short: "MiniMax",
    category: "acp-cn",
    vendor: "MiniMax",
    description: "MiniMax 终端编程智能体",
    transport: "acp",
    defaultCommand: ["npx", "-y", "-p", "@minimax-ai/code@0.6.13", "mcode", "acp"],
    probeBinary: "mcode",
    installUrl: "https://agent.minimax.io",
    enabledByDefault: false,
  },
  {
    id: "codebuddy-code",
    name: "Codebuddy Code",
    short: "Codebuddy",
    category: "acp-cn",
    vendor: "腾讯云",
    description: "腾讯云官方智能编程工具 CLI",
    transport: "acp",
    defaultCommand: ["codebuddy", "--acp"],
    installUrl: "https://www.codebuddy.cn/cli/",
    enabledByDefault: false,
  },
  {
    id: "qoder",
    name: "Qoder CLI",
    short: "Qoder",
    category: "acp-cn",
    vendor: "Qoder",
    description: "具备智能体自主能力的 AI 编程助手",
    transport: "acp",
    defaultCommand: ["npx", "-y", "@qoder-ai/qodercli@1.1.78", "--acp"],
    probeBinary: "qodercli",
    installUrl: "https://qoder.com",
    enabledByDefault: false,
  },
  {
    id: "codewhale",
    name: "CodeWhale",
    short: "CodeWhale",
    category: "acp-cn",
    vendor: "CodeWhale",
    description: "面向 DeepSeek 与开放模型的终端编程 Agent",
    transport: "acp",
    defaultCommand: ["codewhale", "serve", "--acp"],
    installUrl: "https://codewhale.net/",
    enabledByDefault: false,
  },

  // ==================== C3. ACP 垂直与社区智能体（12 款） ====================
  {
    id: "agoragentic-acp",
    name: "Agoragentic",
    short: "Agoragentic",
    category: "acp-community",
    vendor: "Agoragentic",
    description: "聚合 174+ AI 能力的 Agent 服务市场 CLI",
    transport: "acp",
    defaultCommand: ["npx", "-y", "agoragentic-mcp@1.3.6", "--acp"],
    probeBinary: "agoragentic-mcp",
    installUrl: "https://agoragentic.com",
    enabledByDefault: false,
  },
  {
    id: "autohand",
    name: "Autohand Code",
    short: "Autohand",
    category: "acp-community",
    vendor: "Autohand AI",
    description: "Autohand AI 驱动的编程智能体",
    transport: "acp",
    defaultCommand: ["npx", "-y", "@autohandai/autohand-acp@0.2.1"],
    probeBinary: "autohand-acp",
    installUrl: "https://www.autohand.ai/cli/",
    enabledByDefault: false,
  },
  {
    id: "corust-agent",
    name: "Corust Agent",
    short: "Corust",
    category: "acp-community",
    vendor: "Corust AI",
    description: "专注于 Rust 工程协作的编程伙伴",
    transport: "acp",
    defaultCommand: ["corust-agent-acp"],
    installUrl: "https://github.com/Corust-ai/corust-agent-release/releases",
    enabledByDefault: false,
  },
  {
    id: "crow-cli",
    name: "crow-cli",
    short: "crow",
    category: "acp-community",
    vendor: "Crow AI",
    description: "极简原生 ACP 编程智能体",
    transport: "acp",
    defaultCommand: ["crow-cli", "acp"],
    installUrl: "https://crow-ai.dev/",
    enabledByDefault: false,
  },
  {
    id: "dimcode",
    name: "DimCode",
    short: "DimCode",
    category: "acp-community",
    vendor: "DimCode",
    description: "整合多家前沿大模型的终端编程 Agent",
    transport: "acp",
    defaultCommand: ["npx", "-y", "dimcode@0.5.21", "acp"],
    probeBinary: "dimcode",
    installUrl: "https://dimcode.dev/docs/acp.html",
    enabledByDefault: false,
  },
  {
    id: "dirac",
    name: "Dirac",
    short: "Dirac",
    category: "acp-community",
    vendor: "Dirac",
    description: "开源并行哈希锚点编辑与 AST 优化编程 Agent",
    transport: "acp",
    defaultCommand: ["npx", "-y", "dirac-cli@0.5.23", "--acp"],
    probeBinary: "dirac-cli",
    installUrl: "https://dirac.run",
    enabledByDefault: false,
  },
  {
    id: "gjc",
    name: "Gajae Code",
    short: "Gajae",
    category: "acp-community",
    vendor: "Gajae",
    description: "先规划后修改、支持证据门控执行的编程 Agent",
    transport: "acp",
    defaultCommand: ["gjc", "acp"],
    defaultEnv: { GJC_ACP_PERMISSION_MODE: "prompt" },
    installUrl: "https://gajae-code.com",
    enabledByDefault: false,
  },
  {
    id: "minion-code",
    name: "Minion Code",
    short: "Minion",
    category: "acp-community",
    vendor: "Minion",
    description: "基于 Minion 框架构建的多工具编程助手",
    transport: "acp",
    defaultCommand: ["uvx", "--from", "minion-code==0.1.45", "minion-code", "acp"],
    probeBinary: "minion-code",
    installUrl: "https://github.com/femto/minion-code",
    enabledByDefault: false,
  },
  {
    id: "nova",
    name: "Nova",
    short: "Nova",
    category: "acp-community",
    vendor: "Compass AI",
    description: "Compass AI 全栈软件工程师智能体",
    transport: "acp",
    defaultCommand: ["npx", "-y", "@compass-ai/nova@1.1.59", "acp"],
    probeBinary: "nova",
    installUrl: "https://www.compassap.ai/portfolio/nova.html",
    enabledByDefault: false,
  },
  {
    id: "sigit",
    name: "siGit Code",
    short: "siGit",
    category: "acp-community",
    vendor: "siGit",
    description: "本地优先编程智能体，支持端侧模型推理",
    transport: "acp",
    defaultCommand: ["sigit"],
    installUrl: "https://github.com/getsigit/sigit",
    enabledByDefault: false,
  },
  {
    id: "stakpak",
    name: "Stakpak",
    short: "Stakpak",
    category: "acp-community",
    vendor: "Stakpak",
    description: "Rust 编写的企业级安全 DevOps 智能体",
    transport: "acp",
    defaultCommand: ["stakpak", "acp"],
    installUrl: "https://stakpak.dev/",
    enabledByDefault: false,
  },
  {
    id: "vtcode",
    name: "VT Code",
    short: "VT Code",
    category: "acp-community",
    vendor: "VT Code",
    description: "支持多服务商自动故障转移与 Shell 安全防护的开源 Agent",
    transport: "acp",
    defaultCommand: ["vtcode", "acp"],
    defaultEnv: { VT_ACP_ENABLED: "1", VT_ACP_ZED_ENABLED: "1" },
    installUrl: "https://github.com/vinhnx/VTCode",
    enabledByDefault: false,
  },

  // ==================== D. 内置本地演示与回归模拟器 ====================
  {
    id: "mock",
    name: "Mock Simulator（本地无密钥模拟执行器）",
    short: "Mock",
    category: "custom",
    vendor: "Agent Leader Built-in",
    description: "无需外部订阅即可在本地演练流式输出、工具调用、回报与换人闭环",
    transport: "mock",
    defaultCommand: ["node", "--version"],
    installUrl: "local://builtin",
    enabledByDefault: true,
  },
] as const;

/**
 * 兼容旧示例种子中的别名（如 claude-code -> claude, gpt -> codex）
 */
const LEGACY_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  "claude-code": "claude",
  gpt: "codex",
};

/**
 * 将历史或用户输入的 Provider ID 归一化为标准目录 ID
 */
export function normalizeProviderId(id: string): string {
  return LEGACY_PROVIDER_ALIASES[id] ?? id;
}

/**
 * 根据 Provider ID 获取展示名称
 */
export function getProviderDisplayName(
  id: string,
  customProviders: readonly CustomProviderConfig[] = [],
): string {
  const normalized = normalizeProviderId(id);
  const found = BUILTIN_PROVIDER_CATALOG.find((item) => item.id === normalized);
  if (found) return found.name;
  const custom = customProviders.find((item) => item.id === normalized);
  if (custom) return custom.name;
  if (id === "gpt") return "GPT (Codex)";
  if (id === "claude-code") return "Claude Code";
  return id;
}

/**
 * Provider 分类中文名称映射
 */
export const PROVIDER_CATEGORY_LABELS: Record<ProviderCategory, string> = {
  native: "核心原生支持（6 款）",
  plugin: "官方内置扩展（6 款）",
  "acp-intl": "ACP 目录 · 国际主流（16 款）",
  "acp-cn": "ACP 目录 · 国内主流（8 款）",
  "acp-community": "ACP 目录 · 垂直与社区（12 款）",
  custom: "自定义与本地模拟器",
};
