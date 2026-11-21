import { useEffect, useMemo, useState } from 'react';
import { Eye, RotateCw, Trash2 } from 'lucide-react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import type { AccountRow } from '@ggbdpq/console-shared';
import { useDeleteAccount, useRefreshAccountQuota, useSettings } from '@/lib/assets/api';
import { getQuotaPresentation, type QuotaTone } from '@/lib/assets/accountPresentation';
import { StatusBadge } from '@/components/assets/StatusBadge';
import { ExpiryCell } from '@/components/assets/ExpiryCell';
import { AccountDetailDialog } from '@/components/assets/AccountDetailDialog';
import { ActionErrorDialog, type ActionErrorState } from '@/components/assets/ActionErrorDialog';
import { Button } from '@ggbdpq/console-ui';
import { Checkbox } from '@ggbdpq/console-ui';
import { toast } from 'sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ggbdpq/console-ui';
import { cn } from '@ggbdpq/console-ui';

interface Props {
  accounts: AccountRow[];
  showBatch?: boolean;
  selectable?: boolean;
  onSelectionChange?: (ids: number[]) => void;
}

const QUOTA_TONE_CLASS: Record<QuotaTone, string> = {
  healthy: 'bg-success',
  low: 'bg-warning',
  blocked: 'bg-destructive',
  stale: 'bg-muted-foreground/35',
  unknown: 'bg-muted-foreground/60',
};

function fmtTime(value: string | null): string {
  return value ? value.slice(0, 16).replace('T', ' ') : '—';
}

function isRiskRow(account: AccountRow): boolean {
  return ['token_expired', 'creds_invalid', 'quota_exhausted'].includes(account.status);
}

function QuotaCell({ account }: { account: AccountRow }) {
  const quota = getQuotaPresentation(account);
  return (
    <div className="min-w-44">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className={cn('font-medium', quota.tone === 'stale' && 'text-muted-foreground')}>{quota.label}</span>
        {quota.percent != null && <span className="text-xs text-muted-foreground">{quota.percent}%</span>}
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-all', QUOTA_TONE_CLASS[quota.tone])}
          style={{ width: `${quota.percent ?? 0}%` }}
        />
      </div>
      <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">{quota.meta}</div>
    </div>
  );
}

