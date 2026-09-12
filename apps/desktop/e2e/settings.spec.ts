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

import { awaitSendReady, COMPOSER_INPUT, ensureSidebarExpanded, expect, test } from './fixtures';

test('Code Mode persists as a global setting after reopening settings', async ({ window: page }, testInfo) => {
  await ensureSidebarExpanded(page);
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '通用', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Code Mode', exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect.poll(() => page.evaluate(async () => (await window.maka.settings.get()).chatDefaults.codeModeEnabled)).toBe(true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '设置' }).click();
  await expect(toggle).toBeChecked();
  await toggle.scrollIntoViewIfNeeded();
  const screenshotPath = testInfo.outputPath('code-mode-settings.png');
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach('Code Mode in General settings', {
    path: screenshotPath,
    contentType: 'image/png',
  });
  await toggle.click();
  await expect.poll(() => page.evaluate(async () => (await window.maka.settings.get()).chatDefaults.codeModeEnabled === true)).toBe(false);
});

test('opening settings commits an active titlebar rename', async ({ window: page }) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create a session for settings rename');
  await awaitSendReady(page);
  await composer.press('Enter');

  await page.getByRole('button', { name: '展开任务工作栏' }).click();
  const workbar = page.locator('.maka-session-workbar[data-placement="right"]');
  const workbarToolbar = workbar.getByRole('toolbar', { name: '任务工作栏标签' });
  await expect(workbarToolbar).toBeVisible();
  await expect(
    workbarToolbar.getByRole('button', { name: '打开或关闭工作栏的面' }),
  ).toBeVisible();
  await expect(workbarToolbar.getByRole('button', { name: '收起任务工作栏' })).toBeVisible();
  await page
    .getByRole('button', { name: /变更.*查看当前 Git 工作区变化/ })
    .click();
  const openFaceTab = workbarToolbar.getByRole('tab', { name: '变更' });
  await expect(openFaceTab).toBeVisible();

  const identity = page.locator('[data-maka-contract="titlebar-identity"]');
  await expect(identity).toBeVisible();
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await identity.getByRole('button', { name: /重命名任务/ }).click();
  await page.getByRole('textbox', { name: '重命名任务' }).fill('renamed before settings');

  // Programmatic activation preserves input focus, matching the macOS
  // application-menu command that opens Settings before Chromium can blur it.
  await page.getByRole('button', { name: '设置' }).evaluate((button) => button.click());
  await expect(page.getByRole('main', { name: '设置内容' })).toBeVisible();
  await expect(workbar).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(workbarToolbar).toBeVisible();
  await expect(openFaceTab).toBeVisible();

  await expect(identity).toContainText('renamed before settings');
  await expect.poll(() => page.evaluate(async () =>
    (await window.maka.sessions.list()).some((session) => session.name === 'renamed before settings'),
  )).toBe(true);
});
