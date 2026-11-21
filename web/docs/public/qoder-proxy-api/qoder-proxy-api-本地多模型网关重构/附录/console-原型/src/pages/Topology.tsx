import { useLayoutEffect, useRef, useState } from "react";
import type { RouteGroup } from "../contracts";
import { keyOf } from "../contracts";
import { restingOf, useStore } from "../store";
import { agentColor, agentName } from "../seed";
import { Badge, cx } from "../components/ui";

type Pt = { x: number; y: number };

export function Topology({ group }: { group: RouteGroup }) {
  const { agents, active, health, now, providers, gatewayAddr, finished } = useStore();
  const box = useRef<HTMLDivElement>(null);
  const agentRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const memberRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const gwRef = useRef<HTMLDivElement>(null);
  const [pts, setPts] = useState<{ a: Record<string, Pt>; m: Record<string, Pt>; gin: Pt; gout: Pt; w: number; h: number } | null>(null);

  const inGroup = Object.values(active).filter((r) => r.groupId === group.id);
  const shownAgents = agents.filter((a) => a.connected && (a.model === `group/${group.id}` || inGroup.some((r) => r.agent === a.id)));

  useLayoutEffect(() => {
    const measure = () => {
      const root = box.current?.getBoundingClientRect();
      const gw = gwRef.current?.getBoundingClientRect();
      if (!root || !gw) return;
      const rel = (r: DOMRect, side: "l" | "r"): Pt => ({ x: (side === "r" ? r.right : r.left) - root.left, y: r.top + r.height / 2 - root.top });
      const a: Record<string, Pt> = {};
      for (const [k, el] of Object.entries(agentRefs.current)) if (el) a[k] = rel(el.getBoundingClientRect(), "r");
      const m: Record<string, Pt> = {};
      for (const [k, el] of Object.entries(memberRefs.current)) if (el) m[k] = rel(el.getBoundingClientRect(), "l");
      const next = { a, m, gin: rel(gw, "l"), gout: rel(gw, "r"), w: root.width, h: root.height };
      setPts((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  });

  const curve = (p: Pt, q: Pt) => {
    const mx = (p.x + q.x) / 2;
    return `M${p.x},${p.y} C${mx},${p.y} ${mx},${q.y} ${q.x},${q.y}`;
  };
  const recent = (k: string) => finished.filter((f) => f.member && keyOf(f.member) === k && now - f.at < 5 * 60_000).length;

  return (
    <div ref={box} className="relative grid grid-cols-[190px_1fr_170px_1fr_minmax(260px,1.6fr)] items-center gap-y-2 py-2">
      <svg className="pointer-events-none absolute inset-0" width={pts?.w ?? 0} height={pts?.h ?? 0} aria-hidden>
        {pts &&
          shownAgents.map((a) => {
            const p = pts.a[a.id];
            if (!p) return null;
            const live = inGroup.some((r) => r.agent === a.id);
            return <path key={a.id} d={curve(p, pts.gin)} fill="none" stroke={agentColor[a.id]} strokeWidth={live ? 1.8 : 1.2} strokeDasharray="5 5" opacity={live ? 0.95 : 0.35} className={live ? "wire-live" : ""} />;
          })}
        {pts &&
          group.members.map((m) => {
            const k = keyOf(m);
            const q = pts.m[k];
            if (!q) return null;
            const req = inGroup.find((r) => r.member && keyOf(r.member) === k);
            const resting = restingOf(health, m, now);
            if (resting) return <path key={k} d={curve(pts.gout, q)} fill="none" stroke="var(--red)" strokeWidth={1.4} strokeDasharray="3 5" opacity={0.8} />;
            if (req)
              return <path key={k} d={curve(pts.gout, q)} fill="none" stroke={agentColor[req.agent]} strokeWidth={2} strokeDasharray={req.phase === "answering" ? "8 4" : "3 5"} className="wire-live" />;
            return <path key={k} d={curve(pts.gout, q)} fill="none" stroke="var(--line)" strokeWidth={1.2} />;
          })}
      </svg>

      <div className="col-start-1 flex flex-col gap-2" style={{ gridRow: `1 / span ${Math.max(group.members.length, 1)}` }}>
        {shownAgents.length === 0 && <div className="text-[12px] text-faint">没有 Agent 用这个组</div>}
        {shownAgents.map((a) => {
          const live = inGroup.filter((r) => r.agent === a.id).length;
          return (
            <div key={a.id} ref={(el) => { agentRefs.current[a.id] = el; }} className={cx("relative z-10 rounded-xl border bg-card px-3 py-2", live ? "border-line" : "border-line opacity-70")}>
              <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
                <span className={cx("inline-block h-[7px] w-[7px] rounded-full", live > 0 && "dot-live")} style={{ background: agentColor[a.id] }} />
                {agentName[a.id]}
                {live > 0 && <span className="ml-auto text-[10.5px] font-normal text-muted">{live} 个在发</span>}
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-muted">group/{group.id}</div>
            </div>
          );
        })}
      </div>

      <div className="col-start-3 flex justify-center" style={{ gridRow: `1 / span ${Math.max(group.members.length, 1)}` }}>
        <div ref={gwRef} className="relative z-10 w-full rounded-2xl border border-accent/40 bg-accent-soft px-3 py-3 text-center">
          <div className="text-[12.5px] font-semibold text-accent">网关</div>
          <div className="mt-0.5 font-mono text-[11px] text-muted">{gatewayAddr}</div>
          <div className="mt-1.5"><Badge tone="accent">{group.strategy === "smart" ? "智能" : "按顺序"}</Badge></div>
        </div>
      </div>

      {group.members.map((m, i) => {
        const k = keyOf(m);
        const p = providers.find((x) => x.id === m.providerId);
        const reqs = inGroup.filter((r) => r.member && keyOf(r.member) === k);
        const answering = reqs.find((r) => r.phase === "answering");
        const waiting = reqs.find((r) => r.phase !== "answering");
        const resting = restingOf(health, m, now);
        const disabled = !p?.enabled;
        const color = answering ? agentColor[answering.agent] : waiting ? agentColor[waiting.agent] : undefined;
        return (
          <div
            key={k}
            ref={(el) => { memberRefs.current[k] = el; }}
            className={cx(
              "relative z-10 col-start-5 flex items-center gap-2 rounded-xl border bg-card px-3 py-2 transition-colors",
              resting ? "border-dashed border-bad/70 bg-bad-soft/40" : !color && "border-line",
              disabled && "opacity-50",
            )}
            style={{ gridRow: i + 1, ...(color && !resting ? { borderColor: color, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 14%, transparent)` } : {}) }}
          >
            <span className={cx("text-[12px]", answering && "dot-live")} style={{ color: resting ? "var(--red)" : color ?? "var(--faint)" }}>{answering || waiting ? "●" : "○"}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[12.5px] font-medium">{p?.label ?? m.providerId}</span>
                <span className="truncate font-mono text-[11px] text-muted">{m.model}</span>
              </div>
              <div className={cx("text-[11.5px]", resting ? "text-bad" : answering ? "text-fg" : "text-muted")}>
                {resting
                  ? `限流 · ${Math.max(0, Math.ceil((resting.restUntil - now) / 1000))} 秒后恢复`
                  : answering
                    ? `回答中… · ${agentName[answering.agent]}${reqs.length > 1 ? ` 等 ${reqs.length} 个` : ""}`
                    : waiting
                      ? `等首字… · ${agentName[waiting.agent]}`
                      : disabled
                        ? "供应商未启用"
                        : "空闲 · 一个 Key"}
              </div>
            </div>
            <span className="font-mono text-[10.5px] text-faint" title="近 5 分钟完成的请求">{recent(k)}</span>
          </div>
        );
      })}
    </div>
  );
}
