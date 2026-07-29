import { expect, test } from './fixtures';

const READ_ONLY_HINT = '只读取和搜索，不写入文件、不访问网络；需要这些权限时会先来问你。';

/**
 * #1611 + #1616: the composer's permission control is the only place a user
 * learns what the running session may do. These cover the journeys that cross
 * the main/renderer boundary — a session whose stored boundary is a managed
 * read-only profile, and the moment that boundary is widened.
 */
test('a read-only session names its boundary and can still be raised to full access', async ({
  readOnlyBoundaryWindow: page,
}) => {
  const trigger = page.locator('.maka-composer-left-controls [data-slot="select-trigger"]');
  await expect(trigger).toHaveText('只读');
  await expect(trigger).toHaveAttribute('aria-label', '权限模式：只读');
  await expect(trigger).toHaveAttribute('title', READ_ONLY_HINT);

  await trigger.click();
  const options = page.getByRole('option');
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText('自动');
  await expect(options.nth(1)).toContainText('完全权限');
  await expect(page.getByRole('listbox')).not.toContainText('沙箱');

  // The read-only state is not one of the options, so nothing is selected —
  // and the control must express that as "no value" rather than by handing the
  // Select a value it does not know.
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'false');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'false');

  // Opening and dismissing the menu is not a choice: no mode may change.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(trigger).toHaveText('只读');

  // Full access is one click away from a read-only session, and that click
  // fires exactly one choice: a single confirmation, and cancelling it leaves
  // the session where it was.
  await trigger.click();
  await page.getByRole('option').nth(1).click();
  await expect(page.locator('.maka-confirm-modal')).toHaveCount(1);
  await page.getByRole('button', { name: '保持自动' }).click();
  await expect(page.locator('.maka-confirm-modal')).toHaveCount(0);
  await expect(trigger).toHaveText('只读');

  // Keyboard navigation still works with nothing selected, and choosing Auto
  // is a real permission change.
  await trigger.click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveText('自动');
});

test('approving an expansion updates the permission label at once and after a reload', async ({
  sandboxBoundaryWindow: page,
}) => {
  const prompt = page.locator('.maka-sandbox-boundary-prompt');
  const trigger = page.locator('.maka-composer-left-controls [data-slot="select-trigger"]');

  // The session runs read-only and is asking to write outside the workspace.
  await expect(prompt).toHaveCount(1);

  await prompt.getByRole('button', { name: '本会话允许' }).click();
  await expect(prompt).toHaveCount(0);

  // #1611: the grant only bumps the boundary's revision — no session field
  // moves — so a surface that does not re-read authority would keep telling
  // the user this session cannot write, right after they let it.
  await expect(trigger).toHaveText('自动');

  // And it is the boundary saying so, not renderer state: it survives a reload,
  // where the renderer starts from nothing and has to read the boundary again.
  // The notice assertion adds that the composer came back because that read
  // landed, not because the surface gave up and fell open. It does NOT exercise
  // the retry — nothing rejects here — which the read model's own tests cover
  // deterministically (#1629).
  //
  // The composer returning is only a stable expectation because answering the
  // fixture's request now settles it: while an answered request kept coming
  // back on every hydration, whether the composer or the prompt won this frame
  // was a coin flip, and that was the real cause of the CI timeout that #1630
  // removed this half over.
  await page.reload();
  await expect(page.locator('.maka-composer-textarea')).toBeVisible();
  await expect(page.locator('.maka-boundary-unreadable-notice')).toHaveCount(0);
  await expect(trigger).toHaveText('自动');
});
