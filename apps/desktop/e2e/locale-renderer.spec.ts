import { test, expect } from './fixtures';

// The boot-time locale override, which the runtime switch below cannot cover:
// these windows resolve their locale before the first frame. A rendered control
// carrying the translated name is the observable evidence — the previous
// screenshot byte-size floor would have passed on a blank frame just as well.
test('Chinese e2e-fixture renderer uses the resolved locale', async ({ zhLocaleWindow: page }) => {
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh');
  await expect(page.getByRole('button', { name: '展开侧边栏' })).toBeVisible();
});

test('English e2e-fixture renderer uses the resolved locale', async ({ enLocaleWindow: page }) => {
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
});

test('locale switching, persistence, and Follow system need no reload', async ({ localeSwitchWindow: page }) => {
  await page.getByRole('button', { name: /展开侧边栏|Expand sidebar/ }).click();
  await page.getByRole('button', { name: /设置|Settings/ }).click();
  const settingsNavigation = page.getByRole('navigation', {
    name: /设置分组|Settings sections/,
  });
  const settings = page.getByRole('main', { name: /设置内容|Settings content/ });
  await settingsNavigation.getByRole('button', { name: /通用|General/, exact: true }).click();

  await page.evaluate(() => { (window as unknown as { __localeE2eMarker: string }).__localeE2eMarker = 'alive'; });
  let language = settings.getByRole('radiogroup', { name: /界面语言|Interface language/ });
  await language.getByRole('radio', { name: 'English', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect.poll(() => page.evaluate(() => window.maka.settings.get().then((value) => value.personalization.uiLocale))).toBe('en');

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
