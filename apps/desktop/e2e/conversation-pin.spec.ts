import { COMPOSER_INPUT, expect, test } from './fixtures';

test('a conversation can be pinned, survives reload, and can be unpinned by keyboard', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('conversation pin persistence');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: conversation pin persistence/)).toBeVisible();

  await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();
  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  const row = sidebar.locator('[data-maka-contract="session-row"]').first();
  const actions = row.getByRole('button', { name: '对话操作', exact: true });

  await actions.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '置顶', exact: true }).click();

  await expect(sidebar.getByText('置顶', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: '对话操作', exact: true })).toBeVisible();

  await page.reload();
  await expect(page.locator(COMPOSER_INPUT)).toBeVisible();

  const reloadedSidebar = page.getByRole('navigation', { name: '对话列表' });
  const reloadedRow = reloadedSidebar.locator('[data-maka-contract="session-row"]').first();
  const reloadedActions = reloadedRow.getByRole('button', { name: '对话操作', exact: true });
  await expect(reloadedSidebar.getByText('置顶', { exact: true })).toBeVisible();

  await reloadedActions.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '取消置顶', exact: true }).click();

  // The closed MoreMenu keeps its next "置顶" item mounted but hidden; the
  // section heading itself must disappear from the visible rail.
  await expect(reloadedSidebar.getByText('置顶', { exact: true })).not.toBeVisible();
  await expect(reloadedSidebar.getByText('最近', { exact: true })).toBeVisible();
});
