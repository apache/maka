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
const look = await importApp('look.ts');
const palette = await importApp('colorPalette.ts');
async function importApp(file) {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.startsWith(appRoot.href) && specifier === './colorPalette')
        return next('./colorPalette.ts', context);
      return next(specifier, context);
    },
  });
  try {
    return await import(new URL(file, appRoot));
  } finally {
    hooks.deregister();
  }
}
async function setup(t, storage, os = 'macos') {
  const id = ++sequence;
  const fixture = { storage, themes: [], sizes: [], fonts: [] };
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
      export const platform = {os: '${os}'};
      export const setColorScheme = value => fixture.themes.push(value);
      export const setTheme = value => fixture.fonts.push(value?.cssVars.theme['font-sans'] ?? null);
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
      if (
        context.parentURL?.startsWith(appRoot.href) &&
        (specifier === './colorPalette' || specifier === './look')
      )
        return next(`${specifier}.ts`, context);
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
  settings.appearance.choosePreset('paper');
  reads.get('appearance-theme').resolve('light');
  reads.get('appearance-text-size').resolve('1.15');
  reads.get('appearance-tray-icon').resolve('tile');
  reads.get('appearance-look').resolve(JSON.stringify(look.presetLooks.mono));
  await setImmediate();
  await root.appearance.whenIdle();
  assert.equal(root.appearance.theme(), 'dark');
  assert.equal(settings.appearance.textSize(), 1.15);
  assert.equal(root.appearance.trayIcon(), 'tile');
  assert.equal(root.appearance.look().base, 'paper');
  assert.equal(fixture.fonts.at(-1), look.fontFamilies.serif);
  assert.equal(fixture.themes.at(-1), 'dark');
  assert.equal(fixture.sizes.at(-1), 1.15);
  assert.equal(saved.get('appearance-theme'), 'dark');
  assert.equal(JSON.parse(saved.get('appearance-look')).base, 'paper');
});

test('a palette from before looks becomes a look with the colors it showed', async (t) => {
  const saved = new Map([
    ['appearance-palette', 'custom'],
    ['appearance-custom-palette', JSON.stringify({ hue: 20, tint: 0.1, accent: '#00ff00' })],
  ]);
  const { root } = await setup(t, {
    getItem: async (key) => saved.get(key) ?? null,
    async setItem(key, value) {
      saved.set(key, value);
    },
    async removeItem(key) {
      saved.delete(key);
    },
  });
  await root.initializeAppearance();
  const shown = root.appearance.look();
  const before = palette.paletteTokens({ hue: 20, tint: 0.1, accent: '#00ff00' }, false);
  assert.equal(shown.cssVars.light.background, before.background);
  assert.equal(shown.cssVars.light.primary, before.accent);
  assert.deepEqual(JSON.parse(saved.get('appearance-look')), shown);
  assert.equal(saved.has('appearance-palette'), false);
  assert.equal(saved.has('appearance-custom-palette'), false);
});

test('saved changes to a look undo in order, and the default unchanged is no look', async (t) => {
  const { root } = await setup(t, { getItem: async () => null, async setItem() {} });
  const { appearance } = root;
  appearance.choosePreset('blueprint');
  const edited = structuredClone(appearance.shown());
  edited.cssVars.light.primary = '#ff0000';
  appearance.changeLook(edited, false);
  appearance.changeLook(edited, true);
  assert.equal(appearance.look().cssVars.light.primary, '#ff0000');
  appearance.undo();
  assert.equal(appearance.look().cssVars.light.primary, '#1f5fa8');
  appearance.undo();
  assert.equal(appearance.look(), null);
  assert.equal(appearance.canUndo(), false);
  appearance.choosePreset('default');
  assert.equal(appearance.look(), null);
});

test('a color made readable on a mid-gray background reaches the ratio', () => {
  for (const gray of ['#787878', '#808080'])
    assert.ok(look.contrast(look.readable(gray, gray, 4.5), gray) >= 4.5, gray);
});

test('every preset reads in both appearances', () => {
  for (const id of look.lookIds)
    for (const mode of ['light', 'dark']) {
      const colors = look.presetLooks[id].cssVars[mode];
      const tokens = look.lookTokens(colors);
      const content = colors.background;
      const at = `${id} ${mode}`;
      assert.ok(look.contrast(tokens.text, content) >= 4.5, `${at} text`);
      assert.ok(look.contrast(tokens.secondary, content) >= 4.5, `${at} secondary`);
      assert.ok(look.contrast(tokens.muted, content) >= 4.5, `${at} muted`);
      // Hovered rows and inline code sit a step or two up, whatever color the lines are.
      for (const step of ['raised', 'pressed'])
        assert.ok(look.contrast(tokens.text, tokens[step]) >= 4.5, `${at} text on ${step}`);
      assert.ok(look.contrast(tokens.accentText, content) >= 4.5, `${at} accent text`);
      assert.ok(look.contrast(tokens.onAccent, tokens.accent) >= 4.5, `${at} text on accent`);
    }
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

test('text sizes step by a point between their limits, from saved ratios too', async (t) => {
  const saved = new Map([['appearance-text-size', '1.3']]);
  const { root, fixture } = await setup(t, {
    getItem: async (key) => saved.get(key) ?? null,
    async setItem(key, value) {
      saved.set(key, value);
    },
  });
  root.initializeAppearance();
  await setImmediate();
  const { appearance } = root;
  assert.equal(appearance.fontSize(), 18);
  appearance.stepTextSize(1);
  assert.equal(appearance.textSize(), 18 / 14);
  appearance.stepTextSize(-1);
  assert.equal(appearance.fontSize(), 17);
  appearance.chooseTextSize(0.9);
  appearance.stepTextSize(-1);
  appearance.stepTextSize(-1);
  assert.equal(appearance.fontSize(), 12);
  appearance.stepTextSize(0);
  assert.equal(appearance.textSize(), 1);
  const applied = fixture.sizes.length;
  appearance.stepTextSize(0);
  assert.equal(fixture.sizes.length, applied);
});

test('a hidden tray icon is restored only where the platform offers it', async (t) => {
  const storage = {
    getItem: async (key) => (key === 'appearance-tray-icon' ? 'none' : null),
    async setItem() {},
  };
  const mac = await setup(t, storage);
  assert.equal(mac.root.appearance.trayIconKnown(), false);
  mac.root.initializeAppearance();
  await setImmediate();
  assert.equal(mac.root.appearance.trayIconKnown(), true);
  assert.equal(mac.root.appearance.trayIcon(), 'none');
  const linux = await setup(t, storage, 'linux');
  assert.equal(linux.root.appearance.trayIconKnown(), true);
  linux.root.initializeAppearance();
  await setImmediate();
  assert.equal(linux.root.appearance.trayIcon(), 'bold');
});
