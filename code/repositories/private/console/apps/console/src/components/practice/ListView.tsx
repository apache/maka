'use client';

import { useEffect, useState } from 'react';
import type { PracticeCommit } from '@ggbdpq/console-shared';
import { PRACTICE_TYPE_UI, formatDate, repoAlias } from '@/lib/practice/present';
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@ggbdpq/console-ui';

const PAGE_SIZE = 50;

/** 列表视图：按时间倒序的提交台账，分页浏览 */
export function ListView({
  commits,
  onSelect,
}: {
  commits: PracticeCommit[];
  onSelect: (c: PracticeCommit) => void;
}) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(commits.length / PAGE_SIZE));

  useEffect(() => {
    setPage(1);
  }, [commits]);

  const safePage = Math.min(page, pageCount);
  const rows = commits.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  if (commits.length === 0) {
    return <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">当前筛选条件下没有提交记录</div>;
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">日期</TableHead>
              <TableHead className="w-16">类型</TableHead>
              <TableHead className="w-24">仓库</TableHead>
              <TableHead>提交信息</TableHead>
              <TableHead className="w-28">行变更</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.sha} className="cursor-pointer" onClick={() => onSelect(c)}>
                <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                  {formatDate(c.authoredAt)}
                </TableCell>
                <TableCell>
                  <Badge variant={PRACTICE_TYPE_UI[c.type].badge}>{PRACTICE_TYPE_UI[c.type].label}</Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs">{repoAlias(c.repo)}</TableCell>
                <TableCell>
                  <div className="max-w-[520px] truncate text-sm">{c.subject}</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    {c.shortSha} · {c.branches.slice(0, 2).join(', ')}
                    {c.branches.length > 2 && ` +${c.branches.length - 2}`}
                    {c.tapdBug && ` · TAPD ${c.tapdBug}`}
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap font-mono text-xs">
                  <span className="text-success">+{c.insertions}</span> <span className="text-destructive">−{c.deletions}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          共 {commits.length} 条 · 第 {safePage}/{pageCount} 页
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </Button>
          <Button variant="outline" size="sm" disabled={safePage >= pageCount} onClick={() => setPage((p) => p + 1)}>
            下一页
          </Button>
        </div>
      </div>
    </div>
  );
}
