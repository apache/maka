import type { Toolkit } from "../index";
import { WorkspaceService } from "../marketplace/workspace";

export type CatalogProductLike = {
  duplicate_hidden: boolean;
  status: string;
  title: string;
  category: string;
  shop_name: string;
  price_text: string;
};

export type AutoRule = WorkspaceService["state"]["autoRule"];

export type MarketQuote = {
  title: string;
  shopName: string;
  priceCents: number;
  withinBudget: boolean;
};

export type ReplenishPlan = {
  action: "buy" | "skipped" | "blocked";
  reason: string | null;
  quantity: number;
  healthyCount: number;
  bestQuote: MarketQuote | null;
};

export function parsePriceCents(priceText: string): number {
  const match = priceText.replace(/,/g, "").match(/[\d.]+/);
  if (!match) return 0;
  return Math.round(Number(match[0]) * 100);
}

export function quoteMarketPrices(
  products: CatalogProductLike[],
  { plan, maxUnitPriceCents }: { plan: string; maxUnitPriceCents: number },
): MarketQuote[] {
  const needle = plan.toLowerCase();
  return products
    .filter((product) => !product.duplicate_hidden)
    .filter((product) => product.status.includes("在售"))
    .filter((product) => `${product.title} ${product.category}`.toLowerCase().includes(needle))
    .map((product) => {
      const priceCents = parsePriceCents(product.price_text);
      return {
        title: product.title,
        shopName: product.shop_name,
        priceCents,
        withinBudget: priceCents > 0 && priceCents <= maxUnitPriceCents,
      };
    })
    .filter((quote) => quote.priceCents > 0)
    .toSorted((left, right) => left.priceCents - right.priceCents);
}

export function planReplenish({
  healthyCount,
  rule,
  quotes,
}: {
  healthyCount: number;
  rule: AutoRule;
  quotes: MarketQuote[];
}): ReplenishPlan {
  const inBudget = quotes.filter((quote) => quote.withinBudget);
  const bestQuote = inBudget[0] ?? quotes[0] ?? null;

  if (!rule.enabled) {
    return { action: "skipped", reason: "disabled", quantity: 0, healthyCount, bestQuote };
  }
  if (healthyCount >= rule.threshold) {
    return { action: "skipped", reason: "stock_ok", quantity: 0, healthyCount, bestQuote };
  }
  if (!bestQuote?.withinBudget) {
    return { action: "blocked", reason: "no_quote_in_budget", quantity: 0, healthyCount, bestQuote };
  }

  const quantity = Math.min(rule.target - healthyCount, rule.maxAccountsPerRun, inBudget.length);
  return { action: "buy", reason: null, quantity, healthyCount, bestQuote };
}

function readLoop(toolkit: Toolkit) {
  const catalog = toolkit.seams.consume("catalog") as {
    listProducts: () => CatalogProductLike[];
  };
  const workspace = toolkit.seams.consume("marketplace") as WorkspaceService;
  return { catalog, workspace };
}

export function previewReplenish(toolkit: Toolkit) {
  const { catalog, workspace } = readLoop(toolkit);
  const rule = workspace.state.autoRule;
  const quotes = quoteMarketPrices(catalog.listProducts(), {
    plan: rule.plan,
    maxUnitPriceCents: rule.maxUnitPriceCents,
  });
  const healthyCount = workspace.healthyPoolCount(rule.plan);
  const plan = planReplenish({ healthyCount, rule, quotes });
  return {
    rule,
    healthyCount,
    quotes: quotes.slice(0, 12),
    plan,
  };
}

export function executeReplenish(toolkit: Toolkit) {
  const preview = previewReplenish(toolkit);
  toolkit.events.append({
    type: "catalog.quoted",
    payload: { plan: preview.rule.plan, quotes: preview.quotes },
  });
  toolkit.events.append({
    type: "marketplace.budget.checked",
    payload: preview.plan,
  });

  if (preview.plan.action !== "buy") {
    toolkit.events.append({ type: "replenish.skipped", payload: preview.plan });
    return { ok: true, plan: preview.plan, purchase: null };
  }

  const workspace = toolkit.seams.consume("marketplace") as WorkspaceService;
  const purchase = workspace.purchase({
    quantity: preview.plan.quantity,
    plan: preview.rule.plan,
    maxUnitPriceCents: preview.rule.maxUnitPriceCents,
  });
  toolkit.events.append({
    type: purchase.ok ? "replenish.executed" : "replenish.failed",
    payload: { plan: preview.plan, purchase },
  });
  return { ok: purchase.ok, plan: preview.plan, purchase };
}
