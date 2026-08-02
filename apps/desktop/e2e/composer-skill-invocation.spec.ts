import type { Page } from '@playwright/test';
import { expect, test, COMPOSER_INPUT } from './fixtures';

async function createStarterSkillAndReload(page: Page): Promise<void> {
  const result = await page.evaluate(() => window.maka.skills.createStarter());
  expect(result.ok).toBe(true);
  await page.reload();
  await expect(page.locator(COMPOSER_INPUT)).toBeVisible();
  // The `/` menu lists what the renderer has projected, and that projection is
  // refreshed asynchronously after load. Wait for the Skill to be invocable so
  // an empty first search is never mistaken for a missing suggestion.
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.maka.skills.listInvocable(undefined))).map(
        (skill) => skill.id,
      ),
    )
    .toContain('starter-skill');
}

/** The staged Skill's inline chip, addressed by the token it serializes to. */
const STARTER_CHIP = '[data-astryx-token-value="/skill:starter-skill"]';

/**
 * Pick 示例技能 from the `/` menu. `append` types the trigger after whatever
 * is already in the draft; the default replaces the draft, which is what a
 * chip-only send needs.
 */
async function selectStarterSkill(
  page: Page,
  options: { append?: boolean } = {},
): Promise<void> {
  const composer = page.locator(COMPOSER_INPUT);
  if (options.append) {
    await composer.click();
    await composer.pressSequentially(' /');
  } else {
    await composer.fill('/');
  }
  const listbox = page.getByRole('listbox', { name: '技能' });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole('option', { name: /示例技能/ })).toBeVisible();
  await composer.press('Enter');
  await expect(page.locator(STARTER_CHIP)).toContainText('示例技能');
}

test('slash suggestions follow Runtime project discovery and host gating', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('/');
  const listbox = page.getByRole('listbox', { name: '技能' });
  await expect(listbox).toBeVisible();
  await expect(listbox).toContainText('Project Only');
  await expect(listbox).toContainText('Workspace Only');
  await expect(listbox).toContainText('Agent Write');
  await expect(listbox).not.toContainText('Host Incompatible');

  const planNames = await page.evaluate(async () =>
    (await window.maka.skills.listInvocable(undefined, {
      collaborationMode: 'plan',
    })).map((skill) => skill.name),
  );
  expect(planNames).not.toContain('Agent Write');
});

test('slash suggestions in a Deep Research session drop non-research Skills', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  const listbox = page.getByRole('listbox', { name: '技能' });

  await composer.fill('/');
  await expect(listbox).toBeVisible();
  await expect(listbox).not.toContainText('Deep Research Only');
  await composer.fill('');

  await page.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: '打开命令面板' }).click();
  await page.getByRole('dialog', { name: '命令面板' }).getByRole('option', { name: /新建深度研究/ }).click();
  await expect(page.getByLabel('深度研究，只读探索').filter({ visible: true })).toBeVisible();

  await composer.fill('/');
  await expect(listbox).toContainText('Deep Research Only');
});

test('open Skill suggestions follow current collaboration capabilities', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await expect(composer).toBeVisible();
  await composer.fill('Open a session');
  await composer.press('Enter');
  await expect.poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length).toBe(1);
  const [session] = await page.evaluate(() => window.maka.sessions.list());
  if (!session) throw new Error('the composer did not create a session');

  const listNames = (sessionId: string) =>
    page.evaluate(
      async (id) => (await window.maka.skills.listInvocable(id)).map((skill) => skill.name),
      sessionId,
    );

  await expect.poll(() => listNames(session.id)).toContain('Agent Write');
  await composer.fill('/');
  const listbox = page.getByRole('listbox', { name: '技能' });
  await expect(listbox).toContainText('Agent Write');

  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list()))[0]?.status)
    .not.toBe('running');
  await page.evaluate(
    ({ sessionId }) => window.maka.sessions.setCollaborationMode(sessionId, 'plan'),
    { sessionId: session.id },
  );
  await expect.poll(() => listNames(session.id)).not.toContain('Agent Write');
  await expect(listbox).not.toContainText('Agent Write');
});

/**
 * #1912: ＋ → 选择技能 opens the SAME `/` menu the keyboard opens, by typing the
 * trigger. There is no second Skill surface — the multi-select panel that used
 * to live here is gone, and with it the transparent, product-owned popover that
 * was the reported defect.
 *
 * The half that only a real window can show is the trigger boundary.
 * `useTriggerMenu` recognizes `/` at a line start or after a space or newline,
 * so ＋ on a draft that ends in anything else has to insert the space itself.
 * Get that wrong and ＋ does nothing at all, silently, and only when a draft is
 * present. The draft here ends in a chip, whose U+00A0 anchor is the character
 * that looks like a space and is not one.
 */
