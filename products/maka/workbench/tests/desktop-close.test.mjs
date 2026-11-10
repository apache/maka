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
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

const appRoot = new URL('../app/', import.meta.url);
let sequence = 0;

function windowRef() {
  const listeners = new Set();
  return {
    listeners,
    subscriptions: 0,
    attributes: {},
    hidden: false,
    hides: 0,
    focuses: 0,
    set(attributes) {
      Object.assign(this.attributes, attributes);
    },
    hide() {
      this.hidden = true;
      this.hides++;
    },
    focus() {
      this.hidden = false;
      this.focuses++;
    },
    on(event, handler) {
      assert.equal(event, 'closePress');
      this.subscriptions++;
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    closePress() {
      for (const handler of listeners) handler({ reason: 'closeButton' });
    },
  };
}

async function setup(
  t,
  { desktop = true, idiom = 'desktop', available = true, os = 'linux', bootstrap = false } = {},
) {
  const id = ++sequence;
  const cleanups = [];
  const streamEnd = Promise.withResolvers();
  const fixture = {
    cleanups,
    mounted: 0,
    platform: { desktop, idiom, os },
    available,
    main: windowRef(),
    other: windowRef(),
    gets: [],
    icon: 'asset:/maka/desktop-icon.png',
    tray: null,
    trayUpdates: 0,
    menu: [],
    posts: [],
    bindingsClosed: 0,
    watchClosed: 0,
    imports: 0,
    activations: 0,
    captures: 0,
    calls: 0,
    state: { draft: 'unfinished 原文😀', selectedSession: 'conversation-42' },
    module: {
      activate() {
        fixture.activations++;
        return {
          exports: {
            root: { kind: 'root', render() {} },
            run: {
              kind: 'command',
              run() {
                fixture.calls++;
                fixture.state.draft += '!';
              },
            },
          },
          prepareReload() {
            fixture.captures++;
            return fixture.state;
          },
        };
      },
    },
    dispose() {
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    },
  };
  fixture.host = {
    restored: null,
    refresh: async () => {},
    readUi: async () =>
      bootstrap
        ? { source: { revision: 1 }, ui: null, instances: [] }
        : {
            source: { stateDomain: 'domain', deployment: 'main', revision: 1 },
            ui: { instance: ['plugin'], id: 'root' },
            instances: [
              {
                instance: ['plugin'],
                path: ['plugin'],
                package: { id: 'demo.ui', revision: 'sha256-package' },
                module: 'main.tsx',
                definitionBasis: 'definition',
                configuration: {},
                contributions: { root: { kind: 'root' }, run: { kind: 'command' } },
              },
            ],
          },
    subscribe: async () => ({
      next: () => streamEnd.promise,
      async close() {
        fixture.watchClosed++;
        streamEnd.resolve(null);
      },
    }),
    bindUi: async () => ({
      imports: {},
      application: () => ({}),
      async close() {
        fixture.bindingsClosed++;
      },
    }),
  };
  globalThis.__desktopFixture = fixture;
  const native = {
    nsh: `const fixture = globalThis.__desktopFixture;
      // fixture ${id}
      let tracking;
      export const signal = initial => {
        let value = initial;
        const subscribers = new Set();
        const read = () => {
          if (tracking) { subscribers.add(tracking); tracking.dependencies.add(subscribers); }
          return value;
        };
        read.set = next => { value = next; for (const run of [...subscribers]) run(); };
        return read;
      };
      export const cleanup = fn => fixture.cleanups.push(fn);
      export const effect = fn => {
        const run = () => { tracking = run; try { fn(); } finally { tracking = undefined; } };
        run.dependencies = new Set();
        cleanup(() => { for (const subscribers of run.dependencies) subscribers.delete(run); });
        run();
      };
      export const mount = root => { fixture.tree = root(); fixture.mounted++; };
      export const jsx = (type, props, ...children) => ({ type, props, children });
      export const View = 'View', Text = 'Text', Each = 'Each', If = 'If';
      export const platform = fixture.platform;
      export const computed = read => read;
      export const batch = fn => fn();
      export const host = { post: event => fixture.posts.push(event) };
      export const importModule = async () => { fixture.imports++; return fixture.module; };`,
    'nsh/desktop': `const fixture = globalThis.__desktopFixture;
      // fixture ${id}
      export const isAvailable = fixture.available;
      export const Menu = { setApplicationMenu: items => { fixture.menu = items; } };
      export const currentWindow = () => fixture.main;
      export const titleBar = () => ({ left: 0, right: 0 });
      export const Window = { get: id => { fixture.gets.push(id); return fixture[id]; } };
      export const Tray = { set: value => { fixture.tray = value; fixture.trayUpdates++; } };`,
    'maka/host': `// fixture ${id}
      export const host = globalThis.__desktopFixture.host;`,
    text: `export class UiError extends Error {}
      export const errorText = value => value; export const renderText = value => String(value);`,
    host: 'export const uiHost = {};',
    'nsh/base': "export const Button = 'Button';",
    appearance: 'export const initializeAppearance = () => {};',
    ui: 'export const C = {};',
    Loading: "export const LoadingState = 'LoadingState';",
    locale: `import { signal } from 'nsh';
      // fixture ${id}
      export const currentLocale = signal('en');
      export const tr = key => currentLocale() + ':' + key;`,
    RuntimeView: `export const PluginInstances = 'PluginInstances';
      export const renderContribution = () => { throw Error('unexpected render'); };
      export const renderEmbeddedView = renderContribution;`,
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      let key = specifier;
      if (context.parentURL?.startsWith(appRoot.href)) {
        if (specifier === '../host') key = 'host';
        if (specifier === '../text' || specifier === './text') key = 'text';
        for (const name of ['appearance', 'ui', 'Loading'])
          if (specifier === './' + name) key = name;
        if (specifier === '../locale' || specifier === './locale') key = 'locale';
        if (specifier === './RuntimeView' || specifier === './plugins/RuntimeView')
          key = 'RuntimeView';
      }
      if (key in native)
        return {
          url: `data:text/javascript,${encodeURIComponent(native[key])}`,
          shortCircuit: true,
        };
      if (
        context.parentURL?.startsWith(appRoot.href) &&
        specifier.startsWith('.') &&
        !/\.\w+$/.test(specifier)
      )
        return next(`${specifier}.ts?fixture=${id}`, context);
      return next(specifier, context);
    },
    load(url, context, next) {
      if (!url.startsWith(new URL('Bootstrap.tsx', appRoot).href)) return next(url, context);
      const result = transformSync(readFileSync(new URL(url), 'utf8'), {
        loader: 'tsx',
        format: 'esm',
        jsxFactory: 'jsx',
        banner: "import { jsx, Each, If } from 'nsh';",
      });
      return { format: 'module', source: result.code, shortCircuit: true };
    },
  });
  t.after(async () => {
    fixture.dispose();
    await setImmediate();
    hooks.deregister();
    delete globalThis.__desktopFixture;
  });
  const { nativeDesktop } = await import(new URL(`nativeDesktop.ts?fixture=${id}`, appRoot));
  const { createPlugins } = await import(new URL(`plugins/registry.ts?fixture=${id}`, appRoot));
  const { currentLocale } = await import('locale');
  fixture.installMenu = async () => {
    const { applicationMenu } = await import(new URL(`chrome.ts?fixture=${id}`, appRoot));
    applicationMenu({ sidebarShown: () => false });
  };
  fixture.install = nativeDesktop;
  fixture.locale = currentLocale;
  if (bootstrap) {
    await import(new URL(`Bootstrap.tsx?fixture=${id}`, appRoot));
    await setImmediate();
    return fixture;
  }
  nativeDesktop();
  fixture.manager = createPlugins();
  await setImmediate();
  fixture.entry = fixture.manager.entries()[0];
  const loading = fixture.manager.load(fixture.entry);
  await setImmediate();
  fixture.manager.activate(fixture.entry, fixture.module);
  await loading;
  fixture.run = () => fixture.manager.runtime.invoke({ key: `${fixture.entry.key}/run` }, {});
  return fixture;
}

