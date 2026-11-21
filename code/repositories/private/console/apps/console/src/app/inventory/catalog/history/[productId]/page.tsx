'use client';
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { getJson } from "@/lib/inventory/api";
import { HistoryChart } from "@/components/inventory/HistoryChart";

type HistoryPayload = {
  times: string[];
  prices: number[];
  stocks: number[];
};

export default function CatalogHistoryPage() {
  const { productId } = useParams();
  const history = useQuery({
    queryKey: ["catalog-history", productId],
    queryFn: () => getJson<HistoryPayload>(`/api/inventory/catalog/products/${productId}/history`),
  });

  const rows = history.data
    ? history.data.times.map((time, index) => ({
        time,
        price: history.data.prices[index],
        stock: history.data.stocks[index],
      }))
    : [];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">history.php?id={productId}</p>
          <h1 className="text-2xl font-semibold">商品历史趋势</h1>
        </div>
        <Link href="/inventory/catalog" className="rounded-lg border border-input bg-background px-4 py-2 text-sm">
          返回市价目录
        </Link>
      </div>
      {history.isLoading ? <p className="text-sm text-muted-foreground">加载中</p> : null}
      {history.isError ? (
        <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
          当前只有 fixture 8732468 有历史趋势，其它商品 id 不会编造数据。
        </p>
      ) : null}
      {history.data ? (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <HistoryChart
              title="库存变化"
              tone="stock"
              times={history.data.times}
              values={history.data.stocks}
            />
            <HistoryChart
              title="价格变化"
              tone="price"
              times={history.data.times}
              values={history.data.prices}
            />
          </div>
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">时间</th>
                  <th className="px-3 py-2 font-medium">价格</th>
                  <th className="px-3 py-2 font-medium">库存</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.time} className="border-t border-border">
                    <td className="px-3 py-2 tnum">{row.time}</td>
                    <td className="px-3 py-2 tnum">{row.price}</td>
                    <td className="px-3 py-2 tnum">{row.stock}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
