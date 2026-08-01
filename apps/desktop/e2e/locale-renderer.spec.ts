import { test, expect } from './fixtures';

// Runtime locale switching must not require a reload; boot-time hydration must
// still read the persisted uiLocale after a full remount.
test('locale switching, persistence, and Follow system need no reload', async ({ localeSwitchWindow: page }) => {
  await page.getByRole('button', { name: /展开侧边栏|Expand sidebar/ }).click();
  await page.getByRole('button', { name: /设置|Settings/ }).click();
  const settingsNavigation = page.getByRole('navigation', {
    name: /设置分组|Settings sections/,
  });
  const settings = page.getByRole('main', { name: /设置内容|Settings content/ });
  await settingsNavigation.getByRole('button', { name: /通用|General/, exact: true }).click();

  let language = settings.getByRole('radiogroup', { name: /界面语言|Interface language/ });
  await language.getByRole('radio', { name: 'English', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect.poll(() => page.evaluate(() => window.maka.settings.get().then((value) => value.personalization.uiLocale))).toBe('en');

  // Boot path: first paint after remount must honor the persisted store.
  await page.reload();
  await page.waitForSelector('.maka-composer-textarea', { timeout: 20_000 });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect.poll(() => page.evaluate(() => window.maka.settings.get().then((value) => value.personalization.uiLocale))).toBe('en');

  await page.getByRole('button', { name: /Expand sidebar|展开侧边栏/ }).click();
  await page.getByRole('button', { name: /Settings|设置/ }).click();
  await settingsNavigation.getByRole('button', { name: /General|通用/, exact: true }).click();

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
