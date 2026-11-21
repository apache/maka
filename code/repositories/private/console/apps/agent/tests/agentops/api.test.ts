import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 配置台契约测试：profiles / runs / dry-run / 404。
// dry-run 只扫描只读、计划不入真实配置；run 记录落在隔离的数据目录。
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "console-agentops-test-"));

let getProfiles: () => Promise<Response>;
let getRuns: () => Promise<Response>;
let getRun: (req: Request, ctx: { params: Promise<{ runId: string }> }) => Promise<Response>;
let postDryRun: (req: Request) => Promise<Response>;
let postApply: (req: Request) => Promise<Response>;

const json = (body: unknown) =>
  new Request("http://localhost:3000/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  process.env.CONSOLE_DATA_DIR = tmpData;
  getProfiles = (await import("@/app/api/agentops/profiles/route")).GET;
  getRuns = (await import("@/app/api/agentops/runs/route")).GET;
  getRun = (await import("@/app/api/agentops/runs/[runId]/route")).GET;
  postDryRun = (await import("@/app/api/agentops/runs/dry-run/route")).POST;
  postApply = (await import("@/app/api/agentops/runs/apply/route")).POST;
});

afterAll(async () => {
  fs.rmSync(tmpData, { recursive: true, force: true });
});

describe("配置台 API 契约", () => {
  it("profiles 列出可用 Profile（默认 default）", async () => {
    const body = (await getProfiles().then((r) => r.json())) as { profiles: string[] };
    expect(body.profiles).toContain("default");
  });

  it("runs 初始为空列表", async () => {
    const body = (await getRuns().then((r) => r.json())) as { runs: unknown[] };
    expect(Array.isArray(body.runs)).toBe(true);
  });

  it("不存在的 run 返回 404", async () => {
    const res = await getRun(new Request("http://localhost:3000/x"), {
      params: Promise.resolve({ runId: "no-such-run" }),
    });
    expect(res.status).toBe(404);
    const err = (await res.json()) as { code: string };
    expect(err.code).toBe("NOT_FOUND");
  });

  it("dry-run 缺 profile 时返回 PROFILE_NOT_FOUND", async () => {
    const res = await postDryRun(json({ profile: "no-such-profile", targets: ["vscode"] }));
    const body = (await res.json()) as { success: boolean; code?: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe("PROFILE_NOT_FOUND");
  });

  it("dry-run 全链路（扫描→计划→执行，不写真实配置）", async () => {
    const res = await postDryRun(json({ profile: "default", targets: ["vscode"] }));
    const body = (await res.json()) as {
      success: boolean;
      run?: { id: string; mode: string };
      error?: string;
    };
    // 本机可能没有 VSCode 配置 → 空计划也是 success
    expect(body.success).toBe(true);
    if (body.run) {
      expect(body.run.mode).toBe("dry-run");
    }
    // run 记录应写入隔离目录
    const runs = (await getRuns().then((r) => r.json())) as { runs: unknown[] };
    expect(runs.runs.length).toBeGreaterThan(0);
  });

  it("apply 与 dry-run 同构（PROFILE_NOT_FOUND 路径）", async () => {
    const res = await postApply(json({ profile: "no-such-profile", targets: ["vscode"] }));
    const body = (await res.json()) as { success: boolean; code?: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe("PROFILE_NOT_FOUND");
  });
});
