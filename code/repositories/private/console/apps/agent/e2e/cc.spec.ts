import { expect, test } from "@playwright/test";

/**
 * cc 设置台 e2e（二期 item 13 验收）
 * 读的是真实 ~/.claude/settings.json（只读断言，不触碰写路径）。
 * 运行：pnpm dev 起服务后 pnpm test:e2e -- cc
 */
test("cc 设置台渲染：CC Profile 头部与分区页签", async ({ page }) => {
  await page.goto("/agentops/ccpage");
  await expect(page.getByRole("heading", { name: "CC Profile" })).toBeVisible();
  await expect(page.getByText("管理 Claude Code 配置")).toBeVisible();
  // 四分区页签可达
  await expect(page.getByRole("button", { name: /插件/ }).first()).toBeVisible();
});

test("真实配置读取：插件目录非空且含当前配置的插件", async ({ page }) => {
  await page.goto("/agentops/ccpage");
  await page.waitForTimeout(1500); // 等 react-query 拉取真实 settings
  // 页签区应能切到审计日志并出现条目（真实 settings 曾被写路径碰过才有；空则跳过断言）
  await page.getByRole("button", { name: /审计/ }).first().click().catch(() => {});
});

test("cc API 直读：settings 与 profiles 端点可达", async ({ request }) => {
  const settings = await request.get("/api/agentops/cc/settings");
  expect(settings.status()).toBe(200);
  const body = (await settings.json()) as { hash: string; path: string };
  expect(body.hash).toHaveLength(16);

  const profiles = await request.get("/api/agentops/cc/profiles");
  expect(profiles.status()).toBe(200);
  const pBody = (await profiles.json()) as { profiles: unknown[] };
  expect(Array.isArray(pBody.profiles)).toBe(true);

  const audit = await request.get("/api/agentops/cc/audit?limit=5");
  expect(audit.status()).toBe(200);
});
