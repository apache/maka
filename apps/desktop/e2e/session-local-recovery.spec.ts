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

import { resolve } from 'node:path';
import { COMPOSER_INPUT, awaitSendReady, ensureSidebarExpanded, expect, test } from './fixtures';

test('a locally saved message survives renderer and application restart, then executes once', async ({
  sessionLocalWindow,
}, testInfo) => {
  let { page } = sessionLocalWindow;
  const { app, restart } = sessionLocalWindow;
  const first = 'durable history before restart';
  await page.locator(COMPOSER_INPUT).fill(first);
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.getByText(`Fake backend received: ${first}`)).toBeVisible();
  await ensureSidebarExpanded(page);
  const sessionId = await page
    .locator('[data-session-id]:has([aria-current="page"])')
    .getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();
  await expect
    .poll(() =>
      page.evaluate(
        async (id) => !!(await window.maka.sessionLocal.readTranscript(id)),
        sessionId!,
      ),
    )
    .toBe(true);

  // Pause only the delivery scheduler in this isolated main process. Admission,
  // SQLite, renderer/preload, and the later Host execution all remain real.
  await app.evaluate((_electron, modulePath) => {
    const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/`);
    const { DesktopSessionLocalService } = require(modulePath);
    DesktopSessionLocalService.prototype.wake = () => {};
  }, resolve('dist/main/session-local-service.js'));
  const pending = 'saved locally across a complete application restart';
  await page.locator(COMPOSER_INPUT).fill(pending);
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.locator(COMPOSER_INPUT)).toHaveText('');
  await expect(page.getByText('已本地保存 · 等待发送')).toBeVisible();
  const before = await page.evaluate((id) => window.maka.sessionLocal.listMessages(id), sessionId!);
  const message = before.find((item) => item.text === pending)!;
  expect(message.state).toBe('saved');
  await page.screenshot({ path: testInfo.outputPath('locally-saved.png') });

  await page.reload();
  await ensureSidebarExpanded(page);
  await page.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();
  await expect(page.getByText('已本地保存 · 等待发送')).toBeVisible();
  expect(
    (await page.evaluate((id) => window.maka.sessionLocal.listMessages(id), sessionId!)).find(
      (item) => item.text === pending,
    )?.messageId,
  ).toBe(message.messageId);

  page = await restart();
  await ensureSidebarExpanded(page);
  await page.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();
  await expect(
    page.getByLabel('Maka 的回答').getByText(`Fake backend received: ${pending}`),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByLabel('Maka 的回答').getByText(`Fake backend received: ${pending}`),
  ).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(
        async (id) => (await window.maka.sessionLocal.listMessages(id)).length,
        sessionId!,
      ),
    )
    .toBe(0);
  await page.screenshot({ path: testInfo.outputPath('recovered.png') });
});

test('cached history remains readable when the live transcript endpoint is unavailable', async ({
  sessionLocalWindow,
}, testInfo) => {
  const { page, app } = sessionLocalWindow;
  const prompt = 'history available without a live transcript';
  await page.locator(COMPOSER_INPUT).fill(prompt);
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(
    page.getByLabel('Maka 的回答').getByText(`Fake backend received: ${prompt}`),
  ).toBeVisible();
  await ensureSidebarExpanded(page);
  const sessionId = await page
    .locator('[data-session-id]:has([aria-current="page"])')
    .getAttribute('data-session-id');
  await expect
    .poll(() =>
      page.evaluate(
        async (id) => !!(await window.maka.sessionLocal.readTranscript(id)),
        sessionId!,
      ),
    )
    .toBe(true);
  // Fault only the live endpoint, not the cache bridge or renderer projection.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('sessions:transcript:open');
    ipcMain.handle('sessions:transcript:open', () => {
      throw new Error('E2E live transcript unavailable');
    });
  });
  await page.reload();
  await ensureSidebarExpanded(page);
  await page.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();
  await expect(
    page.getByLabel('Maka 的回答').getByText(`Fake backend received: ${prompt}`),
  ).toBeVisible();
  await expect(page.locator('.maka-chat-recovery-notice')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('cached-history.png') });
});

test('a new task is readable locally before the Host session exists', async ({
  sessionLocalWindow,
}) => {
  let { page } = sessionLocalWindow;
  await sessionLocalWindow.app.evaluate((_electron, modulePath) => {
    const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/`);
    const { DesktopSessionLocalService } = require(modulePath);
    DesktopSessionLocalService.prototype.wake = () => {};
  }, resolve('dist/main/session-local-service.js'));
  const prompt = 'first message saved before Host creation';
  await page.locator(COMPOSER_INPUT).fill(prompt);
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.locator(COMPOSER_INPUT)).toHaveText('');
  await expect(page.getByText('已本地保存 · 等待发送')).toBeVisible();
  await ensureSidebarExpanded(page);
  const sessionId = await page
    .locator('[data-session-id]:has([aria-current="page"])')
    .getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();
  await expect(page.getByText('读取任务失败', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Graph 状态刷新失败。', { exact: true })).toHaveCount(0);
  await page.reload();
  await ensureSidebarExpanded(page);
  await page.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();
  await expect(page.getByText('已本地保存 · 等待发送')).toBeVisible();
  await expect(page.getByText('读取任务失败', { exact: true })).toHaveCount(0);
  page = await sessionLocalWindow.restart();
  await ensureSidebarExpanded(page);
  await page.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();
  await expect(
    page.getByLabel('Maka 的回答').getByText(`Fake backend received: ${prompt}`),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByLabel('Maka 的回答').getByText(`Fake backend received: ${prompt}`),
  ).toHaveCount(1);
});
