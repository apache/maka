import type { Metadata } from "next";
import { scoreDistribution } from "@/server/database-scoring";
import { getDimensions, listProducts, totalScore } from "@/server/database";

export const metadata: Metadata = { title: "评分分析" };

export default async function AnalysisPage() {
  const [products, dimensions] = await Promise.all([listProducts(), getDimensions()]);
  const scores = products.map(totalScore);
  const max = Math.max(...scores, 10);

  return (
    <div className="space-y-10">
      <section>
        <h2 className="mb-4 text-lg font-semibold">分数段分布（源版 scoring 模块）</h2>
        <div className="flex flex-wrap gap-3">
          {scoreDistribution(scores).map((bucket) => (
            <div key={bucket.range} className="min-w-32 rounded-lg border p-3 text-center">
              <div className="text-xs text-muted-foreground">{bucket.range} 分</div>
              <div className="mt-1 text-xl font-bold">{bucket.count}</div>
              <div className="text-xs text-muted-foreground">{bucket.label}</div>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-4 text-lg font-semibold">总分分布</h2>
        <div className="space-y-2">
          {[...products]
            .sort((a, b) => totalScore(b) - totalScore(a))
            .map((p) => (
              <div key={p.id} className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-sm">{p.shortName}</span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${(totalScore(p) / max) * 100}%` }} />
                </div>
                <span className="w-10 text-right text-sm text-muted-foreground">{totalScore(p)}</span>
              </div>
            ))}
        </div>
      </section>
      {dimensions.map((d) => {
        const ranked = [...products].sort((a, b) => (b.scores[d.id] ?? 0) - (a.scores[d.id] ?? 0));
        return (
          <section key={d.id}>
            <h3 className="mb-1 text-lg font-semibold">{d.name}</h3>
            <p className="mb-3 text-sm text-muted-foreground">{d.description}</p>
            <div className="flex flex-wrap gap-2 text-sm">
              {ranked.map((p, i) => (
                <span key={p.id} className={`rounded-full border px-3 py-1 ${i === 0 ? "border-primary text-primary font-medium" : "text-muted-foreground"}`}>
                  {i + 1}. {p.shortName} · {p.scores[d.id] ?? 0}
                </span>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
