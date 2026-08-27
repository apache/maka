/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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

test('project navigation and actions follow their visual keyboard order', async ({
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
  const projectTitle = navigation.getByText(LONG_SIDEBAR_PROJECT_NAME, { exact: true });
  const sessionTitle = firstSessionControl.getByText('任务 00', { exact: true });
  await expect(projectTitle).toBeVisible();
  await expect(sessionTitle).toBeVisible();
  const [projectNavigationBox, firstSessionBox] = await Promise.all([
    navigation.boundingBox(),
    firstSessionControl.boundingBox(),
  ]);
  expect(projectNavigationBox).not.toBeNull();
  expect(firstSessionBox).not.toBeNull();
  // Nested session buttons share the project header's inline box. Folder vs
  // status-dot still mark the tree; the selected fill must not sit inset.
  const sessionInset = firstSessionBox!.x - projectNavigationBox!.x;
  expect(Math.abs(sessionInset)).toBeLessThanOrEqual(2);
  expect(Math.abs(firstSessionBox!.width - projectNavigationBox!.width)).toBeLessThanOrEqual(2);

  await expect(projectRow.locator('button button')).toHaveCount(0);
  await expect(navigation).toHaveAttribute('aria-expanded', 'true');
  await expect(navigation.locator('.lucide-folder-open')).toBeVisible();
  await expect(navigation.locator('.lucide-folder-closed')).toHaveCount(0);
  await expect(navigation.locator(':scope > span').last()).toBeHidden();

  await navigation.focus();
  await page.keyboard.press('Tab');
  await expect(action).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(firstSessionControl).toBeFocused();

  await navigation.focus();
  await page.keyboard.press('Enter');
  await expect(navigation).toHaveAttribute('aria-expanded', 'false');
  await expect(navigation.locator('.lucide-folder-closed')).toBeVisible();
  await expect(navigation.locator('.lucide-folder-open')).toHaveCount(0);
  await expect(controlledGroup).toHaveAttribute('aria-hidden', 'true');
  expect(await controlledGroup.getAttribute('inert')).not.toBeNull();
  await page.keyboard.press('Enter');
  await expect(navigation).toHaveAttribute('aria-expanded', 'true');
  await expect(navigation.locator('.lucide-folder-open')).toBeVisible();
  await expect(navigation.locator('.lucide-folder-closed')).toHaveCount(0);
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
  const taskSessionId = `${LONG_SIDEBAR_SESSION_PREFIX}00`;
  const taskRow = sessionRow(sidebar, taskSessionId);
  const actionMenu = taskRow.locator(':scope > .maka-session-row-action');
  const timestamp = taskRow.locator('.maka-session-row-time');
  await expect(timestamp).toHaveCSS('visibility', 'visible');
  await taskRow.hover();
  await taskRow.getByRole('button', { name: /任务操作$/ }).click();

  const rename = page.getByRole('menuitem', { name: '重命名', exact: true });
  await expect(rename).toBeVisible();
  await expect(actionMenu).toHaveAttribute('data-menu-open', 'true');
  await rename.hover();
  await expect.poll(() => taskRow.evaluate((row) => row.matches(':hover'))).toBe(false);
  await expect(timestamp).toHaveCSS('visibility', 'hidden');

  await page.mouse.click(4, 4);
  await expect(rename).not.toBeVisible();
  await expect(actionMenu).not.toHaveAttribute('data-menu-open', 'true');

  await taskRow.hover();
  await taskRow.getByRole('button', { name: /任务操作$/ }).focus();
  await page.keyboard.press('Enter');
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
