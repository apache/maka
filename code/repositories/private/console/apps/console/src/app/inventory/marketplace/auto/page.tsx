'use client';
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getJson, postJson } from "@/lib/inventory/api";
import { formatYuan } from "@/lib/inventory/money";
import type { AutoRun, ReplenishPreview, WorkspaceSummary } from "@/lib/inventory/workspace-types";

const actionLabel: Record<ReplenishPreview["plan"]["action"], string> = {
  buy: "将按预算补池",
  skipped: "当前跳过",
  blocked: "预算未命中",
};

export default function AutoPage() {
  const queryClient = useQueryClient();
  const summary = useQuery({
    queryKey: ["workspace-summary"],
    queryFn: () => getJson<WorkspaceSummary>("/api/inventory/workspace/summary"),
  });
  const preview = useQuery({
    queryKey: ["replenish-preview"],
    queryFn: () => getJson<ReplenishPreview>("/api/inventory/workspace/replenish/preview"),
  });
  const localRun = useMutation({
    mutationFn: () => postJson<AutoRun>("/api/inventory/workspace/auto-replenish/run", {}),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["inventory"] }),
        queryClient.invalidateQueries({ queryKey: ["orders"] }),
        queryClient.invalidateQueries({ queryKey: ["settlement-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["replenish-preview"] }),
        queryClient.invalidateQueries({ queryKey: ["ledgers"] }),
      ]);
    },
  });
  const catalogRun = useMutation({
    mutationFn: () => postJson("/api/inventory/jobs/run", { name: "replenish" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["replenish-preview"] }),
        queryClient.invalidateQueries({ queryKey: ["events"] }),
        queryClient.invalidateQueries({ queryKey: ["inventory"] }),
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

  const plusPlan = summary.data?.plans.find((item) => item.plan === "Plus");
  const rule = summary.data?.autoRule;
  const loop = preview.data;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <article className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="font-medium">本地库存补池</h2>
        <p className="tnum text-sm text-muted-foreground">
          Plus 健康库存 {plusPlan?.stock ?? 0}，最低价 {formatYuan(plusPlan?.minPriceCents ?? null)}。
        </p>
        {rule ? (
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li>监控套餐 {rule.plan}</li>
            <li>触发阈值 {rule.threshold}</li>
            <li>目标水位 {rule.target}</li>
            <li>单次上限 {rule.maxAccountsPerRun}</li>
            <li>最高单价 {formatYuan(rule.maxUnitPriceCents)}</li>
          </ul>
        ) : null}
        <button
          type="button"
          disabled={localRun.isPending}
          onClick={() => localRun.mutate()}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {localRun.isPending ? "补池执行中" : "执行本地补池"}
        </button>
        {localRun.data ? (
          <p className="text-sm text-muted-foreground">
            {localRun.data.message}（{localRun.data.status}，买入 {localRun.data.purchasedCount}）
          </p>
        ) : null}
      </article>

      <article className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="font-medium">市价预算闭环</h2>
        {preview.isError ? (
          <p className="text-sm text-muted-foreground">闭环预览加载失败。</p>
        ) : loop ? (
          <>
            <p className="text-sm text-muted-foreground">
              {loop.rule.plan} 健康库存 {loop.healthyCount} / 阈值 {loop.rule.threshold}，预算上限{" "}
              {formatYuan(loop.rule.maxUnitPriceCents)}。{actionLabel[loop.plan.action]}
              {loop.plan.action === "buy" ? ` ${loop.plan.quantity} 个。` : "。"}
            </p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {loop.quotes.slice(0, 5).map((quote) => (
                <li key={`${quote.shopName}-${quote.title}`}>
                  {quote.shopName} {formatYuan(quote.priceCents)}
                  {quote.withinBudget ? "（预算内）" : "（超预算）"}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">正在读取市价与预算。</p>
        )}
        <button
          type="button"
          disabled={catalogRun.isPending}
          onClick={() => catalogRun.mutate()}
          className="rounded-lg border border-input bg-background px-4 py-2 text-sm transition-colors hover:bg-accent disabled:opacity-50"
        >
          {catalogRun.isPending ? "闭环执行中" : "执行市价闭环"}
        </button>
        {catalogRun.data ? (
          <pre className="overflow-x-auto rounded-xl bg-muted/50 p-3 text-xs">
            {JSON.stringify(catalogRun.data, null, 2)}
          </pre>
        ) : null}
      </article>
    </div>
  );
}
