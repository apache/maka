'use client';
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { getJson } from "@/lib/inventory/api";
import { formatYuan } from "@/lib/inventory/money";
import type { Merchant, WorkspaceSummary } from "@/lib/inventory/workspace-types";

const columnHelper = createColumnHelper<Merchant>();

const columns = [
  columnHelper.accessor("name", { header: "商家" }),
  columnHelper.accessor("stock", { header: "库存" }),
  columnHelper.accessor("minPriceCents", {
    header: "最低价",
    cell: (info) => formatYuan(info.getValue()),
  }),
  columnHelper.accessor("sample", { header: "样本" }),
  columnHelper.accessor("decision", { header: "判断" }),
];

export default function DashboardPage() {
  const summary = useQuery({
    queryKey: ["workspace-summary"],
    queryFn: () => getJson<WorkspaceSummary>("/api/inventory/workspace/summary"),
  });

  const merchants = summary.data?.merchants ?? [];
  const table = useReactTable({
    data: merchants,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (summary.isError) {
    return (
      <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        交易台数据加载失败，请确认 API 已启动。
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <article className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <p className="text-sm text-muted-foreground">套餐库存、商家推荐和最新订单都来自本地 seed，不连接未授权上游。</p>
        <Link
          href="/inventory/marketplace/extract"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          进入采购
        </Link>
      </article>

      <section className="grid gap-3 md:grid-cols-4">
        {(summary.data?.plans ?? []).map((plan) => (
          <article key={plan.plan} className="rounded-xl border bg-card p-4">
            <h2 className="font-medium">{plan.plan}</h2>
            <p className="tnum mt-2 text-lg">{plan.stock ? `${plan.stock} 条库存` : "暂无现货"}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {formatYuan(plan.minPriceCents)} · {plan.merchantCount} 商家
            </p>
          </article>
        ))}
      </section>

      <article className="overflow-x-auto rounded-xl border bg-card">
        <h2 className="px-4 pt-4 font-medium">商家推荐</h2>
        <table className="mt-2 min-w-full text-left text-sm">
          <thead className="bg-muted">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th key={header.id} className="px-3 py-2 font-medium">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="border-t border-border">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </article>
    </div>
  );
}
