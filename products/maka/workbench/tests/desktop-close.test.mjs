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
const native = {
  nsh: `let owner;
    export const setOwner = next => { owner = next; };
    export const fixture = () => owner;
    export const signal = initial => {
      let value = initial;
      const read = () => value;
      read.set = next => { value = next; };
      return read;
    };
    export const computed = read => read;
    export const batch = fn => fn();
    export const cleanup = fn => owner.cleanups.push(fn);
    export const host = {
      on: (event, handler) => owner.on(event, handler),
      post: (event, data) => owner.posts.push({ event, data }),
    };
    export const importModule = () => { throw new Error('unexpected plugin import'); };`,
  'maka/host': `import { fixture } from 'nsh';
    export const host = {
      restored: null,
      refresh: async () => {},
      readUi: () => fixture().catalog.promise,
      subscribe: async () => fixture().stream,
    };`,
  text: `export class UiError extends Error {}`,
  host: `export const uiHost = {};`,
  locale: `export const currentLocale = () => 'en';`,
  value: `export const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);`,
  RuntimeView: `export const renderContribution = () => { throw new Error('unexpected render'); };
    export const renderEmbeddedView = renderContribution;`,
};
const aliases = {
  '../text': 'text',
  '../host': 'host',
  '../locale': 'locale',
  '../../../../../plugins/shared/value': 'value',
  './RuntimeView': 'RuntimeView',
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const local = context.parentURL?.startsWith(appRoot.href);
    const key = local ? (aliases[specifier] ?? specifier) : specifier;
    if (key in native)
      return { url: `data:text/javascript,${encodeURIComponent(native[key])}`, shortCircuit: true };
    if (local && specifier.startsWith('.') && !/\.\w+$/.test(specifier))
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { signal, setOwner } = await import('nsh');
const { createPlugins } = await import(new URL('plugins/registry.ts', appRoot));
hooks.deregister();

const deferred = () => Promise.withResolvers();
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function setup(t) {
  const listeners = new Map();
  const harness = {
    posts: [],
    cleanups: [],
    catalog: deferred(),
    stream: { next: () => new Promise(() => {}), close: async () => {} },
    on(event, handler) {
      let handlers = listeners.get(event);
      if (!handlers) listeners.set(event, (handlers = new Set()));
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit(event, data) {
      for (const handler of listeners.get(event) ?? []) handler(data);
    },
    dispose() {
      for (const cleanup of harness.cleanups.splice(0).reverse()) cleanup();
    },
  };
  setOwner(harness);
  harness.manager = createPlugins();
  t.after(() => harness.dispose());
  return harness;
}

function plugin(name, prepareReload) {
  let calls = 0;
  const entry = {
    key: name,
    identity: name,
    source: {},
    instance: {
      instance: [name],
      path: [name],
      package: { id: `maka.${name}`, revision: 'sha256-package' },
      definitionBasis: 'definition-1',
      contributions: { run: { kind: 'command' } },
    },
    state: signal({
      kind: 'active',
      activation: {
        prepareReload,
        exports: {
          run: {
            kind: 'command',
            run: () => {
              calls++;
            },
          },
        },
      },
      module: {},
      context: {},
    }),
    live: true,
  };
  return { entry, reference: { key: `${name}/run` }, calls: () => calls };
}

const saved = (entry, state) => ({
  instance: entry.instance.instance,
  packageId: entry.instance.package.id,
  state,
});

function ready(id, instances) {
  return { event: 'desktop.closeReady', data: { id, state: { instances } } };
}

test('desktop close captures every active plugin and blocks commands until UI destruction', async (t) => {
  const h = setup(t);
  const capture = deferred();
  const session = { sessionId: 'conversation-42', draft: 'unfinished message' };
  const panel = { selectedPanel: 'files', path: '/workspace/notes.md' };
  const root = plugin('root', () => capture.promise);
  const inspector = plugin('inspector', () => panel);
  const stateless = plugin('stateless');
  const idle = plugin('idle');
  idle.entry.state.set({ kind: 'idle' });
  h.manager.entries.set([root.entry, inspector.entry, stateless.entry, idle.entry]);
  assert.equal(await h.manager.runtime.invoke(root.reference, {}), true);

  h.emit('desktop.prepareClose', { id: 'close-1' });
  assert.equal(h.manager.runtime.reloading(), true);
  assert.equal(h.manager.runtime.commandEnabled(root.reference, {}), false);
  assert.equal(await h.manager.runtime.invoke(root.reference, {}), false);
  assert.equal(root.calls(), 1, 'a close in progress must not dispatch another command');
  assert.deepEqual(h.posts, [], 'the native close must wait for plugin state');

  capture.resolve(session);
  await flush();
  assert.deepEqual(h.posts, [
    ready('close-1', [
      saved(root.entry, session),
      saved(inspector.entry, panel),
      saved(stateless.entry, null),
    ]),
  ]);
  assert.equal(h.manager.runtime.reloading(), true, 'captured UI remains paused until destruction');
});

test('snapshot failure reports the cause and makes the existing UI usable again', async (t) => {
  const h = setup(t);
  const capture = deferred();
  const failure = new Error('draft capture failed');
  const root = plugin('root', () => capture.promise);
  h.manager.entries.set([root.entry]);
  h.emit('desktop.prepareClose', { id: 'close-1' });
  capture.reject(failure);
  await flush();

  assert.deepEqual(h.posts, [
    {
      event: 'desktop.closeReady',
      data: { id: 'close-1', error: String(failure) },
    },
  ]);
  assert.equal(h.manager.runtime.updateError(), failure);
  assert.equal(h.manager.runtime.reloading(), false);
  assert.equal(h.manager.runtime.commandEnabled(root.reference, {}), true);
  assert.equal(await h.manager.runtime.invoke(root.reference, {}), true);
  assert.equal(root.calls(), 1);
});

for (const outcome of ['success', 'failure']) {
  test(`late snapshot ${outcome} from a timed-out close cannot complete or unpause its retry`, async (t) => {
    const h = setup(t);
    const first = deferred();
    const retry = deferred();
    let captures = 0;
    const root = plugin('root', () => (++captures === 1 ? first.promise : retry.promise));
    h.manager.entries.set([root.entry]);
    h.emit('desktop.prepareClose', { id: 'close-1' });
    h.emit('desktop.closeFailed', { id: 'close-1', error: 'state capture timed out' });
    assert.equal(h.manager.runtime.reloading(), false);
    assert.match(String(h.manager.runtime.updateError()), /state capture timed out/);

    h.emit('desktop.prepareClose', { id: 'close-2' });
    const retryError = h.manager.runtime.updateError();
    h.emit('desktop.closeFailed', { id: 'close-1', error: 'late timeout notification' });
    if (outcome === 'success') first.resolve({ sessionId: 'stale-session' });
    else first.reject(new Error('late capture failure'));
    await flush();
    assert.deepEqual(h.posts, [], 'only the current attempt may publish close readiness');
    assert.equal(h.manager.runtime.updateError(), retryError);
    assert.equal(h.manager.runtime.reloading(), true);
    assert.equal(await h.manager.runtime.invoke(root.reference, {}), false);

    const current = { sessionId: 'current-session', panel: 'editor' };
    retry.resolve(current);
    await flush();
    assert.deepEqual(h.posts, [ready('close-2', [saved(root.entry, current)])]);
  });
}

for (const outcome of ['success', 'failure']) {
  test(`disposing the registry suppresses pending snapshot ${outcome}`, async (t) => {
    const h = setup(t);
    const capture = deferred();
    const root = plugin('root', () => capture.promise);
    h.manager.entries.set([root.entry]);
    h.emit('desktop.prepareClose', { id: 'close-1' });
    h.dispose();
    if (outcome === 'success') capture.resolve({ sessionId: 'closed-session' });
    else capture.reject(new Error('capture completed after destruction'));
    await flush();
    assert.deepEqual(h.posts, []);
    assert.equal(h.manager.runtime.updateError(), null);
  });
}

test('catalog updates wait for a close snapshot and resume after native close failure', async (t) => {
  const h = setup(t);
  const capture = deferred();
  const root = plugin('root', () => capture.promise);
  h.manager.entries.set([root.entry]);
  h.emit('desktop.prepareClose', { id: 'close-1' });
  h.catalog.resolve({ source: { revision: 2 }, instances: [], ui: null });
  await flush();
  assert.deepEqual(h.manager.entries(), [root.entry], 'capture must retain its active plugin set');

  h.emit('desktop.closeFailed', { id: 'close-1', error: 'native close timed out' });
  await flush();
  assert.deepEqual(h.manager.entries(), [], 'the deferred catalog must be applied when UI resumes');
  capture.resolve({ sessionId: 'retired-session' });
  await flush();
  assert.deepEqual(h.posts, [], 'the abandoned close may not publish the retired plugin state');
});
