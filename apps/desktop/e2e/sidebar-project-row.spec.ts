import {
  LONG_SIDEBAR_PROJECT_ID,
  LONG_SIDEBAR_PROJECT_NAME,
  LONG_SIDEBAR_SESSION_PREFIX,
} from '../src/main/e2e-fixture/seed-helpers';
import type { Locator } from '@playwright/test';
import { expect, test } from './fixtures';

function sessionRow(sidebar: Locator, sessionId: string): Locator {
  return sidebar.locator(`[data-session-id*=${JSON.stringify(sessionId)}]`);
}

test('project navigation and actions remain adjacent keyboard controls', async ({
  projectSidebarWindow: page,
}) => {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-maka-contract="search-modal"]')).not.toBeVisible();

  const sidebar = page.getByRole('navigation', { name: '任务列表' });
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

  await expect(navigation).toBeVisible();
  await expect(firstSessionControl).toBeVisible();
  const [projectNavigationBox, firstSessionBox] = await Promise.all([
    navigation.boundingBox(),
    firstSessionControl.boundingBox(),
  ]);
  expect(projectNavigationBox).not.toBeNull();
  expect(firstSessionBox).not.toBeNull();
  expect(firstSessionBox!.x - projectNavigationBox!.x).toBeGreaterThanOrEqual(20);

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

test('task row action menu accepts pointer selection', async ({
  projectSidebarWindow: page,
}) => {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-maka-contract="search-modal"]')).not.toBeVisible();

  const sidebar = page.getByRole('navigation', { name: '任务列表' });
  const taskRow = sessionRow(sidebar, `${LONG_SIDEBAR_SESSION_PREFIX}00`);
  await taskRow.hover();
  await taskRow.getByRole('button', { name: '任务操作', exact: true }).click();

  const rename = page.getByRole('menuitem', { name: '重命名', exact: true });
  await expect(rename).toBeVisible();
  await rename.click();

  await expect(page.getByRole('dialog', { name: '重命名任务' })).toBeVisible();
});

test('rail grouping survives a renderer reload', async ({ projectSidebarWindow: page }) => {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-maka-contract="search-modal"]')).not.toBeVisible();

  const sidebar = page.getByRole('navigation', { name: '任务列表' });
  const byTime = sidebar.getByRole('radio', { name: '按时间', exact: true });
  const byProject = sidebar.getByRole('radio', { name: '按项目', exact: true });

  await expect(byTime).toBeChecked();
  await byProject.click();
  await expect(byProject).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('maka-chat-list-view-mode-v1')))
    .toBe('project');

  await page.reload();
  await expect(page.locator('[data-maka-contract="search-modal"][open]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-maka-contract="search-modal"]')).not.toBeVisible();

  await expect(sidebar.getByRole('radio', { name: '按项目', exact: true })).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('maka-chat-list-view-mode-v1')))
    .toBe('project');
});
