import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "../src/index";

describe("healthResponseSchema", () => {
  it("接受合法负载", () => {
    const parsed = healthResponseSchema.parse({
      ok: true,
      service: "console",
      time: new Date().toISOString(),
    });
    expect(parsed.ok).toBe(true);
  });

  it("拒绝非法 service 字段", () => {
    expect(() =>
      healthResponseSchema.parse({ ok: true, service: "other", time: "x" }),
    ).toThrow();
  });
});
