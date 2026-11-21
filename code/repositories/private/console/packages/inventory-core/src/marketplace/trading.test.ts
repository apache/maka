import { describe, expect, it } from "vitest";

import {
  averageInventoryPriceCents,
  estimatePurchase,
  filterInventory,
  filterOrders,
  settlementSummary,
} from "./trading";
import type { InventoryItem, PurchaseOrder } from "./schemas";

const inventory: InventoryItem[] = [
  {
    id: "i-1",
    supplierId: "s-low",
    supplierName: "低价商家",
    account: "alpha@example.com",
    plan: "Plus",
    status: "pool",
    checkStatus: "healthy",
    priceCents: 1320,
  },
  {
    id: "i-2",
    supplierId: "s-stable",
    supplierName: "稳定商家",
    account: "beta@example.com",
    plan: "Plus",
    status: "pool",
    checkStatus: "healthy",
    priceCents: 1500,
  },
  {
    id: "i-3",
    supplierId: "s-risk",
    supplierName: "异常商家",
    account: "gamma@example.com",
    plan: "Plus",
    status: "pool",
    checkStatus: "failed",
    priceCents: 1000,
  },
];

const orders: PurchaseOrder[] = [
  {
    id: "o-1",
    account: "alpha@example.com",
    supplierName: "低价商家",
    plan: "Plus",
    amountCents: 1320,
    status: "active",
    settlementStatus: "warranty_locked",
    pushStatus: "pending",
    createdAt: "2026-07-29T12:00:00+08:00",
  },
  {
    id: "o-2",
    account: "beta@example.com",
    supplierName: "稳定商家",
    plan: "Plus",
    amountCents: 1500,
    status: "invalid",
    settlementStatus: "payable",
    pushStatus: "relay_pushed",
    createdAt: "2026-07-28T12:00:00+08:00",
  },
];

describe("trading domain", () => {
  it("estimates cheapest healthy Plus inventory within budget", () => {
    const estimate = estimatePurchase({
      inventory,
      quantity: 2,
      plan: "Plus",
      maxUnitPriceCents: 1600,
      walletBalanceCents: 5000,
    });

    expect(estimate.complete).toBe(true);
    expect(estimate.totalCents).toBe(2820);
    expect(estimate.matchedQuantity).toBe(2);
    expect(estimate.items.map((item) => item.id)).toEqual(["i-1", "i-2"]);
  });

  it("averages filtered inventory prices in cents", () => {
    expect(averageInventoryPriceCents(inventory.slice(0, 2))).toBe(1410);
    expect(averageInventoryPriceCents([])).toBe(0);
  });

  it("filters inventory by plan, status, and supplier text", () => {
    const sold = { ...inventory[0], id: "i-sold", status: "sold" };
    const rows = filterInventory([...inventory, sold], {
      plan: "Plus",
      status: "pool",
      query: "低价",
    });
    expect(rows.map((item) => item.id)).toEqual(["i-1"]);
  });

  it("filters orders by status and fuzzy supplier text", () => {
    expect(filterOrders(orders, { status: "invalid", query: "稳定" }).map((order) => order.id)).toEqual([
      "o-2",
    ]);
  });

  it("summarizes payable and warranty locked amounts", () => {
    expect(settlementSummary(orders)).toMatchObject({
      payableCents: 1500,
      warrantyLockedCents: 1320,
    });
  });
});
