// 与 inventory-core 同形的类型一律从核心派生，禁止手写影子副本：
// schema 漂移时在编译期暴露。InventoryItem/PurchaseOrder 的可选字段宽化是
// 有意的 API 投影防腐层，保持手写。
import type { Wallet as CoreWallet } from "@ggbdpq/inventory-core";
import type { AutoRule as CoreAutoRule, MarketQuote as CoreMarketQuote } from "@ggbdpq/inventory-core";

export type Wallet = CoreWallet;

export type AutoRule = CoreAutoRule;

export type PlanCard = {
  plan: string;
  stock: number;
  minPriceCents: number | null;
  maxPriceCents: number | null;
  merchantCount: number;
};

export type Merchant = {
  id: string;
  name: string;
  plan: string;
  stock: number;
  minPriceCents: number;
  maxPriceCents: number;
  sample: number;
  risk: string;
  decision: string;
};

export type InventoryItem = {
  id: string;
  account: string;
  plan: string;
  status: string;
  checkStatus?: string;
  supplierName?: string;
  supplierId?: string;
  priceCents?: number;
};

export type PurchaseOrder = {
  id: string;
  account: string;
  plan: string;
  status: string;
  supplierName?: string;
  amountCents?: number;
  settlementStatus?: string;
  pushStatus?: string;
  createdAt?: string;
};

export type WorkspaceSummary = {
  wallet: Wallet;
  plans: PlanCard[];
  merchants: Merchant[];
  latestOrders: PurchaseOrder[];
  autoRule: AutoRule;
};

export type PurchaseEstimate = {
  complete: boolean;
  matchedQuantity: number;
  totalCents: number;
  missingQuantity: number;
  shortfallCents: number;
  reason: string | null;
};

export type LedgerEntry = {
  id: string;
  type: string;
  amountCents: number;
  balanceAfterCents: number;
  createdAt?: string;
};

export type AutoRun = {
  id: string;
  status: string;
  purchasedCount: number;
  message: string;
  createdAt?: string;
};

export type MarketQuote = CoreMarketQuote;

export type ReplenishPreview = {
  rule: AutoRule;
  healthyCount: number;
  quotes: MarketQuote[];
  plan: {
    action: "buy" | "skipped" | "blocked";
    reason: string | null;
    quantity: number;
  };
};

export const WORKSPACE_PLANS = [
  "Plus",
  "Pro",
  "Team",
  "BugTeam",
  "K12",
  "Grok Free",
  "GrokPro",
  "Free",
] as const;
