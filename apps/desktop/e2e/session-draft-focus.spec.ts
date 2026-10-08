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

import { awaitSendReady, ensureSidebarExpanded, expect, test, COMPOSER_INPUT } from './fixtures';

test('activating a session row with an unsent draft keeps focus on the row', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  const prompt = 'session for the draft focus contract';
  await composer.fill(prompt);
  await awaitSendReady(page);
  await composer.press('Enter');
  await expect(page.getByText(`Fake backend received: ${prompt}`)).toBeVisible({
    timeout: 30_000,
  });

  await composer.click();
  // Plain text, no Skill token: this contract is about the caret restore, and a
  // token redraw writes the same selection for a reason of its own.
  await page.keyboard.insertText('an unsent draft');
  await expect(composer).toHaveText('an unsent draft');

  await ensureSidebarExpanded(page);
  const sidebar = page.getByRole('navigation', { name: '任务列表' });
  await sidebar.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(composer).toHaveText('');

  const sessionRow = sidebar.locator('[data-session-id]').first();
  await sessionRow.click();
  await expect(composer).toHaveText('an unsent draft');
  await expect(composer).not.toBeFocused();
  await expect(sessionRow.locator(':focus')).toHaveCount(1);
});
