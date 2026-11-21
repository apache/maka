'use client';
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { getJson } from "@/lib/inventory/api";
import { formatYuan } from "@/lib/inventory/money";
import type { InventoryItem } from "@/lib/inventory/workspace-types";

const statusLabels: Record<string, string> = {
  pool: "号池中",
  sold: "已售出",
  locked: "锁定中",
};

const checkLabels: Record<string, string> = {
  healthy: "健康",
  failed: "异常",
  unchecked: "未校验",
};

const columnHelper = createColumnHelper<InventoryItem>();

const columns = [
  columnHelper.accessor("id", { header: "库存编号" }),
  columnHelper.accessor("account", { header: "账号" }),
  columnHelper.accessor("plan", { header: "套餐" }),
  columnHelper.accessor((row) => row.supplierName ?? row.supplierId ?? "-", {
    id: "supplier",
    header: "商家",
  }),
  columnHelper.accessor("status", {
    header: "状态",
    cell: (info) => statusLabels[info.getValue()] ?? info.getValue(),
  }),
  columnHelper.accessor((row) => row.checkStatus ?? "unchecked", {
    id: "checkStatus",
    header: "校验",
    cell: (info) => checkLabels[info.getValue()] ?? info.getValue(),
  }),
  columnHelper.accessor((row) => row.priceCents ?? 0, {
    id: "priceCents",
    header: "价格",
    cell: (info) => formatYuan(info.getValue()),
  }),
];

export default function InventoryPage() {
  const [plan, setPlan] = useState("all");
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const inventory = useQuery({
    queryKey: ["inventory"],
    queryFn: () => getJson<InventoryItem[]>("/api/inventory/workspace/inventory"),
  });

  const rows = useMemo(() => {
    const items = inventory.data ?? [];
    const normalized = query.trim().toLowerCase();
    return items.filter((item) => {
      const planOk = plan === "all" || item.plan === plan;
      const statusOk = status === "all" || item.status === status;
      if (!planOk || !statusOk) return false;
      if (!normalized) return true;
      const supplier = item.supplierName ?? item.supplierId ?? "";
      return [item.id, item.account, supplier, item.plan].join(" ").toLowerCase().includes(normalized);
    });
  }, [inventory.data, plan, query, status]);

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (inventory.isError) {
    return <p>库存加载失败，请确认 API 已启动。</p>;
  }

  const items = inventory.data ?? [];
  const healthyCount = items.filter(
    (item) => item.checkStatus === "healthy" && item.status === "pool",
  ).length;
  const soldCount = items.filter((item) => item.status === "sold").length;
  const averagePrice = rows.length
    ? Math.round(rows.reduce((sum, item) => sum + (item.priceCents ?? 0), 0) / rows.length)
    : 0;
  const plans = Array.from(new Set(items.map((item) => item.plan)));

  return (
    <div className="space-y-4">
      <section className="grid gap-3 md:grid-cols-4">
        <article className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">总库存</p>
          <p className="tnum mt-1 text-2xl">{items.length}</p>
        </article>
        <article className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">健康池</p>
          <p className="tnum mt-1 text-2xl">{healthyCount}</p>
        </article>
        <article className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">已售出</p>
          <p className="tnum mt-1 text-2xl">{soldCount}</p>
        </article>
        <article className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">筛选均价</p>
          <p className="tnum mt-1 text-2xl">{formatYuan(averagePrice)}</p>
        </article>
      </section>

      <article className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap gap-3">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索账号、商家、库存编号"
            className="min-w-48 flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm"
          />
          <select
            value={plan}
            onChange={(event) => setPlan(event.target.value)}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="all">全部套餐</option>
            {plans.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="all">全部状态</option>
            <option value="pool">号池中</option>
            <option value="sold">已售出</option>
            <option value="locked">锁定中</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
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
        </div>
      </article>
    </div>
  );
}
