'use client';
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { cn } from "@ggbdpq/console-ui";
import { getJson } from "@/lib/inventory/api";
import { catalogTotalLabel } from "@/lib/inventory/catalog-kpi";
import {
  filterCatalogProducts,
  freshnessLabel,
  historyIdFromUrl,
  type CatalogProduct,
} from "@/lib/inventory/filter-catalog";
import { useCatalogFilter } from "@/lib/inventory/store";

type ShopOption = {
  shop_id: string;
  name: string;
};

type CatalogPagePayload = {
  totalProducts: number;
  products: CatalogProduct[];
  shops: ShopOption[];
};

const fieldClass = "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm";

const freshnessClassName: Record<string, string> = {
  "fresh-update-time": "border-success/30 bg-success/10 text-success",
  "warning-update-time": "border-warning/30 bg-warning/10 text-warning",
  "stale-update-time": "border-border bg-muted text-muted-foreground",
};

export default function CatalogPage() {
  const filters = useCatalogFilter();
  const productsQuery = useQuery({
    queryKey: ["catalog-products"],
    queryFn: () => getJson<CatalogPagePayload>("/api/inventory/catalog/products"),
  });
  const shopsQuery = useQuery({
    queryKey: ["catalog-shops"],
    queryFn: () => getJson<{ shops: ShopOption[] }>("/api/inventory/catalog/shops"),
  });
  const metaQuery = useQuery({
    queryKey: ["catalog-db-meta"],
    queryFn: () => getJson<{ updated_at_text: string }>("/api/inventory/catalog/db-meta"),
  });

  const shops = shopsQuery.data?.shops ?? productsQuery.data?.shops ?? [];
  const rows = useMemo(
    () => filterCatalogProducts(productsQuery.data?.products ?? [], filters),
    [
      productsQuery.data?.products,
      filters.keyword,
      filters.excludeKeyword,
      filters.shopName,
      filters.status,
      filters.minPrice,
      filters.maxPrice,
      filters.sort,
      filters.direction,
      filters.showDuplicates,
      filters.expandedGroups,
    ],
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">市价目录</h1>
          <p className="mt-1 text-sm text-muted-foreground">店铺商品监控，只读本地 fixture，不拉源站。</p>
        </div>
        {metaQuery.data ? (
          <p className="text-sm text-muted-foreground">快照更新于 {metaQuery.data.updated_at_text}</p>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <article className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">源站总量</p>
          <p className="tnum mt-1 text-2xl">
            {catalogTotalLabel({
              isPending: productsQuery.isPending,
              isError: productsQuery.isError,
              totalProducts: productsQuery.data?.totalProducts,
            })}
          </p>
        </article>
        <article className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">当前显示</p>
          <p className="tnum mt-1 text-2xl">{rows.length}</p>
        </article>
        <article className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">历史趋势</p>
          <p className="mt-1 text-sm text-muted-foreground">仅商品 8732468</p>
        </article>
      </div>

      {productsQuery.isError ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          目录 fixture 读取失败。请确认 API 从本仓启动，且能读到 `fixtures/shop`。
        </p>
      ) : null}

      <div className="space-y-3 rounded-xl border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span>关键词</span>
            <input
              value={filters.keyword}
              onChange={(event) => filters.setKeyword(event.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span>排除词</span>
            <input
              value={filters.excludeKeyword}
              onChange={(event) => filters.setExcludeKeyword(event.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span>店铺</span>
            <select
              value={filters.shopName}
              onChange={(event) => filters.setShopName(event.target.value)}
              className={fieldClass}
            >
              <option value="">全部店铺</option>
              {shops.map((shop) => (
                <option key={shop.shop_id} value={shop.name}>
                  {shop.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span>状态</span>
            <select
              value={filters.status}
              onChange={(event) => filters.setStatus(event.target.value)}
              className={fieldClass}
            >
              <option value="active">在售</option>
              <option value="inactive">非在售</option>
              <option value="all">全部状态</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span>最低价</span>
            <input
              value={filters.minPrice}
              onChange={(event) => filters.setMinPrice(event.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span>最高价</span>
            <input
              value={filters.maxPrice}
              onChange={(event) => filters.setMaxPrice(event.target.value)}
              className={fieldClass}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={filters.showDuplicates}
              onChange={(event) => filters.setShowDuplicates(event.target.checked)}
            />
            展开同名商品
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filters.sort}
              onChange={(event) => filters.setSort(event.target.value as typeof filters.sort)}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="price">价格</option>
              <option value="stock">库存</option>
              <option value="updated_at">更新时间</option>
              <option value="title">标题</option>
            </select>
            <select
              value={filters.direction}
              onChange={(event) =>
                filters.setDirection(event.target.value as typeof filters.direction)
              }
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="asc">升序</option>
              <option value="desc">降序</option>
            </select>
            <button
              type="button"
              onClick={() => filters.reset()}
              className="rounded-lg border border-input bg-background px-4 py-2 text-sm transition-colors hover:bg-accent"
            >
              重置
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 font-medium">商品</th>
              <th className="px-3 py-2 font-medium">分类</th>
              <th className="px-3 py-2 font-medium">价格</th>
              <th className="px-3 py-2 font-medium">库存</th>
              <th className="px-3 py-2 font-medium">更新时间</th>
              <th className="px-3 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                  暂无匹配商品
                </td>
              </tr>
            ) : (
              rows.map((product) => {
                const productId = historyIdFromUrl(product.history_url);
                return (
                  <tr
                    key={`${product.history_url}-${product.shop_url}`}
                    className={cn("border-t border-border", product.duplicate_hidden ? "bg-muted/50" : "")}
                  >
                    <td className="px-3 py-2">
                      <span className="rounded-full bg-muted px-2.5 py-1 text-xs">{product.status}</span>
                    </td>
                    <td className="min-w-[320px] px-3 py-2">
                      <div className="flex gap-3">
                        {product.image_url ? (
                          <img
                            src={product.image_url}
                            alt=""
                            className="h-12 w-12 rounded-lg border border-border object-cover"
                          />
                        ) : (
                          <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-muted text-xs text-muted-foreground">
                            无图
                          </div>
                        )}
                        <div className="space-y-1">
                          <a
                            href={product.item_url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium hover:underline"
                          >
                            {product.title}
                          </a>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>{product.source}</span>
                            <a
                              href={product.shop_url}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded-full bg-muted px-2 py-0.5"
                            >
                              {product.shop_name}
                            </a>
                            {product.duplicate_toggle_text ? (
                              <button
                                type="button"
                                onClick={() => filters.toggleGroup(product.duplicate_group)}
                                className="text-xs hover:text-foreground"
                              >
                                {product.duplicate_toggle_text}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">{product.category}</td>
                    <td className="px-3 py-2 tnum">{product.price_text}</td>
                    <td className="px-3 py-2 tnum">{product.stock_text}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col items-start gap-1">
                        <span
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-xs",
                            freshnessClassName[product.freshness_class] ?? "border-border bg-muted text-muted-foreground",
                          )}
                        >
                          {freshnessLabel(product.freshness_class)}
                        </span>
                        <span className="tnum text-xs text-muted-foreground">{product.updated_at}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {productId ? (
                        <Link
                          href={`/inventory/catalog/history/${productId}`}
                          className="inline-block rounded-lg border border-input bg-background px-3 py-1 text-sm transition-colors hover:bg-accent"
                        >
                          历史
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
