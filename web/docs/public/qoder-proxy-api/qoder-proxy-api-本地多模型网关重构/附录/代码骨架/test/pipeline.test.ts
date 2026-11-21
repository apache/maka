import { test } from "node:test";
import assert from "node:assert/strict";
import { scripted } from "../src/fakes.ts";
import { classify } from "../src/health.ts";
import { ProviderError, ERROR_CODES } from "../src/events.ts";
import { parseRouteGroups } from "../src/routeGroups.ts";
import type { RouteGroup } from "../src/routeGroups.ts";
import { httpStatusOf, peekFirst, routeStream } from "../src/pipeline.ts";
import { assertInvariants, clock, collect, ctx, req, run, setup, types } from "./helpers.ts";

const group = (strategy: "ordered" | "smart", ids: string[], id = "g"): RouteGroup => ({
  id, name: id, strategy, enabled: true, members: ids.map((p) => ({ providerId: p, model: "m" })),
});

test("ordered：首字节前 429 → 改道下一个，下游只看到后者的内容", async () => {
  const c = clock();
  const a = scripted("a", [{ kind: "fail", code: "PROVIDER_RATE_LIMITED", retryAfterMs: 6000 }]);
  const b = scripted("b", [{ kind: "ok", text: "hello from b" }]);
  const { deps, events } = setup([a, b], [group("ordered", ["a", "b"])], {}, c.now);
  const r = await run(deps, req("group/g"), ctx({ requestId: "x1" }));
  assert.equal(r.text, "hello from b");
  assert.equal(r.error, undefined);
  assert.deepEqual(types(events, "x1"), [
    "request.start", "route.decision", "upstream.attempt", "upstream.failed", "reroute",
    "upstream.attempt", "upstream.firstByte", "request.end",
  ]);
  const endEv: any = events.at(-1);
  assert.equal(endEv.outcome, "ok");
  assert.equal(endEv.reroutes, 1);
  assert.equal(endEv.member.providerId, "b");
  assert.equal(deps.health.restingUntil({ providerId: "a", model: "m" }), c.now() + 6000);
  assertInvariants(events);
});

test("ordered：歇着的成员被跳过并在 decision 里写明原因；到点自动恢复", async () => {
  const c = clock();
  const a = scripted("a", [{ kind: "fail", code: "PROVIDER_RATE_LIMITED", retryAfterMs: 6000 }, { kind: "ok", text: "a back" }]);
  const b = scripted("b", [{ kind: "ok", text: "b1" }, { kind: "ok", text: "b2" }]);
  const { deps, events } = setup([a, b], [group("ordered", ["a", "b"])], {}, c.now);
  await run(deps, req("group/g"));
  const r2 = await run(deps, req("group/g"), ctx({ requestId: "x2" }));
  assert.equal(r2.text, "b2");
  assert.equal(a.calls.length, 1, "歇着的 a 不被调用");
  const decision: any = events.find((e) => e.requestId === "x2" && e.type === "route.decision");
  assert.equal(decision.candidates[1].providerId, "a");
  assert.equal(decision.candidates[1].state, "resting");
  assert.match(decision.candidates[1].reason, /限流 · 6 秒后恢复/);
  c.advance(6001);
  const r3 = await run(deps, req("group/g"));
  assert.equal(r3.text, "a back");
  assertInvariants(events);
});

