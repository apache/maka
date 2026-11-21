import { estimatePurchase, filterOrders, settlementSummary } from "./trading";
import type { InventoryItem, PurchaseOrder } from "./schemas";

export type Wallet = {
  availableCents: number;
  frozenCents: number;
};

export type WorkspaceState = {
  wallet: Wallet;
  inventory: InventoryItem[];
  orders: PurchaseOrder[];
  ledgers: Array<Record<string, unknown>>;
  autoRuns: Array<Record<string, unknown>>;
  autoRule: {
    enabled: boolean;
    plan: string;
    threshold: number;
    target: number;
    maxAccountsPerRun: number;
    maxUnitPriceCents: number;
  };
  merchants: Array<Record<string, unknown>>;
};

const centsOf = (value: InventoryItem) => value.priceCents ?? value.price_cents ?? 0;

export function createSeedState(): WorkspaceState {
  return {
    wallet: { availableCents: 54600, frozenCents: 0 },
    inventory: [
      {
        id: "inv-001",
        supplierId: "s-tlw",
        supplierName: "铜锣湾",
        account: "alicia.market@example.com",
        plan: "Plus",
        status: "pool",
        checkStatus: "healthy",
        priceCents: 1320,
      },
      {
        id: "inv-002",
        supplierId: "s-mkb",
        supplierName: "makabaka",
        account: "bruno.pool@example.com",
        plan: "Plus",
        status: "pool",
        checkStatus: "healthy",
        priceCents: 1500,
      },
      {
        id: "inv-003",
        supplierId: "s-ng",
        supplierName: "ngcoffee",
        account: "cora.stock@example.com",
        plan: "Plus",
        status: "pool",
        checkStatus: "failed",
        priceCents: 1200,
      },
      {
        id: "inv-004",
        supplierId: "s-k12",
        supplierName: "k12-store",
        account: "edu01@example.com",
        plan: "K12",
        status: "pool",
        checkStatus: "healthy",
        priceCents: 85,
      },
    ],
    orders: [
      {
        id: "ord-202607201158-1",
        account: "WilliamCarter63625@hotmail.com",
        supplierName: "ngcoffee",
        plan: "Plus",
        amountCents: 100,
        status: "refunded",
        settlementStatus: "refunded",
        pushStatus: "relay_push_attention",
        createdAt: "2026-07-20T11:58:51+08:00",
      },
      {
        id: "ord-202607201138-2",
        account: "leventervitorino58@outlook.com",
        supplierName: "铜锣湾",
        plan: "Plus",
        amountCents: 98,
        status: "invalid",
        settlementStatus: "settled",
        pushStatus: "relay_pushed",
        createdAt: "2026-07-20T11:38:25+08:00",
      },
    ],
    ledgers: [],
    autoRuns: [],
    autoRule: {
      enabled: true,
      plan: "Plus",
      threshold: 3,
      target: 4,
      maxAccountsPerRun: 2,
      maxUnitPriceCents: 1600,
    },
    merchants: [
      {
        id: "s-ng",
        name: "ngcoffee",
        plan: "Plus",
        stock: 10,
        minPriceCents: 1800,
        maxPriceCents: 1800,
        sample: 194,
        risk: "低",
        decision: "稳定可买",
      },
      {
        id: "s-tlw",
        name: "铜锣湾",
        plan: "Plus",
        stock: 3,
        minPriceCents: 1489,
        maxPriceCents: 1489,
        sample: 125,
        risk: "低",
        decision: "稳定可买",
      },
    ],
  };
}

function nowId() {
  return new Date().toISOString().replaceAll(/[-:TZ.]/g, "").slice(0, 20);
}

export class WorkspaceService {
  state: WorkspaceState;

  constructor(state?: WorkspaceState) {
    this.state = state ?? createSeedState();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  summary() {
    return {
      wallet: this.state.wallet,
      plans: this.planCards(),
      merchants: this.state.merchants,
      latestOrders: this.state.orders.slice(0, 8),
      autoRule: this.state.autoRule,
    };
  }

  ledgers() {
    return this.state.ledgers;
  }

  deposit(amountCents: number) {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return { ok: false as const, reason: "invalid_amount", wallet: this.state.wallet };
    }
    this.state.wallet.availableCents += amountCents;
    this.state.ledgers.unshift({
      id: `ledger-${nowId()}`,
      type: "recharge",
      amountCents,
      balanceAfterCents: this.state.wallet.availableCents,
      createdAt: new Date().toISOString(),
    });
    return { ok: true as const, wallet: this.state.wallet };
  }

  inventory() {
    return this.state.inventory;
  }

