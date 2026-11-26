import type {
  AgentStreamEvent,
  AgentTimelineItem,
  ProjectedTimelineEntry,
  TimelinePage,
  ToolCallDetail,
} from "@agent-leader/protocol";

/** 工具调用单条最大载荷字节上限：64 KiB */
const MAX_TOOL_BYTES = 64 * 1024;
/** 普通消息单条最大载荷字节上限：256 KiB */
const MAX_MESSAGE_BYTES = 256 * 1024;

/**
 * 按字节预算安全截断超长文本，防止巨型日志撑爆内存或断开 WebSocket
 */
export function boundTextByBytes(text: string, maxBytes: number): string {
  const actualBytes = Buffer.byteLength(text, "utf8");
  if (actualBytes <= maxBytes) return text;
  const ratio = maxBytes / actualBytes;
  const approxChars = Math.max(128, Math.floor(text.length * ratio * 0.9));
  const droppedMb = ((actualBytes - maxBytes) / (1024 * 1024)).toFixed(2);
  return `${text.slice(0, approxChars)}\n…[truncated ${droppedMb} MB]`;
}

/**
 * 对单条时间线数据项执行容量边界裁剪（Payload Bounding）
 */
export function boundTimelineItem(item: AgentTimelineItem): AgentTimelineItem {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return { ...item, text: boundTextByBytes(item.text, MAX_MESSAGE_BYTES) };
    case "error":
      return { ...item, message: boundTextByBytes(item.message, MAX_TOOL_BYTES) };
    case "tool_call":
      return {
        ...item,
        error: item.error ? boundTextByBytes(item.error, 4096) : null,
        detail: boundToolDetail(item.detail),
      };
    default:
      return item;
  }
}

function boundToolDetail(detail: ToolCallDetail): ToolCallDetail {
  switch (detail.type) {
    case "shell":
      return {
        ...detail,
        command: boundTextByBytes(detail.command, 4096),
        output: detail.output ? boundTextByBytes(detail.output, MAX_TOOL_BYTES) : detail.output,
      };
    case "edit":
    case "write":
      return {
        ...detail,
        path: boundTextByBytes(detail.path, 1024),
        diffPreview: detail.diffPreview
          ? boundTextByBytes(detail.diffPreview, MAX_TOOL_BYTES)
          : detail.diffPreview,
      };
    case "read":
    case "search":
      return {
        ...detail,
        target: boundTextByBytes(detail.target, 1024),
        outputPreview: detail.outputPreview
          ? boundTextByBytes(detail.outputPreview, MAX_TOOL_BYTES)
          : detail.outputPreview,
      };
    case "plan":
      return { ...detail, text: boundTextByBytes(detail.text, MAX_MESSAGE_BYTES) };
    case "unknown": {
      const rawOut =
        typeof detail.output === "string"
          ? boundTextByBytes(detail.output, MAX_TOOL_BYTES)
          : detail.output;
      return { ...detail, output: rawOut };
    }
  }
}

/**
 * 单调序号与实时时间线投影器（TimelineProjection）
 * - 为每条事件分配单调递增 (epoch, seq)
 * - 原地折叠相邻的 assistant_message / reasoning 增量并记录 sourceSeqRange
 * - 原地更新同 callId 的 tool_call 状态
 * - 在收到终态事件时自动结清所有未结束的瞬态加载项（防坑铁律 #9）
 */
export class TimelineProjection {
  private epoch = 1;
  private headSeq = 0;
  private entries: ProjectedTimelineEntry[] = [];

  constructor(
    private readonly instanceId: string,
    initial?: { epoch: number; headSeq: number; entries: ProjectedTimelineEntry[] },
  ) {
    if (initial) {
      this.epoch = initial.epoch;
      this.headSeq = initial.headSeq;
      this.entries = [...initial.entries];
    }
  }

  /** 获取当前纪元与头序号 */
  cursor(): { epoch: number; headSeq: number } {
    return { epoch: this.epoch, headSeq: this.headSeq };
  }

  /** 获取全部投影条目副本 */
  getAllEntries(): ProjectedTimelineEntry[] {
    return [...this.entries];
  }

  /**
   * 消费一条流事件并更新投影，返回本次新增或更新后的权威投影项（若该事件产生可见投影更新）
   */
  apply(event: AgentStreamEvent): ProjectedTimelineEntry | undefined {
    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      this.terminalizeTransientItems(
        event.type === "turn_canceled"
          ? "canceled"
          : event.type === "turn_failed"
            ? "failed"
            : "completed",
      );
      if (event.type === "turn_failed") {
        return this.appendOrFoldItem(
          { type: "error", message: event.error },
          event.turnId,
          new Date().toISOString(),
        );
      }
      return undefined;
    }

