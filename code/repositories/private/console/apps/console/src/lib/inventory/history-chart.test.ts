import { describe, expect, it } from "vitest";

import { buildPolylinePoints, summarizeSeries } from "./history-chart";

describe("history chart geometry", () => {
  it("summarizes min max and latest for a stock series", () => {
    expect(summarizeSeries([4057, 4049, 4040])).toEqual({
      min: 4040,
      max: 4057,
      latest: 4040,
    });
  });

  it("builds two svg polyline points for a descending series", () => {
    const points = buildPolylinePoints([4057, 4049]);
    const [first, second] = points.split(" ");

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first?.split(",")[1]).not.toBe(second?.split(",")[1]);
  });
});
