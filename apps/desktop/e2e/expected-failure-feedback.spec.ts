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

import { truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FAKE_HOLD_OPEN_PROMPT } from '@maka/runtime/test-only/fake-backend';
import { MAX_ATTACHMENT_BYTES } from '@maka/core/attachments';
import {
  awaitSendReady,
  COMPOSER_INPUT,
  expect,
  getWorkHubPage,
  test,
  withE2eWindow,
} from './fixtures';

test('WorkHub shows the main-side attachment rejection reason', async ({}, testInfo) => {
  await withE2eWindow(
    { seed: true, readinessSelector: COMPOSER_INPUT, locale: 'zh-CN', showWindow: true },
    async (page, { app, userDataDir }) => {
      const attachmentPath = path.join(userDataDir, 'grew-after-selection.txt');
      await writeFile(attachmentPath, 'small');
      await app.evaluate(({ dialog }, selectedPath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
      }, attachmentPath);
      await page.evaluate(() => window.maka.settings.updateClient({ workHub: { enabled: true } }));
      const workHub = await getWorkHubPage(app);
      const addMenu = workHub.locator('.maka-composer-plus-menu button').first();
      await addMenu.click();
      await workHub.getByRole('menuitem', { name: '添加文件', exact: true }).click();
      await expect(workHub.getByText('grew-after-selection.txt', { exact: true })).toBeVisible();

      await truncate(attachmentPath, MAX_ATTACHMENT_BYTES + 1);
      await workHub.locator(COMPOSER_INPUT).fill('验证附件错误提示');
      await workHub.locator(COMPOSER_INPUT).press('Enter');
      await expect(workHub.getByText('发送失败', { exact: true })).toBeVisible();
      const screenshotPath = testInfo.outputPath('workhub-attachment-rejection.png');
      await workHub.screenshot({ path: screenshotPath, animations: 'disabled' });
      await testInfo.attach('WorkHub attachment rejection', {
        path: screenshotPath,
        contentType: 'image/png',
      });
      await expect(workHub.getByText('单个附件超出大小限制。', { exact: true })).toBeVisible();
    },
  );
});

test('setting and Plan failures retain their codes through Electron', async ({ window: page }) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(FAKE_HOLD_OPEN_PROMPT);
  await awaitSendReady(page);
  await composer.press('Enter');
  await expect.poll(async () => {
    const sessions = await page.evaluate(() => window.maka.sessions.list());
    return sessions.some(({ status }) => status === 'running');
  }).toBe(true);
  const sessionId = await page.evaluate(async () => {
    const sessions = await window.maka.sessions.list();
    return sessions.find(({ status }) => status === 'running')!.id;
  });

  const result = await page.evaluate(async (id) => ({
    setting: await window.maka.sessions.setPermissionMode(id, 'explore'),
    plan: await window.maka.sessions.abandonPlanProposal(id, 'missing-proposal'),
  }), sessionId);
  expect(result.setting).toEqual({ ok: false, code: 'session_busy' });
  expect(result.plan).toMatchObject({
    ok: false,
    error: { code: 'session_busy' },
  });
  await page.evaluate((id) => window.maka.sessions.stop(id), sessionId);
});
