// 网关管线：借 langchain middleware 的语义（beforeModel / wrapModelCall / modelFallback / callLimit），
// 但自己实现、零运行时依赖。核心不变量：
//   I1 改道只发生在"下游还没收到任何内容事件"之前；一旦提交（commit），错误原样下发、不再换人。
//   I2 每次请求恰好一条 request.end；每次尝试恰好一条 upstream.attempt，且其后要么 firstByte 要么 failed。
//   I3 只在路由组成员之间改道，成员由用户显式配置；直连模型（非 group/）不改道。
import { ERROR_CODES, ProviderError, toProviderError } from "./events.ts";
import type { CanonicalRequest, GatewayProvider, ProviderContext, ProviderEvent } from "./events.ts";
import type { HealthBook } from "./health.ts";
import { memberKey } from "./health.ts";
import { plan } from "./routeGroups.ts";
import type { Candidate, RouteGroup } from "./routeGroups.ts";
import type { MemberRef, RouteEventBus } from "./routeEvents.ts";

export interface RouteContext extends ProviderContext {
  agent: string; // 由下游 Key 识别（claude-code / codex / opencode / unknown）
  protocol: string; // chat | responses | messages
}

// 中间件：只有两个钩子，够用为止。
export interface GatewayMiddleware {
  name: string;
  // 改写请求（例如注入默认 maxTokens、剥离某供应商不认的字段）。返回新对象，不要原地改。
  beforeRequest?: (request: CanonicalRequest, ctx: RouteContext) => CanonicalRequest;
  // 观察每一个下发事件（用量计量、日志）。不能改事件、不能抛错。
  onEvent?: (event: ProviderEvent, member: MemberRef, ctx: RouteContext) => void;
}

export interface PipelineDeps {
  providers: Map<string, GatewayProvider>;
  groups: Map<string, RouteGroup>;
  directRoutes: Map<string, MemberRef>; // 旧 QODER_MODEL_ROUTES 语义：别名 → 单一目标
  defaultProviderId: string;
  health: HealthBook;
  bus: RouteEventBus;
  affinity: Map<string, string>;
  middlewares?: GatewayMiddleware[];
  maxAttempts?: number; // 对应 langchain modelCallLimit：一次请求最多试几个上游
}

const COMMITTING = new Set(["text.delta", "thinking.delta", "tool.start", "tool.arguments.delta", "tool.end", "message.end"]);

export function resolveTarget(alias: string, deps: PipelineDeps): { group: RouteGroup | null; direct: MemberRef | null } {
  const name = alias.startsWith("group/") ? alias.slice(6) : null;
  if (name !== null) {
    const group = deps.groups.get(name) ?? [...deps.groups.values()].find((g) => g.name === name);
    if (!group || !group.enabled) throw new ProviderError(ERROR_CODES.MODEL_NOT_FOUND, `unknown route group: ${name}`);
    return { group, direct: null };
  }
  const direct = deps.directRoutes.get(alias);
  if (direct) return { group: null, direct };
  // provider/model 显式写法，如 deepseek/deepseek-chat
  const slash = alias.indexOf("/");
  if (slash > 0 && deps.providers.has(alias.slice(0, slash))) {
    return { group: null, direct: { providerId: alias.slice(0, slash), model: alias.slice(slash + 1) } };
  }
  return { group: null, direct: { providerId: deps.defaultProviderId, model: alias } };
}

