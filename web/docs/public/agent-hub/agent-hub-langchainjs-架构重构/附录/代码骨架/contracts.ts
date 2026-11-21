import { z } from "zod";

/**
 * 花语智能体契约层（单一事实源）
 *
 * 前后端共同的"接口词典"：web 用 zod 在边界处 parse，python 侧有 pydantic 镜像
 * （apps/api/app/schemas.py），两端以 fixtures/contract-example.json 同源对账。
 * AI 输出只允许白名单字段进 UI——契约即安全边界。
 */

/* ---------------------------------- 依据 ---------------------------------- */

/** 依据来源类型：AI 推荐结论必须能指认"从哪来" */
export const EvidenceSourceKind = z.enum(["purchase_history", "preference_survey", "care_record"]);
export type EvidenceSourceKind = z.infer<typeof EvidenceSourceKind>;

/** 依据：来源 + 可信度 + 引用原文。可信度 <80 前端渲染金色预警（信任阈值） */
export const Evidence = z.object({
  id: z.string(),
  source: z.string(),
  sourceKind: EvidenceSourceKind,
  /** 可信度 0-100，后端计算，前端只做分级渲染 */
  credibility: z.number().int().min(0).max(100),
  /** 引用原文（顾客对话/记录原文片段） */
  quote: z.string(),
  analyzedAt: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

export const EvidenceRef = z.object({
  evidenceId: z.string(),
  label: z.string(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/* ------------------------------- A2UI 花束卡片 ------------------------------ */

/** 推荐场景：日常自用 / 送礼 / 探望慰问——场景决定卡片段式与文案 */
export const RecommendScene = z.enum(["daily", "gift", "comfort"]);
export type RecommendScene = z.infer<typeof RecommendScene>;

export const FlowerItem = z.object({
  id: z.string(),
  name: z.string(),
  /** 单位：分（避免浮点金额） */
  priceFen: z.number().int().nonnegative(),
  /** 商品类型标签：花束 / 盆栽 / 永生花 */
  typeLabel: z.string(),
  emoji: z.string(),
});
export type FlowerItem = z.infer<typeof FlowerItem>;

/** A2UI 卡片载荷：智能体结构化输出 → 前端按场景渲染，字段白名单 */
export const FlowerCardPayload = z.object({
  scene: RecommendScene,
  title: z.string(),
  reason: z.string(),
  items: z.array(FlowerItem).min(1),
  evidenceRefs: z.array(EvidenceRef),
});
export type FlowerCardPayload = z.infer<typeof FlowerCardPayload>;

/* ------------------------------ Agent 事件流 ------------------------------ */

export const ThoughtEvent = z.object({
  type: z.literal("thought"),
  /** 思考分段序号，从 1 开始 */
  seq: z.number().int().positive(),
  text: z.string(),
  /** 本段是否结束（前端据此决定是否追加下一段） */
  final: z.boolean(),
});
export const TokenEvent = z.object({ type: z.literal("token"), text: z.string() });
export const CardEvent = z.object({ type: z.literal("card"), payload: FlowerCardPayload });
export const EvidenceEvent = z.object({ type: z.literal("evidence"), evidence: Evidence });
export const DoneEvent = z.object({ type: z.literal("done"), replyId: z.string() });
export const ErrorEvent = z.object({
  type: z.literal("error"),
  code: z.enum(["protocol", "server", "aborted"]),
  message: z.string(),
});

/** SSE data 帧的完整事件联合 */
export const AgentStreamEvent = z.discriminatedUnion("type", [
  ThoughtEvent,
  TokenEvent,
  CardEvent,
  EvidenceEvent,
  DoneEvent,
  ErrorEvent,
]);
export type AgentStreamEvent = z.infer<typeof AgentStreamEvent>;

/* --------------------------- 异步任务（养护方案） --------------------------- */

export const TaskStatus = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "archived",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** 后端状态 → 页面态的映射在前端集中维护（TASK_STATUS_TO_PAGE_STATUS） */
export const TaskSnapshot = z.object({
  taskId: z.string(),
  /** 业务单号（有序可读，页面展示用）：YH+日期+每日序号；taskId 是内部主键不上页面 */
  taskNo: z.string(),
  kind: z.literal("care_plan"),
  status: TaskStatus,
  progress: z.number().int().min(0).max(100),
  /** pydantic 会把 None 序列化成 null：这里必须 nullish（optional 只收 undefined） */
  result: z
    .object({
      title: z.string(),
      sections: z.array(z.object({ heading: z.string(), body: z.string() })),
    })
    .nullish(),
  failReason: z.string().nullish(),
});
export type TaskSnapshot = z.infer<typeof TaskSnapshot>;

/* ----------------------------- 订单与支付沙箱 ----------------------------- */

export const PaymentChannel = z.enum(["wechat", "alipay"]);
export type PaymentChannel = z.infer<typeof PaymentChannel>;

export const OrderStatus = z.enum(["created", "paying", "paid", "closed"]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const Order = z.object({
  orderId: z.string(),
  /** 业务单号（有序可读，页面展示用）：DD+日期+每日序号 */
  orderNo: z.string(),
  flowerName: z.string(),
  /** 单位：分 */
  amountFen: z.number().int().positive(),
  channel: PaymentChannel,
  status: OrderStatus,
  /** pydantic None → JSON null：nullish 而非 optional（下单未支付时为 null） */
  paidAt: z.string().nullish(),
});
export type Order = z.infer<typeof Order>;

/** 支付回调（模拟微信/支付宝异步通知）：验签 + 幂等 */
export const PaymentNotify = z.object({
  orderId: z.string(),
  channel: PaymentChannel,
  /** 模拟签名：sha256(orderId + channel + SECRET) 的前 16 位 */
  sign: z.string(),
});
export type PaymentNotify = z.infer<typeof PaymentNotify>;
