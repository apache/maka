import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// cc-settings 契约测试：对齐 18 个 Tauri 命令语义（readModifyWrite 三段式：备份→原子写→审计→回读校验）。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-ccsettings-test-"));
const settingsPath = path.join(tmp, "home", "settings.json");

beforeAll(() => {
  process.env.CC_PROFILE_HOME = path.join(tmp, "data");
  process.env.CC_DEV_ROOT = tmp;
  process.env.CONSOLE_CC_SETTINGS = settingsPath;

  fs.mkdirSync(path.join(tmp, "home"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".claude", "base"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".claude", "profiles", "work"), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ enabledPlugins: { "base@x": true }, env: { A: "1" } }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(tmp, ".claude", "base", "settings.json"),
    JSON.stringify({ env: { BASE: "b" }, language: "zh" }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(tmp, ".claude", "profiles", "work", "settings.patch.json"),
    JSON.stringify({ enabledPlugins: { "work@x": true }, env: { W: "9" } }),
    "utf-8",
  );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CC_PROFILE_HOME;
  delete process.env.CC_DEV_ROOT;
  delete process.env.CONSOLE_CC_SETTINGS;
});

describe("cc 命令域：settings 读写与插件（命令 1-3, 7-9）", () => {
  it("read_settings / get_current_hash / check_settings_exists / get_default_settings_path", async () => {
    const m = await import("@/server/agentops/cc/settings");
    const r = m.readSettings();
    expect(r.settings.enabledPlugins["base@x"]).toBe(true);
    expect(r.hash).toBe(m.computeHash(fs.readFileSync(settingsPath, "utf-8")));
    expect(m.getCurrentHash()).toBe(r.hash);
    expect(m.checkSettingsExists()).toBe(true);
    expect(m.getSettingsPath()).toBe(settingsPath);
  });

  it("toggle_plugin：更新单个插件 + 审计 + 回读校验", async () => {
    const m = await import("@/server/agentops/cc/settings");
    const hash = m.togglePlugin("new@y", true);
    expect(m.readSettings().settings.enabledPlugins["new@y"]).toBe(true);
    expect(m.verifyWrite(hash)).toBe(true);
    // 审计落盘
    const auditPath = path.join(tmp, "data", "audit", "audit.jsonl");
    const lines = fs.readFileSync(auditPath, "utf-8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]!);
    expect(last.action).toBe("toggle_plugin");
    expect(last.changedKeys).toEqual(["enabledPlugins.new@y"]);
    expect(last.beforeHash).not.toBe(last.afterHash);
  });

  it("batch_update_plugins / apply_preset：批量变更记 changedKeys", async () => {
    const m = await import("@/server/agentops/cc/settings");
    m.batchUpdatePlugins({ "a@1": true, "b@2": false });
    expect(m.readSettings().settings.enabledPlugins["b@2"]).toBe(false);
    m.applyPreset({ "p@all": true }, "全开");
    expect(m.readSettings().settings.enabledPlugins["p@all"]).toBe(true);
    const audit = fs.readFileSync(path.join(tmp, "data", "audit", "audit.jsonl"), "utf-8");
    expect(audit).toContain("apply_preset");
    expect(audit).toContain("batch_update");
  });

  it("每次写前自动备份", async () => {
    const m = await import("@/server/agentops/cc/settings");
    const before = m.readSettings().hash;
    m.togglePlugin("backup-trigger@z", true);
    const backupDir = path.join(tmp, "data", "backups");
    const files = fs.readdirSync(backupDir).filter((f) => f.startsWith("settings.json.bak-"));
    expect(files.length).toBeGreaterThanOrEqual(4); // toggle/batch/preset 各留备份
    expect(before).toBeTruthy();
  });
});

describe("cc 命令域：备份与审计（命令 4-6）", () => {
  it("restore_backup 恢复后 hash 一致且记审计", async () => {
    const m = await import("@/server/agentops/cc/settings");
    const auditPath = path.join(tmp, "data", "audit", "audit.jsonl");
    const first = JSON.parse(fs.readFileSync(auditPath, "utf-8").split("\n")[0]!);
    m.restoreBackup(first.backupFile);
    const restored = m.readSettings().settings;
    expect(restored.enabledPlugins["base@x"]).toBe(true); // 回到最初状态
    const audit = fs.readFileSync(path.join(tmp, "data", "audit", "audit.jsonl"), "utf-8");
    expect(audit).toContain("restore_backup");
  });

  it("restore_backup 不存在的路径抛错", async () => {
    const m = await import("@/server/agentops/cc/settings");
    expect(() => m.restoreBackup(path.join(tmp, "nope.bak"))).toThrow("备份文件不存在");
  });
});

describe("cc 命令域：自定义预设 CRUD（命令 10-14）", () => {
  it("save/read/delete/export/import 全链", async () => {
    const m = await import("@/server/agentops/cc/settings");
    const created = m.saveCustomPreset({
      id: "p1", name: "开发集", enabledPlugins: { "dev@a": true, "dev@b": false },
    });
    expect(created.createdAt).toBeTruthy();
    expect(m.readCustomPresets()).toHaveLength(1);

    // 更新同 id
    m.saveCustomPreset({ id: "p1", name: "开发集2", enabledPlugins: { "dev@a": false } });
    const list = m.readCustomPresets();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("开发集2");

    // export → 删 → import 恢复
    const exported = m.exportPresets(["p1"]);
    m.deleteCustomPreset("p1");
    expect(m.readCustomPresets()).toHaveLength(0);
    const imported = m.importPresets(exported);
    expect(imported).toHaveLength(1);
    expect(imported[0]!.name).toBe("开发集2");
  });
});

describe("cc 命令域：profile 合并（命令 15-17，借 18 之 hash 收尾）", () => {
  it("list_profiles 扫描 profile 目录", async () => {
    const m = await import("@/server/agentops/cc/settings");
    const list = m.listProfiles();
    expect(list.map((p) => p.name)).toContain("work");
    expect(list.find((p) => p.name === "work")!.hasPatch).toBe(true);
  });

  it("merge_profile_preview 干跑返回合并结果不落盘", async () => {
    const m = await import("@/server/agentops/cc/settings");
    const runtimePath = path.join(tmp, ".claude", "runtime", "settings.local.json");
    const before = fs.existsSync(runtimePath);
    const preview = await m.mergeProfilePreview("work");
    expect(preview!.merged.enabledPlugins["work@x"]).toBe(true);
    expect(fs.existsSync(runtimePath)).toBe(before); // dry-run 不落盘
  });

  it("apply_profile 全链：生成→应用→返回新 hash", async () => {
    const m = await import("@/server/agentops/cc/settings");
    const hash = await m.applyProfile("work");
    expect(typeof hash).toBe("string");
    expect(m.verifyWrite(hash)).toBe(true);
    const applied = m.readSettings().settings;
    expect(applied.enabledPlugins["work@x"]).toBe(true);
  });
});


it("同一毫秒的写入分别保留可恢复备份", async () => {
  const m = await import("@/server/agentops/cc/settings");
  const list = await import("@/app/api/agentops/cc/backups/route");
  const original = fs.readFileSync(settingsPath, "utf-8");
  const before = new Set((await (await list.GET()).json()).backups.map((b: { path: string }) => b.path));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  try {
    m.togglePlugin("collision@one", true);
    const firstVersion = fs.readFileSync(settingsPath, "utf-8");
    m.togglePlugin("collision@two", true);
    const newBackups = (await (await list.GET()).json()).backups.filter((b: { path: string }) => !before.has(b.path));
    expect(newBackups).toHaveLength(2);
    const originals = newBackups.filter((b: { path: string }) => fs.readFileSync(b.path, "utf-8") === original);
    expect(originals).toHaveLength(1);
    expect(newBackups.some((b: { path: string }) => fs.readFileSync(b.path, "utf-8") === firstVersion)).toBe(true);
    m.restoreBackup(originals[0].path);
    expect(m.readSettings().settings).toEqual(JSON.parse(original));
    // profile 应用使用另一备份入口，也不得覆盖。
    const count = (await (await list.GET()).json()).backups.length;
    await m.applyProfile("work");
    await m.applyProfile("work");
    expect((await (await list.GET()).json()).backups).toHaveLength(count + 2);
  } finally {
    vi.useRealTimers();
  }
});
