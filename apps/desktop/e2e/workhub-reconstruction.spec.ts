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

import { expect, test, getWorkHubPage } from './fixtures';

test('WorkHub moves the same renderer and draft between the main window and floating window', async ({ sessionLocalWindow: { page, app } }) => {
  await page.evaluate(() => window.maka.settings.updateClient({ workHub: { enabled: true } }));
  const workhub = await getWorkHubPage(app);
  const editor = workhub.locator('.maka-composer-editor [contenteditable="true"]');
  await editor.fill('Keep this unsent WorkHub draft');
  const marker = await editor.evaluate((element) => {
    const value = crypto.randomUUID();
    element.setAttribute('data-test-instance', value);
    return value;
  });
  const webContentsId = await workhub.evaluate(() => window.maka.workHub.resolveCoordinationSession());
  await workhub.emulateMedia({ reducedMotion: 'no-preference' });
  await editor.evaluate((element) => {
    element.addEventListener('input', () => {
      if (document.querySelector('.workHubRevealMark')?.getAnimations().some((animation) => animation.playState === 'running')) {
        element.setAttribute('data-input-during-reveal', 'true');
      }
    });
  });
  await workhub.getByRole('button', { name: /^(Float WorkHub|浮出工作台)$/ }).click();
  await workhub.keyboard.type(' — typed during opening');
  await expect(editor).toHaveAttribute('data-input-during-reveal', 'true');
  await expect(page.locator('.workHubDockPlaceholder')).toBeVisible();
  await expect.poll(() => workhub.evaluate(() => window.maka.workHubPresentation.getSnapshot())).toMatchObject({ placement: 'floating', floatingVisible: true });
  await expect(editor).toHaveText('Keep this unsent WorkHub draft — typed during opening');
  await expect(editor).toHaveAttribute('data-test-instance', marker);

  await expect(workhub.locator('.workHubLive')).toHaveAttribute('data-conversation-expanded', 'false');
  const capabilities = await app.evaluate(({ BrowserWindow }) => {
    const floating = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'WorkHub')!;
    return { maximizable: floating.isMaximizable(), fullscreenable: floating.isFullScreenable() };
  });
  expect(capabilities.fullscreenable).toBe(false);
  if (process.platform !== 'linux') expect(capabilities.maximizable).toBe(false);
  await expect(workhub.locator('.workHubHistory')).toBeHidden();
  await expect.poll(() => workhub.evaluate(() => Math.abs(innerHeight - document.querySelector('.workHubComposerSurface')!.getBoundingClientRect().height))).toBeLessThanOrEqual(1);
  await workhub.getByRole('button', { name: /展开对话|Expand conversation/ }).click();
  await expect(workhub.locator('.workHubHistory')).toBeVisible();
  await workhub.getByRole('button', { name: /^(Hide|隐藏|隱藏)$/ }).click();
  await expect.poll(() => workhub.evaluate(() => window.maka.workHubPresentation.getSnapshot())).toMatchObject({ placement: 'floating', floatingVisible: false });
  await page.getByRole('button', { name: /^(Bring WorkHub back|收回工作台)$/ }).click();
  await expect(page.locator('.workHubDockPlaceholder')).toBeHidden();
  await expect.poll(() => workhub.evaluate(() => window.maka.workHubPresentation.getSnapshot())).toMatchObject({ placement: 'docked' });
  await expect(editor).toHaveText('Keep this unsent WorkHub draft — typed during opening');
  await expect(editor).toHaveAttribute('data-test-instance', marker);
  expect(await workhub.evaluate(() => window.maka.workHub.resolveCoordinationSession())).toBe(webContentsId);
  expect(app.context().pages().filter((candidate) => candidate.url().includes('surface=workhub'))).toHaveLength(1);
  await workhub.getByRole('button', { name: /^(Float WorkHub|浮出工作台)$/ }).click();
  await expect(workhub.locator('.workHubLive')).toHaveAttribute('data-conversation-expanded', 'false');
  await expect(workhub.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await workhub.getByRole('button', { name: '发送', exact: true }).click();
  await expect(workhub.locator('.workHubLive')).toHaveAttribute('data-conversation-expanded', 'true');
  await expect(workhub.locator('article').filter({ hasText: 'Keep this unsent WorkHub draft' }).first()).toBeVisible();
});
