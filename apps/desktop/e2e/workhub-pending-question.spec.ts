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

import { FAKE_ASK_USER_QUESTION_PROMPT } from '@maka/runtime/test-only/fake-backend';
import { awaitSendReady, COMPOSER_INPUT, expect, test, getWorkHubPage } from './fixtures';

test('a pending WorkHub question preserves docked placement, choices and focus across window transitions', async ({ sessionLocalWindow: { page, app } }) => {
  await page.evaluate(() => window.maka.settings.updateClient({ workHub: { enabled: true } }));
  const hub = await getWorkHubPage(app);
  await hub.locator(COMPOSER_INPUT).fill(FAKE_ASK_USER_QUESTION_PROMPT);
  await awaitSendReady(hub);
  await hub.locator(COMPOSER_INPUT).press('Enter');
  await expect(hub.getByRole('option', { name: /公开测试/ })).toBeVisible();
  await expect(hub.locator('.workHubLive')).toHaveAttribute('data-placement', 'docked');
  // Reload rehydrates the pending question through Host interaction queries.
  await hub.reload();
  const choice = hub.getByRole('option', { name: /公开测试/ });
  await expect(choice).toBeVisible();
  await expect(hub.locator('.workHubLive')).toHaveAttribute('data-placement', 'docked');
  await choice.click();
  await app.evaluate(async ({ app }) => { if (process.platform === 'darwin') await app.dock!.show(); });
  await hub.evaluate(() => window.maka.workHubPresentation.detach());
  await expect(hub.locator('.workHubLive')).toHaveAttribute('data-placement', 'floating');
  await expect(choice).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => hub.locator('.maka-choice-panel').evaluate((panel) => panel.contains(document.activeElement))).toBe(true);
  await hub.evaluate(() => window.maka.workHubPresentation.dock());
  await expect(hub.locator('.workHubLive')).toHaveAttribute('data-placement', 'docked');
  await expect(choice).toHaveAttribute('aria-selected', 'true');
});
