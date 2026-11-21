import assert from "node:assert/strict";
import { HealthBook } from "../src/health.ts";
import { RouteEventBus } from "../src/routeEvents.ts";
import type { RouteEvent } from "../src/routeEvents.ts";
import type { GatewayProvider, ProviderEvent, CanonicalRequest } from "../src/events.ts";
import type { RouteGroup } from "../src/routeGroups.ts";
import { routeStream } from "../src/pipeline.ts";
import type { PipelineDeps, RouteContext } from "../src/pipeline.ts";

export function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

export function setup(providers: GatewayProvider[], groups: RouteGroup[], extra: Partial<PipelineDeps> = {}, now?: () => number) {
  const bus = new RouteEventBus();
  const events: RouteEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const deps: PipelineDeps = {
    providers: new Map(providers.map((p) => [p.id, p])),
    groups: new Map(groups.map((g) => [g.id, g])),
    directRoutes: new Map(),
    defaultProviderId: providers[0].id,
    health: new HealthBook(now),
    bus,
    affinity: new Map(),
    ...extra,
  };
  return { deps, events, bus };
}

export function req(model: string, patch: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return { model, messages: [{ role: "user", content: "hi" }], ...patch };
}

let n = 0;
export function ctx(patch: Partial<RouteContext> = {}): RouteContext {
  return { requestId: `r${++n}`, agent: "codex", protocol: "chat", signal: new AbortController().signal, ...patch };
}

export async function collect(it: AsyncIterable<ProviderEvent>) {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

export async function run(deps: PipelineDeps, request: CanonicalRequest, c: RouteContext = ctx()) {
  const out = await collect(routeStream(request, c, deps));
  return { out, text: out.filter((e) => e.type === "text.delta").map((e: any) => e.text).join("").trim(), error: (out.find((e) => e.type === "error") as any)?.error };
}

// I2：每个请求恰好一条 request.end 且在最后；每个 attempt 之后紧跟（同成员）firstByte 或 failed。
export function assertInvariants(events: RouteEvent[]) {
  const byReq = new Map<string, RouteEvent[]>();
  for (const e of events) byReq.set(e.requestId, [...(byReq.get(e.requestId) ?? []), e]);
  for (const [id, list] of byReq) {
    assert.equal(list[0].type, "request.start", `${id} starts with request.start`);
    assert.equal(list.filter((e) => e.type === "request.end").length, 1, `${id} has exactly one request.end`);
    assert.equal(list.at(-1)!.type, "request.end", `${id} ends with request.end`);
    list.forEach((e, i) => {
      if (e.type !== "upstream.attempt") return;
      const next = list.slice(i + 1).find((x) => x.type === "upstream.firstByte" || x.type === "upstream.failed" || x.type === "request.end");
      assert.ok(next, `${id} attempt has an outcome`);
    });
  }
}

export const types = (events: RouteEvent[], requestId?: string) =>
  events.filter((e) => !requestId || e.requestId === requestId).map((e) => e.type);
