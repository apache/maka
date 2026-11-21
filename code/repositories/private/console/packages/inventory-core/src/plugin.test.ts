import { describe, expect, it } from "vitest";

import { createToolkit } from "./context";
import { createPluginRegistry } from "./plugin";
import type { Plugin } from "./plugin";

describe("plugin registry", () => {
  it("applies a plugin and reverses it on unregister", async () => {
    const ctx = createToolkit({ dbPath: ":memory:" });
    const registry = createPluginRegistry();
    const plugin: Plugin = {
      id: "clock",
      apply(toolkit) {
        toolkit.seams.define("clock");
        toolkit.seams.provide("clock", () => 42);
      },
      dispose(toolkit) {
        toolkit.seams.unprovide("clock");
      },
    };

    await registry.register(plugin, ctx);
    expect(registry.list().map((item) => item.id)).toEqual(["clock"]);
    expect((ctx.seams.consume("clock") as () => number)()).toBe(42);

    await registry.unregister("clock", ctx);
    expect(registry.list()).toEqual([]);
    expect(() => ctx.seams.consume("clock")).toThrow(/clock/);
  });
});
