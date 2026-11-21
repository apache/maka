import { describe, expect, it } from "vitest";

import { createToolkit } from "../index";
import { marketplacePlugin } from "../marketplace/plugin";
import { WorkspaceService } from "../marketplace/workspace";
import { pipelinePlugin } from "./plugin";

describe("pipeline plugin", () => {
  it("registers replay and authorized-import, not live signup", async () => {
    const ctx = createToolkit({ dbPath: ":memory:" });
    await pipelinePlugin.apply(ctx);
    const tools = ctx.jobs.list();
    expect(tools).toEqual(
      expect.arrayContaining(["replay", "authorized-import", "replenish", "mail-inbox"]),
    );
    expect(tools.some((name) => /signup|register-account/i.test(name))).toBe(false);
  });

  it("replays fixture jobs into the event log", async () => {
    const ctx = createToolkit({ dbPath: ":memory:" });
    await pipelinePlugin.apply(ctx);
    const result = await ctx.jobs.run("replay", {
      jobs: [{ type: "mail.received", payload: { id: "m-1" } }],
    });
    expect(result.ok).toBe(true);
    expect(ctx.events.list().map((event) => event.type)).toContain("mail.received");
  });

  it("imports authorized inventory rows into the marketplace pool", async () => {
    const ctx = createToolkit({ dbPath: ":memory:" });
    await marketplacePlugin.apply(ctx);
    await pipelinePlugin.apply(ctx);
    const result = await ctx.jobs.run("authorized-import", {
      items: [{ id: "inv-local-1", account: "local@example.com", plan: "Plus" }],
    });
    expect(result.ok).toBe(true);
    expect(ctx.events.list().some((event) => event.type === "inventory.imported")).toBe(true);
    const workspace = ctx.seams.consume("marketplace") as WorkspaceService;
    expect(workspace.inventory().some((item) => item.id === "inv-local-1")).toBe(true);
  });

  it("receives fixture mailbox messages into the event log", async () => {
    const ctx = createToolkit({ dbPath: ":memory:" });
    await pipelinePlugin.apply(ctx);
    const result = await ctx.jobs.run("mail-inbox", {});
    expect(result.ok).toBe(true);
    expect(ctx.events.list().some((event) => event.type === "mail.received")).toBe(true);
  });
});
