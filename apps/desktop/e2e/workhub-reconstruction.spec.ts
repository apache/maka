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

test('WorkHub moves the same renderer and draft between the main window and floating window', async ({ sessionLocalWindow: { page, app } }, testInfo) => {
  await page.evaluate(async () => {
    await window.maka.settings.updateClient({ workHub: { enabled: false } });
    await window.maka.workHubPresentation.detach();
    await window.maka.workHubPresentation.dock();
  });
  expect(app.context().pages().filter((candidate) => candidate.url().includes('surface=workhub'))).toHaveLength(0);
  await page.evaluate(() => window.maka.settings.updateClient({ workHub: { enabled: true } }));
  const workhub = await getWorkHubPage(app);
  const appearance = await page.evaluate(async () => (await window.maka.settings.getClient()).appearance);
  await page.evaluate(() => window.maka.settings.updateClient({ appearance: { theme: 'dark', palette: 'nord', uiFontSize: 18 } }));
  const readAppearance = () => ({
    dark: document.documentElement.classList.contains('dark'),
    palette: document.documentElement.dataset.makaTheme,
    fontSize: document.documentElement.style.fontSize,
  });
  await expect.poll(() => workhub.evaluate(readAppearance)).toMatchObject({ dark: true, palette: 'nord' });
  await expect.poll(() => page.evaluate(readAppearance)).toEqual(await workhub.evaluate(readAppearance));
  await page.evaluate((appearance) => window.maka.settings.updateClient({ appearance }), appearance);
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
  // A reused native window is already painted when focus arrives. Replaying
  // the intro here would visibly fade that frame out after it appeared.
  await workhub.evaluate(() => {
    const samples: string[] = [];
    (window as Window & { workHubFocusSamples?: string[] }).workHubFocusSamples = samples;
    window.maka.workHubPresentation.onFocusComposer(() => {
      requestAnimationFrame(() => samples.push(getComputedStyle(document.querySelector('.workHubComposerSurface')!).opacity));
    });
  });
  for (let index = 0; index < 3; index++) {
    await workhub.evaluate(() => window.maka.workHubPresentation.hide());
    await expect(page.locator('.workHubDockPlaceholder')).toBeHidden();
    await expect(workhub.locator('.workHubHistory')).toHaveCSS('pointer-events', 'auto');
    await expect(editor).toHaveAttribute('data-test-instance', marker);
    await page.evaluate(() => window.maka.workHubPresentation.detach());
    await expect.poll(() => workhub.evaluate(() => (window as Window & { workHubFocusSamples?: string[] }).workHubFocusSamples)).toEqual(Array.from({ length: index + 1 }, () => '1'));
  }
  await page.evaluate(() => window.maka.settings.updateClient({ workHub: { enabled: false } }));
  await expect(page.locator('.workHubDock')).toBeHidden();
  await expect.poll(() => workhub.evaluate(() => window.maka.workHubPresentation.getSnapshot())).toMatchObject({ floatingVisible: false, shortcutRegistered: false });
  await page.evaluate(() => window.maka.workHubPresentation.detach());
  expect((await workhub.evaluate(() => window.maka.workHubPresentation.getSnapshot())).floatingVisible).toBe(false);
  await page.evaluate(async () => {
    await window.maka.settings.updateClient({ workHub: { enabled: true } });
    await window.maka.workHubPresentation.detach();
  });
  await expect(editor).toHaveAttribute('data-test-instance', marker);
  await expect(editor).toHaveText('Keep this unsent WorkHub draft — typed during opening');

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
  await expect.poll(() => workhub.evaluate(() => window.maka.workHubPresentation.getSnapshot())).toMatchObject({ placement: 'docked', floatingVisible: false });
  await expect(page.locator('.workHubDockPlaceholder')).toBeHidden();
  await expect.poll(() => workhub.evaluate(() => window.maka.workHubPresentation.getSnapshot())).toMatchObject({ placement: 'docked' });
  await expect(editor).toHaveText('Keep this unsent WorkHub draft — typed during opening');
  await expect(editor).toHaveAttribute('data-test-instance', marker);
  expect(await workhub.evaluate(() => window.maka.workHub.resolveCoordinationSession())).toBe(webContentsId);
  expect(app.context().pages().filter((candidate) => candidate.url().includes('surface=workhub'))).toHaveLength(1);
  await workhub.getByRole('button', { name: /^(Float WorkHub|浮出工作台)$/ }).click();
  await expect(workhub.locator('.workHubLive')).toHaveAttribute('data-conversation-expanded', 'false');
  await expect(workhub.getByRole('button', { name: /^(Return to Maka|收回 Maka)$/ })).toHaveCount(0);
  await workhub.getByRole('button', { name: /展开对话|Expand conversation/ }).click();
  await workhub.locator('.workHubWindowControls').screenshot({ path: testInfo.outputPath('workhub-return-from-pip.png') });
  await workhub.getByRole('button', { name: /^(Return to Maka|收回 Maka)$/ }).click();
  await expect.poll(() => workhub.evaluate(() => window.maka.workHubPresentation.getSnapshot())).toMatchObject({ placement: 'docked' });
  await expect(editor).toHaveAttribute('data-test-instance', marker);
  await expect(editor).toHaveText('Keep this unsent WorkHub draft — typed during opening');
  await workhub.getByRole('button', { name: /^(Float WorkHub|浮出工作台)$/ }).click();
  await expect(workhub.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await workhub.getByRole('button', { name: '发送', exact: true }).click();
  await expect(workhub.locator('.workHubLive')).toHaveAttribute('data-conversation-expanded', 'true');
  await expect(workhub.locator('article').filter({ hasText: 'Keep this unsent WorkHub draft' }).first()).toBeVisible();
  // WorkHub owns foreground focus while native input targets Desktop behind it.
  // Playwright otherwise forces document.hasFocus() true for every page.
  const main = await app.browserWindow(page);
  const cdp = await app.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await main.evaluate(window => window.showInactive());
  await page.evaluate(() => window.maka.workHubPresentation.detach());
  await expect.poll(() => main.evaluate(window => window.isFocused())).toBe(false);
  expect(await page.evaluate(() => document.hasFocus())).toBe(false);
  const result = await app.evaluate(async ({ BrowserWindow }, mainId) => {
    const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
    const { WorkHubUi } = require('./dist/main/workhub-ui.js');
    const main = BrowserWindow.fromId(mainId)!;
    let focused = 0;
    const onFocus = () => focused++;
    main.on('focus', onFocus);
    const ui = new WorkHubUi(() => main.webContents, () => main.webContents.executeJavaScript('window.maka.settings.getClient()'), () => {}, async () => '');
    try {
      const signal = new AbortController().signal;
      await ui.begin(signal);
      await ui.execute({ kind: 'open', area: 'newTask' }, signal);
      const observation = await ui.observe();
      const editor = observation.controls.find((item: any) => item.editable && item.name.match(/消息输入框|Message/));
      if (!editor) throw new Error('Background navigation did not expose the composer');
      await ui.execute({ kind: 'type', ref: editor.ref, text: '后台输入验证' }, signal);
      await main.webContents.executeJavaScript("window.__backgroundKey = undefined; document.addEventListener('keydown', event => { window.__backgroundKey = { key: event.key, trusted: event.isTrusted }; }, { once: true })");
      await ui.execute({ kind: 'key', ref: editor.ref, key: 'ArrowLeft' }, signal);
      return { focused, mainFocused: main.isFocused(), key: await main.webContents.executeJavaScript('window.__backgroundKey'), value: await main.webContents.executeJavaScript('document.querySelector("[contenteditable=true]")?.textContent') };
    } finally { main.removeListener('focus', onFocus); }
  }, await main.evaluate(window => window.id));
  expect(result).toEqual({ focused: 0, mainFocused: false, key: { key: 'ArrowLeft', trusted: true }, value: '后台输入验证' });
  await expect(workhub.locator('[contenteditable=true]')).toBeEmpty();
});
