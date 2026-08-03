import { expect, test, COMPOSER_INPUT } from './fixtures';

/**
 * #1897: leaving a session mode from the composer footer.
 *
 * The mark's shape — position after the model pair, ghost variant, icon,
 * accessible name, and its absence from the drawer count — is unit-covered in
 * `composer-quiet-chrome.test.tsx`, and its accent rule is pinned in
 * `chat-shell-layout-contract.test.ts`. Do not re-lock any of that here.
 *
 * What only a real window can show is the behaviour behind the mark: a static
 * render is byte-identical with and without its `onClick`, so the one thing the
 * issue actually asks for — that removal stays available — is unverifiable
 * anywhere else. Focus travels with it: the click unmounts the button, and
 * without a handoff the keyboard user is left on `document.body`.
 *
 * One journey, both modes of input, because they exit through the same handler.
 */
test('a mode mark switches its mode off and hands focus back to the composer', async ({
  window: page,
}) => {
  const plusMenu = page.locator('.maka-composer-plus-menu').getByRole('button');
  const planMark = page.locator('.maka-composer-mode-button[data-mode="plan"]');

  await plusMenu.click();
  await page.getByRole('menuitemcheckbox', { name: 'Plan' }).click();
  await expect(planMark).toBeVisible();
  await expect(planMark).toHaveAccessibleName('Plan');
  await page.keyboard.press('Escape');

  // Pointer: the mark is the way out of the mode, and the ＋ menu agrees.
  await planMark.click();
  await expect(planMark).toHaveCount(0);
  await expect(page.locator(COMPOSER_INPUT)).toBeFocused();
  await plusMenu.click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Plan' })).toHaveAttribute(
    'aria-checked',
    'false',
  );

  // Keyboard: same handler, so the same exit and the same focus handoff.
  await page.getByRole('menuitemcheckbox', { name: 'Plan' }).click();
  await expect(planMark).toBeVisible();
  await page.keyboard.press('Escape');
  await planMark.focus();
  await page.keyboard.press('Enter');
  await expect(planMark).toHaveCount(0);
  await expect(page.locator(COMPOSER_INPUT)).toBeFocused();
});
