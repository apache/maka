import { test, expect } from './fixtures';

test('first run leads directly to the shared provider setup page', async ({ firstRunWindow: page }) => {
  const onboarding = page.locator('[data-maka-contract="onboarding-card"]');

  await expect(onboarding.getByRole('heading', { name: '接入一个 AI，开始第一项任务。' })).toBeVisible();
  await expect(onboarding.locator('.maka-onboarding-provider-row')).toHaveCount(4);

  await page.setViewportSize({ width: 480, height: 900 });
  const cardRect = await onboarding.boundingBox();
  const layoutRect = await page.locator('[data-chat-scroll-container="true"]').boundingBox();
  expect(cardRect).not.toBeNull();
  expect(layoutRect).not.toBeNull();
  expect(cardRect?.x).toBeGreaterThanOrEqual(layoutRect?.x ?? 0);
  expect((cardRect?.x ?? 0) + (cardRect?.width ?? 0)).toBeLessThanOrEqual(
    (layoutRect?.x ?? 0) + (layoutRect?.width ?? 0),
  );

  await onboarding.locator('.maka-onboarding-provider-row[data-provider="opencode-free"]').click();

  await expect(page.locator('[data-maka-contract="provider-setup"]')).toBeVisible();
  await expect(page.getByLabel('设置内容')).toBeVisible();
});
