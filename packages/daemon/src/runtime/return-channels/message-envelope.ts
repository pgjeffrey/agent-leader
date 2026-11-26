/**
 * 跨智能体通知 XML 转义与防注入系统信封编码器
 * 对齐 docs/multi_agent_control_and_data_return_plan.md 第 3.2 节与防坑铁律 #7、#8
 */

/** 默认自动回传给指挥层的单个执行器响应最大字符数（4000 字符） */
export const MAX_ENVELOPE_RESPONSE_CHARS = 4000;

/**
 * 标准 XML 实体转义，防止子智能体输出伪造系统通知标签
 */
export function escapeXmlEntities(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 对人类输入中若包含系统保留信封标签进行隔离转义
 */
export function sanitizeHumanEnvelopeCollision(input: string): string {
  return input.replace(/<(\/?)leader-system\b/gi, "&lt;$1leader-system");
}

/**
 * 截断过长的子智能体响应正文并附加按需拉取引导
 */
export function boundEnvelopeResponseText(
  text: string,
  maxChars = MAX_ENVELOPE_RESPONSE_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n[truncated ${omitted} chars; use ActivityCurator for full trace]`;
}

/**
 * 构建防注入的标准 <leader-system> 完成或权限检查点通知信封
 */
export function buildAgentNotificationEnvelope(params: {
  sourceInstanceId: string;
  sourceTitle: string;
  messageId: string;
  event: "finished" | "errored" | "permission-required";
  bodyText: string;
}): string {
  const boundedBody = boundEnvelopeResponseText(params.bodyText);
  const escapedBody = escapeXmlEntities(boundedBody);
  const tag = params.event === "permission-required" ? "permission-request" : "agent-response";
  return [
    `<leader-system version="1" kind="agent-notification" source-agent-id="${escapeXmlEntities(params.sourceInstanceId)}" source-agent-title="${escapeXmlEntities(params.sourceTitle)}" message-id="${escapeXmlEntities(params.messageId)}" event="${params.event}">`,
    `Instance ${escapeXmlEntities(params.sourceInstanceId)} (${escapeXmlEntities(params.sourceTitle)}) ${params.event}.`,
    "",
    `&lt;${tag}&gt;`,
    escapedBody,
    `&lt;/${tag}&gt;`,
    `</leader-system>`,
  ].join("\n");
}
