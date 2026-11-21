import { describe, expect, it } from "vitest";

import { catalogTotalLabel } from "./catalog-kpi";

describe("catalogTotalLabel", () => {
  it("shows loading, failure and the source total separately", () => {
    expect(catalogTotalLabel({ isPending: true, isError: false })).toBe("加载中");
    expect(catalogTotalLabel({ isPending: false, isError: true })).toBe("加载失败");
    expect(
      catalogTotalLabel({ isPending: false, isError: false, totalProducts: 4237 }),
    ).toBe("4237");
  });
});
