import type { AgentTimelineItem, ProjectedTimelineEntry } from "@agent-leader/protocol";

/**
 * 时间线活动高信噪比浓缩蒸馏器（ActivityCurator）
 * 将原始时间线蒸馏为紧凑纯文本，供指挥大模型验收评判与交接包生成按需使用，节省上下文窗口
 */
export function curateAgentActivity(
  entries: readonly ProjectedTimelineEntry[],
  limit = 40,
): string {
  const recent = entries.slice(-limit);
  const lines: string[] = [];

  for (const entry of recent) {
    const formatted = formatTimelineItemCompact(entry.item);
    if (formatted) {
      lines.push(formatted);
    }
  }

  return lines.join("\n");
}

function truncateSingleLine(text: string, maxChars = 200): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}…`;
}

function formatTimelineItemCompact(item: AgentTimelineItem): string | null {
  switch (item.type) {
    case "user_message":
      return `[User] ${truncateSingleLine(item.text, 240)}`;
    case "reasoning":
      return `[Thought] ${truncateSingleLine(item.text, 200)}`;
    case "assistant_message":
      return `[Assistant] ${truncateSingleLine(item.text, 500)}`;
    case "tool_call": {
      const d = item.detail;
      const statusBadge = item.status === "completed" ? "ok" : item.status;
      if (d.type === "shell") {
        return `[Bash:${statusBadge}] ${truncateSingleLine(d.command, 160)}${
          d.exitCode !== undefined && d.exitCode !== null ? ` (exit=${d.exitCode})` : ""
        }`;
      }
      if (d.type === "edit" || d.type === "write") {
        return `[${d.type === "edit" ? "Edit" : "Write"}:${statusBadge}] ${d.path}`;
      }
      if (d.type === "read" || d.type === "search") {
        return `[${d.type === "read" ? "Read" : "Search"}:${statusBadge}] ${d.target}`;
      }
      if (d.type === "plan") {
        return `[Plan] ${truncateSingleLine(d.text, 200)}`;
      }
      return `[Tool:${item.name}:${statusBadge}]`;
    }
    case "todo":
      return `[Tasks] ${item.items.map((t) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`).join(" | ")}`;
    case "error":
      return `[Error] ${truncateSingleLine(item.message, 300)}`;
    case "compaction":
      return null;
  }
}
