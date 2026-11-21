'use client';
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getJson, postJson } from "@/lib/inventory/api";
import { formatYuan } from "@/lib/inventory/money";
import type { LedgerEntry, WorkspaceSummary } from "@/lib/inventory/workspace-types";

export default function FundsPage() {
  const queryClient = useQueryClient();
  const [amountYuan, setAmountYuan] = useState("200");
  const summary = useQuery({
    queryKey: ["workspace-summary"],
    queryFn: () => getJson<WorkspaceSummary>("/api/inventory/workspace/summary"),
  });
  const ledgers = useQuery({
    queryKey: ["ledgers"],
    queryFn: () => getJson<{ ledgers: LedgerEntry[] }>("/api/inventory/workspace/ledgers"),
  });
  const deposit = useMutation({
    mutationFn: () =>
      postJson("/api/inventory/workspace/funds/deposit", {
        amountCents: Math.round(Number(amountYuan) * 100),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["ledgers"] }),
      ]);
    },
  });

  if (summary.isError) {
    return (
      <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        交易台数据加载失败，请确认 API 已启动。
      </p>
    );
  }

  const wallet = summary.data?.wallet;
  const amountCents = Math.max(0, Math.round(Number(amountYuan || 0) * 100));

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <article className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="font-medium">资金账户</h2>
        <p className="tnum text-3xl">{formatYuan(wallet?.availableCents)}</p>
        <p className="text-sm text-muted-foreground">冻结 {formatYuan(wallet?.frozenCents)}。充值只写入本地内存钱包。</p>
        <label className="grid gap-1 text-sm">
          充值金额（元）
          <input
            value={amountYuan}
            inputMode="decimal"
            onChange={(event) => setAmountYuan(event.target.value)}
            className="rounded-lg border border-input bg-background px-3 py-2"
          />
        </label>
        <p className="text-sm text-muted-foreground">充值后余额预览 {formatYuan((wallet?.availableCents ?? 0) + amountCents)}</p>
        <button
          type="button"
          disabled={amountCents <= 0 || deposit.isPending}
          onClick={() => deposit.mutate()}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {deposit.isPending ? "入账中" : "本地入账"}
        </button>
      </article>

      <article className="rounded-xl border bg-card p-4">
        <h2 className="font-medium">流水</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-3 py-2 font-medium">类型</th>
                <th className="px-3 py-2 font-medium">金额</th>
                <th className="px-3 py-2 font-medium">余额</th>
              </tr>
            </thead>
            <tbody>
              {(ledgers.data?.ledgers ?? []).map((entry) => (
                <tr key={entry.id} className="border-t border-border">
                  <td className="px-3 py-2">{entry.type}</td>
                  <td className="tnum px-3 py-2">{formatYuan(entry.amountCents)}</td>
                  <td className="tnum px-3 py-2">{formatYuan(entry.balanceAfterCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  );
}
