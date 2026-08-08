import { expect, test, COMPOSER_INPUT } from './fixtures';

/** #1611: the live boundary update must cross main/renderer and survive reload. */
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
