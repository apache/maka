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
import type { Page } from '@playwright/test';
import { awaitSendReady, COMPOSER_INPUT, expect, test, getWorkHubPage } from './fixtures';

async function sendPrompts(page: Page, prefix: string) {
  for (let index = 1; index <= 3; index++) {
    const text = `${prefix} ${index}`;
    await page.locator(COMPOSER_INPUT).fill(text);
    await awaitSendReady(page);
    await page.locator(COMPOSER_INPUT).press('Enter');
    await expect(page.getByText(`Fake backend received: ${text}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  }
  await expect(page.locator('.maka-prompt-rail [data-prompt-turn-id]')).toHaveCount(3);
  await expect(page.locator('.maka-prompt-rail')).toBeVisible();
}

test('Session keeps a return to WorkHub control when the sidebar is collapsed', async ({ sessionLocalWindow: { page, app } }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await sendPrompts(page, 'Return navigation');
  await page.evaluate(() => window.maka.settings.updateClient({ workHub: { enabled: true } }));
  const workhub = await getWorkHubPage(app);
  await workhub.locator(COMPOSER_INPUT).fill('Keep my WorkHub draft');
  const sessionName = await workhub.locator('.workhub-navigation-label').first().innerText();
  await workhub.locator('.workhub-navigation-item').first().click();
  await expect(page.locator('.workHubDock')).toBeVisible();
  const expand = page.getByRole('button', { name: '展开侧边栏', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button').filter({ has: page.getByText(sessionName, { exact: true }) }).click();
  await expect(page.locator('.workHubDock')).toBeHidden();
  const collapse = page.getByRole('button', { name: '收起侧边栏', exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await page.screenshot({ path: testInfo.outputPath('session-return.png'), scale: 'css' });
  const back = page.getByRole('button', { name: '返回 WorkHub', exact: true });
  await expect(back).toBeVisible();
  const alignment = await back.evaluate((button) => {
    const composer = document.querySelector('.maka-composer-astryx')!;
    const body = Array.from(composer.children).find((child) => child.querySelector('[contenteditable]'))!;
    const a = button.getBoundingClientRect();
    const b = composer.getBoundingClientRect();
    return {
      left: Math.abs(a.left - b.left), right: Math.abs(a.right - b.right),
      above: a.bottom <= b.top,
      radius: getComputedStyle(button).borderRadius,
      composerRadius: getComputedStyle(body).borderRadius,
      textAlign: getComputedStyle(button).textAlign,
    };
  });
  expect(alignment.left).toBeLessThanOrEqual(1);
  expect(alignment.right).toBeLessThanOrEqual(1);
  expect(alignment.above).toBe(true);
  expect(alignment.radius).toBe(alignment.composerRadius);
  expect(alignment.textAlign).toBe('center');
  await back.click();
  await expect(page.locator('.workHubDock')).toBeVisible();
  await expect(workhub.locator(COMPOSER_INPUT)).toHaveText('Keep my WorkHub draft');
});


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
