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

const appRoot = new URL('../app/', import.meta.url);
let sequence = 0;

async function setupPreferences(t, storage) {
  const id = ++sequence;
  globalThis.__sidebarPrefsFixture = { storage };
  delete globalThis[Symbol.for('maka.sidebarPreferences')];
  const native = `const fixture = globalThis.__sidebarPrefsFixture; // ${id}
    export const platform = { idiom: 'desktop' };
    export const Storage = fixture.storage;
    export const signal = (v) => { const r = () => v; r.set = (n) => { v = n; }; return r; };`;
  const hooks = registerHooks({
    resolve(specifier, ctx, next) {
      return specifier === 'nsh'
        ? { url: `data:text/javascript,${encodeURIComponent(native)}`, shortCircuit: true }
        : next(specifier, ctx);
    },
  });
  t.after(() => {
    hooks.deregister();
    delete globalThis.__sidebarPrefsFixture;
    delete globalThis[Symbol.for('maka.sidebarPreferences')];
  });
  return {
    root: await import(new URL(`sidebarPreferences.ts?f=${id}&b=root`, appRoot)),
    nav: await import(new URL(`sidebarPreferences.ts?f=${id}&b=nav`, appRoot)),
  };
}

test('normalizes pinned features, supports empty selection, and persists across bundles', async (t) => {
  const saved = new Map();
  const storage = {
    async getItem(key) {
      return saved.get(key) ?? null;
    },
    async setItem(key, value) {
      saved.set(key, value);
    },
  };
  const { root, nav } = await setupPreferences(t, storage);

  assert.deepEqual(root.normalizePinnedSidebarFeatures('invalid'), ['bot', 'automations']);
  assert.deepEqual(root.normalizePinnedSidebarFeatures([]), []);
  assert.deepEqual(root.normalizePinnedSidebarFeatures(['rooms', 'bogus', 'rooms', 'bot']), [
    'bot',
    'rooms',
  ]);
  assert.equal(root.normalizeSidebarSortMode('time'), 'time');
  assert.equal(root.normalizeSidebarSortMode('unknown'), 'project');

  root.initializeSidebarPreferences();
  nav.initializeSidebarPreferences();
  assert.deepEqual(nav.sidebarPreferences.pinnedFeatures(), ['bot', 'automations']);
  assert.equal(nav.sidebarPreferences.sortMode(), 'project');

  nav.sidebarPreferences.toggleFeature('rooms');
  nav.sidebarPreferences.toggleFeature('bot');
  nav.sidebarPreferences.toggleSortMode();
  await root.sidebarPreferences.whenIdle();

  assert.deepEqual(root.sidebarPreferences.pinnedFeatures(), ['automations', 'rooms']);
  assert.equal(root.sidebarPreferences.sortMode(), 'time');
  assert.deepEqual(JSON.parse(saved.get('sidebar-preferences')), {
    pinnedFeatures: ['automations', 'rooms'],
    sortMode: 'time',
  });
});
