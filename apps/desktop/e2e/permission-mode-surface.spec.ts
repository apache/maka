import { expect, test } from './fixtures';

const READ_ONLY_HINT = '只读搜索，不写文件、不上网；需要时先问你。';

/**
 * #1611 + #1616: the composer's permission control is the only place a user
 * learns what the running session may do. Quiet composer: ghost icon button
 * + short radio menu (labels only; full hint on the trigger).
 */
test('a read-only session names its boundary and can still be raised to full access', async ({
  readOnlyBoundaryWindow: page,
}) => {
  const trigger = page
    .locator('.maka-composer-left-controls .permissionModeIcon')
    .getByRole('button');
  await expect(trigger).toHaveAccessibleName('权限模式：只读');
  await expect(trigger).toHaveAccessibleDescription(READ_ONLY_HINT);

  await trigger.click();
  const radios = page.getByRole('menuitemradio');
  await expect(radios).toHaveCount(2);
  await expect(radios.nth(0)).toContainText('自动');
  await expect(radios.nth(1)).toContainText('完全权限');
  await expect(page.getByRole('menu')).not.toContainText('沙箱');

  // Read-only is display-only: neither option is selected.
  await expect(radios.nth(0)).toHaveAttribute('aria-checked', 'false');
  await expect(radios.nth(1)).toHaveAttribute('aria-checked', 'false');

  // Opening and dismissing is not a choice.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName('权限模式：只读');

  // Full access still requires confirmation; cancel leaves the boundary.
  await trigger.click();
  await page.getByRole('menuitemradio', { name: /完全权限/ }).click();
  await expect(page.locator('.maka-confirm-modal')).toHaveCount(1);
  await page.getByRole('button', { name: '保持自动' }).click();
  await expect(page.locator('.maka-confirm-modal')).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName('权限模式：只读');

  // Choosing Auto is a real permission change.
  await trigger.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByRole('menuitemradio', { name: /自动/ }).click();
  await expect(trigger).toHaveAccessibleName('权限模式：自动');
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
  await expect(page.locator('.maka-composer-textarea')).toBeVisible();
  await expect(page.locator('.maka-boundary-unreadable-notice')).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName('权限模式：自动');

  await expect(prompt).toHaveCount(0);
  await expect(page.locator('.maka-composer-textarea')).toBeVisible();
});
