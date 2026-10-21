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

import { createServer } from 'node:http';
import type { ElectronApplication, Page } from '@playwright/test';
import { COMPOSER_INPUT, awaitSendReady, ensureSidebarExpanded, expect, test } from './fixtures';

async function createTask(page: Page, text: string): Promise<string> {
  await page.locator(COMPOSER_INPUT).fill(text);
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.getByText(`Fake backend received: ${text}`)).toBeVisible();
  await ensureSidebarExpanded(page);
  const id = await page.locator('[data-session-id]:has([aria-current="page"])').getAttribute('data-session-id');
  if (!id) throw new Error('No active session');
  return id;
}
async function detach(app: ElectronApplication, page: Page, id: string): Promise<Page> {
  const next = app.waitForEvent('window');
  await page.evaluate((sessionId) => window.maka.appWindow.openSessionWindow(sessionId), id);
  const child = await next;
  await expect(child.locator(COMPOSER_INPUT)).toBeVisible();
  return child;
}

// Electron boundary: real WebContentsView identity and renderer/main handoff;
// a mock window cannot expose Chromium destruction during native reparenting.
test('detaching and returning keeps the same native browser and reveals a hidden owner', async ({ sessionLocalWindow }) => {
  const { page, app } = sessionLocalWindow;
  const id = await createTask(page, 'multi-window browser continuity');
  await page.locator(COMPOSER_INPUT).fill('draft travelling with the session');
  const server = createServer((_request, response) => response.end('<!doctype html><title>Window handoff</title><input id="state" value="initial">'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No server address');
    const url = `http://127.0.0.1:${address.port}/`;
    await page.evaluate(async ({ id, url }) => { window.maka.browser.setActiveSession(id); await window.maka.browser.navigate(id, url); }, { id, url });
    const nativePageId = await app.evaluate(async ({ webContents }, url) => {
      const native = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
      if (!native) throw new Error('Native browser page not found');
      await native.executeJavaScript('document.querySelector("input").value = "preserved native state"');
      return native.id;
    }, url);
    const child = await detach(app, page, id);
    await expect(child.locator(COMPOSER_INPUT)).toHaveText('draft travelling with the session');
    await expect(page.locator(COMPOSER_INPUT)).toHaveText('');
    const childNative = await app.browserWindow(child);
    await childNative.evaluate((window) => window.hide());
    await expect.poll(() => childNative.evaluate((window) => window.isVisible())).toBe(false);
    await page.evaluate((sessionId) => window.maka.appWindow.openSessionWindow(sessionId), id);
    // Inactive E2E fixtures reveal without taking OS focus; active-mode
    // minimized restoration is covered by the production reveal-gate test.
    await expect.poll(() => childNative.evaluate((window) => window.isVisible())).toBe(true);
    await child.getByRole('button', { name: '在主窗口打开', exact: true }).click();
    await expect.poll(() => child.isClosed()).toBe(true);
    await expect(page.locator(COMPOSER_INPUT)).toHaveText('draft travelling with the session');
    expect(await app.evaluate(async ({ webContents }, nativeId) => {
      const native = webContents.fromId(nativeId);
      return native?.executeJavaScript('document.querySelector("input").value');
    }, nativePageId)).toBe('preserved native state');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

// Electron boundary: closing/recreating real BrowserWindows and app restart,
// including in-memory handoff between renderers and a fresh main-process lifetime.
test('closing main keeps the session window alive and restart opens only main', async ({ sessionLocalWindow }) => {
  const { page, app, restart } = sessionLocalWindow;
  const id = await createTask(page, 'multi-window independent lifetime');
  const child = await detach(app, page, id);
  await child.locator(COMPOSER_INPUT).fill('draft moving back to main');
  const mainNative = await app.browserWindow(page);
  await mainNative.evaluate((window) => window.close());
  await expect.poll(() => page.isClosed()).toBe(true);
  expect(child.isClosed()).toBe(false);
  const reopened = app.waitForEvent('window');
  await child.getByRole('button', { name: '在主窗口打开', exact: true }).click();
  const main = await reopened;
  await expect(main.locator(COMPOSER_INPUT)).toHaveText('draft moving back to main');
  const secondChild = await detach(app, main, id);
  await expect(secondChild.locator(COMPOSER_INPUT)).toHaveText('draft moving back to main');
  // Closing a child discards its local drafts; retention is intentionally outside this version.
  await secondChild.locator(COMPOSER_INPUT).fill('');
  const childNative = await app.browserWindow(secondChild);
  await childNative.evaluate((window) => window.close());
  await expect.poll(() => secondChild.isClosed()).toBe(true);
  await ensureSidebarExpanded(main);
  await main.locator(`[data-session-id=${JSON.stringify(id)}]`).click();
  await expect(main.locator(COMPOSER_INPUT)).toHaveText('');
  await detach(app, main, id);
  let restartedApp: ElectronApplication | undefined;
  const restored = await restart(async (next) => { restartedApp = next; });
  expect((await restored.evaluate(() => window.maka.appWindow.context())).kind).toBe('main');
  await expect.poll(async () => {
    const pages = restartedApp!.windows().filter((window) => !window.isClosed());
    const contexts = await Promise.all(pages.map((window) => window.evaluate(() => window.maka?.appWindow?.context()).catch(() => undefined)));
    return contexts.filter((context) => context?.kind === 'session').length;
  }).toBe(0);
  await ensureSidebarExpanded(restored);
  await restored.locator(`[data-session-id=${JSON.stringify(id)}]`).click();
  await expect(restored.locator(COMPOSER_INPUT)).toHaveText('');
});
