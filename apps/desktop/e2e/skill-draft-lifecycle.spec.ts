import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function createStarterSkill(page: Page): Promise<void> {
  const result = await page.evaluate(() => window.maka.skills.createStarter());
  expect(result.ok).toBe(true);
  await page.reload();
  await expect(page.locator('.maka-composer-textarea')).toBeVisible();
}

async function seedEditableTurn(page: Page): Promise<void> {
  const firstSend = page.locator('.maka-composer-textarea');
  await firstSend.fill('original message');
  await firstSend.press('Enter');
  await expect(page.getByText(/Fake backend received: original message/)).toBeVisible();
}

async function selectSkill(page: Page, name: RegExp): Promise<void> {
  const composer = page.locator('.maka-composer-textarea');
  await composer.fill('/');
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

  const composer = page.locator('.maka-composer-textarea');
  await composer.press('Enter');
  await expect(page.getByText('Skill 调用失败，消息未发送')).toBeVisible();
  await expect(composer).toHaveValue('edited with skill');
  await expect(page.locator('.maka-composer-skill-chip')).toContainText('示例技能');
}

test('a successful revision retry clears both child and source drafts', async ({
  window: page,
}) => {
  await createStarterSkill(page);
  await seedEditableTurn(page);
  await beginRevision(page);
  await selectSkill(page, /示例技能/);
  await page.locator('.maka-composer-textarea').fill('edited with skill');
  await failStarterSkillRevision(page);

  const enabled = await page.evaluate(() =>
    window.maka.skills.setEnabled('starter-skill', true),
  );
  expect(enabled.ok).toBe(true);
  await page.locator('.maka-composer-textarea').press('Enter');

  await expect(page.locator('[data-revision-notice="true"]')).toHaveCount(0);
  await expect(page.locator('.maka-composer-skill-chip')).toHaveCount(0);
  await expect(page.locator('.maka-composer-textarea')).toHaveValue('');
  await page.getByRole('button', { name: '查看上一版本' }).click();
  await expect(
    page.getByLabel('你发送的消息').getByText('original message', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.maka-composer-skill-chip')).toHaveCount(0);
  await expect(page.locator('.maka-composer-textarea')).toHaveValue('');
});

test('cancelling a failed revision restores the complete pre-edit draft', async ({
  invocableSkillsWindow: page,
}) => {
  await createStarterSkill(page);
  await seedEditableTurn(page);

  const composer = page.locator('.maka-composer-textarea');
  await selectSkill(page, /Workspace Only/);
  await composer.fill('previous unsent draft');
  await beginRevision(page);
  await page.locator('.maka-composer-skill-chip').getByRole('button').click();
  await selectSkill(page, /示例技能/);
  await composer.fill('edited with skill');
  await failStarterSkillRevision(page);

  await page.getByRole('button', { name: '取消' }).click();

  await expect(page.locator('[data-revision-notice="true"]')).toHaveCount(0);
  await expect(composer).toHaveValue('previous unsent draft');
  await expect(page.locator('.maka-composer-skill-chip')).toHaveCount(1);
  await expect(page.locator('.maka-composer-skill-chip')).toContainText('Workspace Only');
});
