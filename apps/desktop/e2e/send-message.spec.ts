import { test, expect } from './fixtures';

/**
 * Core chat loop: type a message, send it, see the deterministic fake backend
 * stream a reply back into the transcript. Depends on the E2E seam: the
 * fixture's MAKA_E2E=1 forces sessions:create onto the fake backend, and the
 * seeded 'e2e' connection clears onboarding so the composer is usable.
 */
test('send a message and see the fake backend stream a reply', async ({ window: page }) => {
  const composer = page.locator('.maka-composer-textarea');
  // #1433: the deleted first-run panel had its own input, and the spec that
  // covered the handoff between the two asserted this accessible name. With
  // one composer left, the name is what a screen-reader user has to find the
  // send target by — assert it on the path that exercises it.
  await expect(composer).toHaveAttribute('aria-label', '消息输入框');
  await composer.fill('hello e2e');
  await composer.press('Enter');

  await expect(page.getByText(/Fake backend received: hello e2e/)).toBeVisible();
  await expect(
    page.locator('.maka-model-switcher-trigger .maka-composer-provider-mark[data-provider="anthropic"] svg'),
  ).toBeVisible();
});
