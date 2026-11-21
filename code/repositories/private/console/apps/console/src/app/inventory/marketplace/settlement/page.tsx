'use client';
import { useQuery } from "@tanstack/react-query";
import { getJson } from "@/lib/inventory/api";
import { formatYuan } from "@/lib/inventory/money";
import type { PurchaseOrder } from "@/lib/inventory/workspace-types";

const settlementLabels: Record<string, string> = {
  payable: "可结算",
  warranty_locked: "质保中",
  settled: "已结算",
  refunded: "已退款",
};

type SettlementSummary = {
  payableCents: number;
  warrantyLockedCents: number;
  settledCents: number;
};

export default function SettlementPage() {
  const summary = useQuery({
    queryKey: ["settlement-summary"],
    queryFn: () => getJson<SettlementSummary>("/api/inventory/workspace/settlement/summary"),
  });
  const orders = useQuery({
    queryKey: ["orders", "all", ""],
    queryFn: () => getJson<PurchaseOrder[]>("/api/inventory/workspace/orders"),
  });

  if (summary.isError || orders.isError) {
    return <p>结算数据加载失败，请确认 API 已启动。</p>;
  }

  return (
    <div className="space-y-4">
      <section className="grid gap-3 md:grid-cols-3">
        <article className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">可结算</p>
          <p className="tnum mt-1 text-2xl">{formatYuan(summary.data?.payableCents)}</p>
        </article>
        <article className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">质保锁定</p>
          <p className="tnum mt-1 text-2xl">{formatYuan(summary.data?.warrantyLockedCents)}</p>
        </article>
        <article className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">已结算</p>
          <p className="tnum mt-1 text-2xl">{formatYuan(summary.data?.settledCents)}</p>
        </article>
      </section>

      <article className="rounded-xl border bg-card p-4">
        <h2 className="font-medium">订单结算列表（{orders.data?.length ?? 0}）</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-3 py-2 font-medium">订单</th>
                <th className="px-3 py-2 font-medium">账号</th>
                <th className="px-3 py-2 font-medium">商家</th>
                <th className="px-3 py-2 font-medium">结算</th>
                <th className="px-3 py-2 font-medium">金额</th>
                <th className="px-3 py-2 font-medium">时间</th>
              </tr>
            </thead>
            <tbody>
              {(orders.data ?? []).map((order) => {
                const settlementStatus = order.settlementStatus ?? "warranty_locked";
                return (
                  <tr key={order.id} className="border-t border-border">
                    <td className="px-3 py-2">{order.id}</td>
                    <td className="px-3 py-2">{order.account}</td>
                    <td className="px-3 py-2">{order.supplierName ?? "-"}</td>
                    <td className="px-3 py-2">
                      {settlementLabels[settlementStatus] ?? settlementStatus}
                    </td>
                    <td className="tnum px-3 py-2">{formatYuan(order.amountCents)}</td>
                    <td className="px-3 py-2">{order.createdAt ?? "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  );
}
