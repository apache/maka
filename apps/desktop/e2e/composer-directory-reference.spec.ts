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

import { COMPOSER_INPUT, expect, test } from './fixtures';

test('a folder reference is removable, survives send/reload, and leaves project selection unchanged', async ({
  directoryReferenceWindow: { page, folder },
}, testInfo) => {
  const composer = page.locator(COMPOSER_INPUT);
  const project = page.locator('button.maka-workspace-picker');
  // The composer can mount before TaskEntry loads the initial project selection.
  // Compare the settled selection, not the generic label shown during loading.
  const originalProject = '选择项目：无项目';
  await expect(project).toHaveAttribute('aria-label', originalProject);
  const pick = async (keyboard = false) => {
    const trigger = page.locator('.maka-composer-plus-menu button').first();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    if (keyboard) {
      // Exercise keyboard reopening as well. Astryx intentionally ignores pointer
      // reopening within 50ms of dismiss; the native chooser mock returns instantly.
      await trigger.press('ArrowDown');
    } else {
      await trigger.click();
    }
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('menuitem', { name: '引用文件夹', exact: true }).click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  };

  await pick();
  const chip = page.locator('.maka-composer-context-drawer .maka-composer-attachment-token');
  await expect(chip).toContainText('referenced-source');
  await chip.getByRole('button').click();
  await expect(chip).toHaveCount(0);
  await pick(true);
  await expect(chip).toContainText('referenced-source');
  await expect(project).toHaveAttribute('aria-label', originalProject);
  await composer.fill('请检查引用目录');
  await page.screenshot({ path: testInfo.outputPath('directory-reference-staged.png') });
  await composer.press('Enter');

  const user = page.getByLabel('你发送的消息').first();
  await expect(user).toContainText('请检查引用目录');
  await expect(user).toContainText('referenced-source');
  await expect(user).not.toContainText('README.md');
  const transcript = page.getByRole('log');
  await expect(transcript).not.toContainText('README.md');
  await expect(transcript).not.toContainText('"status":"listed"');
  await expect(transcript).not.toContainText('DO_NOT_READ_FILE_CONTENTS');
  await expect(transcript).not.toContainText('deep.txt');
  await expect(chip).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, { timeout: 20_000 });

  const sessions = await page.evaluate(() => window.maka.sessions.list());
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.cwd).not.toBe(folder);
  await page.reload();
  await expect(page.getByLabel('你发送的消息').first()).toContainText('referenced-source');
  await expect(page.getByRole('log')).not.toContainText('README.md');
  await page.screenshot({ path: testInfo.outputPath('directory-reference-sent.png') });
});
