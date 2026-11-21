'use client';
import { useQuery } from "@tanstack/react-query";
import { getJson } from "@/lib/inventory/api";

type ReplenishPreview = {
  healthyCount: number;
  rule: { plan: string; threshold: number };
  plan: { action: string; quantity: number };
};

export default function HomePage() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => getJson<{ ok: boolean }>("/api/health"),
  });
  const loop = useQuery({
    queryKey: ["replenish-preview"],
    queryFn: () => getJson<ReplenishPreview>("/api/inventory/workspace/replenish/preview"),
  });

  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">数字权益库存工作台</h1>
      <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
        默认能力是本地 fixture、授权库存导入、市价只读监控、邮件收信和任务回放。
        不对第三方站点做批量注册，也不连接未授权上游。
      </p>
      <p className="tnum text-sm">
        API 健康检查：{health.data ? (health.data.ok ? "在线" : "异常") : health.isError ? "离线" : "加载中"}
      </p>
      {loop.data ? (
        <p className="text-sm text-muted-foreground">
          补池闭环：{loop.data.rule.plan} 健康库存 {loop.data.healthyCount} / 阈值{" "}
          {loop.data.rule.threshold}，决策 {loop.data.plan.action}
          {loop.data.plan.action === "buy" ? `，数量 ${loop.data.plan.quantity}` : ""}。
        </p>
      ) : null}
    </section>
  );
}
