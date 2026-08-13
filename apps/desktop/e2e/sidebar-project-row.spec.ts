import {
  LONG_SIDEBAR_PROJECT_ID,
  LONG_SIDEBAR_PROJECT_NAME,
} from '../src/main/e2e-fixture/seed-helpers';
import { expect, test } from './fixtures';

test('project navigation and actions remain adjacent keyboard controls', async ({
  projectSidebarWindow: page,
}) => {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-maka-contract="search-modal"]')).not.toBeVisible();

  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  await sidebar.getByRole('radio', { name: '按项目', exact: true }).click();

  const projectRow = sidebar.locator(
    `[data-project-id="project:${LONG_SIDEBAR_PROJECT_ID}"]`,
  );
  const action = projectRow.getByRole('button', {
    name: `${LONG_SIDEBAR_PROJECT_NAME} 项目操作`,
    exact: true,
  });
  const navigation = projectRow.locator(
    'button[aria-controls]:not([aria-haspopup="menu"])',
  );
  const controlledGroupId = await navigation.getAttribute('aria-controls');
  expect(controlledGroupId).toBeTruthy();
  const controlledGroup = page.locator(`[id="${controlledGroupId}"]`);
  const firstSessionControl = controlledGroup.locator('[data-session-id] button').first();

  await expect(projectRow.locator('button button')).toHaveCount(0);
  await expect(navigation).toHaveAttribute('aria-expanded', 'true');

  await action.focus();
  await page.keyboard.press('Tab');
  await expect(navigation).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(firstSessionControl).toBeFocused();

  await navigation.focus();
  await page.keyboard.press('Enter');
  await expect(navigation).toHaveAttribute('aria-expanded', 'false');
  await expect(controlledGroup).toHaveAttribute('aria-hidden', 'true');
  expect(await controlledGroup.getAttribute('inert')).not.toBeNull();
  await page.keyboard.press('Enter');
  await expect(navigation).toHaveAttribute('aria-expanded', 'true');
  await expect(controlledGroup).toHaveAttribute('aria-hidden', 'false');
  expect(await controlledGroup.getAttribute('inert')).toBeNull();

  await action.focus();
  await page.keyboard.press('Enter');
  const newTaskItem = page.getByRole('menuitem', { name: '新建任务', exact: true });
  await expect(newTaskItem).toBeVisible();
  await expect(navigation).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(newTaskItem).not.toBeVisible();
  await expect(action).toBeFocused();

  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '重命名项目' })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(action).toBeFocused();
});
