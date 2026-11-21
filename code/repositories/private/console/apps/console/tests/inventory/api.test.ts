import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 库存域契约测试：直接调用 Route Handler（fixture 数据，无网络依赖）。
type Ctx<P = Record<string, string>> = { params: Promise<P> };

let workspaceSummary: () => Promise<Response>;
let workspaceInventory: () => Promise<Response>;
let workspaceOrders: (req: Request) => Promise<Response>;
let estimate: (req: Request) => Promise<Response>;
let batch: (req: Request) => Promise<Response>;
let deposit: (req: Request) => Promise<Response>;
let ledgers: () => Promise<Response>;
let replenishPreview: () => Promise<Response>;
let catalogProducts: () => Promise<Response>;
let catalogHistory: (req: Request, ctx: Ctx<{ id: string }>) => Promise<Response>;
let mailMessages: () => Promise<Response>;
let jobs: () => Promise<Response>;
let jobsRun: (req: Request) => Promise<Response>;
let events: () => Promise<Response>;

const json = (body: unknown) =>
  new Request("http://localhost:3000/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  const w = (n: string) => import(`@/app/api/inventory/workspace/${n}/route`);
  workspaceSummary = (await w("summary")).GET;
  workspaceInventory = (await w("inventory")).GET;
  workspaceOrders = (await w("orders")).GET;
  estimate = (await w("extractions/estimate")).POST;
  batch = (await w("extractions/batch")).POST;
  deposit = (await w("funds/deposit")).POST;
  ledgers = (await w("ledgers")).GET;
  replenishPreview = (await w("replenish/preview")).GET;
  catalogProducts = (await import("@/app/api/inventory/catalog/products/route")).GET;
  catalogHistory = (await import("@/app/api/inventory/catalog/products/[id]/history/route")).GET;
  mailMessages = (await import("@/app/api/inventory/mail/messages/route")).GET;
  jobs = (await import("@/app/api/inventory/jobs/route")).GET;
  jobsRun = (await import("@/app/api/inventory/jobs/run/route")).POST;
  events = (await import("@/app/api/inventory/events/route")).GET;
});

describe("库存域 workspace 契约", () => {
  it("summary 返回钱包与库存结构", async () => {
    const body = (await workspaceSummary().then((r) => r.json())) as {
      wallet: { availableCents: number };
    };
    expect(typeof body.wallet.availableCents).toBe("number");
  });

  it("inventory 返回数组", async () => {
    const body = (await workspaceInventory().then((r) => r.json())) as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  it("orders 支持状态过滤查询参数", async () => {
    const res = await workspaceOrders(
      new Request("http://localhost:3000/api/inventory/workspace/orders?status=all&query="),
    );
    expect(res.status).toBe(200);
  });

  it("estimatePurchase 校验请求体并返回估价", async () => {
    const ok = await estimate(json({ quantity: 2, plan: "basic" }));
    expect(ok.status).toBe(200);
    const bad = await estimate(json({ quantity: 0 }));
    expect(bad.status).toBe(400);
    const err = (await bad.json()) as { code: string };
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  it("purchase 创建订单并更新库存与钱包", async () => {
    const before = (await workspaceSummary().then((r) => r.json())) as {
      wallet: { availableCents: number };
    };
    const res = await batch(json({ quantity: 1, plan: "basic" }));
    expect(res.status).toBe(200);
    const after = (await workspaceSummary().then((r) => r.json())) as {
      wallet: { availableCents: number };
    };
    expect(after.wallet.availableCents).toBeLessThanOrEqual(before.wallet.availableCents);
  });

  it("deposit 校验并入账", async () => {
    const before = (await workspaceSummary().then((r) => r.json())) as {
      wallet: { availableCents: number };
    };
    const res = await deposit(json({ amountCents: 1000 }));
    expect(res.status).toBe(200);
    const after = (await workspaceSummary().then((r) => r.json())) as {
      wallet: { availableCents: number };
    };
    expect(after.wallet.availableCents).toBe(before.wallet.availableCents + 1000);
    const bad = await deposit(json({ amountCents: -1 }));
    expect(bad.status).toBe(400);
  });

  it("ledgers 与 replenish/preview 返回结构", async () => {
    const l = (await ledgers().then((r) => r.json())) as { ledgers: unknown[] };
    expect(Array.isArray(l.ledgers)).toBe(true);
    const p = await replenishPreview();
    expect(p.status).toBe(200);
  });
});

describe("库存域 catalog / mail / jobs / events 契约", () => {
  it("catalog products 返回 fixture 商品页", async () => {
    const body = (await catalogProducts().then((r) => r.json())) as {
      totalProducts: number;
      products: unknown[];
      shops: unknown[];
    };
    expect(body.totalProducts).toBeGreaterThan(0);
    expect(body.products.length).toBeGreaterThan(0);
  });

  it("catalog history 不存在返回 404", async () => {
    const res = await catalogHistory(new Request("http://localhost:3000/x"), {
      params: Promise.resolve({ id: "no-such-id" }),
    });
    expect(res.status).toBe(404);
    const err = (await res.json()) as { code: string };
    expect(err.code).toBe("NOT_FOUND");
  });

  it("mail fixture 收件箱可列出消息", async () => {
    const body = (await mailMessages().then((r) => r.json())) as {
      messages: Array<{ id: string }>;
    };
    expect(body.messages.length).toBeGreaterThan(0);
  });

  it("jobs 列出工具且 run 执行回放任务", async () => {
    const list = (await jobs().then((r) => r.json())) as { tools: string[] };
    expect(list.tools.length).toBeGreaterThan(0);
    const res = await jobsRun(json({ name: "replay", input: { jobs: [{ type: "replay.sample", payload: { source: "fixture" } }] } }));
    expect(res.status).toBe(200);
    const evts = (await events().then((r) => r.json())) as { events: Array<{ type: string }> };
    expect(evts.events.length).toBeGreaterThan(0);
  });
});

afterAll(async () => {
  // 内存库无文件句柄，无需清理；占位保持对称。
});
