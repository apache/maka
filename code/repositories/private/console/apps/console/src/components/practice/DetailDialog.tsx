'use client';

import type { PracticeCommit } from '@ggbdpq/console-shared';
import { PRACTICE_TYPE_UI } from '@/lib/practice/present';
import { Badge, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@ggbdpq/console-ui';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@ggbdpq/console-ui';

export function DetailDialog({ commit, onClose }: { commit: PracticeCommit | null; onClose: () => void }) {
  return (
    <Dialog open={commit !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        {commit && (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={PRACTICE_TYPE_UI[commit.type].badge}>{PRACTICE_TYPE_UI[commit.type].label}</Badge>
                <span className="font-mono text-xs text-muted-foreground">{commit.sha}</span>
              </div>
              <DialogTitle className="mt-2 text-left text-base leading-6">{commit.subject}</DialogTitle>
              <DialogDescription className="text-left">
                {commit.rawSubject !== commit.subject && `原始标题：${commit.rawSubject}`}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="rounded-lg bg-muted px-3 py-2">
                <div className="text-xs text-muted-foreground">仓库</div>
                <div className="font-mono text-[13px]">{commit.repo}</div>
              </div>
              <div className="rounded-lg bg-muted px-3 py-2">
                <div className="text-xs text-muted-foreground">作者 / 时间</div>
                <div>
                  {commit.authorName} · {commit.authoredAt.slice(0, 19).replace('T', ' ')}
                </div>
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">所在分支（{commit.branches.length}）</div>
              <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                {commit.branches.map((b) => (
                  <Badge key={b} variant="outline" className="font-mono text-[11px]">
                    {b}
                  </Badge>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="font-medium text-muted-foreground">改动文件（{commit.files.length}）</span>
                <span className="font-mono">
                  <span className="text-success">+{commit.insertions}</span>{' '}
                  <span className="text-destructive">−{commit.deletions}</span>
                </span>
              </div>
              <div className="max-h-56 overflow-y-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>路径</TableHead>
                      <TableHead className="w-24 text-right">增/删</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {commit.files.map((f) => (
                      <TableRow key={f.path}>
                        <TableCell className="break-all font-mono text-xs">{f.path}</TableCell>
                        <TableCell className="whitespace-nowrap text-right font-mono text-xs">
                          <span className="text-success">+{f.insertions}</span>{' '}
                          <span className="text-destructive">−{f.deletions}</span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
