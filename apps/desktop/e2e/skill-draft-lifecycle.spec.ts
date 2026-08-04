import type { Page } from '@playwright/test';
import { expect, test, COMPOSER_INPUT } from './fixtures';

/**
 * Revision drafts, per session, with a Skill staged in them.
 *
 * A staged Skill is a `/skill:<id>` chip inside the draft text, so every path
 * here — begin edit, prepare the branch, fail the send, cancel back — moves it
 * by moving the text. The point of these journeys is that nothing has to carry
 * the Skill separately for that to hold.
 */
async function createStarterSkill(page: Page): Promise<void> {
  const result = await page.evaluate(() => window.maka.skills.createStarter());
  expect(result.ok).toBe(true);
  await page.reload();
  await expect(page.locator(COMPOSER_INPUT)).toBeVisible();
}

async function seedEditableTurn(page: Page): Promise<void> {
  const firstSend = page.locator(COMPOSER_INPUT);
  await firstSend.fill('original message');
  await firstSend.press('Enter');
  await expect(page.getByText(/Fake backend received: original message/)).toBeVisible();
}

/** Type the draft, then append the Skill chip — the order a user works in. */
async function composeWithSkill(page: Page, text: string, name: RegExp): Promise<void> {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(text);
  await composer.click();
  await composer.pressSequentially(' /');
  const option = page.getByRole('listbox', { name: '技能' }).getByRole('option', { name });
  await expect(option).toBeVisible();
  await option.click();
}

async function beginRevision(page: Page): Promise<void> {
  const userMessage = page.getByLabel('你发送的消息').first();
  await userMessage.hover();
  await userMessage.getByRole('button', { name: '编辑并重发' }).click();
  await expect(page.locator('[data-revision-notice="true"]')).toBeVisible();
}

async function failStarterSkillRevision(page: Page): Promise<void> {
  const disabled = await page.evaluate(() =>
    window.maka.skills.setEnabled('starter-skill', false),
  );
  expect(disabled.ok).toBe(true);

  const composer = page.locator(COMPOSER_INPUT);
  await composer.press('Enter');
  await expect(page.getByText('Skill 调用失败，消息未发送')).toBeVisible();
  // The draft survives the rejection whole, and reads as the token rather than
  // as a chip: the Skill was just disabled, so it is gone from the catalog the
  // composer draws chips from. A chip here would promise a Skill that no longer
  // resolves — the text is the honest rendering, and re-enabling it below sends.
  await expect(composer).toContainText('edited with skill');
  await expect(composer).toContainText('/skill:starter-skill');
}

test('a successful revision retry clears both child and source drafts', async ({
  window: page,
}) => {
  await createStarterSkill(page);
  await seedEditableTurn(page);
  await beginRevision(page);
  await composeWithSkill(page, 'edited with skill', /示例技能/);
  await failStarterSkillRevision(page);

  const enabled = await page.evaluate(() =>
    window.maka.skills.setEnabled('starter-skill', true),
  );
  expect(enabled.ok).toBe(true);
  await page.locator(COMPOSER_INPUT).press('Enter');

  await expect(page.locator('[data-revision-notice="true"]')).toHaveCount(0);
  await expect(page.locator(COMPOSER_INPUT)).toHaveText('');
  await page.getByRole('button', { name: '查看上一版本' }).click();
  await expect(
    page.getByLabel('你发送的消息').getByText('original message', { exact: true }),
  ).toBeVisible();
  await expect(page.locator(COMPOSER_INPUT)).toHaveText('');
});

test('cancelling a failed revision restores the complete pre-edit draft', async ({
  invocableSkillsWindow: page,
}) => {
  await createStarterSkill(page);
  await seedEditableTurn(page);

  const composer = page.locator(COMPOSER_INPUT);
  await composeWithSkill(page, 'previous unsent draft', /Workspace Only/);
  await beginRevision(page);
  await composeWithSkill(page, 'edited with skill', /示例技能/);
  await failStarterSkillRevision(page);

  await page.getByRole('button', { name: '取消' }).click();

  await expect(page.locator('[data-revision-notice="true"]')).toHaveCount(0);
  // Restored through a single controlled write, which rebuilds the editor from
  // the serialized draft; the Skill comes back as a chip because the composer
  // redraws it from that text, not because anything carried it separately.
  await expect(composer).toContainText('previous unsent draft');
  await expect(
    page.locator('[data-astryx-token-value="/skill:workspace-only"]'),
  ).toContainText('Workspace Only');
});
