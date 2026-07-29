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
  // The click resolves when it is dispatched, not when the popup exists. Keys
  // sent before then land on nothing: no option is highlighted, Enter selects
  // nothing, and the label sits on 只读 until the assertion times out. Waiting
  // for the listbox the keys are aimed at fixes the sequence rather than
  // widening the window it is allowed to be wrong in (measured: 2/25 failures
  // without this line, 25/25 clean with it).
  await expect(page.getByRole('listbox')).toBeVisible();
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

  // The answer has to reach the fixture state itself, not just the active
  // request list. The renderer seeds its interaction queue straight out of
  // `e2eFixture:getState` on every boot, bypassing that list entirely, so a
  // retirement only one exit could see would put the prompt back over the
  // composer after the reload below — depending on which reply landed last.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const state = await window.maka.e2eFixture.getState();
        return Object.keys(state?.sandboxBoundaryBySession ?? {}).length;
      }),
    )
    .toBe(0);

  // And it is the boundary saying so, not renderer state: it survives a reload,
  // where the renderer starts from nothing and has to read the boundary again.
  // The notice assertion adds that the composer came back because that read
  // landed, not because the surface gave up and fell open. It does NOT exercise
  // the retry — nothing rejects here — which the read model's own tests cover
  // deterministically (#1629).
  //
  // The boot path reaches the answered request twice: the active-request list,
  // and the fixture state the renderer seeds its interaction queue from. Both
  // read one retirement now, so the assertions below are a settled state rather
  // than a frame they happened to catch — while either could still resurrect
  // the prompt, whichever reply landed last decided whether the composer or the
  // prompt owned the slot, and that coin flip is what timed out on CI.
  await page.reload();
  await expect(page.locator('.maka-composer-textarea')).toBeVisible();
  await expect(page.locator('.maka-boundary-unreadable-notice')).toHaveCount(0);
  await expect(trigger).toHaveText('自动');

  // Re-checked after the boot path has had time to run both seeds: a late
  // resurrection would take the slot back here rather than never happening.
  await expect(prompt).toHaveCount(0);
  await expect(page.locator('.maka-composer-textarea')).toBeVisible();
});
