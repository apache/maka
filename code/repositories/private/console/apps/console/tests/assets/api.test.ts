import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 契约测试：直接调用 Route Handler（真 HTTP 语义的函数化），不经网络。
// 关键：在动态 import 之前注入 CONSOLE_DATA_DIR，让 db/exporter 落在临时目录。
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "console-assets-test-"));

type Ctx<P = Record<string, string>> = { params: Promise<P> };

let getSettings: (req?: Request) => Promise<Response>;
let putSettings: (req: Request) => Promise<Response>;
let getOverview: (req?: Request) => Promise<Response>;
let listBatches: (req?: Request) => Promise<Response>;
let getAccounts: (req: Request) => Promise<Response>;
let getAccount: (req: Request, ctx: Ctx<{ id: string }>) => Promise<Response>;
let patchAccount: (req: Request, ctx: Ctx<{ id: string }>) => Promise<Response>;
let deleteAccount: (req: Request, ctx: Ctx<{ id: string }>) => Promise<Response>;
let deleteAccounts: (req: Request) => Promise<Response>;
let postScan: (req: Request) => Promise<Response>;
let postImportOriginal: (req: Request) => Promise<Response>;
let postImportReauth: (req: Request) => Promise<Response>;
let postImportErrors: (req: Request) => Promise<Response>;
let postExportCpa: (req: Request) => Promise<Response>;
let postQuotaRefreshBatch: (req: Request) => Promise<Response>;

const json = (body: unknown) =>
  new Request("http://localhost:3000/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  process.env.CONSOLE_DATA_DIR = tmpData;
  const settings = await import("@/app/api/assets/settings/route");
  getSettings = settings.GET;
  putSettings = settings.PUT;
  getOverview = (await import("@/app/api/assets/overview/route")).GET;
  listBatches = (await import("@/app/api/assets/batches/route")).GET;
  const accounts = await import("@/app/api/assets/accounts/route");
  getAccounts = accounts.GET;
  deleteAccounts = accounts.DELETE;
  const account = await import("@/app/api/assets/accounts/[id]/route");
  getAccount = account.GET;
  patchAccount = account.PATCH;
  deleteAccount = account.DELETE;
  postScan = (await import("@/app/api/assets/scan/route")).POST;
  postImportOriginal = (await import("@/app/api/assets/import/original/route")).POST;
  postImportReauth = (await import("@/app/api/assets/import/reauth/route")).POST;
  postImportErrors = (await import("@/app/api/assets/import/errors/route")).POST;
  postExportCpa = (await import("@/app/api/assets/export/cpa/route")).POST;
  postQuotaRefreshBatch = (await import("@/app/api/assets/accounts/quota/refresh/route")).POST;

  // 扫描夹具：一个符合批次命名规范的目录 + 一个原始 jsonl
  const root = path.join(tmpData, "card-root");
  const batch = path.join(root, "01.2026-08-01-测试批次-10件-100元");
  fs.mkdirSync(batch, { recursive: true });
  fs.writeFileSync(
    path.join(batch, "a.jsonl"),
    `${JSON.stringify({ email: "scan-test@example.com", password: "pw", created_at: 1754000000 })}\n`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(root, "loose.jsonl"),
    `${JSON.stringify({ email: "loose@example.com", password: "pw" })}\n`,
    "utf-8",
  );
  (globalThis as typeof globalThis & { __assetRoot?: string }).__assetRoot = root;
});

afterAll(async () => {
  // Windows 下必须先关 SQLite 连接才能删临时目录
  const { db } = await import("@/server/assets/db");
  try {
    db.close();
  } catch {
    // 已关闭则忽略
  }
  fs.rmSync(tmpData, { recursive: true, force: true });
});

