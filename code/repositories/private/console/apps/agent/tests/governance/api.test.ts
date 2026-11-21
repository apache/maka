import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// 治理台契约测试：直接调用 Route Handler。
// 默认扫描 console 仓根及直接子项目；也允许显式设置 GOVERNANCE_ROOT。

let getPrd: (req?: Request) => Promise<Response>;
let getProgress: (req?: Request) => Promise<Response>;
let getSpecs: (req?: Request) => Promise<Response>;
let getGit: (req: Request) => Promise<Response>;

beforeAll(async () => {
  getPrd = (await import("@/app/api/governance/prd/route")).GET;
  getProgress = (await import("@/app/api/governance/progress/route")).GET;
  getSpecs = (await import("@/app/api/governance/specs/route")).GET;
  getGit = (await import("@/app/api/governance/git/route")).GET;
});

describe("治理台 API 契约（吃自己狗粮）", () => {
  it("prd 解析出 扫描根工件，含 console 自身", async () => {
    const res = await getPrd();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      document: {
        items: Array<{ id: string; passes: boolean }>;
        statistics: { total: number; passing: number; failing: number };
      } | null;
      sources: Array<{ project: string; ok: boolean }>;
    };
    expect(body.document, JSON.stringify(body.sources)).not.toBeNull();
    expect(body.sources.some((s) => s.project === "console" && s.ok)).toBe(true);
    expect(body.document!.items.length).toBeGreaterThanOrEqual(9);
    expect(body.document!.statistics.total).toBe(body.document!.items.length);
  });

  it("progress 端点返回 entries 与 warnings 结构", async () => {
    const res = await getProgress();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ project: string; prdId: string; datetime: string | null }>;
      warnings: string[];
      sources: unknown[];
    };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("specs 端点返回 specs 与 warnings 结构", async () => {
    const res = await getSpecs();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { specs: unknown[]; warnings: string[] };
    expect(Array.isArray(body.specs)).toBe(true);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("git 端点返回真实提交历史", async () => {
    const res = await getGit(new Request("http://localhost:3000/api/governance/git?limit=10"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      commits: Array<{ sha: string; author: string; date: string; message: string }>;
      error?: string;
    };
    expect(body.commits.length).toBeGreaterThan(0);
    expect(body.commits[0]!.sha.length).toBeGreaterThan(3);
    expect(new Date(body.commits[0]!.date).getTime()).not.toBeNaN();
  });
});


it("扫描根自身与直接子项目都可提供治理工件", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "governance-root-"));
  const previous = process.env.GOVERNANCE_ROOT;
  const prd = fs.readFileSync(new URL("./unit/fixtures/prd/all-pending.json", import.meta.url));
  for (const dir of [root, path.join(root, "child")]) {
    fs.mkdirSync(path.join(dir, ".ggbdpq"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".ggbdpq", "prd.json"), prd);
  }
  process.env.GOVERNANCE_ROOT = root;
  try {
    const body = await (await getPrd()).json();
    expect(body.sources.map((s: { project: string }) => s.project).sort()).toEqual([path.basename(root), "child"].sort());
    expect(body.document.items).toHaveLength(6);
  } finally {
    if (previous === undefined) delete process.env.GOVERNANCE_ROOT;
    else process.env.GOVERNANCE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
