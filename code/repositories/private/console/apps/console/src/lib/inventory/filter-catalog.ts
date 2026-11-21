import type { Product } from "@ggbdpq/inventory-core";

export type CatalogSort = "price" | "updated_at" | "stock" | "title";
export type CatalogDirection = "asc" | "desc";

// 目录条目即核心 Product（API 直返 Product[]，此前手写 16 字段影子类型已收敛）：
// schema 字段漂移时在此编译期暴露，不再各自烂掉。
export type CatalogProduct = Product;

export type CatalogFilters = {
  keyword: string;
  excludeKeyword: string;
  shopName: string;
  status: string;
  minPrice: string;
  maxPrice: string;
  sort: CatalogSort;
  direction: CatalogDirection;
  showDuplicates: boolean;
  expandedGroups: string[];
};

const normalize = (value: string): string => value.trim().toLowerCase();

const parsePrice = (value: string): number => {
  const match = value.replace(/,/g, "").match(/[\d.]+/);
  return match ? Number(match[0]) : 0;
};

const parseStock = (value: string): number => {
  const match = value.replace(/,/g, "").match(/\d+/);
  return match ? Number(match[0]) : 0;
};

const matchesStatus = (product: CatalogProduct, status: string): boolean => {
  if (!status || status === "all") {
    return true;
  }
  if (status === "active") {
    return product.status.includes("在售");
  }
  if (status === "inactive") {
    return !product.status.includes("在售");
  }
  return product.status === status;
};

const sortableValue = (product: CatalogProduct, sort: CatalogSort) => {
  if (sort === "price") {
    return parsePrice(product.price_text);
  }
  if (sort === "stock") {
    return parseStock(product.stock_text);
  }
  if (sort === "updated_at") {
    return new Date(product.updated_at.replace(" ", "T")).getTime();
  }
  return product.title;
};

export function historyIdFromUrl(historyUrl: string): string | null {
  const match = historyUrl.match(/[?&]id=(\d+)/);
  return match?.[1] ?? null;
}

const freshnessCopy: Record<string, string> = {
  "fresh-update-time": "新鲜",
  "warning-update-time": "关注",
  "stale-update-time": "滞后",
};

export function freshnessLabel(freshnessClass: string): string {
  return freshnessCopy[freshnessClass] ?? "未知";
}

export function filterCatalogProducts(
  products: CatalogProduct[],
  filters: CatalogFilters,
): CatalogProduct[] {
  const keyword = normalize(filters.keyword);
  const excludeKeyword = normalize(filters.excludeKeyword);
  const shopName = normalize(filters.shopName);
  const minPrice = filters.minPrice.trim() === "" ? undefined : Number(filters.minPrice);
  const maxPrice = filters.maxPrice.trim() === "" ? undefined : Number(filters.maxPrice);

  return products
    .filter((product) => {
      const searchable = normalize(
        [
          product.title,
          product.category,
          product.shop_name,
          product.source,
          product.price_text,
          product.stock_text,
        ].join(" "),
      );
      const price = parsePrice(product.price_text);
      const duplicateVisible =
        !product.duplicate_hidden ||
        filters.showDuplicates ||
        filters.expandedGroups.includes(product.duplicate_group);

      return (
        duplicateVisible &&
        (!keyword || searchable.includes(keyword)) &&
        (!excludeKeyword || !searchable.includes(excludeKeyword)) &&
        (!shopName || normalize(product.shop_name).includes(shopName)) &&
        matchesStatus(product, filters.status) &&
        (minPrice === undefined || price >= minPrice) &&
        (maxPrice === undefined || price <= maxPrice)
      );
    })
    .sort((left, right) => {
      const leftValue = sortableValue(left, filters.sort);
      const rightValue = sortableValue(right, filters.sort);
      const order = filters.direction === "asc" ? 1 : -1;
      if (typeof leftValue === "number" && typeof rightValue === "number") {
        return (leftValue - rightValue) * order;
      }
      return String(leftValue).localeCompare(String(rightValue), "zh-CN") * order;
    });
}