export function AccountsTable({ accounts, selectable, onSelectionChange }: Props) {
  const { data: settings } = useSettings();
  const refreshQuota = useRefreshAccountQuota();
  const deleteAccount = useDeleteAccount();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [actionError, setActionError] = useState<ActionErrorState | null>(null);

  const publishSelection = (next: Set<number>) => {
    setSelected(next);
    onSelectionChange?.([...next]);
  };

  const toggle = (id: number, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    publishSelection(next);
  };

  const columns = useMemo<ColumnDef<AccountRow>[]>(() => {
    const cols: ColumnDef<AccountRow>[] = [];
    if (selectable) {
      cols.push({
        id: 'select',
        header: () => {
          const visibleIds = accounts.map((a) => a.id);
          const allChecked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
          const partlyChecked = !allChecked && visibleIds.some((id) => selected.has(id));
          return (
            <Checkbox
              checked={allChecked || (partlyChecked ? 'indeterminate' : false)}
              onCheckedChange={(v) => {
                const next = new Set(selected);
                for (const id of visibleIds) {
                  if (v === true) next.add(id);
                  else next.delete(id);
                }
                publishSelection(next);
              }}
              aria-label="选择当前页账号"
            />
          );
        },
        cell: ({ row }) => (
          <Checkbox
            checked={selected.has(row.original.id)}
            onCheckedChange={(v) => toggle(row.original.id, v === true)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`选择 ${row.original.email}`}
          />
        ),
        enableSorting: false,
      });
    }
    cols.push(
      {
        accessorKey: 'email',
        header: '账号',
        cell: (c) => {
          const account = c.row.original;
          return (
            <div className="min-w-72">
              <div className="font-mono text-xs font-medium">{c.getValue<string>()}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{account.platform}</span>
                {account.account_id && <span className="font-mono">ID {account.account_id.slice(0, 8)}…</span>}
                {account.duplicate === 1 && <span className="rounded bg-warning/10 px-1.5 py-0.5 text-warning">重复</span>}
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: 'status',
        header: '状态',
        cell: (c) => <StatusBadge status={c.getValue<AccountRow['status']>()} />,
      },
      {
        accessorKey: 'quota_percent',
        header: '真实额度',
        cell: (c) => <QuotaCell account={c.row.original} />,
      },
      {
        accessorKey: 'quota_reset_at',
        header: '限额重置',
        cell: (c) => (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {fmtTime(c.getValue<string | null>())}
          </span>
        ),
      },
      {
        accessorKey: 'expires_at',
        header: '账号过期',
        cell: (c) => <ExpiryCell expiresAt={c.getValue<string | null>()} warnDays={settings?.warn_days} />,
      },
      {
        accessorKey: 'reauth_at',
        header: '最近授权',
        cell: (c) => {
          const v = c.getValue<string | null>();
          return v ? (
            <span className="whitespace-nowrap text-xs">{v.slice(0, 10)}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
        },
      },
      {
        id: 'actions',
        header: '操作',
        cell: ({ row }) => {
          const acc = row.original;
          return (
            <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
              <Button variant="outline" size="sm" onClick={() => setDetailId(acc.id)}>
                <Eye />
                详情
              </Button>
              <Button
                variant="ghost"
                size="icon"
                disabled={refreshQuota.isPending || !acc.access_token}
                title="刷新真实额度"
                onClick={() =>
                  refreshQuota.mutate(acc.id, {
                    onSuccess: (r) => {
                      if (r.error) {
                        setActionError({
                          title: '刷新额度失败',
                          message: `${acc.email} 的真实额度刷新失败`,
                          detail: r.error,
                        });
                        return;
                      }
                      toast.success(`${acc.email} 真实额度已刷新`);
                    },
                    onError: (e) =>
                      setActionError({
                        title: '刷新额度接口错误',
                        message: `${acc.email} 的真实额度刷新请求失败`,
                        detail: e.message,
                      }),
                  })
                }
              >
                <RotateCw className={refreshQuota.isPending ? 'animate-spin' : undefined} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={deleteAccount.isPending}
                title="删除账号"
                onClick={() => {
                  if (!window.confirm(`确定删除账号 ${acc.email} 吗？`)) return;
                  deleteAccount.mutate(acc.id, {
                    onSuccess: () => {
                      toast.success('账号已删除');
                      if (detailId === acc.id) setDetailId(null);
                    },
                    onError: (e) =>
                      setActionError({
                        title: '删除账号失败',
                        message: `${acc.email} 删除失败`,
                        detail: e.message,
                      }),
                  });
                }}
              >
                <Trash2 />
              </Button>
            </div>
          );
        },
        enableSorting: false,
      },
    );
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, deleteAccount, detailId, refreshQuota, selectable, selected, settings?.warn_days]);

  useEffect(() => {
    setSelected((prev) => {
      const visibleIds = new Set(accounts.map((a) => a.id));
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      if (next.size !== prev.size) onSelectionChange?.([...next]);
      return next;
    });
  }, [accounts, onSelectionChange]);

  const table = useReactTable({
    data: accounts,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 20 } },
  });

  return (
    <>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id}>
              {hg.headers.map((h) => (
                <TableHead
                  key={h.id}
                  onClick={h.column.getCanSort() ? h.column.getToggleSortingHandler() : undefined}
                  className={cn(h.column.getCanSort() && 'cursor-pointer select-none', h.id === 'actions' && 'text-right')}
                >
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {{ asc: ' ↑', desc: ' ↓' }[h.column.getIsSorted() as string] ?? ''}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              data-state={selected.has(row.original.id) ? 'selected' : undefined}
              onClick={() => setDetailId(row.original.id)}
              className={cn('cursor-pointer', isRiskRow(row.original) && 'bg-destructive/[0.04]')}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id} className={cell.column.id === 'actions' ? 'text-right' : undefined}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {accounts.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns.length} className="py-14 text-center">
                <div className="text-base font-medium">没有匹配的账号</div>
                <div className="mt-1 text-sm text-muted-foreground">请调整邮箱、状态或批次筛选条件。</div>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {table.getPageCount() > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-sm text-muted-foreground">
          第 {table.getState().pagination.pageIndex + 1} / {table.getPageCount()} 页
          <Button variant="outline" size="sm" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>
            上一页
          </Button>
          <Button variant="outline" size="sm" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
            下一页
          </Button>
        </div>
      )}
      <AccountDetailDialog id={detailId} onClose={() => setDetailId(null)} />
      <ActionErrorDialog error={actionError} onClose={() => setActionError(null)} />
    </>
  );
}
