'use client';
import { Suspense } from 'react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertCircle, RotateCw, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ACCOUNT_STATUSES, STATUS_LABELS } from '@ggbdpq/console-shared';
import { useAccounts, useBatches, useDeleteAccounts, useRefreshAccountsQuota } from '@/lib/assets/api';
import { AccountsTable } from '@/components/assets/AccountsTable';
import { Button } from '@ggbdpq/console-ui';
import { Input } from '@ggbdpq/console-ui';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ggbdpq/console-ui';

// useSearchParams 在静态预渲染时要求 Suspense 边界（CSR bailout），否则 build 失败
export default function AccountsPage() {
  return (
    <Suspense fallback={null}>
      <AccountsPageContent />
    </Suspense>
  );
}

function AccountsPageContent() {
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState(params.get('status') ?? 'all');
  const [batchId, setBatchId] = useState('all');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const deleteAccounts = useDeleteAccounts();
  const refreshQuota = useRefreshAccountsQuota();

  const { data: batches } = useBatches();
  const { data, isLoading } = useAccounts({
    email: email || undefined,
    status: status === 'all' ? undefined : status,
    batchId: batchId === 'all' ? undefined : Number(batchId),
  });

  const quotaState = useMemo(() => {
    const rows = data?.rows ?? [];
    return {
      stale: rows.filter((row) => !row.quota_source).length,
      low: rows.filter((row) => row.quota_source && row.quota_percent <= 20).length,
      refreshed: rows.filter((row) => row.quota_source).length,
    };
  }, [data?.rows]);

  return (
    <div className="space-y-5">
      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
              <Search className="h-3.5 w-3.5" />
              账号库存检索与处置
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight">账号台账</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              当前查询共 {data?.total ?? 0} 条；每页展示 20 条，批量操作只作用于当前已选账号。
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded-xl border bg-background/70 px-4 py-3">
              <div className="text-xl font-semibold">{quotaState.stale}</div>
              <div className="mt-1 text-xs text-muted-foreground">已加载未刷新</div>
            </div>
            <div className="rounded-xl border bg-background/70 px-4 py-3">
              <div className="text-xl font-semibold">{quotaState.low}</div>
              <div className="mt-1 text-xs text-muted-foreground">已加载低额度</div>
            </div>
            <div className="rounded-xl border bg-background/70 px-4 py-3">
              <div className="text-xl font-semibold">{quotaState.refreshed}</div>
              <div className="mt-1 text-xs text-muted-foreground">已加载已刷新</div>
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-3 xl:grid-cols-[1fr_auto]">
          <div className="grid gap-2 md:grid-cols-[minmax(260px,1fr)_180px_260px]">
            <Input
              placeholder="输入邮箱关键字…"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                {ACCOUNT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={batchId} onValueChange={setBatchId}>
              <SelectTrigger>
                <SelectValue placeholder="全部批次" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部批次</SelectItem>
                {batches?.map((b) => (
                  <SelectItem key={b.id} value={String(b.id)}>
                    {b.card_code ?? b.folder_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-background/70 p-2">
            <span className="px-2 text-xs text-muted-foreground">已选 {selectedIds.length} 条</span>
            <Button
              variant="outline"
              size="sm"
              disabled={selectedIds.length === 0 || refreshQuota.isPending}
              onClick={() => {
                refreshQuota.mutate(selectedIds, {
                  onSuccess: (r) => {
                    const msg = r.failed > 0 ? `已刷新 ${r.refreshed} 个，失败 ${r.failed} 个` : `已刷新 ${r.refreshed} 个账号`;
                    toast[r.failed > 0 ? 'warning' : 'success'](msg);
                  },
                  onError: (e) => toast.error(e.message),
                });
              }}
            >
              <RotateCw className={refreshQuota.isPending ? 'animate-spin' : undefined} />
              刷新额度
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={selectedIds.length === 0 || deleteAccounts.isPending}
              onClick={() => {
                if (!window.confirm(`确定删除已选中的 ${selectedIds.length} 个账号吗？`)) return;
                deleteAccounts.mutate(selectedIds, {
                  onSuccess: (r) => {
                    toast.success(`已删除 ${r.deleted} 个账号`);
                    setSelectedIds([]);
                  },
                  onError: (e) => toast.error(e.message),
                });
              }}
            >
              <Trash2 />
              删除选中
            </Button>
          </div>
        </div>
      </section>

      {quotaState.stale > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-warning/25 bg-warning/10 px-4 py-3 text-sm text-warning">
          <AlertCircle className="h-4 w-4" />
          当前已加载结果有 {quotaState.stale} 条账号尚未刷新真实额度，列表不会把静态 100 当作真实可用额度。
        </div>
      )}

      {isLoading ? (
        <div className="rounded-xl border bg-card p-6 text-muted-foreground">加载账号台账中…</div>
      ) : (
        <AccountsTable accounts={data?.rows ?? []} selectable onSelectionChange={setSelectedIds} />
      )}
    </div>
  );
}
