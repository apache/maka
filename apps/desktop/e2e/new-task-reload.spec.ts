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

import { COMPOSER_INPUT, awaitSendReady, ensureSidebarExpanded, expect, test } from './fixtures';

test('archived-only history boots into a usable new task', async ({ window: page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const composer = page.locator(COMPOSER_INPUT);
  const reply = page.getByText(/Fake backend received: archived startup regression/);
  await composer.fill('archived startup regression');
  await awaitSendReady(page);
  await composer.press('Enter');
  await expect(reply).toBeVisible({ timeout: 20_000 });

  // Visible streaming text is not proof that the Host has released the Turn.
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1);

  // Prove bootstrap can restore this history before archiving it.
  await page.reload();
  await expect(reply).toBeVisible();
  const sessionIds = await page.evaluate(async () =>
    (await window.maka.sessions.list()).map((session) => session.id));
  for (const sessionId of sessionIds) {
    // Turn completion does not join background naming/recap effects. Archive
    // is the authoritative readiness check; retry only its specific busy case.
    await expect.poll(() => page.evaluate(async (id) => {
      try {
        await window.maka.sessions.archive(id);
        return 'archived';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes(`Session ${id} has a live derived effect`)) return message;
        throw error;
      }
    }, sessionId), { timeout: 20_000 }).toBe('archived');
  }
  await expect.poll(async () =>
    page.evaluate(async () => (await window.maka.sessions.list()).map(({ isArchived }) => isArchived)),
  ).toEqual([true]);
  // A cold window has no explicit new-task reload intent. Keep this test on
  // automatic bootstrap even if retirement starts recording that intent.
  await page.evaluate(() => sessionStorage.removeItem('maka-new-task-reload-intent-v1'));
  await page.reload();
  await expect(composer).toBeVisible();
  await ensureSidebarExpanded(page);
  await expect(page.locator('[data-session-id]')).toHaveCount(0);
  try {
    await expect(page.locator('.maka-titlebar-identity__segment--session')).toHaveCount(0);
    await expect(page.locator('.maka-turn')).toHaveCount(0);
  } finally {
    await testInfo.attach('archived-only-startup', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
  }

  await composer.fill('new task after archived history');
  await awaitSendReady(page);
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: new task after archived history/))
    .toBeVisible({ timeout: 20_000 });
  await expect.poll(async () =>
    page.evaluate(async () => {
      const sessions = await window.maka.sessions.list();
      return {
        archived: sessions.filter((session) => session.isArchived).length,
        active: sessions.filter((session) => !session.isArchived).length,
      };
    }),
  ).toEqual({ archived: 1, active: 1 });
});

test('an explicit new task survives a renderer reload without reopening history', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create history');
  await awaitSendReady(page);
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: create history/)).toBeVisible({
    timeout: 20_000,
  });

  await ensureSidebarExpanded(page);
  await page.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(page.locator('.maka-turn')).toHaveCount(0);
  await composer.fill('draft survives renderer replacement');

  await page.reload();

  await expect(page.locator(COMPOSER_INPUT)).toBeVisible();
  await expect(page.locator(COMPOSER_INPUT)).toHaveText('draft survives renderer replacement');
  await expect(page.locator('.maka-turn')).toHaveCount(0);
});
