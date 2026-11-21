'use client';
import Link from 'next/link';
import { useBatches } from '@/lib/assets/api';
import { Card, CardContent, CardHeader, CardTitle } from '@ggbdpq/console-ui';
import { Badge } from '@ggbdpq/console-ui';

export default function BatchesPage() {
  const { data, isLoading } = useBatches();
  if (isLoading || !data) return <div className="text-muted-foreground">加载中…</div>;

  const groups = new Map<string, typeof data>();
  for (const b of data) {
    const key = b.month_group ?? '未分组';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(b);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">批次</h1>
      {data.length === 0 && (
        <div className="text-muted-foreground">还没有批次。点击左侧「扫描追加」扫描卡密目录，或到导入中心手动导入。</div>
      )}
      {[...groups.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, batches]) => (
        <div key={month} className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">{month}</h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {batches.map((b) => {
              const total = b.total ?? 0;
              const alive = b.alive ?? 0;
              const aliveRate = total > 0 ? Math.round((alive / total) * 100) : 0;
              return (
                <Link key={b.id} href={`/assets/batches/${b.id}`}>
                  <Card className="h-full hover:border-foreground/30 transition-colors">
                    <CardHeader className="p-4 pb-2">
                      <CardTitle className="text-sm font-mono leading-snug break-all">
                        {b.card_code ?? b.folder_name}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-4 pt-0 space-y-2 text-sm">
                      <div className="flex gap-2 flex-wrap">
                        <Badge variant="secondary">{total} 个号</Badge>
                        <Badge variant={aliveRate >= 80 ? 'success' : aliveRate >= 50 ? 'warning' : 'danger'}>
                          存活 {alive}（{aliveRate}%）
                        </Badge>
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {b.purchase_date ?? '日期未知'} · 总价 {b.total_price ?? '?'} 元
                        {b.unit_cost != null && ` · 单价 ≈${b.unit_cost} 元`}
                        {b.unit_cost != null && alive > 0 && ` · 成活成本 ≈${((b.total_price ?? 0) / alive).toFixed(3)} 元`}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
