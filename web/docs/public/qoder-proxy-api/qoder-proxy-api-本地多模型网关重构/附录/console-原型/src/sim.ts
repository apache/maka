// mock 模式：在浏览器里按与网关管线相同的规则产生 RouteEvent（同一 schema），驱动所有页面。
// 规则对齐 附录/代码骨架/src/pipeline.ts：首字节前可改道；限流按 Retry-After 歇；smart 看并发与首字速度。
import { keyOf } from "./contracts";
import type { MemberRef, RouteEvent } from "./contracts";
import { useStore } from "./store";

const rest = new Map<string, number>();
const inflight = new Map<string, number>();
const ewma = new Map<string, number>();
let kimiCalls = 0;
let n = 0;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const later = (ms: number, f: () => void) => window.setTimeout(f, ms);

function emit(e: RouteEvent) {
  useStore.getState().apply(e);
}

function startRequest(agentId?: string) {
  const s = useStore.getState();
  const connected = s.agents.filter((a) => a.connected);
  if (!connected.length) return;
  const agent = agentId ? connected.find((a) => a.id === agentId) ?? connected[0] : connected[Math.floor(Math.random() * connected.length)];
  const requestId = `req_${(++n).toString().padStart(4, "0")}`;
  const now = Date.now();
  const groupId = agent.model.startsWith("group/") ? agent.model.slice(6) : null;
  const group = groupId ? s.groups.find((g) => g.id === groupId) : null;
  const protocol = agent.id === "claude-code" ? "messages" : agent.id === "codex" ? "responses" : "chat";
  emit({ type: "request.start", requestId, at: now, agent: agent.id, alias: agent.model, groupId: group?.id ?? null, protocol });

  const members: MemberRef[] = group ? group.members : [{ providerId: agent.model.split("/")[0], model: agent.model.split("/").slice(1).join("/") }];
  const judged = members.map((m) => {
    const p = s.providers.find((x) => x.id === m.providerId);
    if (!p || !p.enabled) return { ...m, state: "skipped" as const, reason: "供应商未启用" };
    const until = rest.get(keyOf(m)) ?? 0;
    if (until > now) return { ...m, state: "resting" as const, reason: `限流 · ${Math.ceil((until - now) / 1000)} 秒后恢复`, restUntil: until };
    return { ...m, state: "ready" as const, reason: "" };
  });
  let ready = judged.filter((c) => c.state === "ready");
  if (group?.strategy === "smart") {
    ready = [...ready].sort((a, b) => (inflight.get(keyOf(a)) ?? 0) - (inflight.get(keyOf(b)) ?? 0) || (ewma.get(keyOf(a)) ?? 0) - (ewma.get(keyOf(b)) ?? 0));
    ready.forEach((c, i) => (c.reason = i === 0 ? `并发最少（${inflight.get(keyOf(c)) ?? 0}）${ewma.has(keyOf(c)) ? `，首字约 ${ewma.get(keyOf(c))} ms` : ""}` : `备选 #${i + 1}`));
  } else {
    ready.forEach((c, i) => (c.reason = !group ? "直连，不改道" : i === 0 ? "排在最前且可用" : `备选 #${i + 1}`));
  }
  const candidates = [...ready, ...judged.filter((c) => c.state !== "ready")];
  emit({ type: "route.decision", requestId, at: now, strategy: group ? group.strategy : "direct", candidates });

  let reroutes = 0;
  const attempt = (i: number) => {
    const c = ready[i];
    if (!c) {
      emit({ type: "request.end", requestId, at: Date.now(), outcome: "error", member: null, ms: Date.now() - now, reroutes, errorCode: "PROVIDER_RATE_LIMITED" });
      return;
    }
    const m = { providerId: c.providerId, model: c.model };
    const k = keyOf(m);
    const t0 = Date.now();
    emit({ type: "upstream.attempt", requestId, at: t0, member: m, attempt: i + 1 });
    inflight.set(k, (inflight.get(k) ?? 0) + 1);
    const fails = m.providerId === "kimi" && ++kimiCalls % 3 !== 1;
    if (fails) {
      later(rnd(200, 400), () => {
        inflight.set(k, Math.max(0, (inflight.get(k) ?? 1) - 1));
        const until = Date.now() + 6000;
        rest.set(k, until);
        emit({ type: "upstream.failed", requestId, at: Date.now(), member: m, code: "PROVIDER_RATE_LIMITED", status: 429, restUntil: until, reroutable: true });
        const next = ready[i + 1];
        if (next) {
          reroutes++;
          emit({ type: "reroute", requestId, at: Date.now(), from: m, to: { providerId: next.providerId, model: next.model }, reason: "限流 · 6 秒后恢复" });
        }
        attempt(i + 1);
      });
      return;
    }
    const fb = Math.round(rnd(m.providerId === "glm" ? 500 : 250, m.providerId === "glm" ? 1100 : 700));
    later(fb, () => {
      ewma.set(k, Math.round((ewma.get(k) ?? fb) * 0.7 + fb * 0.3));
      emit({ type: "upstream.firstByte", requestId, at: Date.now(), member: m, ms: fb });
      later(rnd(1800, 4200), () => {
        inflight.set(k, Math.max(0, (inflight.get(k) ?? 1) - 1));
        emit({
          type: "request.end", requestId, at: Date.now(), outcome: "ok", member: m, ms: Date.now() - now, reroutes,
          usage: { inputTokens: Math.round(rnd(8_000, 60_000)), outputTokens: Math.round(rnd(200, 2_400)) },
        });
      });
    });
  };
  attempt(0);
}

export function startSimulation(): () => void {
  // 开场三连发：三个 Agent 同时往同一组发，便于看清 smart 分流与限流改道
  const timers = [later(100, () => startRequest("claude-code")), later(350, () => startRequest("codex")), later(600, () => startRequest("opencode"))];
  const loop = window.setInterval(() => {
    if (Object.keys(useStore.getState().active).length < 5) startRequest();
  }, 1300);
  return () => {
    timers.forEach(clearTimeout);
    clearInterval(loop);
  };
}
