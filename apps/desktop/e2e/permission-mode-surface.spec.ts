import { expect, test, COMPOSER_INPUT } from './fixtures';

/**
 * #1611 + #1616: cross-boundary permission journeys only.
 * Quiet chrome shape (icon menu, option set) is unit-covered — do not re-lock
 * tooltip copy or menu structure here.
 *
 * Auto transition from a live boundary is covered by the sandbox-expansion
 * test below; this case only locks the full-access confirm cancel path.
 */
test('full access from a read-only session requires confirm; cancel keeps the boundary', async ({
  readOnlyBoundaryWindow: page,
}) => {
  const trigger = page
    .locator('.maka-composer-left-controls .permissionModeIcon')
    .getByRole('button');
  await expect(trigger).toHaveAccessibleName('权限模式：只读');

  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitemradio', { name: /完全权限/ }).click();

  await expect(page.locator('.maka-confirm-modal')).toHaveCount(1);
  await page.getByRole('button', { name: '保持自动' }).click();
  await expect(page.locator('.maka-confirm-modal')).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName('权限模式：只读');
});

test('approving an expansion updates the permission label at once and after a reload', async ({
  sandboxBoundaryWindow: page,
}) => {
  const prompt = page.locator('.maka-sandbox-boundary-prompt');
  const trigger = page
    .locator('.maka-composer-left-controls .permissionModeIcon')
    .getByRole('button');

  // The session runs read-only and is asking to write outside the workspace.
  await expect(prompt).toHaveCount(1);

  await prompt.getByRole('button', { name: '本会话允许' }).click();
  await expect(prompt).toHaveCount(0);

  // #1611: the grant only bumps the boundary's revision — re-read authority.
  await expect(trigger).toHaveAccessibleName('权限模式：自动');

  await expect
    .poll(() =>
      page.evaluate(async () => {
        const state = await window.maka.e2eFixture.getState();
        return Object.keys(state?.sandboxBoundaryBySession ?? {}).length;
      }),
    )
    .toBe(0);

  await page.reload();
  await expect(page.locator(COMPOSER_INPUT)).toBeVisible();
  await expect(page.locator('.maka-boundary-unreadable-notice')).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName('权限模式：自动');

  await expect(prompt).toHaveCount(0);
  await expect(page.locator(COMPOSER_INPUT)).toBeVisible();
});
