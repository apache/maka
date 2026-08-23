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

test('wide settings gutters scroll the whole main pane', async ({ window: page }) => {
  await page.setViewportSize({ width: 1600, height: 520 });
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '通用', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '助手语气偏好' })).toBeEnabled();

  const pane = page.locator('.settingsMainPane');
  const content = pane.locator('.settingsPageStack').first();
  const geometry = await pane.evaluate((element) => {
    const paneRect = element.getBoundingClientRect();
    const contentElement = element.querySelector('.settingsPageStack');
    const contentRect = contentElement?.getBoundingClientRect();
    const layoutContent = element.querySelector('.astryx-layout-content');
    if (!contentRect || !layoutContent) throw new Error('Settings layout is incomplete');
    return {
      blankRight: paneRect.right - contentRect.right,
      clientHeight: element.clientHeight,
      contentOverflowY: getComputedStyle(layoutContent).overflowY,
      paneOverflowY: getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight,
      wheelPoint: {
        x: Math.floor((contentRect.right + paneRect.right) / 2),
        y: Math.floor(Math.min(contentRect.top + 120, paneRect.bottom - 40)),
      },
    };
  });

  expect(geometry.blankRight).toBeGreaterThan(40);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  expect(geometry.contentOverflowY).not.toBe('auto');
  expect(geometry.paneOverflowY).toBe('auto');

  await page.mouse.move(geometry.wheelPoint.x, geometry.wheelPoint.y);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(content).toBeVisible();
});
