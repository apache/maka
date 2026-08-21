import { test, expect, COMPOSER_INPUT } from './fixtures';

test('opening settings commits an active titlebar rename', async ({ window: page }) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create a session for settings rename');
  await composer.press('Enter');

  const identity = page.locator('[data-maka-contract="titlebar-identity"]');
  await expect(identity).toBeVisible();
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await identity.getByRole('button', { name: /重命名任务/ }).click();
  await page.getByRole('textbox', { name: '重命名任务' }).fill('renamed before settings');

  // Programmatic activation preserves input focus, matching the macOS
  // application-menu command that opens Settings before Chromium can blur it.
  await page.getByRole('button', { name: '设置' }).evaluate((button) => button.click());
  await expect(page.getByRole('main', { name: '设置内容' })).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(identity).toContainText('renamed before settings');
});

test('settings hides expanded workbar chrome and restores it on close', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create a session with an expanded workbar');
  await composer.press('Enter');

  await page.getByRole('button', { name: '展开任务工作栏' }).click();
  const workbar = page.locator('.maka-session-workbar[data-placement="right"]');
  const workbarToolbar = workbar.getByRole('toolbar', { name: '任务工作栏标签' });
  await expect(workbarToolbar).toBeVisible();
  await expect(workbarToolbar.getByRole('button', { name: '打开工作栏标签' })).toBeVisible();
  await expect(workbarToolbar.getByRole('button', { name: '收起任务工作栏' })).toBeVisible();
  await page
    .getByRole('button', { name: /待办.*查看和维护这个任务的待办台账/ })
    .click();
  const taskTab = workbarToolbar.getByRole('tab', { name: '待办' });
  await expect(taskTab).toBeVisible();

  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('main', { name: '设置内容' })).toBeVisible();
  await expect(workbar).not.toBeVisible();

  await page.keyboard.press('Escape');
  await expect(workbarToolbar).toBeVisible();
  await expect(taskTab).toBeVisible();
});
