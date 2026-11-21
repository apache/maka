'use client';
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@ggbdpq/console-ui";
import { getJson, postJson } from "@/lib/inventory/api";
import { formatYuan } from "@/lib/inventory/money";
import type { PurchaseEstimate, PurchaseOrder, WorkspaceSummary } from "@/lib/inventory/workspace-types";
import { WORKSPACE_PLANS } from "@/lib/inventory/workspace-types";
import { useWorkspaceForm } from "@/lib/inventory/store";

export default function ExtractPage() {
  const queryClient = useQueryClient();
  const {
    plan,
    quantity,
    maxUnitPriceCents,
    orderQuery,
    orderStatus,
    setPlan,
    setQuantity,
    setMaxUnitPriceYuan,
    setOrderQuery,
    setOrderStatus,
  } = useWorkspaceForm();

  const summary = useQuery({
    queryKey: ["workspace-summary"],
    queryFn: () => getJson<WorkspaceSummary>("/api/inventory/workspace/summary"),
  });
  const estimate = useQuery({
    queryKey: ["estimate", plan, quantity, maxUnitPriceCents],
    queryFn: () =>
      postJson<PurchaseEstimate>("/api/inventory/workspace/extractions/estimate", {
        plan,
        quantity,
        maxUnitPriceCents,
      }),
  });
  const orders = useQuery({
    queryKey: ["orders", orderStatus, orderQuery],
    queryFn: () => {
      const params = new URLSearchParams({
        status: orderStatus,
        query: orderQuery,
      });
      return getJson<PurchaseOrder[]>(`/api/inventory/workspace/orders?${params.toString()}`);
    },
  });
  const purchase = useMutation({
    mutationFn: () =>
      postJson<{ ok: boolean }>("/api/inventory/workspace/extractions/batch", {
        plan,
        quantity,
        maxUnitPriceCents,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["orders"] }),
        queryClient.invalidateQueries({ queryKey: ["estimate"] }),
        queryClient.invalidateQueries({ queryKey: ["inventory"] }),
        queryClient.invalidateQueries({ queryKey: ["settlement-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["ledgers"] }),
      ]);
    },
  });

  if (summary.isError) {
      <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">交易台数据加载失败，请确认 API 已启动。</p>
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
      <article className="space-y-4 rounded-xl border bg-card p-4">
        <h2 className="font-medium">购买需求</h2>
        <label className="grid gap-1 text-sm">
          购买数量
          <input
            type="number"
            min={1}
            max={500}
            value={quantity}
            onChange={(event) => setQuantity(Number(event.target.value))}
            className="rounded-lg border border-input bg-background px-3 py-2"
          />
        </label>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {WORKSPACE_PLANS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setPlan(item)}
              className={cn(
                "rounded-xl border px-3 py-2 text-left text-sm",
                plan === item ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background",
              )}
            >
              {item}
            </button>
          ))}
        </div>
        <label className="grid gap-1 text-sm">
          最高单价（元）
          <input
            defaultValue={((maxUnitPriceCents ?? 0) / 100).toFixed(2)}
            onChange={(event) => setMaxUnitPriceYuan(event.target.value)}
            className="rounded-lg border border-input bg-background px-3 py-2"
          />
        </label>
      </article>

      <article className="h-fit space-y-3 rounded-xl border bg-card p-4">
        <h2 className="font-medium">购买确认</h2>
        <p className="flex justify-between text-sm">
          <span>余额</span>
          <span className="tnum">{formatYuan(summary.data?.wallet.availableCents)}</span>
        </p>
        <p className="flex justify-between text-sm">
          <span>预计扣款</span>
          <span className="tnum">{formatYuan(estimate.data?.totalCents)}</span>
        </p>
        <p className="flex justify-between text-sm">
          <span>匹配数量</span>
          <span className="tnum">{estimate.data?.matchedQuantity ?? 0}</span>
        </p>
        {estimate.data?.reason ? (
          <p className="text-sm text-muted-foreground">未能完成：{estimate.data.reason}</p>
        ) : null}
        <button
          type="button"
          disabled={!estimate.data?.complete || purchase.isPending}
          onClick={() => purchase.mutate()}
          className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {purchase.isPending ? "购买中" : "确认购买"}
        </button>
      </article>

      <article className="space-y-3 rounded-xl border bg-card p-4 xl:col-span-2">
        <h2 className="font-medium">订单</h2>
        <div className="flex flex-wrap gap-3">
          <input
            value={orderQuery}
            onChange={(event) => setOrderQuery(event.target.value)}
            placeholder="搜索账号或商家"
            className="min-w-48 flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm"
          />
          <select
            value={orderStatus}
            onChange={(event) => setOrderStatus(event.target.value)}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="all">全部状态</option>
            <option value="active">有效</option>
            <option value="invalid">无效</option>
            <option value="refunded">已退款</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-3 py-2 font-medium">订单</th>
                <th className="px-3 py-2 font-medium">账号</th>
                <th className="px-3 py-2 font-medium">商家</th>
                <th className="px-3 py-2 font-medium">金额</th>
                <th className="px-3 py-2 font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {(orders.data ?? []).map((order) => (
                <tr key={order.id} className="border-t border-border">
                  <td className="px-3 py-2">{order.id}</td>
                  <td className="px-3 py-2">{order.account}</td>
                  <td className="px-3 py-2">{order.supplierName ?? "-"}</td>
                  <td className="tnum px-3 py-2">{formatYuan(order.amountCents)}</td>
                  <td className="px-3 py-2">{order.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  );
}