export async function* routeStream(
  input: CanonicalRequest,
  ctx: RouteContext,
  deps: PipelineDeps,
): AsyncGenerator<ProviderEvent> {
  const startedAt = deps.health.now();
  const { bus, health } = deps;
  const mws = deps.middlewares ?? [];
  let request = input;
  for (const mw of mws) if (mw.beforeRequest) request = mw.beforeRequest(request, ctx);

  let target: ReturnType<typeof resolveTarget>;
  try {
    target = resolveTarget(input.model, deps);
  } catch (error) {
    const err = toProviderError(error);
    bus.emit({ type: "request.start", requestId: ctx.requestId, at: startedAt, agent: ctx.agent, alias: input.model, groupId: null, protocol: ctx.protocol });
    bus.emit({ type: "request.end", requestId: ctx.requestId, at: health.now(), outcome: "error", member: null, ms: 0, reroutes: 0, errorCode: err.code });
    yield { type: "error", error: err };
    return;
  }
  bus.emit({ type: "request.start", requestId: ctx.requestId, at: startedAt, agent: ctx.agent, alias: input.model, groupId: target.group?.id ?? null, protocol: ctx.protocol });

  const capabilityOf = (m: MemberRef) => deps.providers.get(m.providerId)?.capabilities() ?? null;
  const candidates: Candidate[] = target.group
    ? plan({ group: target.group, request, conversationId: ctx.conversationId, health, affinity: deps.affinity, capabilityOf })
    : [{ ...target.direct!, state: capabilityOf(target.direct!) ? "ready" : "skipped", reason: capabilityOf(target.direct!) ? "直连，不改道" : "供应商未启用或不存在" }];
  bus.emit({ type: "route.decision", requestId: ctx.requestId, at: health.now(), strategy: target.group?.strategy ?? "direct", candidates });

  const ready = candidates.filter((c) => c.state === "ready").slice(0, deps.maxAttempts ?? 3);
  let reroutes = 0;
  let lastError: ProviderError | null = null;
  const end = (outcome: "ok" | "error" | "cancelled", member: MemberRef | null, extra: { errorCode?: string; usage?: { inputTokens?: number; outputTokens?: number } } = {}) =>
    bus.emit({ type: "request.end", requestId: ctx.requestId, at: health.now(), outcome, member, ms: health.now() - startedAt, reroutes, ...extra });

  for (let i = 0; i < ready.length; i++) {
    const member: MemberRef = { providerId: ready[i].providerId, model: ready[i].model };
    const provider = deps.providers.get(member.providerId)!;
    const attemptAt = health.now();
    bus.emit({ type: "upstream.attempt", requestId: ctx.requestId, at: attemptAt, member, attempt: i + 1 });
    health.begin(member);
    const iterator = provider.stream({ ...request, model: member.model }, ctx)[Symbol.asyncIterator]();
    const held: ProviderEvent[] = [];
    let committed = false;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    const emitDown = function* (event: ProviderEvent) {
      if (event.type === "usage") usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
      for (const mw of mws) {
        try {
          mw.onEvent?.(event, member, ctx);
        } catch {
          /* 观察者不能影响数据面 */
        }
      }
      yield event;
    };
    try {
      while (true) {
        const step = await iterator.next();
        if (step.done) break;
        const event = step.value;
        if (event.type === "error") throw event.error;
        if (!committed && COMMITTING.has(event.type)) {
          committed = true;
          const ms = health.now() - attemptAt;
          health.firstByte(member, ms);
          bus.emit({ type: "upstream.firstByte", requestId: ctx.requestId, at: health.now(), member, ms });
          for (const h of held) yield* emitDown(h);
          held.length = 0;
        }
        if (committed) yield* emitDown(event);
        else held.push(event);
      }
      if (ctx.signal.aborted) throw new ProviderError(ERROR_CODES.PROVIDER_ABORTED, "client aborted");
      if (!committed) {
        // 上游干净结束但没有任何内容：视为协议错误，可改道（真实遇到过空 body，见 qoder dc6336f）。
        throw new ProviderError(ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "upstream ended without content");
      }
      health.success(member);
      if (ctx.conversationId) deps.affinity.set(ctx.conversationId, memberKey(member));
      end("ok", member, { usage });
      return;
    } catch (error) {
      const err = toProviderError(error, ctx.signal);
      await iterator.return?.(undefined).catch(() => {});
      if (err.code === ERROR_CODES.PROVIDER_ABORTED) {
        end("cancelled", member);
        return; // 客户端走了，不再下发
      }
      const verdict = health.failure(member, err);
      bus.emit({ type: "upstream.failed", requestId: ctx.requestId, at: health.now(), member, code: err.code, status: err.status, restUntil: verdict.restUntil, reroutable: verdict.reroutable && !committed });
      if (committed || !verdict.reroutable) {
        yield { type: "error", error: err };
        end("error", member, { errorCode: err.code, usage });
        return;
      }
      lastError = err;
      const next = ready[i + 1];
      if (next) {
        reroutes++;
        bus.emit({ type: "reroute", requestId: ctx.requestId, at: health.now(), from: member, to: { providerId: next.providerId, model: next.model }, reason: verdict.reason });
      }
    } finally {
      health.end(member);
    }
  }

  // 一个都没成：把"最该让客户端知道的"错误给出去。全部在歇 → 429 + 最早恢复时间。
  const resting = candidates.filter((c) => c.state === "resting" && c.restUntil);
  let finalError = lastError;
  if (!finalError) {
    if (resting.length) {
      const soonest = Math.min(...resting.map((c) => c.restUntil!));
      finalError = new ProviderError(ERROR_CODES.PROVIDER_RATE_LIMITED, "all members of the route group are resting", { retryAfterMs: Math.max(0, soonest - health.now()) });
    } else {
      finalError = new ProviderError(ERROR_CODES.UNSUPPORTED_CAPABILITY, "no member of the route group can serve this request");
    }
  }
  yield { type: "error", error: finalError };
  end("error", null, { errorCode: finalError.code });
}

// 协议层用：先等第一个事件再决定 HTTP 状态码（修 Q-P1-2 的前提）。
// 第一个就是 error → 还能回 4xx/5xx + Retry-After；否则 beginSse 后把它连同剩余事件一起写出。
export async function peekFirst(stream: AsyncIterable<ProviderEvent>): Promise<{ first: ProviderEvent | null; rest: AsyncIterator<ProviderEvent> }> {
  const rest = stream[Symbol.asyncIterator]();
  const step = await rest.next();
  return { first: step.done ? null : step.value, rest };
}

export function httpStatusOf(error: ProviderError): { status: number; retryAfterSec?: number } {
  switch (error.code) {
    case ERROR_CODES.PROVIDER_RATE_LIMITED:
      return { status: 429, retryAfterSec: error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : undefined };
    case ERROR_CODES.PROVIDER_AUTH_ERROR:
      return { status: 502 }; // 上游 Key 坏了不是客户端的 401
    case ERROR_CODES.PROVIDER_TIMEOUT:
      return { status: 504 };
    case ERROR_CODES.PROVIDER_UNAVAILABLE:
    case ERROR_CODES.PROVIDER_PROTOCOL_ERROR:
      return { status: 502 };
    case ERROR_CODES.MODEL_NOT_FOUND:
    case ERROR_CODES.UNSUPPORTED_CAPABILITY:
    case ERROR_CODES.PROVIDER_REJECTED:
      return { status: 400 };
    case ERROR_CODES.PROVIDER_ABORTED:
      return { status: 499 };
    default:
      return { status: 500 };
  }
}
