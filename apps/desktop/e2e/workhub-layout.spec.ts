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

import { FAKE_HOLD_OPEN_PROMPT } from '@maka/runtime/test-only/fake-backend';
import { awaitSendReady, COMPOSER_INPUT, expect, test, getWorkHubPage } from './fixtures';

test('WorkHub uses its coordination model and shared attachment composer', async ({ sessionLocalWindow: { page, app } }) => {
  await page.evaluate(async () => {
    const { connections } = await window.maka.connections.getSnapshot();
    const connection = connections.find((entry) => entry.slug === 'e2e')!;
    const ids = ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', 'claude-opus-4-5-20251101'];
    await window.maka.connections.update({ connectionId: connection.connectionId, slug: connection.slug }, { enabledModelIds: ids, models: ids.map((id) => ({ id })) });
  });
  await page.locator(COMPOSER_INPUT).fill('WorkHub navigation regression');
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.getByText('Fake backend received: WorkHub navigation regression')).toBeVisible();
  await page.evaluate(async () => {
    for (let index = 0; index < 8; index++) await window.maka.sessions.create({ name: `Drag task ${index}` });
  });
  await page.evaluate(() => window.maka.settings.updateClient({ workHub: { enabled: true } }));
  const workhub = await getWorkHubPage(app);
  const sessionId = await workhub.evaluate(() => window.maka.workHub.resolveCoordinationSession());
  await expect.poll(async () => workhub.evaluate(async (id) => (await window.maka.workHub.getSession(id)).model, sessionId)).toBeTruthy();
  await expect(workhub.locator('.maka-composer-editor [contenteditable="true"]')).toBeVisible();
  await expect(workhub.getByRole('button', { name: /添加上下文|Add context/ })).toBeEnabled();
  await expect(workhub.locator('.workhub-composer-scope')).toHaveCount(0);
  await expect(workhub.locator('.workHubLiveHeader')).toHaveCount(0);
  const model = workhub.getByRole('button', { name: /切换当前任务模型|Switch.*model|Change.*model/i });
  await expect(model).toBeEnabled();
  const mainWindow = await app.browserWindow(page);
  const originalBounds = await mainWindow.evaluate((window) => window.getBounds());
  for (const width of [1240, 1000, 1600]) {
    const contentWidth = await mainWindow.evaluate((window, width) => {
      window.setBounds({ width });
      return window.getContentSize()[0];
    }, width);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(contentWidth);
    const dockWidth = await page.locator('.workHubDock').evaluate((element) => Math.round(element.getBoundingClientRect().width));
    await expect.poll(() => workhub.evaluate(() => innerWidth)).toBe(dockWidth);
    const rail = workhub.locator('.workhub-anchor-rail');
    await expect.poll(() => rail.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(180);
    await expect.poll(() => rail.locator('.workhub-navigation-label').first().evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(140);
    await expect.poll(() => workhub.locator('.workhub-conversation-shell').evaluate((element) => {
      const conversation = element.getBoundingClientRect();
      return conversation.left >= 0 && conversation.right <= innerWidth + 1;
    })).toBe(true);
  }
  await mainWindow.evaluate((window, bounds) => window.setBounds(bounds), originalBounds);
  const anchors = workhub.locator('.workhub-anchors');
  const draftBeforeOverlays = 'Draft survives main-window overlays and dragging.';
  await workhub.locator(COMPOSER_INPUT).fill(draftBeforeOverlays);
  const railBounds = await anchors.boundingBox();
  const dragStart = { x: railBounds!.x + railBounds!.width - 40, y: railBounds!.y + railBounds!.height / 2 };
  await workhub.mouse.move(dragStart.x, dragStart.y);
  await workhub.mouse.down();
  await workhub.mouse.move(dragStart.x - 300, dragStart.y, { steps: 12 });
  await workhub.mouse.up();
  await expect.poll(() => anchors.evaluate((element) => element.scrollLeft)).toBeGreaterThan(250);
  await expect(page.locator('.workHubDock')).toBeVisible();
  await expect(workhub.locator(COMPOSER_INPUT)).toHaveText(draftBeforeOverlays);
  await workhub.mouse.move(dragStart.x - 300, dragStart.y);
  await workhub.mouse.down();
  await workhub.mouse.move(dragStart.x, dragStart.y, { steps: 12 });
  await workhub.mouse.up();
  await expect.poll(() => anchors.evaluate((element) => element.scrollLeft)).toBeLessThan(5);
  const expandSidebar = page.getByRole('button', { name: '展开侧边栏', exact: true });
  if (await expandSidebar.isVisible()) await expandSidebar.click();
  const nativeWorkHubVisible = () => mainWindow.evaluate((window) => window.contentView.children.some((child) => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL().includes('surface=workhub') && child.getVisible()));
  const actions = page.getByRole('button', { name: /Drag task 0.*任务操作$/ });
  await page.getByRole('button', { name: 'Drag task 0', exact: true }).hover();
  await actions.click();
  await expect(page.getByRole('menuitem', { name: '重命名', exact: true })).toBeVisible();
  await expect.poll(nativeWorkHubVisible).toBe(false);
  await expect(page.locator('.workHubDockBackdrop')).toBeVisible();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '重命名任务' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(nativeWorkHubVisible).toBe(true);
  await page.getByRole('button', { name: '搜索任务', exact: true }).click();
  await expect(page.locator('[data-maka-contract="search-modal"]')).toBeVisible();
  await expect.poll(nativeWorkHubVisible).toBe(false);
  await page.keyboard.press('Escape');
  await expect.poll(nativeWorkHubVisible).toBe(true);
  await expect(workhub.locator(COMPOSER_INPUT)).toHaveText(draftBeforeOverlays);
  await expect(page.locator('.workHubDockBackdrop')).toHaveCount(0);
  await anchors.locator('.workhub-navigation-item').first().click();
  await expect(page.locator('.workHubDock')).toBeHidden();
  await page.getByRole('button', { name: 'WorkHub', exact: true }).click();
  await expect(page.locator('.workHubDock')).toBeVisible();
  await expect(workhub.locator(COMPOSER_INPUT)).toHaveText(draftBeforeOverlays);
  const configured = await workhub.evaluate(async (id) => {
    const session = await window.maka.workHub.getSession(id);
    return window.maka.workHub.configureModel(id, {
      expectedRevision: session.revision,
      modelTarget: { kind: 'explicit', connectionId: session.llmConnectionId!, connectionSlug: session.llmConnectionSlug, model: session.model },
    });
  }, sessionId);
  expect(configured.kind).toBe('committed');
  await workhub.locator('.maka-composer-editor [contenteditable="true"]').fill('WorkHub composer sends through its own coordination model.');
  await expect(workhub.getByRole('button', { name: /发送|Send/, exact: true })).toBeEnabled();
  await workhub.getByRole('button', { name: /发送|Send/, exact: true }).click();
  await expect(workhub.locator('[data-message-role="user"], article').filter({ hasText: 'WorkHub composer sends through its own coordination model.' }).first()).toBeVisible();
  await expect(workhub.locator('.maka-composer').getByRole('button', { name: /^(停止|Stop)$/ })).toHaveCount(0);
  await workhub.reload();
  await expect(workhub.locator('article').filter({ hasText: 'WorkHub composer sends through its own coordination model.' }).first()).toBeVisible();
  await workhub.locator('[data-chat-scroll-container]').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(workhub.locator('.astryx-chat-layout-scroll-button > div')).toHaveCSS('opacity', '0');
  // The macOS hidden-test launch starts without a Dock icon. Establish normal
  // application visibility before checking the floating-window transition.
  await app.evaluate(async ({ app }) => { if (process.platform === 'darwin') await app.dock!.show(); });
  await workhub.getByRole('button', { name: /浮出工作台|Float WorkHub/ }).click();
  await expect(workhub.locator('.workHubLive')).toHaveAttribute('data-placement', 'floating');
  expect(await app.evaluate(({ app }) => process.platform !== 'darwin' || app.dock!.isVisible())).toBe(true);
  const editor = workhub.locator('.maka-composer-editor [contenteditable="true"]');
  await editor.fill('Keep this draft while folding the conversation.');
  const expandedHeight = await workhub.evaluate(() => window.innerHeight);
  const floatingBottom = () => app.evaluate(({ BrowserWindow }) => {
    const bounds = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'WorkHub')!.getBounds();
    return bounds.y + bounds.height;
  });
  const anchoredBottom = await floatingBottom();
  const scrollTop = await workhub.locator('[data-chat-scroll-container]').evaluate((element) => element.scrollTop);
  const close = await workhub.getByRole('button', { name: /^(隐藏|Hide)$/ }).boundingBox();
  const input = await editor.boundingBox();
  expect(close!.y).toBeLessThan(input!.y);
  await workhub.getByRole('button', { name: /收起对话|Collapse conversation/ }).click();
  await expect(workhub.locator('.workHubHistory')).toBeHidden();
  await expect(workhub.getByRole('button', { name: /滚动到底部|Scroll to bottom/ })).toHaveCount(0);
  await expect.poll(() => workhub.evaluate(() => window.innerHeight)).toBeLessThan(expandedHeight / 2);
  await expect(editor).toBeVisible();
  await expect(editor).toHaveText('Keep this draft while folding the conversation.');
  await expect(workhub.getByRole('button', { name: /^(隐藏|Hide)$/ })).toHaveCount(0);
  await expect.poll(() => workhub.evaluate(() => innerHeight === Math.ceil(document.querySelector('.workHubComposerSurface')!.getBoundingClientRect().height))).toBe(true);
  await expect.poll(floatingBottom).toBe(anchoredBottom);
  const compactHeight = await workhub.evaluate(() => innerHeight);
  await model.click();
  const wheel = workhub.getByRole('listbox');
  await expect(wheel).toBeVisible();
  await expect(wheel.getByRole('option')).toHaveCount(3);
  await expect(workhub.locator('.workHubHistory')).toBeHidden();
  await expect.poll(() => workhub.evaluate(() => innerHeight)).toBeGreaterThan(compactHeight);
  await expect.poll(floatingBottom).toBe(anchoredBottom);
  const modelBeforeBrowsing = await workhub.evaluate(async (id) => (await window.maka.workHub.getSession(id)).model, sessionId);
  await wheel.hover();
  await workhub.mouse.wheel(0, 30);
  await expect.poll(() => wheel.evaluate((element) => {
    const selected = element.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
    const viewport = element.getBoundingClientRect();
    return Math.abs((selected.top + selected.bottom - viewport.top - viewport.bottom) / 2);
  })).toBeLessThanOrEqual(1);
  expect(await workhub.evaluate(async (id) => (await window.maka.workHub.getSession(id)).model, sessionId)).toBe(modelBeforeBrowsing);
  await wheel.press('Escape');
  await model.click();
  await expect(wheel.getByRole('option')).toHaveCount(3);
  await expect.poll(() => workhub.evaluate(() => innerHeight === Math.ceil(document.querySelector('.workHubComposerSurface')!.getBoundingClientRect().height))).toBe(true);
  const dragInitialTop = await wheel.evaluate((element) => element.scrollTop);
  const dragDistance = dragInitialTop > 0 ? 32 : -32;
  const wheelBounds = (await wheel.boundingBox())!;
  const dragX = wheelBounds.x + wheelBounds.width / 2;
  const dragY = wheelBounds.y + wheelBounds.height / 2;
  await workhub.mouse.move(dragX, dragY);
  await workhub.mouse.down();
  await workhub.mouse.move(dragX, dragY + dragDistance, { steps: 8 });
  await expect.poll(() => wheel.evaluate((element) => element.scrollTop)).toBe(dragInitialTop - dragDistance);
  await workhub.mouse.up();
  await expect(wheel).toBeVisible();
  await expect.poll(() => wheel.evaluate((element) => element.scrollTop)).toBe(Math.round((dragInitialTop - dragDistance) / 44) * 44);
  expect(await workhub.evaluate(async (id) => (await window.maka.workHub.getSession(id)).model, sessionId)).toBe(modelBeforeBrowsing);
  await wheel.press('ArrowDown');
  await wheel.press('Escape');
  await expect(wheel).toHaveCount(0);
  await expect.poll(() => workhub.evaluate(() => innerHeight)).toBe(compactHeight);
  await expect(editor).toHaveText('Keep this draft while folding the conversation.');
  const longDraft = Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行：长输入应当只在编辑区内滚动。`).join('\n');
  await editor.fill(longDraft);
  await expect.poll(() => editor.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect.poll(() => editor.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(132);
  await expect(workhub.locator('[data-chat-scroll-container]')).toHaveCSS('overflow-y', 'hidden');
  await expect.poll(floatingBottom).toBe(anchoredBottom);
  const longInputHeight = await workhub.evaluate(() => innerHeight);
  await editor.hover();
  await workhub.mouse.wheel(0, 1000);
  await expect.poll(() => editor.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(workhub.getByRole('button', { name: /发送|Send/, exact: true })).toBeVisible();
  expect(await workhub.evaluate(() => innerHeight)).toBe(longInputHeight);
  await editor.fill('Keep this draft while folding the conversation.');
  await expect.poll(() => workhub.evaluate(() => innerHeight)).toBe(compactHeight);
  await workhub.getByRole('button', { name: /展开对话|Expand conversation/ }).click();
  await expect(workhub.locator('.workHubHistory')).toBeVisible();
  await expect.poll(() => workhub.evaluate(() => window.innerHeight)).toBe(expandedHeight);
  await expect.poll(floatingBottom).toBe(anchoredBottom);
  await expect.poll(() => workhub.locator('[data-chat-scroll-container]').evaluate((element) => element.scrollTop)).toBe(scrollTop);
  await expect(editor).toHaveText('Keep this draft while folding the conversation.');
  await expect(model).toHaveAttribute('aria-haspopup', 'menu');
});


test('WorkHub keeps the submitted prompt visible while its agent is still running', async ({ sessionLocalWindow: { page, app } }) => {
  await page.locator(COMPOSER_INPUT).fill('Initialize WorkHub model');
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.getByText('Fake backend received: Initialize WorkHub model')).toBeVisible();
  await page.evaluate(() => window.maka.settings.updateClient({ workHub: { enabled: true } }));
  const workhub = await getWorkHubPage(app);
  await workhub.getByRole('button', { name: /浮出工作台|Float WorkHub/ }).click();
  await expect(workhub.locator('.workHubLive')).toHaveAttribute('data-conversation-expanded', 'false');
  await workhub.locator(COMPOSER_INPUT).fill(FAKE_HOLD_OPEN_PROMPT);
  await workhub.getByRole('button', { name: /发送|Send/, exact: true }).click();
  const prompt = workhub.locator('.maka-user-message').filter({ hasText: FAKE_HOLD_OPEN_PROMPT });
  await expect(workhub.locator('.workHubLive')).toHaveAttribute('data-conversation-expanded', 'true');
  await expect(prompt).toHaveCount(1);
  await expect(prompt).toBeInViewport();
  await expect(workhub.locator('.maka-bubble-streaming')).toContainText('Fake backend waiting');
  const stop = workhub.locator('.maka-composer').getByRole('button', { name: /^(停止|Stop)$/ });
  await expect(stop).toBeVisible();
  await expect(prompt).toBeInViewport();
  await stop.click();
  await expect(stop).toHaveCount(0);
  await expect(workhub.locator('[data-transient-message-id]')).toHaveCount(0);
  await expect(prompt).toHaveCount(1);
  await expect(prompt).toBeInViewport();
  await workhub.reload();
  await expect(prompt).toHaveCount(1);
  await workhub.getByRole('button', { name: /收起对话|Collapse conversation/ }).click();
  await expect(workhub.locator('.workHubHistory')).toBeHidden();
  await workhub.locator(COMPOSER_INPUT).fill(FAKE_HOLD_OPEN_PROMPT);
  await workhub.getByRole('button', { name: /发送|Send/, exact: true }).click();
  await expect(workhub.locator('.workHubLive')).toHaveAttribute('data-conversation-expanded', 'true');
  await expect(prompt).toHaveCount(2);
  await expect(prompt.last()).toBeInViewport();
  await stop.click();
  await expect(stop).toHaveCount(0);
  await expect(workhub.locator('[data-transient-message-id]')).toHaveCount(0);
  await expect(prompt).toHaveCount(2);
});
