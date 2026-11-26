/**
 * 敏感凭据与密钥脱敏过滤器
 * 确保 API Key、Token、Bearer 凭据绝不以明文进入项目事实库或标准交接包（PRD FR-15）
 */

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[a-zA-Z0-9_-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/gi,
  /\b(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,}["']?/gi,
];

/**
 * 将文本中的敏感密钥替换为 [REDACTED_SECRET]
 */
export function redactSecrets(input: string, extraLiterals: readonly string[] = []): string {
  let out = input;
  for (const literal of extraLiterals) {
    if (literal && literal.trim().length >= 8) {
      out = out.split(literal).join("[REDACTED_SECRET]");
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED_SECRET]");
  }
  return out;
}

/**
 * 判断一条 shell 命令是否属于需经用户批准的高风险操作（删除、装包、推送、发布、提权等）
 */
export function classifyHighRiskCommand(command: string): { isHighRisk: boolean; reason?: string } {
  const trimmed = command.trim();
  const rules: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|-[a-zA-Z]*f[a-zA-Z]*r)\b/, reason: "递归或强制删除文件/目录" },
    { pattern: /\b(del|rmdir|rd)\s+\/[sq]/i, reason: "Windows 强制删除文件/目录" },
    { pattern: /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f)\b/, reason: "Git 远程推送或破坏性重置" },
    { pattern: /\b(npm|pnpm|yarn)\s+(publish|install|add|i)\b/, reason: "外部依赖安装或包发布" },
    { pattern: /\b(pip|uv)\s+install\b/, reason: "Python 外部依赖安装" },
    { pattern: /\bsudo\b/, reason: "系统提权命令" },
  ];

  for (const rule of rules) {
    if (rule.pattern.test(trimmed)) {
      return { isHighRisk: true, reason: rule.reason };
    }
  }
  return { isHighRisk: false };
}
