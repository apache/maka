import { create } from "zustand";
import { keyOf, RouteEvent } from "./contracts";
import type { AgentIntegration, MemberRef, Provider, RouteGroup } from "./contracts";
import * as seed from "./seed";

export interface Active {
  requestId: string;
  agent: string;
  alias: string;
  groupId: string | null;
  protocol: string;
  member?: MemberRef;
  phase: "routing" | "waiting" | "answering";
  startedAt: number;
}
export interface Finished {
  requestId: string;
  agent: string;
  groupId: string | null;
  outcome: "ok" | "error" | "cancelled";
  member: MemberRef | null;
  ms: number;
  reroutes: number;
  at: number;
  inputTokens: number;
  outputTokens: number;
}
type Health = Record<string, { restUntil: number; reason: string }>;

interface State {
  mode: "mock" | "live";
  connection: "connecting" | "open" | "closed";
  gatewayAddr: string;
  theme: "light" | "dark";
  now: number;
  providers: Provider[];
  groups: RouteGroup[];
  agents: AgentIntegration[];
  plans: Array<{ id: string; name: string; mapping: Record<string, string> }>;
  activePlan: string | null;
  health: Health;
  active: Record<string, Active>;
  traces: Record<string, RouteEvent[]>;
  finished: Finished[];
  lastFinishedId: string | null;
  invalidEvents: number;
  apply: (raw: unknown) => void;
  tick: () => void;
  setTheme: (t: "light" | "dark") => void;
  setAgentModel: (id: string, model: string) => void;
  setAgentConnected: (id: string, connected: boolean) => void;
  applyPlan: (id: string) => void;
  savePlan: (name: string) => void;
  upsertGroup: (g: RouteGroup) => void;
  resetHealth: (m: MemberRef) => void;
}

const CODE_TEXT: Record<string, string> = {
  PROVIDER_RATE_LIMITED: "限流",
  PROVIDER_AUTH_ERROR: "Key 被拒",
  PROVIDER_UNAVAILABLE: "上游不可用",
  PROVIDER_TIMEOUT: "超时",
  MODEL_NOT_FOUND: "不提供该模型",
};
export const codeText = (c?: string) => (c ? CODE_TEXT[c] ?? c : "");

export const useStore = create<State>((set, get) => ({
  mode: "mock",
  connection: "connecting",
  gatewayAddr: "127.0.0.1:8320",
  theme: "light",
  now: Date.now(),
  providers: seed.providers,
  groups: seed.groups,
  agents: seed.agents,
  plans: seed.plans,
  activePlan: "focus",
  health: {},
  active: {},
  traces: {},
  finished: [],
  lastFinishedId: null,
  invalidEvents: 0,

  apply(raw) {
    const parsed = RouteEvent.safeParse(raw);
    if (!parsed.success) {
      set((s) => ({ invalidEvents: s.invalidEvents + 1 }));
      return;
    }
    const e = parsed.data;
    set((s) => {
      const traces = { ...s.traces, [e.requestId]: [...(s.traces[e.requestId] ?? []), e] };
      const active = { ...s.active };
      const health = { ...s.health };
      const cur = active[e.requestId];
      switch (e.type) {
        case "request.start":
          active[e.requestId] = { requestId: e.requestId, agent: e.agent, alias: e.alias, groupId: e.groupId, protocol: e.protocol, phase: "routing", startedAt: e.at };
          break;
        case "route.decision":
          for (const c of e.candidates) if (c.state === "resting" && c.restUntil) health[keyOf(c)] = { restUntil: c.restUntil, reason: c.reason };
          break;
        case "upstream.attempt":
          if (cur) active[e.requestId] = { ...cur, member: e.member, phase: "waiting" };
          break;
        case "upstream.firstByte":
          if (cur) active[e.requestId] = { ...cur, phase: "answering" };
          break;
        case "upstream.failed":
          if (e.restUntil) health[keyOf(e.member)] = { restUntil: e.restUntil, reason: `${codeText(e.code)} · 恢复中` };
          break;
        case "reroute": {
          const h = health[keyOf(e.from)];
          if (h) health[keyOf(e.from)] = { ...h, reason: e.reason };
          break;
        }
        case "request.end": {
          delete active[e.requestId];
          const start = s.traces[e.requestId]?.find((x) => x.type === "request.start");
          const fin: Finished = {
            requestId: e.requestId,
            agent: start?.type === "request.start" ? start.agent : "unknown",
            groupId: start?.type === "request.start" ? start.groupId : null,
            outcome: e.outcome,
            member: e.member,
            ms: e.ms,
            reroutes: e.reroutes,
            at: e.at,
            inputTokens: e.usage?.inputTokens ?? 0,
            outputTokens: e.usage?.outputTokens ?? 0,
          };
          // 有界：只保留最近 60 条请求的轨迹、500 条完成记录
          const keep = Object.keys(traces).slice(-60);
          return {
            traces: Object.fromEntries(keep.map((k) => [k, traces[k]])),
            active,
            health,
            finished: [...s.finished, fin].slice(-500),
            lastFinishedId: e.requestId,
          };
        }
      }
      return { traces, active, health };
    });
  },
  tick: () => set({ now: Date.now() }),
  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },
  setAgentModel: (id, model) => set((s) => ({ agents: s.agents.map((a) => (a.id === id ? { ...a, model } : a)), activePlan: null })),
  setAgentConnected: (id, connected) =>
    set((s) => ({
      agents: s.agents.map((a) =>
        a.id === id ? { ...a, connected, backupPath: connected ? a.backupPath ?? `~/.qoder-proxy-api/backups/${a.id}.${new Date().toISOString().slice(0, 10)}.bak` : a.backupPath } : a,
      ),
    })),
  applyPlan: (id) => {
    const plan = get().plans.find((p) => p.id === id);
    if (!plan) return;
    set((s) => ({ agents: s.agents.map((a) => ({ ...a, model: plan.mapping[a.id] ?? a.model })), activePlan: id }));
  },
  savePlan: (name) =>
    set((s) => {
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || `plan-${s.plans.length + 1}`;
      return { plans: [...s.plans, { id, name, mapping: Object.fromEntries(s.agents.map((a) => [a.id, a.model])) }], activePlan: id };
    }),
  upsertGroup: (g) => set((s) => ({ groups: s.groups.some((x) => x.id === g.id) ? s.groups.map((x) => (x.id === g.id ? g : x)) : [...s.groups, g] })),
  resetHealth: (m) =>
    set((s) => {
      const health = { ...s.health };
      delete health[keyOf(m)];
      return { health };
    }),
}));

export function restingOf(health: Health, m: MemberRef, now: number) {
  const h = health[keyOf(m)];
  return h && h.restUntil > now ? h : null;
}

// 便于 E2E / 调试读取状态（只读用途）
(globalThis as unknown as { __qpaStore: typeof useStore }).__qpaStore = useStore;
