import { test, expect } from './fixtures';
import { PROVIDER_REGISTRY, RECOMMENDED_PROVIDER_TYPES, type ProviderType } from '@maka/core';
import { PROVIDER_DISPLAY_COPY } from '../src/renderer/settings/provider-display-copy';

function providerDisplayName(type: ProviderType): string {
  return PROVIDER_DISPLAY_COPY[type]?.zh.name ?? PROVIDER_REGISTRY[type].label;
}

/**
 * First-run flow: a brand-new workspace (empty userData) must boot to the main
 * window with the renderer mounted. This is the cheapest end-to-end proof that
 * the launch → main → preload → renderer chain is intact, and it exercises the
 * E2E isolation seam (MAKA_E2E_USER_DATA_DIR) and the fake-backend switch
 * (MAKA_E2E) that the rest of the suite depends on.
 */
test('boots to registry recommendations and browses the shared provider catalog', async ({ emptyWindow: page }) => {
  await expect(page).toHaveTitle('Maka');
  await expect(page.locator('#root')).not.toBeEmpty();

  const providerRows = page.locator('.maka-firstrun-row');
  await expect(providerRows).toHaveCount(RECOMMENDED_PROVIDER_TYPES.length);
  await expect(providerRows).toContainText(
    RECOMMENDED_PROVIDER_TYPES.map((type) => providerDisplayName(type)),
  );

  await page.getByRole('button', { name: '浏览全部服务商' }).click();

  await expect(page.getByLabel('设置内容')).toBeVisible();
  await expect(page.getByRole('heading', { name: '已连接' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '添加新连接' })).toBeVisible();
  await expect(page.getByRole('tablist', { name: '模型供应商分类' })).toBeVisible();
  await expect(page.getByPlaceholder('搜索服务商')).toBeVisible();
  await expect(page.getByText('还没有模型连接')).toBeVisible();

  const settingsNav = page.locator('[aria-label="设置分组"]');
  await settingsNav.getByText('外观', { exact: true }).click();
  await settingsNav.getByText('模型', { exact: true }).click();

  await expect(page.getByRole('heading', { name: '添加新连接' })).toBeVisible();
  await expect(page.getByPlaceholder('搜索服务商')).toBeVisible();
});

// The provider list's bottom fade is a "more below" cue: it must be opaque
// while the list can scroll further down and gone at scroll end (otherwise
// it veils the last row, reading as broken dimming).
test('provider list bottom fade tracks scroll position', async ({ emptyWindow: page }) => {
  const scroller = page.locator('.maka-firstrun-list ul');
  const fadeOpacity = () => scroller.evaluate((el) => getComputedStyle(el, '::after').opacity);

  await expect.poll(fadeOpacity).toBe('1');
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(fadeOpacity).toBe('0');
});

test('clicking a recommended provider row opens that provider connection form', async ({ emptyWindow: page }) => {
  const name = providerDisplayName('deepseek');
  await page.locator('.maka-firstrun-row', { hasText: name }).click();

  await expect(page.getByLabel('设置内容')).toBeVisible();
  await expect(page.getByRole('dialog', { name: `连接 ${name}` })).toBeVisible();
});

test('closing the auto-opened provider form does not resurrect it on section re-entry', async ({ emptyWindow: page }) => {
  const name = providerDisplayName('deepseek');
  await page.locator('.maka-firstrun-row', { hasText: name }).click();

  const dialog = page.getByRole('dialog', { name: `连接 ${name}` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(dialog).not.toBeVisible();

  const settingsNav = page.locator('[aria-label="设置分组"]');
  await settingsNav.getByText('外观', { exact: true }).click();
  await settingsNav.getByText('模型', { exact: true }).click();

  await expect(page.getByRole('heading', { name: '添加新连接' })).toBeVisible();
  await expect(dialog).not.toBeVisible();
});