test('closing the main window only hides it; plugins and other windows keep working', async (t) => {
  const h = await setup(t);
  const state = h.state;
  const active = h.entry.state();
  let otherCloses = 0;
  h.other.on('closePress', () => otherCloses++);

  assert.equal(h.tray.icon, h.icon);
  assert.equal(h.main.attributes.closeOnPress, false);
  h.main.closePress();
  h.main.closePress();
  assert.equal(h.main.hides, 2);
  assert.equal(h.main.hidden, true);
  assert.equal(await h.run(), true);
  assert.equal(h.state, state);
  assert.equal(h.state.draft, 'unfinished 原文😀!');
  assert.equal(h.state.selectedSession, 'conversation-42');
  assert.equal(h.entry.state(), active);
  assert.equal(h.entry.live, true);
  assert.equal(h.manager.runtime.reloading(), false);
  assert.equal(h.captures, 0);
  assert.equal(h.bindingsClosed, 0);
  assert.equal(h.watchClosed, 0);
  assert.deepEqual(h.posts, []);

  h.other.closePress();
  assert.equal(otherCloses, 1);
  assert.equal(h.main.hides, 2);
  assert.deepEqual(h.other.attributes, {});
  assert.deepEqual(h.gets, ['main']);
});

test('Open and primary tray click focus the existing main window without reloading UI', async (t) => {
  const h = await setup(t);
  for (const open of [h.tray.menu[0].onSelect, h.tray.onClick]) {
    h.main.closePress();
    open();
    assert.equal(h.main.hidden, false);
    assert.equal(await h.run(), true);
  }
  assert.equal(h.main.focuses, 2);
  assert.equal(h.imports, 1);
  assert.equal(h.activations, 1);
  assert.equal(h.captures, 0);
  assert.equal(h.state.draft, 'unfinished 原文😀!!');
  assert.deepEqual(h.gets, ['main']);
});

