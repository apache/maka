import { expect, test, COMPOSER_INPUT } from './fixtures';

test('groups commands before Skills and stages a command without running it', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('seed session');
  await composer.press('Enter');
  await expect(page.getByText('Fake backend received: seed session')).toBeVisible();

  await composer.click();
  await composer.pressSequentially('/');

  const menu = page.getByRole('listbox', { name: '命令和技能' });
  const groups = menu.getByRole('group');
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAttribute('aria-label', '命令');
  await expect(groups.nth(1)).toHaveAttribute('aria-label', 'Skills');

  const compact = groups.nth(0).getByRole('option', { name: /压缩上下文.*\/compact/ });
  await expect(compact).toBeVisible();
  await compact.click();

  await expect.poll(() => composer.textContent()).toBe('/compact ');
  await expect(menu).not.toBeVisible();
});
