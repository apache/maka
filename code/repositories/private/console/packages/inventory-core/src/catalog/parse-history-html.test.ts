import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseHistoryHtml } from "./parse-history-html";

const readFixture = (fileName: string) =>
  readFileSync(join(process.cwd(), "fixtures", "shop", fileName), "utf8");

describe("parseHistoryHtml", () => {
  it("extracts chart payload from product history fixture", () => {
    const result = parseHistoryHtml(readFixture("shop.history.8732468.html"));

    expect(result.times).toHaveLength(9);
    expect(result.prices.at(0)).toBe(0.02);
    expect(result.stocks.at(-1)).toBe(4049);
  });
});
