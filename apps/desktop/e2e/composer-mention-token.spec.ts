import { expect, test, COMPOSER_INPUT } from './fixtures';

/**
 * The `@` file trigger: menu → inline token → the path the backend receives.
 * The token is a real chip in the draft now, so this also pins the one cascade
 * invariant it depends on — the token span must shrink to its badge. A
 * `[contenteditable]` selector that also matched the token's
 * `contenteditable="false"` stretched it to the full line and pushed the
 * surrounding text onto separate rows.
 */
test('a picked file mention becomes an inline token and sends as its path', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('看一下 @agent');

  const listbox = page.getByRole('listbox', { name: '工作区文件' });
  await expect(listbox.getByRole('option').first()).toBeVisible();
  await composer.press('Enter');
  await composer.pressSequentially('里的说明');
  await composer.pressSequentially('；普通文本 @.maka/skills/agent-write/SKILL.md');
  await composer.press('Escape');

  const token = composer.locator('[data-astryx-token]');
  await expect(token).toHaveAttribute(
    'data-astryx-token-value',
    '@.maka/skills/agent-write/SKILL.md',
  );
  await composer.press('Enter');
  const bubble = page.getByLabel('你发送的消息').first();
  await expect(bubble).toBeVisible();
  const sentFileBadges = bubble.locator('.maka-chat-message-bubble-user .astryx-badge');
  await expect(sentFileBadges).toHaveCount(1);
  await expect(sentFileBadges).toHaveText('SKILL.md');
  await expect(bubble).toContainText(
    '看一下 SKILL.md 里的说明；普通文本 @.maka/skills/agent-write/SKILL.md',
  );
  // The transcript replays the selected token's label, while the model still
  // receives the exact serialized path with normalized spacing.
  await expect(
    page.getByText(
      'Fake backend received: 看一下 @.maka/skills/agent-write/SKILL.md 里的说明；普通文本 @.maka/skills/agent-write/SKILL.md',
    ),
  ).toBeVisible();

  await page.reload();
  const reloadedBubble = page.getByLabel('你发送的消息').first();
  await expect(reloadedBubble).toBeVisible();
  await expect(
    reloadedBubble.locator('.maka-chat-message-bubble-user .astryx-badge'),
  ).toHaveCount(1);
  await expect(reloadedBubble).toContainText(
    '普通文本 @.maka/skills/agent-write/SKILL.md',
  );
});

/**
 * Upstream contract: the trigger boundaries are Astryx's `findActiveTrigger`
 * now, and it is NOT equivalent to the `detectMentionTrigger` it replaced — a
 * space ends an `@` query, so a path with a space in it can no longer be
 * searched. Pin the grammar we actually depend on so an Astryx upgrade that
 * moves a boundary fails here rather than in front of a user.
 */
test('the trigger menu opens exactly on the boundaries we depend on', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  const expanded = () => composer.getAttribute('aria-expanded');
  const files = page.getByRole('listbox', { name: '工作区文件' });

  await composer.fill('看一下 @agent');
  await expect(files).toBeVisible();

  // A space ends the query — narrowing an `@` search by a second word, which
  // the retired popup allowed, is gone.
  await composer.pressSequentially(' write');
  await expect.poll(expanded).toBe('false');

  // A non-boundary `@` is not a trigger.
  await composer.fill('mail user@host.com');
  await expect.poll(expanded).toBe('false');

  // The nearest boundary wins.
  await composer.fill('@a /b');
  await expect(page.getByRole('listbox', { name: /技能/ })).toBeVisible();
  await expect(files).toHaveCount(0);
});

/**
 * An open menu with nothing highlighted (still loading, or no matches) leaves
 * Enter unconsumed. It must not send the draft out from under the popup — and
 * it must not deadlock either: "no matches" is a stable state, so swallowing
 * Enter forever would leave the keyboard unable to send at all.
 */
test('Enter with an open, empty trigger menu withholds one send, not every send', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('@zzzznomatchzzzz');
  await expect(page.getByRole('listbox', { name: '工作区文件' })).toBeVisible();

  // A leaked send is asynchronous, so `toHaveCount(0)` here would pass before
  // it lands — and a second Enter sending the same text would then hide it.
  // Withhold, retype into something distinguishable, and pin the total.
  await composer.press('Enter');
  await composer.press('Enter');
  await expect(page.getByText('Fake backend received: @zzzznomatchzzzz')).toBeVisible();
  await expect(page.getByLabel('你发送的消息')).toHaveCount(1);
});

/**
 * The menu has to follow the caret, not just the text. Astryx recomputes the
 * active trigger only on `input`, so an arrow key off the query used to leave
 * the menu open over a trigger no longer under the cursor — and the next Enter
 * spliced a token in at the stale offset instead of sending.
 */
test('moving the caret off the query closes the trigger menu', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('看一下 @agent');
  await expect(page.getByRole('listbox', { name: '工作区文件' })).toBeVisible();

  for (let index = 0; index < 6; index += 1) await composer.press('ArrowLeft');
  await expect.poll(() => composer.getAttribute('aria-expanded')).toBe('false');

  await composer.press('Enter');
  await expect(page.getByText('Fake backend received: 看一下 @agent')).toBeVisible();
  await expect(composer.locator('[data-astryx-token]')).toHaveCount(0);
});