test('Quit explicitly posts terminal.exit without closing or snapshotting the main window', async (t) => {
  const h = await setup(t);
  h.tray.menu[2].onSelect();
  assert.deepEqual(h.posts, ['terminal.exit']);
  assert.equal(h.main.hides, 0);
  assert.equal(h.captures, 0);
  assert.equal(h.bindingsClosed, 0);
});

test('locale updates do not resubscribe close; repeated owner cleanup and remount leave no tray handlers', async (t) => {
  const h = await setup(t);
  for (const locale of ['zh-CN', 'zh-TW', 'en']) {
    h.locale.set(locale);
    assert.equal(h.tray.menu[0].label, `${locale}:Open Maka`);
    assert.equal(h.tray.menu[2].label, `${locale}:Quit Maka`);
  }
  assert.equal(h.main.subscriptions, 1);
  assert.equal(h.main.listeners.size, 1);
  for (let i = 0; i < 3; i++) {
    h.dispose();
    h.dispose();
    assert.equal(h.tray, null);
    assert.equal(h.main.listeners.size, 0);
    const updates = h.trayUpdates;
    h.locale.set('zh-CN');
    assert.equal(h.trayUpdates, updates, 'disposed locale effects must not recreate a tray');
    const hides = h.main.hides;
    h.main.closePress();
    assert.equal(h.main.hides, hides);
    h.install();
    assert.equal(h.main.listeners.size, 1);
    h.main.closePress();
    assert.equal(h.main.hides, hides + 1);
  }
});

for (const [name, options] of [
  ['terminal on a desktop OS', { idiom: 'terminal' }],
  ['non-desktop platform', { desktop: false }],
  ['unavailable desktop API', { available: false }],
]) {
  test(`${name} does not install native desktop lifecycle`, async (t) => {
    const h = await setup(t, options);
    assert.deepEqual(h.gets, []);
    assert.equal(h.main.listeners.size, 0);
    assert.deepEqual(h.main.attributes, {});
    assert.equal(h.trayUpdates, 0);
    assert.equal(await h.run(), true);
  });
}

test('the non-Mac application menu explicitly quits without binding Alt+F4', async (t) => {
  const h = await setup(t, { os: 'windows' });
  await h.installMenu();
  h.main.closePress();
  const quit = h.menu
    .flatMap((group) => group?.submenu ?? [])
    .find((item) => item?.label === 'en:Quit Maka');
  assert.ok(quit);
  assert.equal(quit.shortcut, 'mod+q');
  assert.equal(quit.role, undefined);
  quit.onSelect();
  assert.deepEqual(h.posts, ['terminal.exit']);
});

test('the Mac application menu retains its native Quit role', async (t) => {
  const h = await setup(t, { os: 'macos' });
  await h.installMenu();
  const quit = h.menu[0].submenu.find((item) => item?.role === 'quit');
  assert.ok(quit);
});

test('Bootstrap owns Desktop residency even when the deployment has no root UI', async (t) => {
  const h = await setup(t, { bootstrap: true });
  assert.equal(h.mounted, 1);
  assert.equal(h.imports, 0);
  assert.equal(h.main.attributes.closeOnPress, false);
  h.main.closePress();
  assert.equal(h.main.hidden, true);
  h.tray.menu[0].onSelect();
  assert.equal(h.main.hidden, false);
  h.tray.menu[2].onSelect();
  assert.deepEqual(h.posts, ['terminal.exit']);
  h.dispose();
  assert.equal(h.main.listeners.size, 0);
  assert.equal(h.tray, null);
  assert.equal(h.watchClosed, 1);
});
