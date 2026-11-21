import { useMemo } from "react";
import { OverallMastery, SectionMastery } from "@ig/components/SectionMastery";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ig/components/ui/card";
import { attemptTotals, buildHeatmap, currentStreak } from "@ig/features/stats/lib/heatmap";
import { useArena } from "@ig/state/store";

const LEVEL_CLASS = [
  "bg-muted",
  "bg-primary/25",
  "bg-primary/45",
  "bg-primary/65",
  "bg-primary/90",
] as const;

// 统计页：日历热力图 + 连续天数 + 掌握度分布
export function StatsPage() {
  const attempts = useArena((s) => s.attempts);
  const heatmap = useMemo(() => buildHeatmap(attempts), [attempts]);
  const streak = useMemo(() => currentStreak(attempts), [attempts]);
  const totals = useMemo(() => attemptTotals(attempts), [attempts]);

  // 按周分列（每列 7 天，周一开头）
  const columns: (typeof heatmap)[] = [];
  for (let i = 0; i < heatmap.length; i += 7) columns.push(heatmap.slice(i, i + 7));

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">统计</h1>

      <div className="grid grid-cols-3 gap-2">
        {(
          [
            ["累计评分", totals.count],
            ["练习天数", totals.days],
            ["连续天数", streak],
          ] as const
        ).map(([label, n]) => (
          <div key={label} className="rounded-lg border p-3 text-center">
            <div className="text-2xl font-semibold">{n}</div>
            <div className="text-xs text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">近半年练习热力图</CardTitle>
          <CardDescription>颜色越深，当天评分次数越多（一周从周一开始）</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-1 overflow-x-auto pb-1">
            {columns.map((col, i) => (
              <div key={i} className="flex flex-col gap-1">
                {col.map((cell) => (
                  <div
                    key={cell.date}
                    title={`${cell.date}：${cell.count} 次`}
                    className={`size-3 rounded-sm ${LEVEL_CLASS[cell.level]}`}
                  />
                ))}
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            少
            {LEVEL_CLASS.map((cls) => (
              <span key={cls} className={`size-3 rounded-sm ${cls}`} />
            ))}
            多
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">全库掌握度</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <OverallMastery />
          <SectionMastery />
        </CardContent>
      </Card>
    </div>
  );
}
