import { test, expect } from './fixtures';

test('project picker keeps fixed actions outside the scroll region and can create an unassigned task', async ({
  window: page,
}) => {
  const picker = page.locator('.maka-composer-workspace-picker');
  await picker.click();

  const projectScroll = page.locator('.maka-composer-project-scroll');
  const addProject = page.getByRole('menuitem', { name: '添加项目' });
  const noProject = page.getByRole('menuitem', { name: '无项目' });
  await expect(projectScroll).toBeAttached();
  await expect(addProject).toBeVisible();
  await expect(noProject).toBeVisible();
  await expect(projectScroll).toHaveCSS('overflow-y', 'auto');
  expect(await projectScroll.locator('text=添加项目').count()).toBe(0);
  expect(await projectScroll.locator('text=无项目').count()).toBe(0);

  await noProject.click();
  await expect(picker).toContainText('无项目');

  const composer = page.locator('.maka-composer-textarea');
  await composer.fill('unassigned-project-marker');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: unassigned-project-marker/)).toBeVisible();

  await page.getByRole('button', { name: '展开侧边栏' }).click();
  const sidebar = page.locator('.maka-session-panel');
  await sidebar.getByRole('button', { name: '会话分组方式' }).click();
  await page.getByRole('menuitemradio', { name: '按项目' }).click();
  await expect(sidebar.locator('.maka-list-project-heading').filter({ hasText: '未归属项目' })).toBeVisible();
});
