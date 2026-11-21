import { expect, test } from "@playwright/test";

/**
 * 资产台冒烟 e2e（迁移自 card-admin e2e/smoke.spec.ts，路径适配控制台分区）
 * 运行：pnpm dev 起服务后 pnpm test:e2e
 */
test("资产台首页渲染分区导航与运营总览", async ({ page }) => {
  await page.goto("/assets");
  await expect(page.getByRole("link", { name: "运营总览" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "运营总览" })).toBeVisible();
});

test("导入原始卡密 → 导出 CPA tar", async ({ page }) => {
  await page.goto("/assets/import");
  await page
    .getByPlaceholder("也可以直接粘贴 JSONL 文本…")
    .fill('{"email":"e2e-test@outlook.com","access_token":"x.y.z","refresh_token":"rt_1"}');
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await expect(page.getByText(/解析 1 条/)).toBeVisible();

  await page.goto("/assets/export");
  await page.getByRole("button", { name: "生成 tar 包" }).click();
  await expect(page.getByRole("link", { name: "下载 tar 包" })).toBeVisible();
});
