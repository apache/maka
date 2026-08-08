import { test, expect, COMPOSER_INPUT } from './fixtures';

const MOD_SLASH = process.platform === 'darwin' ? 'Meta+/' : 'Control+/';

/**
 * #1689 regression pins: the cheat sheet must render as a structured grid
 * with keycap chrome — not the stacked plain text the issue reported — and
 * every documented entry point must reach it.
 */
test('the help modal opens from its entry points and keeps its styled layout', async ({ window: page }) => {
  // Entry point 1: bare `?` with no input focused. The composer autofocuses,
  // so park focus somewhere non-typing first.
  await page.locator('body').click({ position: { x: 4, y: 200 } });
  await page.keyboard.press('?');
  const body = page.locator('dialog[open] .maka-help-body');
  await expect(body).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(body).not.toBeVisible();

  // Entry point 2: the platform mod combo — allowed even while typing.
  await page.locator(COMPOSER_INPUT).click();
  await page.keyboard.press(MOD_SLASH);
  await expect(body).toBeVisible();

  // The platform's own modifier is what the sheet documents — ⌘ on macOS,
  // Ctrl elsewhere. (This harness boots with healthy UA-CH; the blank-UA-CH
  // environment is pinned by the dedicated test below.)
  const firstCombo = page.locator('.maka-help-section dd').first();
  await expect(firstCombo).toContainText(process.platform === 'darwin' ? '⌘' : 'Ctrl');

  // The same combo toggles it closed again.
  await page.keyboard.press(MOD_SLASH);
  await expect(body).not.toBeVisible();
});

/**
 * Guard for the `@astryxdesign/core` blank-UA-CH patch (patches/README.md).
 *
 * Electron bundles with a rewritten identity (the ad-hoc-signed dev app)
 * ship `userAgentData.platform: ''`, and Astryx's probe read the blank as
 * "not Apple" — mod hotkeys bound Ctrl on macOS and keycaps drew Ctrl. This
 * harness boots with healthy UA-CH, so the broken environment is
 * reconstructed explicitly: blank UA-CH plus a Mac `navigator.platform`,
 * installed before the app boots. Patched Astryx must fall through the
 * blank to navigator.platform and land on ⌘ — on every host OS, which is
 * what makes this test discriminating in CI (unpatched, the blank decides
 * "not Apple" and the keycap reads Ctrl).
 */
test('a blank UA-CH platform falls through to navigator.platform', async ({ window: page }) => {
  await page.context().addInitScript(() => {
    const original = (navigator as { userAgentData?: unknown }).userAgentData ?? {};
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      configurable: true,
      get: () => ({ ...(original as object), platform: '', brands: [] }),
    });
    Object.defineProperty(Navigator.prototype, 'platform', {
      configurable: true,
      get: () => 'MacIntel',
    });
  });
  await page.reload();
  await page.locator(COMPOSER_INPUT).waitFor();

  // With the fake Mac platform installed, the mod hotkey must bind ⌘ — so
  // Meta+/ opens the modal regardless of the host OS.
  await page.keyboard.press('Meta+/');
  const body = page.locator('dialog[open] .maka-help-body');
  await expect(body).toBeVisible();
  await expect(page.locator('.maka-help-section dd').first()).toContainText('⌘');
});
