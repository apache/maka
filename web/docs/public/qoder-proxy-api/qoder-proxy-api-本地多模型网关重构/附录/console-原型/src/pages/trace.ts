import type { Provider, RouteEvent } from "../contracts";
import { agentName } from "../seed";
import { codeText } from "../store";

const PROTO: Record<string, string> = { messages: "Anthropic Messages", responses: "OpenAI Responses", chat: "Chat Completions" };
const fmtK = (n?: number) => (n == null ? "?" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const clock = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour12: false });

export function narrate(events: RouteEvent[], providers: Provider[]): Array<{ tone: "muted" | "ok" | "bad" | "warn" | "accent"; text: string }> {
  const label = (id: string) => providers.find((p) => p.id === id)?.label ?? id;
  const out: Array<{ tone: "muted" | "ok" | "bad" | "warn" | "accent"; text: string }> = [];
  const t0 = events[0]?.at ?? 0;
  const dt = (at: number) => `+${at - t0}ms`;
  for (const e of events) {
    switch (e.type) {
      case "request.start":
        out.push({ tone: "muted", text: `${clock(e.at)} ${agentName[e.agent] ?? e.agent} 请求 ${e.alias}（${PROTO[e.protocol] ?? e.protocol}）` });
        break;
      case "route.decision": {
        const ready = e.candidates.filter((c) => c.state === "ready");
        const others = e.candidates.filter((c) => c.state !== "ready");
        const s = e.strategy === "smart" ? "智能" : e.strategy === "ordered" ? "按顺序" : "直连";
        let text = `策略「${s}」：候选 ${ready.map((c) => label(c.providerId)).join(" → ") || "无"}`;
        if (ready[0]?.reason) text += `；先选 ${label(ready[0].providerId)}，因为${ready[0].reason}`;
        if (others.length) text += `；跳过 ${others.map((c) => `${label(c.providerId)}（${c.reason}）`).join("、")}`;
        out.push({ tone: "accent", text });
        break;
      }
      case "upstream.attempt":
        out.push({ tone: "muted", text: `${dt(e.at)} 第 ${e.attempt} 次：发往 ${label(e.member.providerId)} ${e.member.model}` });
        break;
      case "upstream.failed":
        out.push({ tone: "bad", text: `${dt(e.at)} ${label(e.member.providerId)} 返回 ${e.status ?? ""} ${codeText(e.code)}${e.restUntil ? `，歇到 ${clock(e.restUntil)}` : ""}${e.reroutable ? "" : "，不改道"}` });
        break;
      case "reroute":
        out.push({ tone: "warn", text: `改道 → ${label(e.to.providerId)} ${e.to.model}（还没给 Agent 发任何内容，Agent 无感）` });
        break;
      case "upstream.firstByte":
        out.push({ tone: "ok", text: `${dt(e.at)} ${label(e.member.providerId)} 首字 ${e.ms} ms，开始回答` });
        break;
      case "request.end":
        out.push(
          e.outcome === "ok"
            ? { tone: "ok", text: `完成，用时 ${(e.ms / 1000).toFixed(1)} s，改道 ${e.reroutes} 次 · 输入 ${fmtK(e.usage?.inputTokens)} / 输出 ${fmtK(e.usage?.outputTokens)} tokens` }
            : e.outcome === "cancelled"
              ? { tone: "muted", text: "Agent 取消了请求，上游已中止" }
              : { tone: "bad", text: `失败：${codeText(e.errorCode)}（Agent 收到了这个错误）` },
        );
        break;
    }
  }
  return out;
}
