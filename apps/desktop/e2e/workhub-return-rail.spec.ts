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

async function railGeometry(page: Page) {
  return page.locator('.maka-prompt-rail').evaluate((rail) => {
    const scroller = document.querySelector('[data-chat-scroll-container]:not([hidden])')!;
    const edge = scroller.getBoundingClientRect();
    const ticks = rail.getBoundingClientRect();
    const composer = document.querySelector('.maka-composer')!.getBoundingClientRect();
    return { rightInset: edge.right - ticks.right, top: ticks.top - edge.top,
      bottom: composer.top - ticks.bottom, width: ticks.width };
  });
}

test('WorkHub prompt rail uses the scrollport edge and the shared reading width', async ({ sessionLocalWindow: { page, app } }, testInfo) => {
  const mainWindow = await app.browserWindow(page);
  const contentWidth = await mainWindow.evaluate((window) => {
    window.unmaximize();
    window.setBounds({ width: 1600, height: 900 });
    return window.getContentSize()[0];
  });
  // Startup can restore saved bounds after the first resize request.
  await expect.poll(async () => {
    await mainWindow.evaluate((window) => window.setBounds({ width: 1600, height: 900 }));
    return page.evaluate(() => innerWidth);
  }).toBe(contentWidth);
  await sendPrompts(page, 'Session navigation');
  const sessionRail = await railGeometry(page);
  const ordinary = await page.locator('.maka-turn').first().evaluate((element) => element.getBoundingClientRect().width);
  await page.evaluate(() => window.maka.settings.updateClient({ workHub: { enabled: true } }));
  const workhub = await getWorkHubPage(app);
  await workhub.setViewportSize({ width: 1600, height: 800 });
  await sendPrompts(workhub, 'WorkHub navigation');
  await workhub.screenshot({ path: testInfo.outputPath('workhub-wide.png'), scale: 'css' });
  const geometry = await railGeometry(workhub);
  expect(geometry.width).toBeGreaterThan(0);
  expect(geometry.rightInset).toBeGreaterThanOrEqual(10);
  expect(geometry.rightInset).toBeLessThanOrEqual(32);
  expect(Math.abs(geometry.rightInset - sessionRail.rightInset)).toBeLessThanOrEqual(1);
  // Both surfaces apply their shared transcript gutters exactly once.
  const hubWidth = await workhub.locator('.maka-turn').first().evaluate((element) => element.getBoundingClientRect().width);
  expect(Math.abs(hubWidth - ordinary)).toBeLessThanOrEqual(2);
  for (const width of [1000, 720]) {
    await workhub.setViewportSize({ width, height: 720 });
    await expect.poll(async () => (await railGeometry(workhub)).bottom).toBeGreaterThanOrEqual(0);
    const narrow = await railGeometry(workhub);
    expect(narrow.rightInset).toBeGreaterThanOrEqual(10);
    expect(narrow.rightInset).toBeLessThanOrEqual(32);
    expect(narrow.top).toBeGreaterThanOrEqual(0);
    expect(await workhub.locator('.workhub-body').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await workhub.screenshot({ path: testInfo.outputPath(`workhub-${width}.png`), scale: 'css' });
  }
});

test('Session keeps a return to WorkHub control when the sidebar is collapsed', async ({ sessionLocalWindow: { page, app } }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await sendPrompts(page, 'Return navigation');
  await page.evaluate(() => window.maka.settings.updateClient({ workHub: { enabled: true } }));
  const workhub = await getWorkHubPage(app);
  await workhub.locator(COMPOSER_INPUT).fill('Keep my WorkHub draft');
  await workhub.locator('.workhub-navigation-item').first().click();
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
