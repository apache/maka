import { describe, expect, it } from "vitest";

import { WorkspaceService } from "./workspace";

describe("workspace service", () => {
  it("exposes autoRule on the buyer summary", () => {
    const workspace = new WorkspaceService();
    expect(workspace.summary().autoRule).toMatchObject({
      enabled: true,
      plan: "Plus",
      threshold: 3,
      target: 4,
      maxAccountsPerRun: 2,
      maxUnitPriceCents: 1600,
    });
  });

  it("credits a local deposit into the wallet and ledger", () => {
    const workspace = new WorkspaceService();
    const result = workspace.deposit(20000);
    expect(result.ok).toBe(true);
    expect(result.wallet.availableCents).toBe(74600);
    expect(workspace.ledgers()[0]).toMatchObject({
      type: "recharge",
      amountCents: 20000,
      balanceAfterCents: 74600,
    });
  });

  it("rejects non-positive deposits", () => {
    const workspace = new WorkspaceService();
    expect(workspace.deposit(0).ok).toBe(false);
    expect(workspace.state.wallet.availableCents).toBe(54600);
  });

  it("imports authorized accounts into the healthy pool", () => {
    const workspace = new WorkspaceService();
    const imported = workspace.importAuthorized([
      { id: "inv-local-1", account: "local@example.com", plan: "Plus" },
    ]);
    expect(imported).toHaveLength(1);
    expect(workspace.inventory().find((item) => item.id === "inv-local-1")).toMatchObject({
      account: "local@example.com",
      plan: "Plus",
      status: "pool",
      checkStatus: "healthy",
      supplierName: "授权导入",
    });
  });

  it("skips duplicate authorized import ids", () => {
    const workspace = new WorkspaceService();
    expect(
      workspace.importAuthorized([{ id: "inv-001", account: "dup@example.com", plan: "Plus" }]),
    ).toHaveLength(0);
    expect(workspace.inventory().filter((item) => item.id === "inv-001")).toHaveLength(1);
  });
});
