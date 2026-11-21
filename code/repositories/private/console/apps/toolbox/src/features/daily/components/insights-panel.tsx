import type { DailyInsights } from "@/schemas/daily"

export function InsightsPanel({ insights }: { insights: DailyInsights }) {
  return (
    <section className="grid gap-4 rounded-xl border bg-card p-4 lg:grid-cols-3" aria-label="日报洞察">
      <div>
        <h2 className="mb-2 text-sm font-semibold">每日 Top 5</h2>
        <ol className="space-y-2 text-sm">
          {insights.topItems.map((item, index) => (
            <li key={item.id}>
              <div className="font-medium">
                {index + 1}. {item.title}
              </div>
              <p className="text-xs text-muted-foreground">{item.reason}</p>
            </li>
          ))}
        </ol>
      </div>
      <div>
        <h2 className="mb-2 text-sm font-semibold">主题聚类</h2>
        <div className="flex flex-wrap gap-2">
          {insights.themes.map((theme) => (
            <span key={theme.id} className="rounded-md border px-2 py-1 text-xs">
              {theme.label} · {theme.itemIds.length}
            </span>
          ))}
        </div>
      </div>
      <div>
        <h2 className="mb-2 text-sm font-semibold">趋势追踪</h2>
        <div className="flex flex-wrap gap-2">
          {insights.trends.slice(0, 6).map((trend) => (
            <span key={trend.label} className="rounded-md border px-2 py-1 text-xs">
              {trend.label} · {trend.count} 天
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}
