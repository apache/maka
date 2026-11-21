import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// cc API 契约：17 命令 → 11 端点的 HTTP 语义（zod 校验 + 错误码）。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-ccapi-test-"));
const settingsPath = path.join(tmp, "home", "settings.json");

const json = (body: unknown) =>
  new Request("http://localhost:3000/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(() => {
  process.env.CC_PROFILE_HOME = path.join(tmp, "data");
  process.env.CC_DEV_ROOT = tmp;
  process.env.CONSOLE_CC_SETTINGS = settingsPath;
  fs.mkdirSync(path.join(tmp, "home"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".claude", "base"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".claude", "profiles", "work"), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ enabledPlugins: { "a@x": true }, env: {} }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(tmp, ".claude", "base", "settings.json"),
    JSON.stringify({ env: { B: "1" } }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(tmp, ".claude", "profiles", "work", "settings.patch.json"),
    JSON.stringify({ enabledPlugins: { "w@x": true } }),
    "utf-8",
  );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CC_PROFILE_HOME;
  delete process.env.CC_DEV_ROOT;
  delete process.env.CONSOLE_CC_SETTINGS;
});

describe("cc API 契约（18 命令映射）", () => {
  it("GET settings 聚合读（命令 1/7/8/9）", async () => {
    const { GET } = await import("@/app/api/agentops/cc/settings/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: Record<string, unknown>; hash: string; path: string };
    expect(body.settings.enabledPlugins).toBeTruthy();
    expect(body.hash).toHaveLength(16);
    expect(body.path).toBe(settingsPath);
  });

  it("POST toggle-plugin（命令 2）：合法 200 / 非法 400", async () => {
    const { POST } = await import("@/app/api/agentops/cc/settings/toggle-plugin/route");
    const ok = await POST(json({ pluginId: "t@1", enabled: true }));
    expect(ok.status).toBe(200);
    const bad = await POST(json({ pluginId: "" }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("VALIDATION_ERROR");
  });

  it("POST batch-plugins / apply-preset（命令 3/4）", async () => {
    const batch = (await import("@/app/api/agentops/cc/settings/batch-plugins/route")).POST;
    const r1 = await batch(json({ updates: { "x@1": true, "x@2": false } }));
    expect(r1.status).toBe(200);
    const preset = (await import("@/app/api/agentops/cc/settings/apply-preset/route")).POST;
    const r2 = await preset(json({ presetPlugins: { "p@z": true }, presetName: "测试" }));
    expect(r2.status).toBe(200);
  });

  it("GET backups / POST restore（命令 5/6）：恢复不存在路径 500", async () => {
    const list = (await import("@/app/api/agentops/cc/backups/route")).GET;
    const l = (await (await list()).json()) as { backups: Array<{ path: string }> };
    expect(l.backups.length).toBeGreaterThanOrEqual(3);
    const restore = (await import("@/app/api/agentops/cc/backups/restore/route")).POST;
    const bad = await restore(json({ backupPath: path.join(tmp, "none") }));
    expect(bad.status).toBe(500);
    expect(((await bad.json()) as { code: string }).code).toBe("RESTORE_FAILED");
  });

  it("presets CRUD（命令 11-13）+ export/import（命令 14-15）", async () => {
    const presets = await import("@/app/api/agentops/cc/presets/route");
    const created = await presets.POST(
      json({ id: "k1", name: "预设A", enabledPlugins: { "k@1": true } }),
    );
    expect(created.status).toBe(200);
    const list = (await (await presets.GET()).json()) as { presets: Array<{ id: string }> };
    expect(list.presets).toHaveLength(1);

    const exportRoute = (await import("@/app/api/agentops/cc/presets/export/route")).POST;
    const exp = await exportRoute(json({ presetIds: ["k1"] }));
    expect(exp.headers.get("content-type")).toBe("application/json");
    const payload = (await exp.json()) as Array<{ id: string }>;
    expect(payload).toHaveLength(1);

    const importRoute = (await import("@/app/api/agentops/cc/presets/import/route")).POST;
    const imp = await importRoute(json([{ id: "k2", name: "预设B", enabledPlugins: {} }]));
    expect(imp.status).toBe(200);
    const after = (await (await presets.GET()).json()) as { presets: string[] };
    expect(after.presets).toHaveLength(2);

    const del = await presets.DELETE(json({ id: "k2" }));
    expect(del.status).toBe(200);
  });

  it("profiles 三端点（命令 16/17/18）", async () => {
    const list = (await import("@/app/api/agentops/cc/profiles/route")).GET;
    const l = (await (await list()).json()) as { profiles: Array<{ name: string }> };
    expect(l.profiles.map((p) => p.name)).toContain("work");

    const preview = (await import("@/app/api/agentops/cc/profiles/preview/route")).POST;
    const pv = await preview(json({ profileName: "work" }));
    expect(pv.status).toBe(200);

    const apply = (await import("@/app/api/agentops/cc/profiles/apply/route")).POST;
    const ap = await apply(json({ profileName: "work" }));
    expect(ap.status).toBe(200);
    const body = (await ap.json()) as { hash: string };
    expect(body.hash).toHaveLength(16);
  });
});
