// = packages/contracts 的原型版本。网关侧不依赖 zod（手写校验，ADR-0007），
// 控制台在边界上 parse，类型从 schema 推导。
import { z } from "zod";

export const MemberRef = z.object({ providerId: z.string(), model: z.string() });
export type MemberRef = z.infer<typeof MemberRef>;

const base = { requestId: z.string(), at: z.number(), seq: z.number().optional() };

export const RouteEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("request.start"), ...base, agent: z.string(), alias: z.string(), groupId: z.string().nullable(), protocol: z.string() }),
  z.object({
    type: z.literal("route.decision"),
    ...base,
    strategy: z.enum(["ordered", "smart", "direct"]),
    candidates: z.array(MemberRef.extend({ state: z.enum(["ready", "resting", "skipped"]), reason: z.string(), restUntil: z.number().optional() })),
  }),
  z.object({ type: z.literal("upstream.attempt"), ...base, member: MemberRef, attempt: z.number() }),
  z.object({ type: z.literal("upstream.firstByte"), ...base, member: MemberRef, ms: z.number() }),
  z.object({
    type: z.literal("upstream.failed"),
    ...base,
    member: MemberRef,
    code: z.string(),
    status: z.number().optional(),
    restUntil: z.number().optional(),
    reroutable: z.boolean(),
  }),
  z.object({ type: z.literal("reroute"), ...base, from: MemberRef, to: MemberRef, reason: z.string() }),
  z.object({
    type: z.literal("request.end"),
    ...base,
    outcome: z.enum(["ok", "error", "cancelled"]),
    member: MemberRef.nullable(),
    ms: z.number(),
    reroutes: z.number(),
    errorCode: z.string().optional(),
    usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional() }).optional(),
  }),
]);
export type RouteEvent = z.infer<typeof RouteEvent>;

export const RouteGroup = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "只能用小写字母、数字和 -"),
  name: z.string().min(1, "起个名字"),
  strategy: z.enum(["ordered", "smart"]),
  members: z.array(MemberRef).min(1, "至少一个成员"),
  enabled: z.boolean(),
});
export type RouteGroup = z.infer<typeof RouteGroup>;

export const Provider = z.object({
  id: z.string(),
  kind: z.enum(["qoder-gateway", "qoder-cli", "qoder-cloudAgents", "openai-compatible", "anthropic-compatible"]),
  label: z.string(),
  baseUrl: z.string().optional(),
  keyHint: z.string().optional(), // 只回显尾 4 位
  models: z.array(z.string()),
  capabilities: z.object({ tools: z.boolean(), vision: z.boolean(), thinking: z.boolean() }),
  enabled: z.boolean(),
});
export type Provider = z.infer<typeof Provider>;

export const AgentIntegration = z.object({
  id: z.enum(["claude-code", "codex", "opencode"]),
  name: z.string(),
  detected: z.boolean(),
  connected: z.boolean(),
  configPath: z.string(),
  backupPath: z.string().nullable(),
  model: z.string(), // 当前写入的 model（直连或 group/<id>）
  note: z.string(),
});
export type AgentIntegration = z.infer<typeof AgentIntegration>;

export const keyOf = (m: MemberRef) => `${m.providerId}/${m.model}`;
