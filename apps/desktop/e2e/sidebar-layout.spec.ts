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

import { COMPOSER_INPUT, ensureSidebarExpanded, expect, getWorkHubPage, test } from './fixtures';

// Native keyboard delivery must follow focus from the titlebar search action
// through dialog dismissal into the new-task composer. DOM focus alone would
// miss input lost when the separate WorkHub WebContentsView relinquishes focus.
test('titlebar search and new task receive native input, including when leaving WorkHub', async ({
  sessionLocalWindow: { page, app },
}) => {
  const nativeWindow = await app.browserWindow(page);
  await nativeWindow.evaluate((window) => {
    window.show();
    window.focus();
    window.webContents.focus();
  });
  const chrome = page.locator('.maka-shell-topbar-rail');
  const sidebar = page.locator('.maka-sidenav-motion');
  const composer = page.locator(COMPOSER_INPUT);

  const search = chrome.getByRole('button', { name: '搜索任务' });
  await search.focus();
  await search.press('Enter');
  const searchInput = page.getByRole('combobox', { name: '搜索任务' });
  await expect(searchInput).toBeFocused();
  await nativeWindow.evaluate((window) => {
    for (const character of 'sidebar') {
      window.webContents.sendInputEvent({ type: 'char', keyCode: character });
    }
  });
  await expect(searchInput).toHaveValue('sidebar');
  await page.keyboard.press('Escape');
  await expect(search).toBeFocused();
  await page.keyboard.press('Tab');
  const newTask = chrome.getByRole('button', { name: '新任务', exact: true });
  await expect(newTask).toBeFocused();

  await newTask.click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText('');
  await nativeWindow.evaluate((window) => {
    for (const character of 'new task draft') {
      window.webContents.sendInputEvent({ type: 'char', keyCode: character });
    }
  });
  await expect(composer).toHaveText('new task draft');

  await ensureSidebarExpanded(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '通用', exact: true }).click();
  const enableWorkHub = page.getByRole('switch', { name: '启用 WorkHub', exact: true });
  await enableWorkHub.click();
  await expect(enableWorkHub).toBeChecked();
  await page.keyboard.press('Escape');
  await sidebar.getByRole('button', { name: 'WorkHub', exact: true }).click();
  const workhub = await getWorkHubPage(app);
  await expect(page.locator('.workHubDock')).toBeVisible();
  await chrome.getByRole('button', { name: '收起侧边栏' }).click();
  await workhub.locator(COMPOSER_INPUT).click();
  await expect(workhub.locator(COMPOSER_INPUT)).toBeFocused();

  await newTask.click();
  await expect(page.locator('.workHubDock')).toBeHidden();
  await expect(composer).toBeVisible();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText('new task draft');
  // Do not focus webContents here: the new-task action must hand input back.
  await nativeWindow.evaluate((window) => {
    for (const character of ' returned from WorkHub ') {
      window.webContents.sendInputEvent({ type: 'char', keyCode: character });
    }
  });
  await expect(composer).toContainText('returned from WorkHub');
});

// After drag-collapse remounts Astryx's handle, Electron key events must still
// resize it. Geometry confirms native input reached the remounted control,
// rather than merely checking DOM focus or dispatching a renderer key event.
test('native keyboard resizing reaches the restored handle after drag-collapse', async ({
  sessionLocalWindow: { page, app },
}) => {
  const nativeWindow = await app.browserWindow(page);
  await nativeWindow.evaluate((window) => {
    window.show();
    window.focus();
    window.webContents.focus();
  });
  const chrome = page.locator('.maka-shell-topbar-rail');
  const sidebar = page.locator('.maka-sidenav-motion');
  const handle = page.getByTestId('astryx-sidenav-resize-handle');
  const sidebarWidth = async () => Math.round((await sidebar.boundingBox())?.width ?? 0);
  await ensureSidebarExpanded(page);
  await expect.poll(sidebarWidth).toBe(260);

  const box = await handle.boundingBox();
  if (!box) throw new Error('Missing sidebar resize handle');
  const x = box.x + box.width / 2;
  const y = box.y + 80;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(sidebarWidth).toBe(320);

  const widened = await handle.boundingBox();
  if (!widened) throw new Error('Missing resized sidebar handle');
  await page.mouse.move(widened.x + widened.width / 2, y);
  await page.mouse.down();
  // Cross the threshold in one move so an intermediate drag width is not saved.
  await page.mouse.move(widened.x - 230, y);
  await page.mouse.up();
  await expect(sidebar).not.toBeVisible();
  await expect.poll(sidebarWidth).toBe(0);

  await chrome.getByRole('button', { name: '展开侧边栏' }).click();
  await expect.poll(sidebarWidth).toBe(320);
  await handle.focus();
  await expect(handle).toBeFocused();
  await nativeWindow.evaluate((window) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
  });
  await expect.poll(sidebarWidth).toBe(330);
});
