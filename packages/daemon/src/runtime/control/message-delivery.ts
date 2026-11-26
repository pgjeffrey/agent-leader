import type { ActiveTurnBehavior } from "@agent-leader/protocol";

interface QueuedEnvelope {
  text: string;
  behavior: ActiveTurnBehavior;
  enqueuedAt: number;
  held: boolean;
  resolveDispatched: () => void;
  rejectDispatched: (err: Error) => void;
}

/**
 * 面向单个执行实例的底层消息投递执行回调
 */
export interface DeliveryExecutorAdapter {
  isTurnActive(instanceId: string): boolean;
  getActiveTurnId(instanceId: string): string | null;
  startTurn(instanceId: string, prompt: string): Promise<void>;
  steerTurn(instanceId: string, prompt: string, expectedTurnId: string): Promise<boolean>;
  interruptTurn(instanceId: string): Promise<void>;
}

/**
 * 单接收方严格保序的消息调度器（AgentMessageDelivery）
 * 严格遵循 docs/multi_agent_control_and_data_return_plan.md 第 2.4 节与防坑铁律 #3、#6：
 * - queue: 空闲时短窗合并派发，运行中排队等待当前 Turn 结束
 * - steer / interrupt: 绝不跳过队列前置消息，而是将前置排队消息按因果顺序打包在前面一并送入
 * - holdOnStop: 用户点击停止时，已排队消息转为 held 挂起态，不丢失也不自启新推理
 */
export class AgentMessageDelivery {
  private readonly queues = new Map<string, QueuedEnvelope[]>();
  private readonly draining = new Set<string>();

  constructor(private readonly executor: DeliveryExecutorAdapter) {}

  /** 检查实例是否有待派发的非挂起消息（供空闲进程回收否决检查） */
  hasPendingMessages(instanceId: string): boolean {
    const q = this.queues.get(instanceId);
    return Boolean(q && q.some((m) => !m.held));
  }

  /**
   * 入站投递消息；返回的 Promise 在消息真正被底层会话接收执行时 resolve
   */
  enqueue(
    instanceId: string,
    text: string,
    behavior: ActiveTurnBehavior = "queue",
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const list = this.queues.get(instanceId) ?? [];
      // 新的人工或高优消息唤醒此前因 Stop 而处于 held 挂起的前置消息
      for (const item of list) {
        item.held = false;
      }
      list.push({
        text,
        behavior,
        enqueuedAt: Date.now(),
        held: false,
        resolveDispatched: resolve,
        rejectDispatched: reject,
      });
      this.queues.set(instanceId, list);
      void this.pump(instanceId);
    });
  }

  /**
   * 当底层实例一轮 Turn 结束回到空闲态时触发，继续消费队列中等待的 queue 消息
   */
  onTurnSettled(instanceId: string): void {
    void this.pump(instanceId);
  }

  /**
   * Stop 挂起语义（Hold on Stop）：终止当前活跃 Turn，并将队列剩余消息置为 held 挂起态
   */
  async stopAndHold(instanceId: string): Promise<void> {
    const list = this.queues.get(instanceId) ?? [];
    for (const item of list) {
      item.held = true;
    }
    await this.executor.interruptTurn(instanceId);
  }

  /**
   * 强制清空并拒绝某实例的全部未派发消息（用于换人强制隔离时）
   */
  purge(instanceId: string, reason = "Instance isolated"): void {
    const list = this.queues.get(instanceId);
    if (!list) return;
    this.queues.delete(instanceId);
    for (const item of list) {
      item.rejectDispatched(new Error(reason));
    }
  }

  private async pump(instanceId: string): Promise<void> {
    if (this.draining.has(instanceId)) return;
    const list = this.queues.get(instanceId);
    if (!list || list.length === 0) return;
    if (list.every((m) => m.held)) return;

    this.draining.add(instanceId);
    try {
      while (true) {
        const currentList = this.queues.get(instanceId);
        if (!currentList || currentList.length === 0 || currentList.every((m) => m.held)) {
          break;
        }

        const active = this.executor.isTurnActive(instanceId);
        const urgentIdx = currentList.findIndex(
          (m) => !m.held && (m.behavior === "steer" || m.behavior === "interrupt"),
        );

        if (active && urgentIdx < 0) {
          // 当前正在运行且全部是普通 queue 消息：静候当前 Turn 完成后由 onTurnSettled 再次唤醒
          break;
        }

        // 取出本次需要打包按序交付的批次（防坑铁律 #6：合并前置排队消息保证因果顺序）
        const takeCount = urgentIdx >= 0 ? urgentIdx + 1 : currentList.length;
        const batch = currentList.slice(0, takeCount);
        const combinedPrompt = batch.map((b) => b.text).join("\n\n");
        const triggerBehavior = urgentIdx >= 0 ? currentList[urgentIdx].behavior : "queue";

        try {
          if (active && triggerBehavior === "steer") {
            const expectedTurnId = this.executor.getActiveTurnId(instanceId);
            const steered = expectedTurnId
              ? await this.executor.steerTurn(instanceId, combinedPrompt, expectedTurnId)
              : false;
            if (!steered) {
              // 底层不支持 Steer，安全降级为先确认中断再开启新 Turn（防坑铁律 #3）
              await this.executor.interruptTurn(instanceId);
              await this.executor.startTurn(instanceId, combinedPrompt);
            }
          } else if (active && triggerBehavior === "interrupt") {
            await this.executor.interruptTurn(instanceId);
            await this.executor.startTurn(instanceId, combinedPrompt);
          } else {
            await this.executor.startTurn(instanceId, combinedPrompt);
          }

          // 仅在底层确认接收后才移出队列并结算回执
          currentList.splice(0, takeCount);
          for (const item of batch) {
            item.resolveDispatched();
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          currentList.splice(0, takeCount);
          for (const item of batch) {
            item.rejectDispatched(error);
          }
          break;
        }
      }
    } finally {
      this.draining.delete(instanceId);
    }
  }
}
