import { randomUUID } from "node:crypto";
import type { AgentPermissionRequest } from "@agent-leader/protocol";
import { buildAgentNotificationEnvelope } from "./message-envelope.js";

/**
 * 持久化完成订阅记录结构（确保 At-Least-Once 异步回调唤醒，防坑铁律 #1、#2）
 */
export interface FinishSubscriptionRecord {
  id: string;
  projectId: string;
  taskId: string;
  instanceId: string;
  title: string;
  createdAt: number;
}

/**
 * 完成订阅持久化存储接口
 */
export interface FinishSubscriptionStore {
  saveSubscription(record: FinishSubscriptionRecord): void;
  deleteSubscription(id: string): void;
  listSubscriptions(): FinishSubscriptionRecord[];
}

/**
 * 回调投递处理器：当执行实例触发权限检查点或运行进入终态时唤醒指挥层
 */
export interface FinishNotificationCallbacks {
  onPermissionCheckpoint: (params: {
    subscription: FinishSubscriptionRecord;
    request: AgentPermissionRequest;
    envelope: string;
  }) => Promise<void>;
  onInstanceSettled: (params: {
    subscription: FinishSubscriptionRecord;
    outcome: "finished" | "errored" | "canceled";
    lastAssistantMessage: string;
    errorMessage?: string;
    envelope: string;
  }) => Promise<void>;
}

/**
 * 持久化完成订阅管理器（FinishSubscriptions）
 * 1. 派发 Prompt 前必须先调用 registerBeforeDispatch 落盘订阅（防坑铁律 #1）
 * 2. 遇到 permission_requested 仅发送检查点通知，绝不销毁订阅（防坑铁律 #2）
 * 3. 只有当指挥层确认消费完成回调后才从磁盘删除该订阅记录
 */
export class FinishSubscriptions {
  private readonly byInstance = new Map<string, FinishSubscriptionRecord>();

  constructor(
    private readonly store: FinishSubscriptionStore,
    private readonly callbacks: FinishNotificationCallbacks,
  ) {
    for (const rec of this.store.listSubscriptions()) {
      this.byInstance.set(rec.instanceId, rec);
    }
  }

  /**
   * 在启动子实例 Turn 之前先持久化注册完成监听
   */
  registerBeforeDispatch(params: {
    projectId: string;
    taskId: string;
    instanceId: string;
    title: string;
  }): FinishSubscriptionRecord {
    const existing = this.byInstance.get(params.instanceId);
    if (existing) return existing;

    const record: FinishSubscriptionRecord = {
      id: `fsub_${randomUUID().slice(0, 8)}`,
      projectId: params.projectId,
      taskId: params.taskId,
      instanceId: params.instanceId,
      title: params.title,
      createdAt: Date.now(),
    };
    this.store.saveSubscription(record);
    this.byInstance.set(params.instanceId, record);
    return record;
  }

  /**
   * 检查给定实例是否有未结算的完成订阅（用于空闲回收否决保护）
   */
  hasPendingForInstance(instanceId: string): boolean {
    return this.byInstance.has(instanceId);
  }

  /**
   * 手动取消/移除某实例的监听（例如实例被强制隔离作废时）
   */
  cancelForInstance(instanceId: string): void {
    const rec = this.byInstance.get(instanceId);
    if (!rec) return;
    this.byInstance.delete(instanceId);
    this.store.deleteSubscription(rec.id);
  }

  /**
   * 权限审批检查点触发（保持订阅存活，不删除！）
   */
  async notifyPermissionCheckpoint(
    instanceId: string,
    request: AgentPermissionRequest,
  ): Promise<void> {
    const sub = this.byInstance.get(instanceId);
    if (!sub) return;
    const envelope = buildAgentNotificationEnvelope({
      sourceInstanceId: instanceId,
      sourceTitle: sub.title,
      messageId: `msg_${randomUUID().slice(0, 8)}`,
      event: "permission-required",
      bodyText: JSON.stringify(
        { instanceId, requestId: request.id, kind: request.kind, title: request.title },
        null,
        2,
      ),
    });
    await this.callbacks.onPermissionCheckpoint({ subscription: sub, request, envelope });
  }

  /**
   * 实例进入终态结算：先等待上层指挥器确认处理完毕，再从持久化存储中移除订阅
   */
  async settleInstance(params: {
    instanceId: string;
    outcome: "finished" | "errored" | "canceled";
    lastAssistantMessage: string;
    errorMessage?: string;
  }): Promise<void> {
    const sub = this.byInstance.get(params.instanceId);
    if (!sub) return;

    const bodyText =
      params.outcome === "errored"
        ? `Error: ${params.errorMessage ?? "Unknown failure"}\n${params.lastAssistantMessage}`
        : params.lastAssistantMessage || "(empty response)";

    const envelope = buildAgentNotificationEnvelope({
      sourceInstanceId: params.instanceId,
      sourceTitle: sub.title,
      messageId: `msg_${randomUUID().slice(0, 8)}`,
      event: params.outcome === "errored" ? "errored" : "finished",
      bodyText,
    });

    await this.callbacks.onInstanceSettled({
      subscription: sub,
      outcome: params.outcome,
      lastAssistantMessage: params.lastAssistantMessage,
      errorMessage: params.errorMessage,
      envelope,
    });

    // 确认上层已接收并处理后再删除持久化订阅（At-Least-Once 保证）
    this.byInstance.delete(params.instanceId);
    this.store.deleteSubscription(sub.id);
  }
}
