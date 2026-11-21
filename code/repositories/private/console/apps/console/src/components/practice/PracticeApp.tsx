'use client';

import { useMemo, useState } from 'react';
import { History, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { PracticeCommit } from '@ggbdpq/console-shared';
import { usePracticeData, usePracticeSync } from '@/lib/practice/api';
import { BoardView } from './BoardView';
import { ChatDock } from './ChatDock';
import { DashboardView } from './DashboardView';
import { DetailDialog } from './DetailDialog';
import { ListView } from './ListView';
import { Button } from '@ggbdpq/console-ui';
import { cn } from '@ggbdpq/console-ui';
import { Empty, EmptyDescription } from '@ggbdpq/console-ui';
import { Input } from '@ggbdpq/console-ui';
import { Segmented } from '@ggbdpq/console-ui';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ggbdpq/console-ui';
import { ThemeToggle } from '@ggbdpq/console-ui';

type ViewMode = 'dashboard' | 'board' | 'list';

const VIEW_OPTIONS: Array<{ value: ViewMode; label: string }> = [
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'board', label: '看板' },
  { value: 'list', label: '列表' },
];

export function PracticeApp() {
  const { data, isLoading } = usePracticeData();
  const sync = usePracticeSync();
  const [view, setView] = useState<ViewMode>('dashboard');
  const [repo, setRepo] = useState('all');
  const [branch, setBranch] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [selected, setSelected] = useState<PracticeCommit | null>(null);

  const synced = Boolean(data?.syncedAt);

  // 窗口输入框初值跟随已同步窗口（since/until 均为含当天的展示语义）
  const effectiveSince = since || data?.window.since || '';
  const effectiveUntil = until || data?.window.until || '';

  const branches = useMemo(() => {
    if (!data) return [];
    const pool = repo === 'all' ? data.commits : data.commits.filter((c) => c.repo === repo);
    return [...new Set(pool.flatMap((c) => c.branches))].sort();
  }, [data, repo]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const kw = keyword.trim().toLowerCase();
    return data.commits.filter(
      (c) =>
        (repo === 'all' || c.repo === repo) &&
        (branch === 'all' || c.branches.includes(branch)) &&
        (!kw || c.subject.toLowerCase().includes(kw)),
    );
  }, [data, repo, branch, keyword]);

  const startSync = () => {
    sync.mutate(
      {
        since: effectiveSince || undefined,
        until: effectiveUntil || undefined,
      },
      {
        onSuccess: (r) => {
          const failed = r.perRepo.filter((p) => p.error);
          if (failed.length > 0) {
            toast.warning(`同步完成（部分仓库失败）：成功 ${r.commits} 条`, {
              description: failed.map((f) => `${f.name}: ${f.error}`).join('；'),
            });
          } else {
            toast.success(`同步完成：共 ${r.commits} 条提交，耗时 ${(r.durationMs / 1000).toFixed(1)}s`);
          }
        },
        onError: (e) => toast.error(`同步失败：${e.message}`),
      },
    );
  };

  return (
    <div className="mx-auto max-w-[1720px] px-6 py-6">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sidebar text-sidebar-foreground ring-1 ring-sidebar-border">
              <History className="h-4 w-4" />
            </div>
            <div>
              <div className="text-base font-semibold tracking-tight">实践台</div>
              <div className="text-xs text-muted-foreground">
                数联天下项目开发实践复盘
                {data?.syncedAt && ` · 同步于 ${data.syncedAt.slice(0, 19).replace('T', ' ')}`}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              value={effectiveSince}
              onChange={(e) => setSince(e.target.value)}
              className="w-36"
              aria-label="窗口起始日期"
            />
            <span className="text-xs text-muted-foreground">至</span>
            <Input
              type="date"
              value={effectiveUntil}
              onChange={(e) => setUntil(e.target.value)}
              className="w-36"
              aria-label="窗口结束日期"
            />
            <Button variant="outline" size="sm" onClick={startSync} disabled={sync.isPending}>
              <RefreshCw className={cn(sync.isPending && 'animate-spin')} />
              {sync.isPending ? '同步中（1-2 分钟）…' : '同步提交'}
            </Button>
            <ThemeToggle />
          </div>
        </div>

        {isLoading || !data ? (
          <div className="rounded-xl border bg-card p-6 text-muted-foreground">加载实践数据中…</div>
        ) : !synced ? (
          <Empty>
            <EmptyDescription>
              还没有同步过数据。确认上方时间窗口后点「同步提交」，将扫描 4 个仓库中你在窗口内的分支与提交
              （约 1-2 分钟）。
            </EmptyDescription>
            <Button size="sm" onClick={startSync} disabled={sync.isPending} className="mt-2">
              <RefreshCw className={cn(sync.isPending && 'animate-spin')} />
              立即同步
            </Button>
          </Empty>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Segmented options={VIEW_OPTIONS} value={view} onChange={setView} />
              <Select value={repo} onValueChange={(v) => { setRepo(v); setBranch('all'); }}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="仓库" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部仓库</SelectItem>
                  {data.repos.map((r) => (
                    <SelectItem key={r.name} value={r.name}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={branch} onValueChange={setBranch}>
                <SelectTrigger className="w-56">
                  <SelectValue placeholder="分支" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部分支</SelectItem>
                  {branches.map((b) => (
                    <SelectItem key={b} value={b}>
                      {b}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索提交标题…"
                className="w-56"
              />
              <span className="text-xs text-muted-foreground">
                筛出 {filtered.length} / {data.commits.length} 条
              </span>
            </div>

            {view === 'dashboard' && <DashboardView stats={data.stats} />}
            {view === 'board' && <BoardView commits={filtered} onSelect={setSelected} />}
            {view === 'list' && <ListView commits={filtered} onSelect={setSelected} />}
          </>
        )}
      </div>

      <DetailDialog commit={selected} onClose={() => setSelected(null)} />
      <ChatDock disabled={!synced} />
    </div>
  );
}
