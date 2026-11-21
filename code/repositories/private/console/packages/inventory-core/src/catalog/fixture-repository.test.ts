import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readFixtureDbMeta,
  readFixtureHistoryById,
  readFixtureProducts,
  readFixtureSearchPage,
  readFixtureShops,
} from "./fixture-repository";

describe("catalog fixture repository", () => {
  it("reads local shop product fixtures", () => {
    const products = readFixtureProducts();
    expect(products.length).toBeGreaterThan(0);
    expect(products[0]?.title).toBeTruthy();
  });

  it("reads local shop options and db metadata", () => {
    const shops = readFixtureShops();
    expect(shops).toHaveLength(999);
    expect(shops[0]?.shop_id).toBeTruthy();
    expect(readFixtureDbMeta().updated_at_text).toBe("2026-07-29 21:23:11");
  });

  it("reads the search page when cwd is not the repo root", () => {
    const previousCwd = process.cwd();
    const isolatedCwd = mkdtempSync(join(tmpdir(), "tokens-fixtures-"));
    process.chdir(isolatedCwd);
    try {
      expect(readFixtureSearchPage().totalProducts).toBe(4237);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("returns parsed history for the known fixture id and nothing otherwise", () => {
    const history = readFixtureHistoryById("8732468");
    expect(history?.stocks.at(-1)).toBe(4049);
    expect(readFixtureHistoryById("missing")).toBeNull();
  });
});
