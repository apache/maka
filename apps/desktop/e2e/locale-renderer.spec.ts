import type { Page } from '@playwright/test';
import { test, expect, COMPOSER_INPUT } from './fixtures';

/** Sidebar expand is absent when already expanded (state can survive reload). */
async function ensureSidebarExpanded(page: Page): Promise<void> {
  const expand = page.getByRole('button', { name: /展开侧边栏|Expand sidebar/ });
  if (await expand.isVisible().catch(() => false)) {
    await expand.click();
  }
}

async function openSettingsGeneral(page: Page): Promise<{
  settingsNavigation: ReturnType<Page['getByRole']>;
  settings: ReturnType<Page['getByRole']>;
}> {
  await ensureSidebarExpanded(page);
  await page.getByRole('button', { name: /设置|Settings/ }).click();
  const settingsNavigation = page.getByRole('navigation', {
    name: /设置分组|Settings sections/,
  });
  const settings = page.getByRole('main', { name: /设置内容|Settings content/ });
  await settingsNavigation.getByRole('button', { name: /通用|General/, exact: true }).click();
  return { settingsNavigation, settings };
}

// Runtime locale switching must not require a reload; boot-time hydration must
// still read the persisted uiLocale after a full remount.
test('locale switching, persistence, and Follow system need no reload', async ({ localeSwitchWindow: page }) => {
  let { settings } = await openSettingsGeneral(page);

  let language = settings.getByRole('radiogroup', { name: /界面语言|Interface language/ });
  await language.getByRole('radio', { name: 'English', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect.poll(() => page.evaluate(() => window.maka.settings.get().then((value) => value.personalization.uiLocale))).toBe('en');

  // Boot path: first paint after remount must honor the persisted store.
  await page.reload();
  await page.waitForSelector(COMPOSER_INPUT, { timeout: 20_000 });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect.poll(() => page.evaluate(() => window.maka.settings.get().then((value) => value.personalization.uiLocale))).toBe('en');

  ({ settings } = await openSettingsGeneral(page));

  await page.evaluate(() => { (window as unknown as { __localeE2eMarker: string }).__localeE2eMarker = 'alive'; });
  language = settings.getByRole('radiogroup', { name: 'Interface language' });
  await language.getByRole('radio', { name: '中文', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh');
  await expect.poll(() => page.evaluate(() => window.maka.settings.get().then((value) => value.personalization.uiLocale))).toBe('zh');

  language = settings.getByRole('radiogroup', { name: '界面语言' });
  await language.getByRole('radio', { name: '跟随系统', exact: true }).click();
  const expectedSystemLocale = await page.evaluate(() => {
    const supportedLanguage = navigator.languages
      .map((value) => value.toLowerCase())
      .find((value) => value.startsWith('zh') || value.startsWith('en'));
    return supportedLanguage?.startsWith('zh') ? 'zh' : 'en';
  });
  await expect(page.locator('html')).toHaveAttribute('lang', expectedSystemLocale);
  await expect.poll(() => page.evaluate(() => window.maka.settings.get().then((value) => value.personalization.uiLocale))).toBe('auto');
  expect(await page.evaluate(() => (window as unknown as { __localeE2eMarker?: string }).__localeE2eMarker)).toBe('alive');
});