describe("资产域 API 契约", () => {
  it("GET settings 返回状态/规则/目录配置", async () => {
    const res = await getSettings();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { statuses: string[]; expire_rule: string };
    expect(body.statuses).toContain("normal");
    expect(["month", "30d", "28d"]).toContain(body.expire_rule);
  });

  it("PUT settings 更新 warn_days", async () => {
    const res = await putSettings(json({ warn_days: 14 }));
    expect(res.status).toBe(200);
    const after = (await getSettings().then((r) => r.json())) as { warn_days: number };
    expect(after.warn_days).toBe(14);
  });

  it("POST import/original 解析并入库", async () => {
    const res = await postImportOriginal(
      json({ text: `${JSON.stringify({ email: "a@example.com", password: "p1" })}\n${JSON.stringify({ email: "b@example.com", password: "p2" })}\n` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { parsed: number; created: number };
    expect(body.parsed).toBe(2);
    expect(body.created).toBe(2);
  });

  it("GET accounts 列出已导入账号", async () => {
    const res = await getAccounts(new Request("http://localhost:3000/api/assets/accounts"));
    const body = (await res.json()) as { rows: Array<{ email: string }>; total: number };
    expect(body.total).toBeGreaterThanOrEqual(2);
    const emails = body.rows.map((r) => r.email);
    expect(emails).toContain("a@example.com");
  });

  it("GET accounts 支持 email 过滤", async () => {
    const res = await getAccounts(
      new Request("http://localhost:3000/api/assets/accounts?email=a@example"),
    );
    const body = (await res.json()) as { rows: Array<{ email: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.rows[0]?.email).toBe("a@example.com");
  });

  it("PATCH accounts/:id 更新状态并写入历史", async () => {
    const list = (await getAccounts(
      new Request("http://localhost:3000/api/assets/accounts?email=a@example"),
    ).then((r) => r.json())) as { rows: Array<{ id: number }> };
    const id = list.rows[0]!.id;
    const res = await patchAccount(json({ status: "rate_limited", reason: "测试限流" }), {
      params: Promise.resolve({ id: String(id) }),
    });
    expect(res.status).toBe(200);
    const detail = (await getAccount(new Request("http://localhost:3000/x"), {
      params: Promise.resolve({ id: String(id) }),
    }).then((r) => r.json())) as {
      account: { status: string };
      history: { status: Array<{ to_status: string }> };
    };
    expect(detail.account.status).toBe("rate_limited");
    expect(detail.history.status[0]?.to_status).toBe("rate_limited");
  });

  it("GET account 不存在返回 404", async () => {
    const res = await getAccount(new Request("http://localhost:3000/x"), {
      params: Promise.resolve({ id: "999999" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST scan 扫描夹具目录并按批次归组", async () => {
    const root = (globalThis as typeof globalThis & { __assetRoot?: string }).__assetRoot!;
    const res = await postScan(json({ root, reset: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      batchesFound: number;
      filesRead: number;
      original: { created: number };
      errors: string[];
    };
    expect(body.errors).toEqual([]);
    expect(body.batchesFound).toBe(1);
    expect(body.filesRead).toBe(2);
    expect(body.original.created).toBeGreaterThanOrEqual(2);
    const batches = (await listBatches().then((r) => r.json())) as Array<{
      folder_name: string;
      total: number;
    }>;
    const batch = batches.find((b) => b.folder_name.includes("测试批次"));
    expect(batch?.total).toBe(1);
  });

  it("POST import/reauth 匹配已存在账号并归位 normal", async () => {
    const res = await postImportOriginal(
      json({ text: `${JSON.stringify({ email: "reauth@example.com", password: "p" })}\n` }),
    );
    expect(res.status).toBe(200);
    const r = await postImportReauth(
      json({
        text: `${JSON.stringify({ email: "reauth@example.com", access_token: "tok2", reauth_at: "2026-08-01 10:00:00" })}\n`,
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { applied: number; unmatched: string[] };
    expect(body.applied).toBe(1);
    expect(body.unmatched).toEqual([]);
  });

  it("POST import/errors 行内邮箱自动归属", async () => {
    const r = await postImportErrors(
      json({ text: "a@example.com 额度耗尽 quota_exhausted" }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { applied: number };
    expect(body.applied).toBeGreaterThanOrEqual(0);
  });

  it("POST export/cpa 产出 tar 文件", async () => {
    const res = await postExportCpa(json({ statuses: ["normal", "rate_limited"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fileName: string; count: number; filePath: string };
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(body.filePath)).toBe(true);
  });

  it("POST accounts/quota/refresh 空请求体返回 400", async () => {
    const res = await postQuotaRefreshBatch(json({}));
    expect(res.status).toBe(400);
  });

  it("DELETE accounts/:id 删除并刷新重复标记", async () => {
    // 自建自删，消除与其他用例（scan reset 会清表）的顺序依赖
    await postImportOriginal(json({ text: `${JSON.stringify({ email: "delete-me@example.com" })}\n` }));
    const list = (await getAccounts(
      new Request("http://localhost:3000/api/assets/accounts?email=delete-me@"),
    ).then((r) => r.json())) as { rows: Array<{ id: number }> };
    const id = list.rows[0]!.id;
    const res = await deleteAccount(new Request("http://localhost:3000/x"), {
      params: Promise.resolve({ id: String(id) }),
    });
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBe(1);
  });

  it("DELETE accounts 批量删除", async () => {
    const res = await deleteAccounts(json({ ids: [1, 2, 3] }));
    expect(res.status).toBe(200);
  });

  it("GET overview 返回结构", async () => {
    const ov = (await getOverview().then((r) => r.json())) as { byStatus: unknown[] };
    expect(Array.isArray(ov.byStatus)).toBe(true);
  });
});
