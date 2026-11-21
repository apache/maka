import { describe, expect, it } from "vitest";

import { createToolkit } from "./context";
import { createSeamRegistry } from "./seams";

describe("capability seams", () => {
  it("defines a seam and swaps fixture/live providers", () => {
    const seams = createSeamRegistry();
    const fixture = { source: "fixture" as const };
    const live = { source: "live" as const };

    seams.define("catalog");
    seams.provide("catalog", fixture);
    expect(seams.consume("catalog")).toBe(fixture);

    seams.provide("catalog", live);
    expect(seams.consume("catalog")).toBe(live);
  });

  it("does not register live signup tools on a fresh toolkit", () => {
    const ctx = createToolkit({ dbPath: ":memory:" });
    expect(ctx.jobs.list().some((tool) => /signup|register-account/i.test(tool))).toBe(false);
  });
});
