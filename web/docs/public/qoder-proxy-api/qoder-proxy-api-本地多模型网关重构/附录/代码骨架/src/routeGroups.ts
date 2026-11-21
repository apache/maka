// 路由组配置 + 选路策略。数据面零依赖：配置在网关侧手写校验（ADR-0007），
// 控制台侧用 packages/contracts 的 zod schema 生成同一形状。
import type { CanonicalRequest } from "./events.ts";
import type { HealthBook } from "./health.ts";
import { memberKey } from "./health.ts";
import type { CandidateState, MemberRef } from "./routeEvents.ts";

export type Strategy = "ordered" | "smart";

export interface RouteGroup {
  id: string; // 客户端用 group/<id> 调用
  name: string;
  strategy: Strategy;
  members: MemberRef[];
  enabled: boolean;
}

export interface Candidate extends MemberRef {
  state: CandidateState;
  reason: string;
  restUntil?: number;
}

export function parseRouteGroups(raw: unknown): RouteGroup[] {
  if (!Array.isArray(raw)) throw new TypeError("routeGroups must be an array");
  const seen = new Set<string>();
  return raw.map((g, i) => {
    const where = `routeGroups[${i}]`;
    if (!g || typeof g !== "object") throw new TypeError(`${where} must be an object`);
    const o = g as Record<string, unknown>;
    const id = String(o.id ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new TypeError(`${where}.id must match [a-z0-9-]`);
    if (seen.has(id)) throw new TypeError(`${where}.id "${id}" is duplicated`);
    seen.add(id);
    const strategy = o.strategy ?? "ordered";
    if (strategy !== "ordered" && strategy !== "smart") throw new TypeError(`${where}.strategy must be ordered|smart`);
    if (!Array.isArray(o.members) || o.members.length === 0) throw new TypeError(`${where}.members must be non-empty`);
    const members = o.members.map((m, j) => {
      const r = (m ?? {}) as Record<string, unknown>;
      const providerId = String(r.providerId ?? "").trim();
      const model = String(r.model ?? "").trim();
      if (!providerId || !model) throw new TypeError(`${where}.members[${j}] needs providerId and model`);
      return { providerId, model };
    });
    return { id, name: String(o.name ?? id), strategy, members, enabled: o.enabled !== false };
  });
}

export interface PlanInput {
  group: RouteGroup;
  request: CanonicalRequest;
  conversationId?: string;
  health: HealthBook;
  affinity: Map<string, string>; // conversationId -> memberKey
  capabilityOf: (m: MemberRef) => { tools: boolean; vision: boolean } | null;
}

function needs(request: CanonicalRequest) {
  const tools = Boolean(request.tools?.length) || request.messages.some((m) => m.toolCalls?.length || m.role === "tool");
  const vision = request.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image"));
  return { tools, vision };
}

// 返回全部成员的判定（给控制台画"为什么没选它"），ready 的按尝试顺序排在前面。
export function plan(input: PlanInput): Candidate[] {
  const { group, request, health } = input;
  const need = needs(request);
  const judged: Candidate[] = group.members.map((m) => {
    const caps = input.capabilityOf(m);
    if (!caps) return { ...m, state: "skipped", reason: "供应商未启用或不存在" };
    if (need.tools && !caps.tools) return { ...m, state: "skipped", reason: "不支持工具调用" };
    if (need.vision && !caps.vision) return { ...m, state: "skipped", reason: "不支持图片" };
    const restUntil = health.restingUntil(m);
    if (restUntil) return { ...m, state: "resting", reason: health.reason(m), restUntil };
    return { ...m, state: "ready", reason: "" };
  });

  const ready = judged.filter((c) => c.state === "ready");
  const rest = judged.filter((c) => c.state !== "ready");
  if (group.strategy === "ordered") {
    ready.forEach((c, i) => (c.reason = i === 0 ? "排在最前且可用" : `备选 #${i + 1}`));
    return [...ready, ...rest];
  }

  // smart：会话亲和（提示词缓存命中）> 最近没出错 > 并发少 > 首字快 > 配置顺序。
  const sticky = input.conversationId ? input.affinity.get(input.conversationId) : undefined;
  const order = new Map(group.members.map((m, i) => [memberKey(m), i]));
  const score = (c: Candidate) => {
    const s = health.stats(c);
    return [
      memberKey(c) === sticky ? 0 : 1,
      s.strikes,
      s.inflight,
      s.ewmaFirstByteMs ?? 0, // 没测过的当作最快，给它一次被探测的机会
      order.get(memberKey(c)) ?? 0,
    ];
  };
  ready.sort((a, b) => {
    const x = score(a);
    const y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  ready.forEach((c, i) => {
    const s = health.stats(c);
    if (i > 0) c.reason = `备选 #${i + 1}`;
    else if (memberKey(c) === sticky) c.reason = "这个会话上次由它回答（缓存更可能命中）";
    else if (s.ewmaFirstByteMs != null) c.reason = `最近首字最快（约 ${s.ewmaFirstByteMs} ms）且并发 ${s.inflight}`;
    else c.reason = "尚无测速数据，先探测";
  });
  return [...ready, ...rest];
}
