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
import { registerHooks } from 'node:module';
import test from 'node:test';

test('native menu returns only the selected action, cancels cleanly, and anchors at renderer zoom', async () => {
  let items: Electron.MenuItemConstructorOptions[] = [];
  let options: Electron.PopupOptions | undefined;
  const globals = globalThis as typeof globalThis & { nativeMenuTest?: unknown };
  globals.nativeMenuTest = { buildFromTemplate(template: Electron.MenuItemConstructorOptions[]) {
    items = template;
    return { popup(input: Electron.PopupOptions) { options = input; } };
  } };
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier === 'electron'
      ? { url: 'data:text/javascript,export const Menu=globalThis.nativeMenuTest', shortCircuit: true }
      : next(specifier, context);
  } });
  try {
    const { popupNativeMenu } = await import('../native-menu.js');
    const window = { isDestroyed: () => false, webContents: { getZoomFactor: () => 1.5 } } as Electron.BrowserWindow;
    const request = { x: 30, y: 40, items: [
      { id: 'browser', label: 'Browser', checked: true, enabled: true },
      { id: 'side-chat', label: 'Side Chat', checked: false, enabled: false },
    ] };
    const selected = popupNativeMenu(window, request);
    assert.equal(items[0]?.checked, true);
    assert.equal(items[1]?.enabled, false);
    assert.equal(options?.window, window);
    assert.equal(options?.x, 45);
    assert.equal(options?.y, 60);
    items[0]!.click!({} as Electron.MenuItem, window, {} as Electron.KeyboardEvent);
    options!.callback!();
    assert.equal(await selected, 'browser');
    const cancelled = popupNativeMenu(window, request);
    options!.callback!();
    assert.equal(await cancelled, null);
    assert.throws(() => popupNativeMenu(window, { ...request, x: Infinity }), /Invalid native menu/);
    assert.throws(() => popupNativeMenu(window, { ...request, items: [{ role: 'quit' }] }), /Invalid native menu/);
  } finally { hooks.deregister(); delete globals.nativeMenuTest; }
});
