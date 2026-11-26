import type { AgentStreamEvent } from "@agent-leader/protocol";

/**
 * 高频流式增量节流合并器（AgentStreamCoalescer）
 * 在短时间窗口内合并连续的 assistant_message / reasoning 文本块，降低序列化与 WebSocket 广播开销
 */
export class AgentStreamCoalescer {
  private timer: NodeJS.Timeout | null = null;
  private bufferedKind: "assistant_message" | "reasoning" | null = null;
  private bufferedText = "";
  private bufferedProvider = "";
  private bufferedTurnId?: string;
  private bufferedMessageId?: string;

  constructor(
    private readonly onFlush: (event: AgentStreamEvent) => void,
    private readonly windowMs = 35,
  ) {}

  /**
   * 推入一条源流式事件；对于非文本增量或状态切换事件，先立即冲刷缓冲区再原样透传
   */
  push(event: AgentStreamEvent): void {
    if (
      event.type === "timeline" &&
      (event.item.type === "assistant_message" || event.item.type === "reasoning")
    ) {
      const kind = event.item.type;
      const msgId = event.item.type === "assistant_message" ? event.item.messageId : undefined;
      if (
        this.bufferedKind === kind &&
        this.bufferedProvider === event.provider &&
        this.bufferedTurnId === event.turnId &&
        this.bufferedMessageId === msgId
      ) {
        this.bufferedText += event.item.text;
        this.scheduleFlush();
        return;
      }
      this.flush();
      this.bufferedKind = kind;
      this.bufferedText = event.item.text;
      this.bufferedProvider = event.provider;
      this.bufferedTurnId = event.turnId;
      this.bufferedMessageId = msgId;
      this.scheduleFlush();
      return;
    }

    this.flush();
    this.onFlush(event);
  }

  /**
   * 立即排空缓冲文本块（在 Turn 结束或关闭前必须调用）
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.bufferedKind) return;
    const item =
      this.bufferedKind === "assistant_message"
        ? {
            type: "assistant_message" as const,
            text: this.bufferedText,
            ...(this.bufferedMessageId ? { messageId: this.bufferedMessageId } : {}),
          }
        : {
            type: "reasoning" as const,
            text: this.bufferedText,
          };

    const out: AgentStreamEvent = {
      type: "timeline",
      provider: this.bufferedProvider,
      turnId: this.bufferedTurnId,
      timestamp: new Date().toISOString(),
      item,
    };
    this.bufferedKind = null;
    this.bufferedText = "";
    this.onFlush(out);
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.windowMs);
  }
}
