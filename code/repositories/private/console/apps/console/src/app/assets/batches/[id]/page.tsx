'use client';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { ACCOUNT_STATUSES, STATUS_LABELS } from '@ggbdpq/console-shared';
import { useAccounts, useBatches } from '@/lib/assets/api';
import { AccountsTable } from '@/components/assets/AccountsTable';
import { Input } from '@ggbdpq/console-ui';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ggbdpq/console-ui';

export default function BatchDetailPage() {
  const { id } = useParams();
  const batchId = Number(id);
  const { data: batches } = useBatches();
  const batch = batches?.find((b) => b.id === batchId);

  const [status, setStatus] = useState('all');
  const [email, setEmail] = useState('');
  const { data, isLoading } = useAccounts({
    batchId,
    status: status === 'all' ? undefined : status,
    email: email || undefined,
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold font-mono break-all">{batch?.folder_name ?? `批次 #${batchId}`}</h1>
        {batch && (
          <div className="mt-1 text-sm text-muted-foreground">
            {batch.purchase_date ?? '日期未知'} · {batch.total ?? 0} 个号 · 存活 {batch.alive ?? 0}
            {batch.unit_cost != null && ` · 单价 ≈${batch.unit_cost} 元`}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <Input
          className="w-64"
          placeholder="按邮箱过滤…"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40">
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
      </div>

      {isLoading ? (
        <div className="text-muted-foreground">加载中…</div>
      ) : (
        <AccountsTable accounts={data?.rows ?? []} />
      )}
    </div>
  );
}
