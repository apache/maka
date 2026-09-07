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

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import type { HostHandoffView } from '@maka/runtime-host/client';
import { createStartupProgressWindow, renderStartupProgressHtml } from '../startup-progress-window.js';

function harness() {
  let resolveLoad!: () => void;
  let rejectLoad!: (error: Error) => void;
  let destroyed = false;
  let minimized = false;
  let visible = false;
  let copied = 0;
  let copiedHandoff: HostHandoffView | undefined;
  let documentUrl = '';
  let options: BrowserWindowConstructorOptions | undefined;
  let openWindow!: () => { action: string };
  const scripts: string[] = [];
  const errors: unknown[] = [];
  const contents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler(handler: typeof openWindow) { openWindow = handler; },
    async executeJavaScript(source: string) { scripts.push(source); },
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    setMenuBarVisibility() {},
    setSize() {},
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    destroy() { destroyed = true; },
    minimize() { minimized = true; },
    restore() { minimized = false; },
    showInactive() { visible = true; },
    show() { visible = true; },
    focus() {},
    loadURL: (url: string) => {
      documentUrl = url;
      return new Promise<void>((resolve, reject) => {
        resolveLoad = resolve;
        rejectLoad = reject;
      });
    },
  });
  const progress = createStartupProgressWindow({
    locale: 'en', dark: false, icon: '/test/icon.png',
    createWindow(input) { options = input; return window as unknown as BrowserWindow; },
    copyDiagnostics(_phase, handoff) { copied += 1; copiedHandoff = handoff; },
    onError(error) { errors.push(error); },
  });
  return {
    progress, window, contents, scripts, errors, resolveLoad, rejectLoad,
    get options() { return options; },
    get copied() { return copied; },
    get copiedHandoff() { return copiedHandoff; },
    get documentUrl() { return documentUrl; },
    get destroyed() { return destroyed; },
    get minimized() { return minimized; },
    get visible() { return visible; },
    get openWindow() { return openWindow; },
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('shows the latest real phase after loading and minimizes without terminating startup', async () => {
  const h = harness();
  h.progress.update('staging');
  assert.equal(h.visible, false);
  h.resolveLoad();
  await flush();
  assert.equal(h.visible, true);
  assert.match(h.scripts.at(-1) ?? '', /Installing the update/);
  let prevented = false;
  h.window.emit('close', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.minimized, true);
  assert.equal(h.destroyed, false);
  h.progress.focus();
  assert.equal(h.minimized, false);
  h.progress.close();
  assert.equal(h.destroyed, true);
  assert.equal(h.progress.window(), undefined);
});

test('handoff before HTML finishes loading cannot reveal an orphan startup window', async () => {
  const h = harness();
  h.progress.close();
  h.resolveLoad();
  await flush();
  h.progress.update('renderer');
  h.progress.focus();
  assert.equal(h.visible, false);
  assert.equal(h.scripts.length, 0);
  assert.equal(h.destroyed, true);
});

test('presentation failure is contained and does not reject the startup operation', async () => {
  const h = harness();
  const error = new Error('renderer could not load');
  h.rejectLoad(error);
  await flush();
  assert.deepEqual(h.errors, [error]);
  assert.equal(h.destroyed, true);
  h.progress.close();
});

test('diagnostics is the only permitted navigation action; the window has no app bridge', async () => {
  const h = harness();
  h.resolveLoad();
  await flush();
  assert.equal(h.options?.webPreferences?.nodeIntegration, false);
  assert.equal(h.options?.webPreferences?.sandbox, true);
  assert.equal(h.options?.webPreferences?.preload, undefined);
  assert.ok(h.documentUrl.startsWith('data:text/html;charset=utf-8,'));
  assert.deepEqual(h.openWindow(), { action: 'deny' });
  for (const url of ['https://example.test', 'maka-startup://copy/anything', 'maka-startup://copy']) {
    let prevented = false;
    h.contents.emit('will-navigate', { preventDefault() { prevented = true; } }, url);
    assert.equal(prevented, true);
  }
  await flush();
  assert.equal(h.copied, 1);
  assert.match(h.scripts.at(-1) ?? '', /Diagnostics copied/);
  h.progress.close();
});

test('localized progress stays self-contained, accessible and has no fabricated percentage', () => {
  for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
    for (const dark of [false, true]) {
      const html = renderStartupProgressHtml(locale, dark);
      assert.ok(html.includes('lang="' + locale + '"'));
      assert.match(html, /default-src 'none'/);
      assert.match(html, /aria-live="polite"/);
      assert.match(html, /prefers-reduced-motion/);
      assert.doesNotMatch(html, /aria-valuenow|<progress|https?:/);
      assert.match(html, /maka-startup:\/\/copy/);
    }
  }
});

test('live handoff accepts only current allowed actions and copies the current diagnosis', async () => {
  const h = harness();
  const actions: string[] = [];
  const view: HostHandoffView = { revision: 'first', target: { name: 'local', location: 'local' },
    state: 'attention', reason: 'busy', mayExitNaturally: false,
    actions: ['cancel', 'retry', 'interrupt'], defaultAction: 'cancel', diagnostic: 'current host is busy' };
  const submit = (revision: string, action: string) => { actions.push(`${revision}:${action}`); };
  h.progress.handoff(view, submit, 'en');
  h.resolveLoad(); await flush();
  h.progress.handoff({ ...view, revision: 'second', state: 'progress', phase: 'pausing', actions: ['cancel'] }, submit, 'en');
  for (const url of ['maka-startup://handoff/first/interrupt', 'maka-startup://handoff/second/interrupt',
    'maka-startup://handoff/second/cancel', 'maka-startup://copy']) {
    h.contents.emit('will-navigate', { preventDefault() {} }, url);
  }
  await flush();
  assert.deepEqual(actions, ['second:cancel']);
  assert.equal(h.copiedHandoff?.revision, 'second');
  assert.equal(h.copiedHandoff?.diagnostic, view.diagnostic);
  h.progress.close();
});
