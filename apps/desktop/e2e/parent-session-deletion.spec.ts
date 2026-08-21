import {
  expect,
  PARENT_REMOVAL_CHILD_NAME,
  PARENT_REMOVAL_PARENT_NAME,
  test,
} from './fixtures';

test('deleting a parent task archives its linked subagent task', async ({
  parentRemovalWindow: page,
}) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  const taskList = page.getByRole('navigation', { name: '任务列表' });
  const parentRow = taskList
    .locator('[data-maka-contract="session-row"]')
    .filter({ hasText: PARENT_REMOVAL_PARENT_NAME });

  await expect(parentRow).toHaveCount(1);
  await expect(taskList.getByText(PARENT_REMOVAL_CHILD_NAME, { exact: true })).toHaveCount(0);

  await parentRow.hover();
  await parentRow.getByRole('button', { name: '任务操作' }).click();
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  const confirm = page.getByRole('alertdialog', {
    name: `删除 "${PARENT_REMOVAL_PARENT_NAME}"`,
  });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '删除', exact: true }).click();

  await expect(parentRow).toHaveCount(0);
  await expect(taskList.getByText(PARENT_REMOVAL_CHILD_NAME, { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('main', { name: '设置内容' })).toBeVisible();
  await page.getByRole('button', { name: '已归档任务', exact: true }).click();

  const archivedTasks = page.getByRole('main', { name: '设置内容' });
  await expect(archivedTasks.getByText(PARENT_REMOVAL_CHILD_NAME, { exact: true })).toBeVisible();
  await expect(archivedTasks.getByText(/原父任务已删除/)).toBeVisible();
  await expect(archivedTasks.getByText(PARENT_REMOVAL_PARENT_NAME, { exact: true })).toHaveCount(0);
});
