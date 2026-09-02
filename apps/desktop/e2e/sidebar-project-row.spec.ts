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
  const [projectNavigationBox, firstSessionBox, projectTitleBox, sessionTitleBox] = await Promise.all([
    navigation.boundingBox(),
    firstSessionControl.boundingBox(),
    projectTitle.boundingBox(),
    sessionTitle.boundingBox(),
  ]);
  expect(projectNavigationBox).not.toBeNull();
  expect(firstSessionBox).not.toBeNull();
  expect(projectTitleBox).not.toBeNull();
  expect(sessionTitleBox).not.toBeNull();
  // Hierarchy is the session button sitting inside the project button. Title
  // alignment is the product contract: leading content widths differ, so the
  // inset is not the same as the title column.
  const sessionInset = firstSessionBox!.x - projectNavigationBox!.x;
  expect(sessionInset).toBeGreaterThanOrEqual(6);
  expect(sessionInset).toBeLessThan(16);
  expect(Math.abs(projectTitleBox!.x - sessionTitleBox!.x)).toBeLessThanOrEqual(2);

  await expect(projectRow.locator('button button')).toHaveCount(0);
  await expect(navigation).toHaveAttribute('aria-expanded', 'true');

  await navigation.focus();
  await page.keyboard.press('Tab');
  await expect(action).toBeFocused();
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

test('project and task rows show contextual hover details', async ({
  projectSidebarWindow: page,
}) => {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-maka-contract="search-modal"]')).not.toBeVisible();

  const sidebar = page.getByRole('navigation', { name: '任务列表' });
  const taskSessionId = `${LONG_SIDEBAR_SESSION_PREFIX}00`;
  const taskRow = sessionRow(sidebar, taskSessionId);
  const taskNavigation = taskRow.locator('.astryx-side-nav-item');
  await expect(taskNavigation).toHaveAccessibleDescription(
    /已归档第 00 条研究记录。.*glm-5\.1/,
  );
  // A new Electron window can open under the cursor left by the prior test;
  // force a real leave → enter transition so the delayed hover trigger fires.
  await page.mouse.move(800, 400);
  await taskNavigation.hover();

  const taskCard = page.locator('.maka-sidebar-hover-card[data-kind="session"]');
  await expect(taskCard).toBeVisible();
  await expect(taskCard.locator('.maka-sidebar-hover-card-title')).toHaveText('任务 00');
  await expect(taskCard.locator('.maka-sidebar-hover-card-preview')).toHaveText(
    '已归档第 00 条研究记录。',
  );
  await expect(taskCard.locator('.maka-sidebar-hover-card-path')).toContainText(
    'e2e-fixture-sidebar-search-modal-open',
  );
  await expect(taskCard.locator('.maka-sidebar-hover-card-meta')).toContainText('glm-5.1');

  await sidebar.getByRole('radio', { name: '按项目', exact: true }).click();
  const projectRow = sidebar.locator(
    `[data-project-id="project:${LONG_SIDEBAR_PROJECT_ID}"]`,
  );
  const projectNavigation = projectRow.locator(':scope > div > .astryx-side-nav-item');
  await expect(projectNavigation.locator('.astryx-badge')).toHaveCount(0);
  await expect(projectNavigation).toHaveAccessibleDescription(/3 个任务.*目录可用/);
  await projectNavigation.hover();

  const projectCard = page.locator('.maka-sidebar-hover-card[data-kind="project"]');
  await expect(projectCard).toBeVisible();
  await expect(projectCard.locator('.maka-sidebar-hover-card-title')).toHaveText(
    LONG_SIDEBAR_PROJECT_NAME,
  );
  await expect(projectCard.locator('.maka-sidebar-hover-card-meta')).toContainText('3 个任务');
  await expect(projectCard.locator('.maka-sidebar-hover-card-meta')).toContainText('目录可用');

  const ungroupedRow = sidebar.locator('[data-project-id="__ungrouped__"]');
  const ungroupedNavigation = ungroupedRow.locator(':scope > div > .astryx-side-nav-item');
  await expect(ungroupedNavigation.locator('.astryx-badge')).toHaveCount(0);
  await ungroupedNavigation.focus();
  await expect(
    page.getByRole('dialog', { name: '未归属项目 分组详情', exact: true }),
  ).toBeVisible();
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
