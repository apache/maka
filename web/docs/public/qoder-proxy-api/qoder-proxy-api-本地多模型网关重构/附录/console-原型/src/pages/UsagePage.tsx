import { useStore } from "../store";
import { agentColor, agentName } from "../seed";
import { Card, PageHeader } from "../components/ui";

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export function UsagePage() {
  const { finished, providers } = useStore();
  const byAgent = Object.entries(
    finished.reduce<Record<string, { req: number; inT: number; outT: number }>>((acc, f) => {
      const a = (acc[f.agent] ??= { req: 0, inT: 0, outT: 0 });
      a.req++;
      a.inT += f.inputTokens;
      a.outT += f.outputTokens;
      return acc;
    }, {}),
  );
  const byProvider = Object.entries(
    finished.reduce<Record<string, { req: number; tokens: number; ms: number }>>((acc, f) => {
      if (!f.member) return acc;
      const p = (acc[f.member.providerId] ??= { req: 0, tokens: 0, ms: 0 });
      p.req++;
      p.tokens += f.inputTokens + f.outputTokens;
      p.ms += f.ms;
      return acc;
    }, {}),
  );
  const maxTok = Math.max(1, ...byProvider.map(([, v]) => v.tokens));
  return (
    <div>
      <PageHeader title="用量" sub="来自 request.end 事件；正式版落 node:sqlite，按天聚合，只记元数据不记内容。" />
      <div className="grid grid-cols-2 gap-4">
        <Card className="p-4">
          <div className="mb-3 text-[13px] font-semibold">按 Agent</div>
          {byAgent.length === 0 && <div className="text-[12px] text-faint">等待请求…</div>}
          {byAgent.map(([id, v]) => (
            <div key={id} className="flex items-center gap-2 py-1.5 text-[12.5px]">
              <span className="inline-block h-[8px] w-[8px] rounded-full" style={{ background: agentColor[id] }} />
              <span className="flex-1">{agentName[id] ?? id}</span>
              <span className="font-mono text-muted">{v.req} 次</span>
              <span className="w-32 text-right font-mono">{k(v.inT)} / {k(v.outT)}</span>
            </div>
          ))}
        </Card>
        <Card className="p-4">
          <div className="mb-3 text-[13px] font-semibold">按供应商</div>
          {byProvider.map(([id, v]) => (
            <div key={id} className="py-1.5 text-[12.5px]">
              <div className="flex items-center gap-2">
                <span className="flex-1">{providers.find((p) => p.id === id)?.label ?? id}</span>
                <span className="font-mono text-muted">{v.req} 次 · 平均 {(v.ms / v.req / 1000).toFixed(1)} s</span>
                <span className="w-16 text-right font-mono">{k(v.tokens)}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-pill"><div className="h-1.5 rounded-full bg-accent" style={{ width: `${(v.tokens / maxTok) * 100}%` }} /></div>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
