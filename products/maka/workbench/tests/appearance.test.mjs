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
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

const appRoot = new URL('../app/', import.meta.url);
let sequence = 0;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function setup(t, storage) {
  const id = ++sequence;
  const fixture = { storage, themes: [], sizes: [] };
  globalThis.__appearanceFixture = fixture;
  delete globalThis[Symbol.for('maka.appearance')];
  const native = {
    nsh: `const fixture = globalThis.__appearanceFixture;
      // fixture ${id}
      export const signal = initial => {
        let value = initial;
        const read = () => value;
        read.set = next => { value = next; };
        return read;
      };
      export const Storage = fixture.storage;
      export const setColorScheme = value => fixture.themes.push(value);
      export const host = {call: async (method, input) => {
        if (method !== 'appearance.textSize') throw Error(method);
        fixture.sizes.push(input.scale);
      }};`,
    chrome: 'export const ownTitleBar = true;',
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const key =
        context.parentURL?.startsWith(appRoot.href) && specifier === './chrome'
          ? 'chrome'
          : specifier;
      if (key in native)
        return {
          url: `data:text/javascript,${encodeURIComponent(native[key])}`,
          shortCircuit: true,
        };
      if (context.parentURL?.startsWith(appRoot.href) && specifier === './colorPalette')
        return next('./colorPalette.ts', context);
      return next(specifier, context);
    },
  });
  t.after(() => {
    hooks.deregister();
    delete globalThis.__appearanceFixture;
    delete globalThis[Symbol.for('maka.appearance')];
  });
  const root = await import(new URL(`appearance.ts?fixture=${id}&bundle=root`, appRoot));
  const settings = await import(new URL(`appearance.ts?fixture=${id}&bundle=settings`, appRoot));
  return { root, settings, fixture };
}

test('independent UI bundles retain user choices and restore untouched startup preferences', async (t) => {
  const reads = new Map();
  const saved = new Map();
  const { root, settings, fixture } = await setup(t, {
    getItem(key) {
      const read = deferred();
      reads.set(key, read);
      return read.promise;
    },
    async setItem(key, value) {
      saved.set(key, value);
    },
  });
  root.initializeAppearance();
  settings.initializeAppearance();
  settings.appearance.chooseTheme('dark');
  settings.appearance.choosePalette('custom');
  settings.appearance.changeCustom({ hue: 280, tint: 0.3, accent: '#ff0000' }, false);
  reads.get('appearance-theme').resolve('light');
  reads.get('appearance-text-size').resolve('1.15');
  reads.get('appearance-palette').resolve('sage');
  reads.get('appearance-tray-icon').resolve('tile');
  reads.get('appearance-custom-palette').resolve(
    JSON.stringify({
      hue: 20,
      tint: 0.1,
      accent: '#00ff00',
    }),
  );
  await setImmediate();
  await root.appearance.whenIdle();
  assert.equal(root.appearance.theme(), 'dark');
  assert.equal(settings.appearance.textSize(), 1.15);
  assert.equal(root.appearance.trayIcon(), 'tile');
  assert.equal(root.appearance.palette(), 'custom');
  assert.deepEqual(root.appearance.recipe(), { hue: 280, tint: 0.3, accent: '#ff0000' });
  assert.equal(fixture.themes.at(-1), 'dark');
  assert.equal(fixture.sizes.at(-1), 1.15);
  assert.equal(saved.get('appearance-theme'), 'dark');
  assert.equal(saved.get('appearance-palette'), 'custom');
});

test('latest selections persist after a delayed failed write without blocking the owner', async (t) => {
  const firstWrite = deferred();
  const saved = new Map();
  const writes = [];
  const { root, settings } = await setup(t, {
    getItem: async () => null,
    async setItem(key, value) {
      writes.push([key, value]);
      if (writes.length === 1) await firstWrite.promise;
      saved.set(key, value);
    },
  });
  settings.appearance.chooseTheme('dark');
  root.initializeAppearance();
  await setImmediate();
  settings.appearance.chooseTheme('light');
  root.appearance.chooseTheme('system');
  settings.appearance.chooseTextSize(1.15);
  const idle = root.appearance.whenIdle();
  firstWrite.reject(new Error('storage unavailable'));
  await idle;
  assert.equal(saved.get('appearance-theme'), 'system');
  assert.equal(saved.get('appearance-text-size'), '1.15');
  assert.equal(settings.appearance.theme(), 'system');
  assert.equal(root.appearance.textSize(), 1.15);
  root.appearance.chooseTheme('light');
  await settings.appearance.whenIdle();
  assert.equal(saved.get('appearance-theme'), 'light');
  assert.equal(root.appearance.saving(), false);
});
