import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// cc watcher 契约：settings.json 变更 → 版本号自增；stop 幂等。
describe("cc 域 watcher 常驻任务", () => {
  it("文件变更触发版本自增，stop 后不再触发", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-watch-"));
    const settingsPath = path.join(tmp, "settings.json");
    process.env.CONSOLE_CC_SETTINGS = settingsPath;
    fs.writeFileSync(settingsPath, '{"enabledPlugins":{}}', "utf-8");

    vi.resetModules();
    const { ccWatchTaskFactory, getCcSettingsVersion } = await import(
      "@/server/agentops/cc/watch"
    );
    const gv = () => (globalThis as { __ccSettingsVersion?: number }).__ccSettingsVersion ?? 0;
    const before = gv();

    const task = ccWatchTaskFactory();
    // 等待 watcher 生效
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(settingsPath, '{"enabledPlugins":{"x":true}}', "utf-8");
    // 事件去抖到达
    await new Promise((r) => setTimeout(r, 250));
    const after = gv();
    expect(after).toBeGreaterThan(before);

    await task.stop();
    await task.stop(); // 幂等
    fs.writeFileSync(settingsPath, '{"enabledPlugins":{"y":true}}', "utf-8");
    await new Promise((r) => setTimeout(r, 250));
    expect(gv()).toBe(after); // stop 后不再变化

    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CONSOLE_CC_SETTINGS;
  });
});
