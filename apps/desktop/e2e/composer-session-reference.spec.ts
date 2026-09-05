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

import { ensureSidebarExpanded, expect, test, COMPOSER_INPUT } from './fixtures';

test('references another Session from @, including a trailing-space browse', async ({
  window: page,
}, testInfo) => {
  const composer = page.locator(COMPOSER_INPUT);
  const sourceName = 'Reference source';
  const sourcePrompt = 'source transcript marker';

  await composer.fill(sourcePrompt);
  await composer.press('Enter');
  await expect(page.getByText(`Fake backend received: ${sourcePrompt}`)).toBeVisible();
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, {
    timeout: 20_000,
  });

  await page.evaluate(async (name) => {
    const source = (await window.maka.sessions.list())[0];
    if (!source) throw new Error('the source Session was not created');
    await window.maka.sessions.rename(source.id, name);
  }, sourceName);

  await ensureSidebarExpanded(page);
  const sidebar = page.getByRole('navigation', { name: '任务列表' });
  await sidebar.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(composer).toHaveText('');

  await composer.click();
  await composer.pressSequentially('@');
  const menu = page.getByRole('listbox', { name: '工作区文件和会话' });
  await expect(menu).toBeVisible();

  const sourceOption = menu.getByRole('option', { name: sourceName, exact: true });
  await expect(sourceOption).toBeVisible();
  await expect(sourceOption.locator('svg.lucide-messages-square')).toHaveCount(1);

  await composer.press('Space');
  await expect(menu).toBeVisible();
  await expect(sourceOption).toBeVisible();

  await composer.fill('@reference');
  await expect(sourceOption).toBeVisible();
  await sourceOption.click();
  await expect(menu).not.toBeVisible();

  const chip = page.locator('.maka-composer-session-token');
  await expect(chip).toContainText(sourceName);
  await expect(chip.locator('svg.lucide-messages-square')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('session-reference-staged.png') });

  const followUp = 'continue from the referenced session';
  await composer.fill(followUp);
  await composer.press('Enter');
  const sent = page.getByLabel('你发送的消息').last();
  await expect(sent).toContainText(followUp);
  await expect(sent).toContainText(sourceName);
  await expect(chip).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, {
    timeout: 20_000,
  });
});
