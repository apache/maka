import type { InventoryItem, PurchaseOrder } from "./schemas";

const centsOf = (value: {
  price_cents?: number;
  priceCents?: number;
  amount_cents?: number;
  amountCents?: number;
}) => value.price_cents ?? value.priceCents ?? value.amount_cents ?? value.amountCents ?? 0;

export function formatMoney(cents: number | null | undefined) {
  if (cents === null || cents === undefined) return "-";
  return `¥${(cents / 100).toFixed(2)}`;
}

export function estimatePurchase({
  inventory,
  quantity,
  plan,
  maxUnitPriceCents,
  walletBalanceCents,
}: {
  inventory: InventoryItem[];
  quantity: number;
  plan: string;
  maxUnitPriceCents: number | null;
  walletBalanceCents: number;
}) {
  const limit = maxUnitPriceCents ?? Number.POSITIVE_INFINITY;
  const items = inventory
    .filter((item) => item.status === "pool")
    .filter((item) => (item.check_status ?? item.checkStatus ?? "unchecked") !== "failed")
    .filter((item) => item.plan === plan)
    .filter((item) => centsOf(item) <= limit)
    .sort((left, right) => centsOf(left) - centsOf(right))
    .slice(0, quantity);
  const totalCents = items.reduce((sum, item) => sum + centsOf(item), 0);
  const missingQuantity = Math.max(0, quantity - items.length);
  const shortfallCents = Math.max(0, totalCents - walletBalanceCents);
  return {
    complete: missingQuantity === 0 && shortfallCents === 0,
    reason: missingQuantity ? "insufficient_inventory" : shortfallCents ? "insufficient_balance" : null,
    items,
    matchedQuantity: items.length,
    totalCents,
    missingQuantity,
    shortfallCents,
  };
}

export function averageInventoryPriceCents(items: InventoryItem[]): number {
  if (items.length === 0) {
    return 0;
  }
  return Math.round(items.reduce((sum, item) => sum + centsOf(item), 0) / items.length);
}

export function filterInventory(
  items: InventoryItem[],
  { plan = "all", status = "all", query = "" }: { plan?: string; status?: string; query?: string } = {},
) {
  const normalized = query.trim().toLowerCase();
  return items.filter((item) => {
    const planOk = plan === "all" || item.plan === plan;
    const statusOk = status === "all" || item.status === status;
    if (!planOk || !statusOk) return false;
    if (!normalized) return true;
    const supplier =
      item.supplierName ?? item.supplier_name ?? item.supplierId ?? item.supplier_id ?? "";
    return [item.id, item.account, supplier, item.plan].join(" ").toLowerCase().includes(normalized);
  });
}

export function filterOrders(
  orders: PurchaseOrder[],
  { status = "all", query = "" }: { status?: string; query?: string },
) {
  const normalized = query.trim().toLowerCase();
  return orders.filter((order) => {
    const orderStatus = order.status;
    const pushStatus = order.push_status ?? order.pushStatus;
    const statusOk = status === "all" || status === orderStatus || status === pushStatus;
    if (!statusOk) return false;
    if (!normalized) return true;
    return [order.id, order.account, order.supplier_name ?? order.supplierName, order.plan]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalized);
  });
}

export function settlementSummary(orders: PurchaseOrder[]) {
  return orders.reduce(
    (summary, order) => {
      const settlementStatus = order.settlement_status ?? order.settlementStatus;
      const amount = centsOf(order);
      if (settlementStatus === "payable") summary.payableCents += amount;
      if (settlementStatus === "warranty_locked") summary.warrantyLockedCents += amount;
      if (settlementStatus === "settled") summary.settledCents += amount;
      return summary;
    },
    { payableCents: 0, warrantyLockedCents: 0, settledCents: 0 },
  );
}
