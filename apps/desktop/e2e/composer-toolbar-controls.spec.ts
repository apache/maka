import { expect, test } from './fixtures';

/**
 * Quiet composer: upload / modes / skills collapse into the ＋ menu.
 * Skills still write the same structured draft chips as the `/` popup
 * (composer-skill-invocation.spec.ts covers the slash path).
 */
test('the plus menu exposes attach, skills, and collaboration modes', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator('.maka-composer-astryx');
  const plus = composer.getByRole('button', { name: '添加上下文' });
  await expect(plus).toBeVisible();

  // Retired standalone toolbar triggers must not linger.
  await expect(composer.getByRole('button', { name: '添加文件或目录' })).toHaveCount(0);
  await expect(composer.getByRole('button', { name: '模式' })).toHaveCount(0);
  await expect(composer.getByRole('button', { name: '技能' })).toHaveCount(0);

  await plus.click();
  await expect(page.getByRole('menuitem', { name: '添加文件或目录' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '选择技能' })).toBeVisible();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Plan' })).toBeVisible();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Swarm' })).toBeVisible();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Graph' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Plan' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('the Skills entry from plus writes the same tokens the slash popup does', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator('.maka-composer-astryx');
  const plus = composer.getByRole('button', { name: '添加上下文' });
  await plus.click();
  await page.getByRole('menuitem', { name: '选择技能' }).click();

  const panel = page.getByRole('group', { name: '技能选择' });
  await expect(panel).toBeVisible();
  await panel.getByRole('textbox', { name: '搜索技能…' }).fill('Project Only');
  const option = panel.getByRole('checkbox', { name: /Project Only/ });
  await expect(option).toHaveAttribute('aria-checked', 'false');
  await option.click();
  await expect(option).toHaveAttribute('aria-checked', 'true');

  // Staged selection is a drawer token (Astryx Token), same draft as `/`.
  const skillToken = page.locator('.maka-composer-skill-token');
  await expect(skillToken).toContainText('Project Only');

  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(skillToken).toContainText('Project Only');
  // Esc restores focus to the ＋ opener (hideTrigger skill panel).
  await expect(plus).toBeFocused();
});
