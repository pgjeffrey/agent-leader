import { z } from "zod";

/**
 * 软件开发标准五阶段枚举（对齐工作台 v0.8 阶段条）
 */
export const SoftwareStageIdSchema = z.enum(["req", "design", "dev", "test", "release"]);

/**
 * 指挥大模型拆解生成的单个子任务规格 Schema
 */
export const PlannedTaskSpecSchema = z.object({
  tempId: z.string().min(1),
  name: z.string().min(1),
  stageId: SoftwareStageIdSchema,
  roleId: z.string().min(1),
  deps: z.array(z.string()).default([]),
  doing: z.string().min(1),
  instruction: z.string().min(1),
  artifact: z.string().min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  verificationCommands: z.array(z.string()).optional().default([]),
  targetPaths: z.array(z.string()).optional().default([]),
});

/** 规划子任务规格类型 */
export type PlannedTaskSpec = z.infer<typeof PlannedTaskSpecSchema>;

/**
 * 指挥大模型 TaskPlanner 的完整输出 Schema
 */
export const ProjectPlanResultSchema = z.object({
  /** 根据项目背景与目标自动提炼的简洁项目名称（6~16 字） */
  projectName: z.string().min(1).optional(),
  leaderSummary: z.string().min(1),
  roles: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        duty: z.string().min(1),
        executorId: z.string().min(1),
      }),
    )
    .min(1),
  tasks: z.array(PlannedTaskSpecSchema).min(1),
});

/** 项目拆解结果类型 */
export type ProjectPlanResult = z.infer<typeof ProjectPlanResultSchema>;

/**
 * 指挥大模型 TurnEvaluator 的五选一综合评判与动态再决策 Schema
 * 覆盖：验收通过、打回返工、动态进一步拆分子任务、建议换人、人工阻塞介入
 */
export const BrainEvaluationDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ACCEPT"),
    summary: z.string().min(1),
    confirmedFacts: z
      .array(
        z.object({
          content: z.string().min(1),
          version: z.string().min(1),
        }),
      )
      .default([]),
  }),
  z.object({
    action: z.literal("REWORK"),
    reason: z.string().min(1),
    reworkInstruction: z.string().min(1),
    lessonToRecord: z.string().optional(),
  }),
  z.object({
    action: z.literal("SPLIT_TASKS"),
    reason: z.string().min(1),
    currentTaskDisposition: z.enum(["accept-and-extend", "keep-pending-children"]).default("accept-and-extend"),
    newTasks: z.array(PlannedTaskSpecSchema).min(1).max(8),
    rewireDownstreamDeps: z
      .array(
        z.object({
          taskId: z.string().min(1),
          addDepTempIds: z.array(z.string().min(1)),
        }),
      )
      .optional()
      .default([]),
  }),
  z.object({
    action: z.literal("SUGGEST_SWITCH"),
    reason: z.string().min(1),
    recommendedExecutorId: z.string().optional(),
  }),
  z.object({
    action: z.literal("BLOCK_FOR_HUMAN"),
    reason: z.string().min(1),
    questionForUser: z.string().min(1),
    options: z.array(z.string()).optional(),
  }),
]);

/** 指挥大模型结果评判决策类型 */
export type BrainEvaluationDecision = z.infer<typeof BrainEvaluationDecisionSchema>;

/**
 * 指挥大模型对话意图解析 Schema（底部常驻指挥对话用）
 */
export const BrainChatReplySchema = z.object({
  replyText: z.string().min(1),
  intent: z
    .enum([
      "answer_only",
      "dispatch_ready",
      "open_handoff",
      "accept_task",
      "reject_task",
      "split_new_tasks",
    ])
    .default("answer_only"),
  targetTaskId: z.string().optional(),
  targetExecutorId: z.string().optional(),
  newTasks: z.array(PlannedTaskSpecSchema).optional(),
});

/** 指挥对话决策返回类型 */
export type BrainChatReply = z.infer<typeof BrainChatReplySchema>;
