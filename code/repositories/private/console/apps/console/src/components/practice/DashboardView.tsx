'use client';

import type { PracticeStats } from '@ggbdpq/console-shared';
import { Card, CardContent, CardHeader, CardTitle } from '@ggbdpq/console-ui';
import { cn } from '@ggbdpq/console-ui';

function HeroMetric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number | string;
  hint: string;
  tone?: 'pr' | 'issue' | 'other';
}) {
  return (
    <div
      className={cn(
        'rounded-xl border bg-card/85 p-4 shadow-sm',
        tone === 'pr' && 'border-success/20 bg-success/5',
        tone === 'issue' && 'border-warning/25 bg-warning/5',
        tone === 'other' && 'border-info/20 bg-info/5',
      )}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

/** 周活动柱状（纯 CSS，无图表库依赖） */
function WeeklyBars({ stats }: { stats: PracticeStats }) {
  const weeks = stats.weekly;
  const max = Math.max(1, ...weeks.map((w) => w.total));
  return (
    <div className="flex h-36 items-end gap-1">
      {weeks.map((w) => {
        const issueH = (w.issue / max) * 100;
        const restH = ((w.total - w.issue) / max) * 100;
        return (
          <div
            key={w.weekStart}
            className="group relative flex h-full flex-1 flex-col justify-end"
            title={`${w.weekStart} 那周：共 ${w.total}（修复 ${w.issue}）`}
          >
            <div className="flex w-full min-h-0 flex-1 flex-col justify-end overflow-hidden rounded-t-sm">
              <div className="w-full bg-warning/70" style={{ height: `${issueH}%` }} />
              <div className="w-full bg-primary/60" style={{ height: `${restH}%` }} />
            </div>
            <div className="mt-1 truncate text-center text-[9px] text-muted-foreground">
              {weeks.length > 14 ? w.weekStart.slice(6) : w.weekStart.slice(5)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ClusterList({
  items,
  emptyText,
}: {
  items: Array<{ key: string; count: number }>;
  emptyText: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.key} className="text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-mono" title={item.key}>
              {item.key}
            </span>
            <span className="shrink-0 font-semibold">{item.count} 次</span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-muted">
            <div className="h-full rounded-full bg-warning/70" style={{ width: `${(item.count / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Dashboard：总量指标 + 周活动 + 修复聚类（scope/目录/文件三视角） */
export function DashboardView({ stats }: { stats: PracticeStats }) {
  const { total, byType } = stats;
  const fixRatio = byType.pr + byType.issue > 0 ? Math.round((byType.issue / (byType.pr + byType.issue)) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <HeroMetric label="总提交" value={total} hint="窗口内、排除 merge 提交" />
        <HeroMetric label="功能新增（PR）" value={byType.pr} hint={`占功能+修复的 ${100 - fixRatio}%`} tone="pr" />
        <HeroMetric label="缺陷修复（Issue）" value={byType.issue} hint={`修复率 ${fixRatio}%（修复/(功能+修复)）`} tone="issue" />
        <HeroMetric label="其他改动" value={byType.other} hint="重构 / 文档 / 杂项" tone="other" />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">周活动</CardTitle>
            <span className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-sm bg-warning/70" /> 修复
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-sm bg-primary/60" /> 功能+其他
              </span>
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {weeklyOrEmpty(stats)}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">仓库分布</CardTitle>
          </CardHeader>
          <CardContent>
            <ClusterList
              items={stats.byRepo.map((r) => ({ key: r.repo, count: r.total }))}
              emptyText="暂无数据"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">修复 scope 聚类 Top</CardTitle>
          </CardHeader>
          <CardContent>
            <ClusterList
              items={stats.topFixScopes.map((c) => ({ key: c.key, count: c.count }))}
              emptyText="没有可解析的 fix(scope) 前缀"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">反复修复的目录 Top</CardTitle>
          </CardHeader>
          <CardContent>
            <ClusterList
              items={stats.topFixDirs.map((c) => ({ key: c.key, count: c.count }))}
              emptyText="暂无修复类提交的文件数据"
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">反复修改的文件 Top10</CardTitle>
        </CardHeader>
        <CardContent>
          <ClusterList
            items={stats.topFixFiles.map((c) => ({ key: c.key, count: c.count }))}
            emptyText="暂无修复类提交的文件数据"
          />
        </CardContent>
      </Card>
    </div>
  );
}

function weeklyOrEmpty(stats: PracticeStats) {
  if (stats.weekly.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">暂无数据</p>;
  }
  return <WeeklyBars stats={stats} />;
}
