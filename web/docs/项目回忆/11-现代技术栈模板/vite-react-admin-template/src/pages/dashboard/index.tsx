import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getDashboardStats } from '@/api/admin';
import type { DashboardStats } from '@/api/schemas';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const STATS_META = [
  { key: 'totalUsers', title: '用户总数', description: '系统内注册用户' },
  { key: 'activeUsers', title: '活跃用户', description: '近期有登录行为' },
  { key: 'todayOrders', title: '今日订单', description: '自然日累计' },
  { key: 'successRate', title: '成功率', description: '关键链路成功率', suffix: '%' },
] as const;

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDashboardStats()
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : '加载统计数据失败');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">仪表盘</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          请求层示例：Zod 校验 + 命名转换 + 错误码解包（数据来自 vite mock 中间件）
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {STATS_META.map((meta) => (
          <Card key={meta.key}>
            <CardHeader>
              <CardDescription>{meta.title}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">
                {stats ? (
                  `${stats[meta.key]}${'suffix' in meta ? meta.suffix : ''}`
                ) : (
                  <Skeleton className="h-8 w-20" />
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-xs">{meta.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
