import { expect, test } from './fixtures';

/**
 * PR-COMPOSER-TOOLBAR-SPLIT: the composer's single ＋ menu became three named
 * controls — upload / modes / skills — placed in their native Astryx slots. The mode menu itself is
 * covered by composer-mode-indicator.spec.ts; this spec pins the two surfaces
 * that menu never had: the standalone upload trigger, and the Skills picker
 * writing into the SAME structured draft the `/` popup owns
 * (composer-skill-invocation.spec.ts covers the `/` side).
 */
test('the toolbar exposes upload, modes and skills as separate triggers', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator('.maka-composer-astryx');
  const headerActions = composer.locator('.maka-composer-header-actions');
  const footerActions = composer.locator('.maka-composer-left-controls');
  await expect(headerActions.getByRole('button', { name: '添加文件或目录' })).toBeVisible();
  await expect(footerActions.getByRole('button', { name: '模式' })).toBeVisible();
  await expect(footerActions.getByRole('button', { name: '技能' })).toBeVisible();
  // The retired ＋ trigger must not linger beside them.
  await expect(composer.getByRole('button', { name: '添加', exact: true })).toHaveCount(0);
});

test('the Skills picker writes the same chips the slash popup does', async ({
  invocableSkillsWindow: page,
}) => {
  const trigger = page.getByRole('button', { name: '技能' });
  await trigger.click();

  const panel = page.getByRole('group', { name: '技能选择' });
  await expect(panel).toBeVisible();
  // Search narrows the catalog; the picker filters by name/id/description.
  await panel.getByRole('textbox', { name: '搜索技能…' }).fill('Project Only');
  const option = panel.getByRole('checkbox', { name: /Project Only/ });
  await expect(option).toHaveAttribute('aria-checked', 'false');
  await option.click();
  await expect(option).toHaveAttribute('aria-checked', 'true');

  // Selecting produces the same chip the `/` popup produces, and the trigger
  // carries the count so an active selection is legible with the panel closed.
  const chip = page.locator('.maka-composer-skill-chip');
  await expect(chip).toContainText('Project Only');
  await expect(page.locator('.maka-composer-skill-trigger-count')).toHaveText('1');

  // Esc closes the panel and returns focus to the trigger it came from.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(chip).toContainText('Project Only');

  // 清除全部 drops the whole selection, chips included.
  await trigger.click();
  await page.getByRole('button', { name: '清除全部' }).click();
  await expect(chip).toHaveCount(0);
  await expect(page.locator('.maka-composer-skill-trigger-count')).toHaveCount(0);
});
