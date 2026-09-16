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
import test from 'node:test';
import type { Menu, MenuItemConstructorOptions } from 'electron';
import type { UiLocale } from '@maka/core/ui-locale';
import { createWindowsAppTray } from '../windows-app-tray.js';

function fixture(platform: NodeJS.Platform = 'win32', enabled = true) {
  let locale: UiLocale = 'en';
  let localeChanged: (() => void) | undefined;
  let template: MenuItemConstructorOptions[] = [];
  let failMenu = false;
  let creations = 0;
  let releases = 0;
  const actions: string[] = [];
  const errors: unknown[] = [];
  class FakeTray extends EventEmitter {
    destroyed = false;
    tooltip = '';
    setToolTip(value: string) { this.tooltip = value; }
    setContextMenu() { if (failMenu) throw new Error('Tray menu failed'); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  let surface: FakeTray | undefined;
  const tray = createWindowsAppTray({
    platform, enabled,
    locale: {
      current: () => locale,
      subscribe: (handler) => { localeChanged = () => handler(locale); return () => { releases++; localeChanged = undefined; }; },
    },
    createTray: () => { creations++; surface = new FakeTray(); return surface as never; },
    createMenu: (items) => { template = items; return {} as Menu; },
    openMain: () => { actions.push('main'); },
    openWorkHub: () => { actions.push('workhub'); },
    quit: () => { actions.push('quit'); },
    onError: (error) => errors.push(error),
  });
  return {
    tray, actions, errors,
    surface: () => surface,
    labels: () => template.map((item) => item.label),
    choose: (index: number) => (template[index]?.click as (() => void) | undefined)?.(),
    setLocale: (next: UiLocale) => { locale = next; localeChanged?.(); },
    failMenu: () => { failMenu = true; },
    creations: () => creations,
    releases: () => releases,
  };
}

test('Windows tray reopens either surface and reserves quit for the explicit menu action', async () => {
  const f = fixture();
  assert.equal(f.tray.start(), true);
  assert.equal(f.tray.start(), true);
  assert.equal(f.creations(), 1);
  f.surface()!.emit('double-click');
  f.choose(1);
  await Promise.resolve();
  assert.deepEqual(f.actions, ['main', 'workhub']);
  assert.equal(f.tray.hasTray(), true);
  f.choose(3);
  await Promise.resolve();
  assert.deepEqual(f.actions, ['main', 'workhub', 'quit']);
  f.tray.dispose();
  f.tray.dispose();
  assert.equal(f.tray.hasTray(), false);
  assert.equal(f.surface()!.destroyed, true);
  assert.equal(f.releases(), 1);
  assert.equal(f.tray.start(), false);
});

test('tray follows the current native UI locale', () => {
  const f = fixture();
  f.tray.start();
  assert.equal(f.labels()[0], 'Open Maka');
  f.setLocale('zh-CN');
  assert.equal(f.labels()[3], '退出 Maka');
  f.setLocale('zh-TW');
  assert.equal(f.labels()[1], '開啟 WorkHub');
  f.tray.dispose();
});

test('failed native setup never claims that a background entry exists', () => {
  const f = fixture();
  f.failMenu();
  assert.equal(f.tray.start(), false);
  assert.equal(f.tray.hasTray(), false);
  assert.equal(f.surface()!.destroyed, true);
  assert.equal(f.errors.length, 1);
});

test('macOS and isolated runs do not create another tray entry', () => {
  for (const f of [fixture('darwin'), fixture('win32', false)]) {
    assert.equal(f.tray.start(), false);
    assert.equal(f.creations(), 0);
  }
});