test("I1：已经下发内容后失败 → 不改道，错误原样下发", async () => {
  const a = scripted("a", [{ kind: "failAfter", text: "partial answer", code: "PROVIDER_UNAVAILABLE" }]);
  const b = scripted("b", [{ kind: "ok", text: "should not run" }]);
  const { deps, events } = setup([a, b], [group("ordered", ["a", "b"])]);
  const r = await run(deps, req("group/g"));
  assert.equal(r.text, "partial answer");
  assert.equal(r.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(b.calls.length, 0);
  const failed: any = events.find((e) => e.type === "upstream.failed");
  assert.equal(failed.reroutable, false);
  assert.ok(!types(events).includes("reroute"));
  assertInvariants(events);
});

test("请求本身被拒（400/拒答）→ 不改道、不让成员歇", async () => {
  const a = scripted("a", [{ kind: "fail", code: "PROVIDER_REJECTED" }]);
  const b = scripted("b", [{ kind: "ok", text: "x" }]);
  const { deps } = setup([a, b], [group("ordered", ["a", "b"])]);
  const r = await run(deps, req("group/g"));
  assert.equal(r.error.code, "PROVIDER_REJECTED");
  assert.equal(b.calls.length, 0);
  assert.equal(deps.health.restingUntil({ providerId: "a", model: "m" }), null);
});

test("全部在歇 → 429 + 最早恢复时间，且不打上游", async () => {
  const c = clock();
  const a = scripted("a", [{ kind: "fail", code: "PROVIDER_RATE_LIMITED", retryAfterMs: 9000 }]);
  const b = scripted("b", [{ kind: "fail", code: "PROVIDER_RATE_LIMITED", retryAfterMs: 4000 }]);
  const { deps, events } = setup([a, b], [group("ordered", ["a", "b"])], {}, c.now);
  const r1 = await run(deps, req("group/g"));
  assert.equal(r1.error.code, "PROVIDER_RATE_LIMITED");
  c.advance(1000);
  const r2 = await run(deps, req("group/g"));
  assert.equal(r2.error.code, "PROVIDER_RATE_LIMITED");
  assert.equal(r2.error.retryAfterMs, 3000);
  assert.deepEqual(httpStatusOf(r2.error), { status: 429, retryAfterSec: 3 });
  assert.equal(a.calls.length + b.calls.length, 2);
  assertInvariants(events);
});

test("能力过滤：带图片的请求跳过不支持图片的成员", async () => {
  const a = scripted("a", [{ kind: "ok", text: "a" }], { vision: false });
  const b = scripted("b", [{ kind: "ok", text: "b sees" }], { vision: true });
  const { deps, events } = setup([a, b], [group("ordered", ["a", "b"])]);
  const r = await run(deps, req("group/g", { messages: [{ role: "user", content: [{ type: "text", text: "看图" }, { type: "image", source: { url: "data:," } }] }] }));
  assert.equal(r.text, "b sees");
  const d: any = events.find((e) => e.type === "route.decision");
  assert.deepEqual(d.candidates.map((x: any) => [x.providerId, x.state, x.reason]).at(-1), ["a", "skipped", "不支持图片"]);
});

test("smart：会话亲和优先；无会话时选首字更快的", async () => {
  const a = scripted("a", () => ({ kind: "ok", text: "A" }));
  const b = scripted("b", () => ({ kind: "ok", text: "B" }));
  const { deps } = setup([a, b], [group("smart", ["a", "b"])]);
  const r1 = await run(deps, req("group/g"), ctx({ conversationId: "c1" }));
  assert.equal(r1.text, "A", "都没测速时按配置顺序");
  deps.health.firstByte({ providerId: "a", model: "m" }, 2000);
  deps.health.firstByte({ providerId: "b", model: "m" }, 300);
  assert.equal((await run(deps, req("group/g"))).text, "B", "无会话 → 更快的 B");
  assert.equal((await run(deps, req("group/g"), ctx({ conversationId: "c1" }))).text, "A", "c1 亲和 A");
});

test("客户端中止 → cancelled，不改道、不下发错误", async () => {
  const a = scripted("a", [{ kind: "hang" }]);
  const b = scripted("b", [{ kind: "ok", text: "no" }]);
  const { deps, events } = setup([a, b], [group("ordered", ["a", "b"])]);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const r = await run(deps, req("group/g"), ctx({ signal: ac.signal }));
  assert.equal(r.out.length, 0);
  assert.equal(b.calls.length, 0);
  assert.equal((events.at(-1) as any).outcome, "cancelled");
  assertInvariants(events);
});

test("maxAttempts 限制一次请求最多试几个上游", async () => {
  const mk = (id: string) => scripted(id, [{ kind: "fail", code: "PROVIDER_UNAVAILABLE" }]);
  const ps = [mk("a"), mk("b"), mk("c")];
  const { deps } = setup(ps, [group("ordered", ["a", "b", "c"])], { maxAttempts: 2 });
  const r = await run(deps, req("group/g"));
  assert.equal(r.error.code, "PROVIDER_UNAVAILABLE");
  assert.deepEqual(ps.map((p) => p.calls.length), [1, 1, 0]);
});

test("上游空回复视为协议错误，可改道", async () => {
  const a = scripted("a", [{ kind: "ok", text: "" }]);
  // text "" 会产出一个 " " 的 delta；改用自定义空流
  a.stream = async function* () { yield { type: "message.start" } as const; };
  const b = scripted("b", [{ kind: "ok", text: "filled" }]);
  const { deps } = setup([a, b], [group("ordered", ["a", "b"])]);
  assert.equal((await run(deps, req("group/g"))).text, "filled");
});

test("直连模型（provider/model）失败不改道", async () => {
  const a = scripted("a", [{ kind: "fail", code: "PROVIDER_RATE_LIMITED" }]);
  const b = scripted("b", [{ kind: "ok", text: "no" }]);
  const { deps, events } = setup([a, b], [group("ordered", ["a", "b"])]);
  const r = await run(deps, req("a/m"));
  assert.equal(r.error.code, "PROVIDER_RATE_LIMITED");
  assert.equal(b.calls.length, 0);
  assert.equal((events.find((e) => e.type === "route.decision") as any).strategy, "direct");
});

test("未知路由组 → MODEL_NOT_FOUND（400），仍有 request.end", async () => {
  const a = scripted("a", []);
  const { deps, events } = setup([a], []);
  const r = await run(deps, req("group/nope"));
  assert.equal(r.error.code, "MODEL_NOT_FOUND");
  assert.equal(httpStatusOf(r.error).status, 400);
  assertInvariants(events);
});

test("peekFirst：第一个事件就是 error 时协议层还能回 HTTP 状态码", async () => {
  const a = scripted("a", [{ kind: "fail", code: "PROVIDER_RATE_LIMITED", retryAfterMs: 2000 }]);
  const { deps } = setup([a], [group("ordered", ["a"])]);
  const { first, rest } = await peekFirst(routeStream(req("group/g"), ctx(), deps));
  assert.equal(first?.type, "error");
  assert.deepEqual(httpStatusOf((first as any).error), { status: 429, retryAfterSec: 2 });
  assert.equal((await rest.next()).done, true);
});

test("中间件：beforeRequest 改写请求，onEvent 观察用量且异常不影响数据面", async () => {
  let seenMax: number | undefined;
  const b = scripted("b", [{ kind: "ok", text: "ok" }]);
  const origStream = b.stream.bind(b);
  b.stream = (r, c) => { seenMax = r.maxTokens; return origStream(r, c); };
  const usage: number[] = [];
  const { deps } = setup([b], [group("ordered", ["b"])], {
    middlewares: [
      { name: "defaults", beforeRequest: (r) => ({ ...r, maxTokens: r.maxTokens ?? 4096 }) },
      { name: "meter", onEvent: (e) => { if (e.type === "usage") usage.push(e.outputTokens ?? 0); } },
      { name: "broken", onEvent: () => { throw new Error("boom"); } },
    ],
  });
  const r = await run(deps, req("group/g"));
  assert.equal(r.text, "ok");
  assert.equal(seenMax, 4096);
  assert.deepEqual(usage, [2]);
});

test("classify：限流指数退避与上限；Retry-After 上限 1 小时", () => {
  const rl = (retryAfterMs?: number) => new ProviderError(ERROR_CODES.PROVIDER_RATE_LIMITED, "x", { retryAfterMs });
  assert.equal(classify(rl(), 0).restMs, 60_000);
  assert.equal(classify(rl(), 1).restMs, 120_000);
  assert.equal(classify(rl(), 10).restMs, 30 * 60_000);
  assert.equal(classify(rl(7_200_000), 0).restMs, 3_600_000);
  assert.equal(classify(new ProviderError(ERROR_CODES.PROVIDER_UNAVAILABLE, "x"), 9).restMs, 10 * 60_000);
  assert.equal(classify(new ProviderError(ERROR_CODES.PROVIDER_REJECTED, "x"), 0).reroutable, false);
});

test("parseRouteGroups：手写校验给出可定位的报错", () => {
  assert.throws(() => parseRouteGroups([{ id: "Bad Id", members: [{ providerId: "a", model: "m" }] }]), /routeGroups\[0\]\.id/);
  assert.throws(() => parseRouteGroups([{ id: "g", strategy: "random", members: [{ providerId: "a", model: "m" }] }]), /strategy/);
  assert.throws(() => parseRouteGroups([{ id: "g", members: [] }]), /members/);
  assert.throws(() => parseRouteGroups([{ id: "g", members: [{ providerId: "a" }] }]), /members\[0\]/);
  const [g] = parseRouteGroups([{ id: "long-context", name: "Long context", strategy: "smart", members: [{ providerId: "deepseek", model: "deepseek-chat" }] }]);
  assert.equal(g.enabled, true);
});

test("collect 辅助：确保 routeStream 可被多次独立调用", async () => {
  const a = scripted("a", () => ({ kind: "ok", text: "z" }));
  const { deps } = setup([a], [group("ordered", ["a"])]);
  const [x, y] = await Promise.all([collect(routeStream(req("group/g"), ctx(), deps)), collect(routeStream(req("group/g"), ctx(), deps))]);
  assert.equal(x.length, y.length);
});
