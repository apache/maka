import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseProductsHtml } from "./parse-products-html";

const readFixture = (fileName: string) =>
  readFileSync(join(process.cwd(), "fixtures", "shop", fileName), "utf8");

describe("parseProductsHtml", () => {
  it("extracts source totals, shops and visible product rows from search fixture", () => {
    const result = parseProductsHtml(readFixture("shop.search.gpt.html"));

    expect(result.totalProducts).toBe(4237);
    expect(result.shops).toHaveLength(999);
    expect(result.products).toHaveLength(71);
    expect(result.products[1]).toMatchObject({
      duplicate_hidden: false,
      duplicate_group: "duplicate-group-1",
      status: "在售",
      shop_name: "gpt_plus_批发",
      stock_text: "4049",
      history_url: "history.php?id=8732468",
    });
  });
});
