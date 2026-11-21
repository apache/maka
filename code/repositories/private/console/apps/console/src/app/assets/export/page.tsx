'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { ACCOUNT_STATUSES, STATUS_LABELS, type AccountStatus } from '@ggbdpq/console-shared';
import { downloadUrl, useBatches, useExportCpa, useSettings } from '@/lib/assets/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ggbdpq/console-ui';
import { Button } from '@ggbdpq/console-ui';
import { Checkbox } from '@ggbdpq/console-ui';
import { Label } from '@ggbdpq/console-ui';

export default function ExportPage() {
  const { data: settings } = useSettings();
  const { data: batches } = useBatches();
  const exportCpa = useExportCpa();

  const [statuses, setStatuses] = useState<Set<AccountStatus>>(
    new Set(settings?.default_export_statuses ?? ['normal', 'rate_limited']),
  );
  const [batchIds, setBatchIds] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<{ fileName: string; count: number } | null>(null);

  const toggleStatus = (s: AccountStatus, checked: boolean) => {
    const next = new Set(statuses);
    if (checked) next.add(s);
    else next.delete(s);
    setStatuses(next);
  };
  const toggleBatch = (id: number, checked: boolean) => {
    const next = new Set(batchIds);
    if (checked) next.add(id);
    else next.delete(id);
    setBatchIds(next);
  };

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">导出中心</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">导出 CPA（tar 包）</CardTitle>
          <CardDescription>
            每个账号一个 <code className="font-mono">&lt;邮箱&gt;.json</code>；异常状态账号会诚实标记{' '}
            <code className="font-mono">disabled: true</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="mb-2 block">包含的状态</Label>
            <div className="flex flex-wrap gap-4">
              {ACCOUNT_STATUSES.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={statuses.has(s)} onCheckedChange={(v) => toggleStatus(s, v === true)} />
                  {STATUS_LABELS[s]}
                </label>
              ))}
            </div>
          </div>

          <div>
            <Label className="mb-2 block">限定批次（不选 = 全部批次）</Label>
            <div className="grid max-h-48 gap-2 overflow-auto md:grid-cols-2">
              {batches?.map((b) => (
                <label key={b.id} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={batchIds.has(b.id)} onCheckedChange={(v) => toggleBatch(b.id, v === true)} />
                  <span className="truncate font-mono text-xs">{b.card_code ?? b.folder_name}</span>
                </label>
              ))}
              {(!batches || batches.length === 0) && (
                <span className="text-sm text-muted-foreground">暂无批次</span>
              )}
            </div>
          </div>

          <Button
            disabled={statuses.size === 0 || exportCpa.isPending}
            onClick={() =>
              exportCpa.mutate(
                {
                  statuses: [...statuses],
                  batchIds: batchIds.size ? [...batchIds] : undefined,
                },
                {
                  onSuccess: (r) => {
                    setResult(r);
                    toast.success(`已导出 ${r.count} 个账号`);
                  },
                  onError: (e) => toast.error(e.message),
                },
              )
            }
          >
            生成 tar 包
          </Button>

          {result && (
            <div className="rounded-md border p-4 text-sm">
              <div>
                已生成：<span className="font-mono">{result.fileName}</span>（{result.count} 个账号）
              </div>
              <Button asChild className="mt-2">
                <a href={downloadUrl(result.fileName)} download>
                  下载 tar 包
                </a>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