  importAuthorized(items: Array<{ id: string; account: string; plan: string; priceCents?: number }>) {
    const imported: InventoryItem[] = [];
    for (const item of items) {
      if (this.state.inventory.some((existing) => existing.id === item.id)) {
        continue;
      }
      const row: InventoryItem = {
        id: item.id,
        account: item.account,
        plan: item.plan,
        status: "pool",
        checkStatus: "healthy",
        supplierName: "授权导入",
        supplierId: "s-authorized",
        priceCents: item.priceCents,
      };
      this.state.inventory.push(row);
      imported.push(row);
    }
    return imported;
  }

  orders(status = "all", query = "") {
    return filterOrders(this.state.orders, { status, query });
  }

  estimatePurchase(input: { quantity: number; plan: string; maxUnitPriceCents: number | null }) {
    return estimatePurchase({
      inventory: this.state.inventory,
      quantity: input.quantity,
      plan: input.plan,
      maxUnitPriceCents: input.maxUnitPriceCents,
      walletBalanceCents: this.state.wallet.availableCents,
    });
  }

  purchase(input: { quantity: number; plan: string; maxUnitPriceCents: number | null }) {
    const estimate = this.estimatePurchase(input);
    if (!estimate.complete) {
      return { ok: false, estimate, orderIds: [] as string[] };
    }

    const orderIds: string[] = [];
    const createdAt = new Date().toISOString();
    for (const item of estimate.items) {
      const inventoryItem = this.state.inventory.find((candidate) => candidate.id === item.id);
      if (!inventoryItem) continue;
      inventoryItem.status = "sold";
      const orderId = `ord-${nowId()}-${orderIds.length + 1}`;
      orderIds.push(orderId);
      this.state.orders.unshift({
        id: orderId,
        account: inventoryItem.account,
        supplierName: inventoryItem.supplierName,
        plan: inventoryItem.plan,
        amountCents: centsOf(inventoryItem),
        status: "active",
        settlementStatus: "warranty_locked",
        pushStatus: "pending",
        createdAt,
      });
    }
    this.state.wallet.availableCents -= estimate.totalCents;
    this.state.ledgers.unshift({
      id: `ledger-${nowId()}`,
      type: "purchase",
      amountCents: -estimate.totalCents,
      balanceAfterCents: this.state.wallet.availableCents,
      refId: orderIds.join(","),
      createdAt,
    });
    return { ok: true, estimate, orderIds };
  }

  runAutoReplenish() {
    const rule = this.state.autoRule;
    const healthyCount = this.healthyPoolCount(rule.plan);
    if (!rule.enabled || healthyCount >= rule.threshold) {
      const run = {
        id: `auto-${nowId()}`,
        status: "skipped",
        purchasedCount: 0,
        message: `当前库存 ${healthyCount} 个，未触发`,
        createdAt: new Date().toISOString(),
      };
      this.state.autoRuns.unshift(run);
      return run;
    }
    const quantity = Math.min(rule.target - healthyCount, rule.maxAccountsPerRun);
    const purchase = this.purchase({
      quantity,
      plan: rule.plan,
      maxUnitPriceCents: rule.maxUnitPriceCents,
    });
    const run = {
      id: `auto-${nowId()}`,
      status: purchase.ok ? "replenished" : "failed",
      purchasedCount: purchase.orderIds.length,
      message: purchase.ok ? `已补入 ${purchase.orderIds.length} 个账号` : "补池失败",
      createdAt: new Date().toISOString(),
    };
    this.state.autoRuns.unshift(run);
    return run;
  }

  settlementSummary() {
    return settlementSummary(this.state.orders);
  }

  healthyPoolCount(plan: string) {
    return this.state.inventory.filter(
      (item) =>
        item.plan === plan &&
        item.status === "pool" &&
        ["healthy", "unchecked"].includes(item.checkStatus ?? item.check_status ?? "unchecked"),
    ).length;
  }

  private planCards() {
    return ["Plus", "Pro", "Team", "BugTeam", "K12", "Grok Free", "GrokPro", "Free"].map((plan) => {
      const items = this.state.inventory.filter(
        (item) =>
          item.plan === plan &&
          item.status === "pool" &&
          ["healthy", "unchecked"].includes(item.checkStatus ?? item.check_status ?? "unchecked"),
      );
      const prices = items.map(centsOf);
      return {
        plan,
        stock: items.length,
        minPriceCents: prices.length ? Math.min(...prices) : null,
        maxPriceCents: prices.length ? Math.max(...prices) : null,
        merchantCount: new Set(items.map((item) => item.supplierId ?? item.supplier_id)).size,
      };
    });
  }
}
