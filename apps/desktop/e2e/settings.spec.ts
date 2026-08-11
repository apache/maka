import { test, expect, COMPOSER_INPUT } from './fixtures';

test('settings owns the window chrome while a session remains active', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create a session for settings');
  await composer.press('Enter');

  const identity = page.locator('[data-maka-contract="titlebar-identity"]');
  await expect(identity).toBeVisible();
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('main', { name: '设置内容' })).toBeVisible();

  await expect(identity).toHaveCount(0);
  await expect(page.getByRole('button', { name: '搜索对话' })).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: '工作区辅助操作' })).toHaveCount(0);
  await expect(page.locator('.maka-shell-astryx')).toHaveAttribute('inert', '');

  const titlebar = page.locator('.maka-window-titlebar');
  await expect(titlebar).toHaveCount(1);
  await expect(titlebar).toHaveAttribute('aria-hidden', 'true');
  await expect(titlebar).not.toHaveAttribute('inert');
  await expect
    .poll(() =>
      titlebar.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          appRegion: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
          hasArea: rect.width > 0 && rect.height > 0,
        };
      }),
    )
    .toEqual({ appRegion: 'drag', hasArea: true });
});

test('opening settings commits an active titlebar rename', async ({ window: page }) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create a session for settings rename');
  await composer.press('Enter');

  const identity = page.locator('[data-maka-contract="titlebar-identity"]');
  await expect(identity).toBeVisible();
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await identity.getByRole('button', { name: /重命名对话/ }).click();
  await page.getByRole('textbox', { name: '重命名对话' }).fill('renamed before settings');

  // Programmatic activation preserves input focus, matching the macOS
  // application-menu command that opens Settings before Chromium can blur it.
  await page.getByRole('button', { name: '设置' }).evaluate((button) => button.click());
  await expect(page.getByRole('main', { name: '设置内容' })).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(identity).toContainText('renamed before settings');
});
