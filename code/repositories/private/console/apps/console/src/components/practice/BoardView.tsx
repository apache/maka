'use client';

import type { PracticeCommit, PracticeType } from '@ggbdpq/console-shared';
import { PRACTICE_TYPE_UI, formatDate, repoAlias } from '@/lib/practice/present';
import { Badge } from '@ggbdpq/console-ui';
import { cn } from '@ggbdpq/console-ui';
import { Empty } from '@ggbdpq/console-ui';

const COLUMNS: Array<{ type: PracticeType }> = [
  { type: 'pr' },
  { type: 'issue' },
  { type: 'other' },
];

function CommitCard({ commit, onSelect }: { commit: PracticeCommit; onSelect: (c: PracticeCommit) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(commit)}
      className="w-full rounded-lg border bg-card p-3 text-left shadow-sm transition-colors hover:border-ring/40 hover:bg-accent/40"
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{commit.shortSha}</span>
        <span>{formatDate(commit.authoredAt)}</span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm leading-5">{commit.subject}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge variant={PRACTICE_TYPE_UI[commit.type].badge}>{repoAlias(commit.repo)}</Badge>
        {commit.tapdBug && (
          <Badge variant="outline" className="text-[10px]">
            TAPD {commit.tapdBug}
          </Badge>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          <span className="text-success">+{commit.insertions}</span> <span className="text-destructive">−{commit.deletions}</span>
        </span>
      </div>
    </button>
  );
}

/** 看板三列：功能新增（PR）/ 缺陷修复（Issue）/ 其他改动；卡片点击看详情 */
export function BoardView({
  commits,
  onSelect,
}: {
  commits: PracticeCommit[];
  onSelect: (c: PracticeCommit) => void;
}) {
  if (commits.length === 0) {
    return <Empty>当前筛选条件下没有提交记录</Empty>;
  }

  return (
    <div className="grid gap-3 md:grid-cols-3">
      {COLUMNS.map(({ type }) => {
        const list = commits.filter((c) => c.type === type);
        const ui = PRACTICE_TYPE_UI[type];
        return (
          <div key={type} className="flex min-h-0 flex-col rounded-xl border bg-muted/30">
            <div className="flex items-center gap-2 border-b px-3 py-2.5">
              <span className={cn('size-2 rounded-full', ui.dot)} />
              <span className="text-sm font-medium">{ui.longLabel}</span>
              <span className="ml-auto text-xs text-muted-foreground">{list.length}</span>
            </div>
            <div className="max-h-[calc(100vh-340px)] min-h-40 flex-1 space-y-2 overflow-y-auto p-2">
              {list.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">无记录</div>
              ) : (
                list.map((c) => <CommitCard key={c.sha} commit={c} onSelect={onSelect} />)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
