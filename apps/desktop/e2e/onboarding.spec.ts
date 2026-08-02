import { test, expect } from './fixtures';

test('first run leads directly to the shared provider setup page', async ({ firstRunWindow: page }) => {
  const onboarding = page.locator('[data-maka-contract="onboarding-card"]');

  await expect(onboarding.getByRole('heading', { name: '接入一个 AI，开始第一项任务。' })).toBeVisible();
  await expect(onboarding.locator('.maka-onboarding-provider-row')).toHaveCount(4);

  await onboarding.locator('.maka-onboarding-provider-row[data-provider="opencode-free"]').click();

  await expect(page.locator('[data-maka-contract="provider-setup"]')).toBeVisible();
  await expect(page.getByLabel('设置内容')).toBeVisible();
});
