import { describe, expect, it } from "vitest";

import { createToolkit } from "../index";
import { marketplacePlugin } from "../marketplace/plugin";
import { WorkspaceService } from "../marketplace/workspace";
import { pipelinePlugin } from "./plugin";
import { parsePriceCents, planReplenish, quoteMarketPrices } from "./replenish";

const sampleProducts = [
  {
    duplicate_hidden: false,
    status: "在售",
    title: "ChatGPT Plus 成品号",
    category: "Plus",
    shop_name: "demo-shop",
    price_text: "￥12.50",
  },
  {
    duplicate_hidden: false,
    status: "在售",
    title: "Plus 高价货",
    category: "Plus",
    shop_name: "pricey",
    price_text: "￥20.00",
  },
  {
    duplicate_hidden: true,
    status: "在售",
    title: "Plus 隐藏同名",
    category: "Plus",
    shop_name: "hidden",
    price_text: "￥5.00",
  },
  {
    duplicate_hidden: false,
    status: "下架",
    title: "Plus 已下架",
    category: "Plus",
    shop_name: "off",
    price_text: "￥8.00",
  },
  {
    duplicate_hidden: false,
    status: "在售",
    title: "K12 教育号",
    category: "K12",
    shop_name: "edu",
    price_text: "￥1.00",
  },
  {
    duplicate_hidden: false,
    status: "在售",
    title: "Plus 零元占位",
    category: "Plus",
    shop_name: "zero",
    price_text: "￥0",
  },
];

const rule = {
  enabled: true,
  plan: "Plus",
  threshold: 3,
  target: 4,
  maxAccountsPerRun: 2,
  maxUnitPriceCents: 1600,
};

describe("replenish quotes", () => {
  it("converts price_text to cents", () => {
    expect(parsePriceCents("￥12.50")).toBe(1250);
    expect(parsePriceCents("￥0.3")).toBe(30);
  });

  it("keeps on-sale Plus listings and marks budget fit", () => {
    const quotes = quoteMarketPrices(sampleProducts, {
      plan: "Plus",
      maxUnitPriceCents: 1600,
    });
    expect(quotes.map((quote) => quote.title)).toEqual(["ChatGPT Plus 成品号", "Plus 高价货"]);
    expect(quotes[0]).toMatchObject({
      shopName: "demo-shop",
      priceCents: 1250,
      withinBudget: true,
    });
    expect(quotes[1]?.withinBudget).toBe(false);
  });
});

describe("replenish plan", () => {
  const inBudget = quoteMarketPrices(sampleProducts, {
    plan: "Plus",
    maxUnitPriceCents: 1600,
  });

  it("skips when the auto rule is off", () => {
    expect(
      planReplenish({
        healthyCount: 0,
        rule: { ...rule, enabled: false },
        quotes: inBudget,
      }),
    ).toMatchObject({ action: "skipped", reason: "disabled", quantity: 0 });
  });

  it("skips when the local pool already meets the threshold", () => {
    expect(
      planReplenish({
        healthyCount: 3,
        rule,
        quotes: inBudget,
      }),
    ).toMatchObject({ action: "skipped", reason: "stock_ok", quantity: 0 });
  });

  it("blocks when no listing fits the budget", () => {
    expect(
      planReplenish({
        healthyCount: 1,
        rule,
        quotes: inBudget.filter((quote) => !quote.withinBudget),
      }),
    ).toMatchObject({ action: "blocked", reason: "no_quote_in_budget", quantity: 0 });
  });

  it("buys up to the remaining target, run cap, and in-budget quotes", () => {
    expect(
      planReplenish({
        healthyCount: 2,
        rule,
        quotes: inBudget,
      }),
    ).toMatchObject({
      action: "buy",
      reason: null,
      quantity: 1,
      healthyCount: 2,
    });
  });
});

describe("replenish job", () => {
  async function applyLoop(toolkit = createToolkit({ dbPath: ":memory:" })) {
    await marketplacePlugin.apply(toolkit);
    toolkit.seams.define("catalog");
    toolkit.seams.provide("catalog", {
      source: "fixture",
      listProducts: () => sampleProducts,
    });
    await pipelinePlugin.apply(toolkit);
    return toolkit;
  }

  it("registers replenish without live signup names", async () => {
    const toolkit = await applyLoop();
    expect(toolkit.jobs.list()).toEqual(
      expect.arrayContaining(["replay", "authorized-import", "replenish"]),
    );
    expect(toolkit.jobs.list().some((name) => /signup|register-account/i.test(name))).toBe(false);
  });

  it("quotes catalog, checks budget, then purchases local inventory", async () => {
    const toolkit = await applyLoop();
    const workspace = toolkit.seams.consume("marketplace") as WorkspaceService;
    const before = workspace.healthyPoolCount("Plus");
    const result = await toolkit.jobs.run("replenish", {});
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      result: {
        ok: true,
        plan: { action: "buy", quantity: 1 },
      },
    });
    expect(workspace.healthyPoolCount("Plus")).toBe(before - 1);
    expect(toolkit.events.list().map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "catalog.quoted",
        "marketplace.budget.checked",
        "replenish.executed",
        "job.ran",
      ]),
    );
  });

  it("writes replenish.skipped when the pool is already healthy", async () => {
    const toolkit = await applyLoop();
    const workspace = toolkit.seams.consume("marketplace") as WorkspaceService;
    workspace.state.autoRule.threshold = 1;
    const result = await toolkit.jobs.run("replenish", {});
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      result: { plan: { action: "skipped", reason: "stock_ok" }, purchase: null },
    });
    expect(toolkit.events.list().map((event) => event.type)).toContain("replenish.skipped");
  });
});
