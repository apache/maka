import { describe, expect, it } from "vitest";

import { readFixtureProducts } from "@ggbdpq/inventory-core";
import {
  filterCatalogProducts,
  freshnessLabel,
  historyIdFromUrl,
  type CatalogFilters,
} from "./filter-catalog";

const baseFilters: CatalogFilters = {
  keyword: "",
  excludeKeyword: "",
  shopName: "",
  status: "active",
  minPrice: "",
  maxPrice: "",
  sort: "price",
  direction: "asc",
  showDuplicates: false,
  expandedGroups: [],
};

describe("filter catalog", () => {
  it("maps history.php ids and freshness classes", () => {
    expect(historyIdFromUrl("history.php?id=8732468")).toBe("8732468");
    expect(freshnessLabel("fresh-update-time")).toBe("新鲜");
    expect(freshnessLabel("warning-update-time")).toBe("关注");
    expect(freshnessLabel("stale-update-time")).toBe("滞后");
  });

  it("keeps GPT rows and reveals hidden duplicate shops when expanded", () => {
    const products = readFixtureProducts();
    const keywordRows = filterCatalogProducts(products, {
      ...baseFilters,
      keyword: "GPT",
    });
    expect(keywordRows.some((product) => product.title.includes("GPT"))).toBe(true);
    expect(keywordRows.some((product) => product.shop_name.includes("AI批发代理"))).toBe(false);

    const expanded = filterCatalogProducts(products, {
      ...baseFilters,
      showDuplicates: true,
    });
    expect(expanded.some((product) => product.shop_name.includes("AI批发代理"))).toBe(true);
  });
});