test('the ＋ Skills entry opens the `/` menu, before and after a chip', async ({
  window: page,
}) => {
  await createStarterSkillAndReload(page);

  const composer = page.locator(COMPOSER_INPUT);
  const listbox = page.getByRole('listbox', { name: '技能' });
  const plus = page.locator('.maka-composer-plus-menu').getByRole('button');
  const skillsEntry = page.getByRole('menuitem', { name: '选择技能' });
  const openFromPlus = async () => {
    // Astryx ignores clicks on a float for ~100ms after one light-dismisses,
    // and picking from the `/` menu dismisses one. Nothing observable marks the
    // end of that window, so retry the click until ＋ answers rather than sleep
    // past it — under the threshold the click reaches nothing at all.
    await expect(async () => {
      await plus.click();
      await expect(skillsEntry).toBeVisible({ timeout: 500 });
    }).toPass();
    await skillsEntry.click();
  };

  // Empty draft: the trigger is at a line start, so no space is needed.
  await openFromPlus();
  await expect(listbox.getByRole('option', { name: /示例技能/ })).toBeVisible();
  await composer.press('Enter');
  await expect(page.locator(STARTER_CHIP)).toContainText('示例技能');

  await openFromPlus();
  await expect(listbox).toBeVisible();

  // Escape leaves the typed trigger behind, exactly as it does when the user
  // types `/` themselves — it is ordinary draft text, not a surface to dismiss.
  await page.keyboard.press('Escape');
  await expect(listbox).toBeHidden();
  await expect(composer).toContainText('/');
});

/**
 * The staged Skill has to still look staged after the draft comes back.
 *
 * `ChatComposerInput` rebuilds the editor from the string on every external
 * value change, which drops the chip spans and leaves the `/skill:<id>` text
 * they serialize to (facebook/astryx #4655). That draft still sends the Skill,
 * but the user is looking at an internal id where they left a chip, and this is
 * the ordinary path: any session that ever staged a Skill hits it on the way
 * back.
 *
 * Two Skills, one of them mid-draft, because the redraw walks the tokens back
 * to front so that replacing a later one cannot move an earlier one's offsets.
 * A single token at the end of the draft would never exercise that.
 *
 * Blurred on purpose: the swap runs from a sidebar click, so the redraw has to
 * work without the editor holding focus, and the caret still has to land after
 * the draft rather than at offset 0. The send at the end is the other half —
 * `insertToken` anchors every chip with a U+00A0, and the wire text has to come
 * out with ordinary spaces regardless.
 */
test('staged Skills come back as chips after leaving and returning', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  const projectChip = page.locator('[data-astryx-token-value="/skill:project-only"]');
  const workspaceChip = page.locator('[data-astryx-token-value="/skill:workspace-only"]');
  const pick = async (query: string, name: RegExp) => {
    await composer.click();
    await composer.pressSequentially(` /${query}`);
    await expect(
      page.getByRole('listbox', { name: '技能' }).getByRole('option', { name }),
    ).toBeVisible();
    await composer.press('Enter');
  };

  await composer.fill('alpha-marker');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: alpha-marker/)).toBeVisible();

  await pick('project', /Project Only/);
  await composer.pressSequentially('run it');
  await pick('workspace', /Workspace Only/);
  await expect(projectChip).toContainText('Project Only');

  await page.getByRole('button', { name: '展开侧边栏' }).click();
  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  await sidebar.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(composer).toHaveText('');

  await sidebar.locator('[data-session-id]').first().click();
  await expect(composer).toContainText('run it');
  await expect(projectChip).toContainText('Project Only');
  await expect(workspaceChip).toContainText('Workspace Only');
  // The token text itself is gone: a chip drawn beside the text it renders
  // would mean the draft now carried the Skill twice.
  await expect(composer).not.toContainText('/skill:');

  await composer.click();
  await composer.press('Enter');
  await expect(page.getByLabel('你发送的消息').last()).toContainText(
    '/skill:project-only run it /skill:workspace-only',
  );
});

test('chip-only send renders a readable user message', async ({ window: page }) => {
  await createStarterSkillAndReload(page);
  await selectStarterSkill(page);

  const composer = page.locator(COMPOSER_INPUT);
  await composer.press('Enter');

  await expect(page.getByLabel('你发送的消息').first()).toContainText('/skill:starter-skill');
});

test('a blocked Skill invocation keeps the complete composer draft', async ({
  window: page,
}) => {
  await createStarterSkillAndReload(page);
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('run it');
  await selectStarterSkill(page, { append: true });
  const disabled = await page.evaluate(() => window.maka.skills.setEnabled('starter-skill', false));
  expect(disabled.ok).toBe(true);

  await composer.press('Enter');

  await expect(page.getByText('Skill 调用失败，消息未发送')).toBeVisible();
  await expect(composer).toContainText('run it');
  await expect(page.locator(STARTER_CHIP)).toContainText('示例技能');
  await expect(page.locator('.maka-turn')).toHaveCount(0);
  // #1433: the composer creates the session BEFORE it sends, so a rejected
  // first send has to remove it again. Otherwise every blocked invocation
  // leaves a nameless empty session in the sidebar. `quick-chat.ts` used to
  // carry unit tests for this; when the composer became the only first-send
  // path, nothing was asserting it any more.
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(0);
});
