import { test, expect } from './fixtures';

// Project picker product journey. "Fixed actions outside the scroll region"
// is owned by `.maka-composer-project-scroll` CSS
// (chat-shell-layout-contract.test.ts).
test('project picker can create an unassigned task and surfaces it under project grouping', async ({
  window: page,
}) => {
  const picker = page.locator('.maka-composer-workspace-picker');
  await picker.click();

  const noProject = page.getByRole('menuitem', { name: '无项目' });
  await expect(page.getByRole('menuitem', { name: '添加项目' })).toBeVisible();
  await expect(noProject).toBeVisible();
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
  // Project groups are collapsible SideNav items, not the retired heading class.
  await expect(sidebar.locator('[data-project-id]').filter({ hasText: '未归属项目' })).toBeVisible();
});
