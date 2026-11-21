'use client';

import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { cn } from '@ggbdpq/console-ui';
import type { JudgeResult } from '@/features/algo/types/problem';

interface ResultPanelProps {
  result: JudgeResult | null;
  running: boolean;
  error: string | null;
}

/** 运行结果面板:总体结论 + 各用例明细(失败时展示输入/期望/实际对比)。 */
export function ResultPanel({ result, running, error }: ResultPanelProps) {
  if (running) {
    return (
      <div className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground sm:px-6">
        <Loader2 className="size-4 animate-spin text-primary" />
        运行中…
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-5 py-4 sm:px-6">
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <XCircle className="mt-0.5 size-4 shrink-0" />
          <pre className="whitespace-pre-wrap break-words font-mono text-xs">{error}</pre>
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="px-5 py-8 text-center text-sm text-muted-foreground sm:px-6">
        点击「运行」提交你的代码,查看测试结果
      </div>
    );
  }

  return (
    <div className="space-y-3 px-5 py-4 sm:px-6">
      <div className="flex items-center gap-2 text-sm font-medium">
        {result.passed ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-0.5 text-success">
            <CheckCircle2 className="size-4" />
            通过 {result.passedCount}/{result.total} · 用时 {result.durationMs}ms
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/15 px-2.5 py-0.5 text-destructive">
            <XCircle className="size-4" />
            未通过 {result.passedCount}/{result.total}
          </span>
        )}
      </div>
      <ul className="space-y-1.5">
        {result.results.map((r) => (
          <li
            key={r.index}
            className={cn(
              'rounded-lg border p-2.5 text-xs',
              r.passed ? 'border-success/20 bg-success/5' : 'border-destructive/25 bg-destructive/5',
            )}
          >
            <div className="flex items-center gap-1.5 font-medium">
              {r.passed ? (
                <CheckCircle2 className="size-3.5 text-success" />
              ) : (
                <XCircle className="size-3.5 text-destructive" />
              )}
              用例 {r.index + 1}
              {r.error && <span className="text-destructive">· {r.error}</span>}
            </div>
            {!r.passed && (
              <div className="mt-1.5 grid gap-0.5 font-mono text-[11px] text-muted-foreground">
                <span>
                  <span className="text-foreground/70">输入 </span>
                  {JSON.stringify(r.input)}
                </span>
                <span>
                  <span className="text-foreground/70">期望 </span>
                  {JSON.stringify(r.expected)}
                </span>
                <span>
                  <span className="text-foreground/70">实际 </span>
                  {JSON.stringify(r.actual)}
                </span>
              </div>
            )}
            {r.stdout.length > 0 && (
              <div className="mt-1.5 font-mono text-[11px] text-muted-foreground">
                <span className="text-foreground/70">输出 </span>
                {r.stdout.join(' | ')}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