    if (event.type !== "timeline") {
      return undefined;
    }

    return this.appendOrFoldItem(
      event.item,
      event.turnId,
      event.timestamp ?? new Date().toISOString(),
    );
  }

  /**
   * 提取投影后最后一条完整的 Assistant 回复全文（作为任务完成评估的标准文本基准）
   */
  getLastAssistantMessage(): string {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const item = this.entries[i].item;
      if (item.type === "assistant_message" && item.text.trim()) {
        return item.text;
      }
    }
    return "";
  }

  /**
   * 按游标分页查询权威时间线（供客户端断线追赶与新鲜度对齐）
   */
  getPage(afterSeq = 0, limit = 200): TimelinePage {
    const filtered = this.entries.filter((e) => e.seq > afterSeq);
    const sliced = filtered.slice(0, limit);
    return {
      instanceId: this.instanceId,
      epoch: this.epoch,
      headSeq: this.headSeq,
      entries: sliced,
      hasMore: filtered.length > limit,
    };
  }

  private appendOrFoldItem(
    rawItem: AgentTimelineItem,
    turnId: string | undefined,
    timestamp: string,
  ): ProjectedTimelineEntry {
    const seq = ++this.headSeq;
    const bounded = boundTimelineItem(rawItem);
    const prev = this.entries.at(-1);

    // 1. 同一轮次相邻 assistant_message 折叠合并
    if (
      bounded.type === "assistant_message" &&
      prev &&
      prev.item.type === "assistant_message" &&
      prev.turnId === turnId &&
      (!bounded.messageId || !prev.item.messageId || bounded.messageId === prev.item.messageId)
    ) {
      const mergedText = bounded.text.startsWith(prev.item.text)
        ? bounded.text
        : `${prev.item.text}${bounded.text}`;
      const updated: ProjectedTimelineEntry = {
        epoch: this.epoch,
        seq,
        sourceSeqRange: [prev.sourceSeqRange[0], seq],
        turnId,
        timestamp,
        item: boundTimelineItem({ ...bounded, text: mergedText }),
      };
      this.entries[this.entries.length - 1] = updated;
      return updated;
    }

    // 2. 同一轮次相邻 reasoning 折叠合并
    if (
      bounded.type === "reasoning" &&
      prev &&
      prev.item.type === "reasoning" &&
      prev.turnId === turnId
    ) {
      const mergedText = bounded.text.startsWith(prev.item.text)
        ? bounded.text
        : `${prev.item.text}${bounded.text}`;
      const updated: ProjectedTimelineEntry = {
        epoch: this.epoch,
        seq,
        sourceSeqRange: [prev.sourceSeqRange[0], seq],
        turnId,
        timestamp,
        item: boundTimelineItem({ type: "reasoning", text: mergedText }),
      };
      this.entries[this.entries.length - 1] = updated;
      return updated;
    }

    // 3. 相同 callId 的 tool_call 原地折叠更新状态
    if (bounded.type === "tool_call") {
      const existingIdx = this.entries.findIndex(
        (e) => e.item.type === "tool_call" && e.item.callId === bounded.callId,
      );
      if (existingIdx >= 0) {
        const existing = this.entries[existingIdx];
        const updated: ProjectedTimelineEntry = {
          epoch: this.epoch,
          seq,
          sourceSeqRange: [existing.sourceSeqRange[0], seq],
          turnId: turnId ?? existing.turnId,
          timestamp,
          item: bounded,
        };
        this.entries[existingIdx] = updated;
        return updated;
      }
    }

    const fresh: ProjectedTimelineEntry = {
      epoch: this.epoch,
      seq,
      sourceSeqRange: [seq, seq],
      turnId,
      timestamp,
      item: bounded,
    };
    this.entries.push(fresh);
    return fresh;
  }

  /**
   * 终态前结清所有临时加载卡片（防坑铁律 #9）
   */
  private terminalizeTransientItems(terminalStatus: "completed" | "failed" | "canceled"): void {
    for (let i = 0; i < this.entries.length; i += 1) {
      const entry = this.entries[i];
      if (entry.item.type === "tool_call" && entry.item.status === "running") {
        const seq = ++this.headSeq;
        this.entries[i] = {
          ...entry,
          seq,
          sourceSeqRange: [entry.sourceSeqRange[0], seq],
          item: { ...entry.item, status: terminalStatus },
        };
      } else if (entry.item.type === "compaction" && entry.item.status === "loading") {
        const seq = ++this.headSeq;
        this.entries[i] = {
          ...entry,
          seq,
          sourceSeqRange: [entry.sourceSeqRange[0], seq],
          item: { type: "compaction", status: "completed" },
        };
      }
    }
  }
}
