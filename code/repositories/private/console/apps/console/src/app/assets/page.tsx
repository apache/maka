'use client';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, RefreshCw, ShieldAlert } from 'lucide-react';
import { useOverview, useSettings } from '@/lib/assets/api';
import { ACCOUNT_STATUSES, type AccountStatus } from '@ggbdpq/console-shared';
import { buildOperationsSummary, type OperationsSeverity } from '@/lib/assets/accountPresentation';
import { Card, CardContent, CardHeader, CardTitle } from '@ggbdpq/console-ui';
import { Button } from '@ggbdpq/console-ui';
import { StatusBadge } from '@/components/assets/StatusBadge';
import { ExpiryCell } from '@/components/assets/ExpiryCell';
import { cn } from '@ggbdpq/console-ui';

const SEVERITY_CLASS: Record<OperationsSeverity, string> = {
  danger: 'border-destructive/25 bg-destructive/10 text-destructive',
  warning: 'border-warning/25 bg-warning/10 text-warning',
  info: 'border-info/25 bg-info/10 text-info',
  muted: 'border-border bg-muted text-muted-foreground',
};

function countOf(byStatus: Array<{ status: AccountStatus; c: number }>, status: AccountStatus): number {
  return byStatus.find((b) => b.status === status)?.c ?? 0;
}

function HeroMetric({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: number | string;
  hint: string;
  tone?: 'default' | 'good' | 'risk';
}) {
  return (
    <div
      className={cn(
        'rounded-xl border bg-card/85 p-4 shadow-sm',
        tone === 'good' && 'border-success/20 bg-success/5',
        tone === 'risk' && 'border-warning/25 bg-warning/10',
      )}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

export default function DashboardPage() {
  const { data, isLoading } = useOverview();
  const { data: settings } = useSettings();
  const warnDays = settings?.warn_days ?? 7;

  if (isLoading || !data) {
    return <div className="rounded-xl border bg-card p-6 text-muted-foreground">加载运营数据中…</div>;
  }

  const summary = buildOperationsSummary({
    total: data.total,
    alive: data.alive,
    expiringCount: data.expiring.length,
    byStatus: data.byStatus,
  });
  const tokenExpired = countOf(data.byStatus, 'token_expired');
  const quotaExhausted = countOf(data.byStatus, 'quota_exhausted');
  const rateLimited = countOf(data.byStatus, 'rate_limited');

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="grid gap-6 p-6 xl:grid-cols-[1fr_380px]">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5 text-success" />
              本地账号库存与额度运营台
            </div>
            <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="text-3xl font-semibold tracking-tight">运营总览</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  先处理不可用账号，再刷新真实额度；购买批次目录仍是账号来源归属的主数据。
                </p>
              </div>
              <Button asChild>
                <Link href="/assets/accounts">
                  进入账号台账
                  <ArrowRight />
                </Link>
              </Button>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <HeroMetric label="账号总量" value={data.total} hint={`存活 ${data.alive} 个`} />
              <HeroMetric label="健康率" value={`${summary.healthRate}%`} hint="按存活账号 / 总账号计算" tone="good" />
              <HeroMetric label="待处理" value={summary.needsAttention} hint="异常状态 + 临期账号" tone={summary.needsAttention ? 'risk' : 'good'} />
              <HeroMetric label="临期窗口" value={`${warnDays} 天`} hint={`${data.expiring.length} 个账号进入窗口`} />
            </div>
          </div>

          <div className="rounded-xl border bg-muted/40 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">今日处理顺序</div>
                <div className="mt-1 text-xs text-muted-foreground">按影响使用的优先级排序</div>
              </div>
              <ShieldAlert className="h-5 w-5 text-primary" />
            </div>
            <div className="mt-4 space-y-2">
              {summary.riskQueue.length > 0 ? (
                summary.riskQueue.slice(0, 5).map((item) => (
                  <Link
                    key={item.status}
                    href={`/assets/accounts?status=${item.status}`}
                    className={cn(
                      'flex items-center justify-between rounded-xl border px-3 py-2 text-sm transition-colors hover:bg-card',
                      SEVERITY_CLASS[item.severity],
                    )}
                  >
                    <span className="font-medium">{item.label}</span>
                    <span className="font-semibold">{item.count}</span>
                  </Link>
                ))
              ) : (
                <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">当前没有高优先级异常账号。</div>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">状态分布</CardTitle>
              <span className="text-xs text-muted-foreground">点击状态进入账号台账</span>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {ACCOUNT_STATUSES.map((status) => {
                const count = countOf(data.byStatus, status);
                const percent = data.total > 0 ? Math.round((count / data.total) * 100) : 0;
                return (
                  <Link
                    key={status}
                    href={`/assets/accounts?status=${status}`}
                    className="rounded-xl border bg-background/60 p-4 transition-colors hover:border-ring/40 hover:bg-accent/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <StatusBadge status={status} />
                      <span className="text-xs text-muted-foreground">{percent}%</span>
                    </div>
                    <div className="mt-4 text-2xl font-semibold">{count}</div>
                    <div className="mt-2 h-1.5 rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
                    </div>
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">真实额度行动</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="rounded-xl border bg-background/70 p-4">
              <div className="flex items-center gap-2 font-medium">
                <RefreshCw className="h-4 w-4 text-primary" />
                刷新额度优先级
              </div>
              <p className="mt-2 text-muted-foreground">
                账号列表中的「未刷新」不展示静态 100%，需要调用真实接口后才进入可用额度判断。
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-muted p-3">
                <div className="text-lg font-semibold">{quotaExhausted}</div>
                <div className="text-xs text-muted-foreground">额度耗尽</div>
              </div>
              <div className="rounded-xl bg-muted p-3">
                <div className="text-lg font-semibold">{rateLimited}</div>
                <div className="text-xs text-muted-foreground">限流</div>
              </div>
              <div className="rounded-xl bg-muted p-3">
                <div className="text-lg font-semibold">{tokenExpired}</div>
                <div className="text-xs text-muted-foreground">token过期</div>
              </div>
            </div>
            <Button asChild variant="outline" className="w-full">
              <Link href="/assets/accounts">批量刷新真实额度</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-warning" />
              {warnDays} 天内到期
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {data.expiring.slice(0, 12).map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl border bg-background/60 px-3 py-2">
                  <span className="min-w-0 truncate font-mono text-xs">{a.email}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={a.status} />
                    <ExpiryCell expiresAt={a.expires_at} warnDays={warnDays} />
                  </span>
                </li>
              ))}
              {data.expiring.length === 0 && <li className="rounded-xl border bg-background/60 p-4 text-muted-foreground">暂无临期账号</li>}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock3 className="h-4 w-4 text-primary" />
              最近授权
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {data.recentReauth.slice(0, 12).map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl border bg-background/60 px-3 py-2">
                  <span className="min-w-0 truncate font-mono text-xs">{a.email}</span>
                  <span className="shrink-0 text-muted-foreground">
                    授权 {a.reauth_at?.slice(0, 10)} → <ExpiryCell expiresAt={a.expires_at} warnDays={warnDays} />
                  </span>
                </li>
              ))}
              {data.recentReauth.length === 0 && <li className="rounded-xl border bg-background/60 p-4 text-muted-foreground">暂无授权记录</li>}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
