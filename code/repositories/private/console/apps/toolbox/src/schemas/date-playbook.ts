import { z } from "zod";
import { STAGE_ORDER as SOURCE_STAGE_ORDER } from "@/features/date-playbook/constants/stage";

// date-playbook 情侣空间领域 schema（迁移自 miniapp domain/types + schemas，Web 化字段子集）
// 领域 SSOT：src/features/date-playbook（domain/types + constants/stage + schemas/*）。
// 本文件保留既有页面使用的五阶段 proposalSchema；新页面走九阶段 stageProposalSchema。

export const planStatusSchema = z.enum(["draft", "pending_confirmation", "confirmed", "completed", "cancelled"]);
export type PlanStatus = z.infer<typeof planStatusSchema>;

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  draft: "草稿",
  pending_confirmation: "待确认",
  confirmed: "已确认",
  completed: "已完成",
  cancelled: "已取消",
};

/** 关系阶段（旧五阶段，既有「我们」页继续使用），只许前后移动不许原地变更 */
export const STAGE_ORDER = ["acquaintance", "dating", "relationship", "engagement", "married"] as const;
export const stageSchema = z.enum(STAGE_ORDER);
export type RelationshipStage = z.infer<typeof stageSchema>;
export const STAGE_LABELS: Record<RelationshipStage, string> = {
  acquaintance: "认识",
  dating: "约会中",
  relationship: "确定关系",
  engagement: "订婚",
  married: "已婚",
};

/** 九阶段源模型（迁移自 miniapp constants/stage）， couples.current_stage 与新阶段提案使用 */
export const relationshipStageSchema = z.enum(SOURCE_STAGE_ORDER);
export type RelationshipStageV2 = z.infer<typeof relationshipStageSchema>;

export const coupleSchema = z.object({
  id: z.string(),
  name: z.string(),
  memberIds: z.array(z.string()),
  inviteCode: z.string(),
  createdAt: z.string(),
  /** 源模型扩展：当前关系阶段（九阶段），旧库默认 initial_contact */
  currentStage: relationshipStageSchema.optional(),
  relationshipStartDate: z.string().optional(),
});
export type Couple = z.infer<typeof coupleSchema>;

export const planSchema = z.object({
  id: z.string(),
  coupleId: z.string(),
  createdBy: z.string(),
  title: z.string(),
  date: z.string(),
  venueIds: z.array(z.string()),
  status: planStatusSchema,
  createdAt: z.string(),
  // 以下为源 DatePlan 字段补齐（nullable 列，旧行为 undefined/默认值）
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  meetingNote: z.string().optional(),
  estimatedBudget: z.number().optional(),
  topics: z.array(z.string()).default([]),
  cautions: z.array(z.string()).default([]),
  backupPlan: z.string().optional(),
  bookingRequired: z.boolean().default(false),
  /** 对方退回时填写的原因（源 rejectPlan 交互 + 数据面补充） */
  rejectReason: z.string().optional(),
  confirmedBy: z.string().optional(),
  confirmedAt: z.string().optional(),
});
export type Plan = z.infer<typeof planSchema>;

export const reviewSchema = z.object({
  id: z.string(),
  planId: z.string(),
  coupleId: z.string(),
  author: z.string(),
  rating: z.number().int().min(1).max(5),
  highlights: z.string(),
  improvements: z.string(),
  createdAt: z.string(),
  // 源 DateReview 字段补齐：feeling=rating、favoritePart=highlights、regretPart=improvements
  userId: z.string().optional(),
  feeling: z.number().int().min(1).max(5).optional(),
  favoritePart: z.string().optional(),
  regretPart: z.string().optional(),
  willingAgain: z.boolean().optional(),
  messageToPartner: z.string().optional(),
});
export type Review = z.infer<typeof reviewSchema>;

export const proposalSchema = z.object({
  id: z.string(),
  coupleId: z.string(),
  proposer: z.string(),
  toStage: stageSchema,
  reason: z.string(),
  status: z.enum(["pending", "accepted", "declined"]),
  createdAt: z.string(),
});
export type Proposal = z.infer<typeof proposalSchema>;

/** 源 StageProposal（九阶段、from→to、响应留痕），独立于旧五阶段 proposals 表 */
export const stageProposalSchema = z.object({
  id: z.string(),
  coupleId: z.string(),
  fromStage: relationshipStageSchema,
  toStage: relationshipStageSchema,
  reason: z.string(),
  proposerId: z.string(),
  status: z.enum(["pending", "accepted", "rejected"]),
  responderId: z.string().optional(),
  respondedAt: z.string().optional(),
  createdAt: z.string(),
});
export type StageProposal = z.infer<typeof stageProposalSchema>;

/** 源 Favorite（couple 维度，want_to_go/visited 互斥），区别于 venues 单表布尔收藏 */
export const favoriteStatusSchema = z.enum(["want_to_go", "visited"]);
export type FavoriteStatusV2 = z.infer<typeof favoriteStatusSchema>;

export const favoriteRecordSchema = z.object({
  id: z.string(),
  coupleId: z.string(),
  venueId: z.string(),
  userId: z.string(),
  status: favoriteStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FavoriteRecord = z.infer<typeof favoriteRecordSchema>;

export const timelineEventSchema = z.object({
  id: z.string(),
  coupleId: z.string(),
  at: z.string(),
  actor: z.string(),
  type: z.string(),
  detail: z.string(),
});
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

export const planFormSchema = z.object({
  title: z.string().trim().min(1, "请填写计划名称").max(30, "计划名称最多 30 字"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "请选择日期"),
  venueIds: z.array(z.string()).min(1, "至少选择一个地点"),
});
