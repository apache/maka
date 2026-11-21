import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// cc 域契约测试：cc-dev 活链路（generate→apply）。
// 全程注入临时目录（CC_PROFILE_HOME / CC_DEV_ROOT / CONSOLE_CC_SETTINGS），绝不触碰真实 ~/.claude。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-cc-test-"));

beforeAll(() => {
  process.env.CC_PROFILE_HOME = path.join(tmp, "data");
  process.env.CC_DEV_ROOT = tmp; // 配置源根：tmp/.claude/{base,profiles,runtime}
  process.env.CONSOLE_CC_SETTINGS = path.join(tmp, "home", "settings.json");

  // 配置源夹具
  fs.mkdirSync(path.join(tmp, ".claude", "base"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".claude", "profiles", "work"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "home"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".claude", "base", "settings.json"),
    JSON.stringify({ env: { BASE_VAR: "base" }, language: "zh" }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(tmp, ".claude", "profiles", "work", "settings.patch.json"),
    JSON.stringify({ enabledPlugins: { "plugin-a@local": true }, env: { WORK_VAR: "42" } }),
    "utf-8",
  );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CC_PROFILE_HOME;
  delete process.env.CC_DEV_ROOT;
  delete process.env.CONSOLE_CC_SETTINGS;
});

describe("cc 域链路契约（原 cc-dev）", () => {
  it("generate：base+profile 深合并并落盘 runtime", async () => {
    const { generate } = await import("@/server/agentops/cc/generate");
    const r = await generate("work");
    expect(r.success).toBe(true);
    const runtimePath = path.join(tmp, ".claude", "runtime", "settings.local.json");
    expect(fs.existsSync(runtimePath)).toBe(true);
    const merged = JSON.parse(fs.readFileSync(runtimePath, "utf-8"));
    expect(merged.enabledPlugins["plugin-a@local"]).toBe(true); // profile 覆盖
    expect(merged.env.WORK_VAR).toBe("42"); // profile 注入
    expect(merged.env.BASE_VAR).toBe("base"); // base 保留
    expect(merged.language).toBe("zh"); // 未知/剩余字段保留
  });

  it("apply：备份→原子写入目标 settings→审计记录", async () => {
    const { apply } = await import("@/server/agentops/cc/apply");
    const settingsPath = process.env.CONSOLE_CC_SETTINGS!;
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ env: { OLD: "1" }, enabledPlugins: { "old@local": false } }),
      "utf-8",
    );

    const r = await apply();
    expect(r.success).toBe(true);

    const applied = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(applied.env.WORK_VAR).toBe("42");
    expect(applied.enabledPlugins["plugin-a@local"]).toBe(true);
  });
});
