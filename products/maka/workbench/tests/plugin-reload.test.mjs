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

function updates() {
  const queued = [];
  let waiting;
  return {
    next() {
      return queued.length
        ? Promise.resolve(queued.shift())
        : new Promise((resolve) => {
            waiting = resolve;
          });
    },
    push(value) {
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve(value);
      } else queued.push(value);
    },
    async close() {
      this.push(null);
    },
  };
}

function catalog(revision, root = 'root') {
  return {
    source: { stateDomain: 'domain', deployment: 'main', revision },
    ui: { instance: ['plugin'], id: root },
    instances: [
      {
        instance: ['plugin'],
        path: ['plugin'],
        package: { id: 'demo.ui', revision: `sha256-${'a'.repeat(64)}` },
        configuration: {},
        module: 'main.tsx',
        definitionBasis: 'definition',
        bindingBasis: `binding-${revision}`,
        imports: {},
        contributions: {
          root: { kind: 'root' },
          other: { kind: 'root' },
          tool: { kind: 'tool_renderer', presentation: 'demo' },
        },
      },
    ],
  };
}

async function setup(
  t,
  { begin = async () => {}, prepare = async () => ({ draft: '原文😀' }) } = {},
) {
  const id = ++sequence;
  const stream = updates();
  const initial = catalog(1);
  const catalogs = new Map([[1, initial]]);
  const cleanups = [];
  const fixture = {
    begins: 0,
    cancels: 0,
    prepares: 0,
    reloads: [],
    imports: [],
    module: {
      activate: () => ({
        exports: {
          root: { kind: 'root', render() {} },
          other: { kind: 'root', render() {} },
          tool: { kind: 'tool_renderer', render() {} },
        },
        async prepareReload() {
          fixture.prepares++;
          return prepare();
        },
      }),
    },
    host: {
      restored: null,
      async refresh() {},
      async readUi({ source }) {
        return catalogs.get(source?.revision ?? 1);
      },
      async subscribe() {
        return stream;
      },
      async bindUi() {
        return { imports: {}, application: () => ({}), close: async () => {} };
      },
      beginUiReload() {
        fixture.begins++;
        return begin();
      },
      cancelUiReload() {
        fixture.cancels++;
      },
      reloadUi(state) {
        fixture.reloads.push(state);
      },
    },
    cleanups,
    publish(value) {
      catalogs.set(value.source.revision, value);
      stream.push(value.source);
    },
    dispose() {
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    },
  };
  globalThis.__pluginReloadFixture = fixture;
  const native = {
    nsh: `const fixture = globalThis.__pluginReloadFixture;
      // fixture ${id}
      export const signal = initial => {
        let value = initial;
        const read = () => value;
        read.set = next => { value = next; };
        return read;
      };
      export const computed = read => read;
      export const batch = run => run();
      export const cleanup = fn => fixture.cleanups.push(fn);
      export const importModule = async id => {
        fixture.imports.push(id);
        return fixture.module;
      };`,
    'maka/host': `// fixture ${id}
      export const host = globalThis.__pluginReloadFixture.host;`,
    host: 'export const uiHost = {};',
    locale: `export const currentLocale = () => 'en';
      currentLocale.set = () => {};
      export const tr = (key, values) => values
        ? key.replace(/\\{(\\w+)\\}/g, (_, name) => values[name]) : key;`,
    RuntimeView: `export const renderContribution = () => { throw Error('unexpected render'); };
      export const renderEmbeddedView = () => { throw Error('unexpected render'); };`,
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      let key = specifier;
      if (context.parentURL?.startsWith(appRoot.href)) {
        if (specifier === '../host') key = 'host';
        if (specifier === '../locale' || specifier === './locale') key = 'locale';
        if (specifier === './RuntimeView') key = 'RuntimeView';
      }
      if (key in native) {
        return {
          url: `data:text/javascript,${encodeURIComponent(native[key])}`,
          shortCircuit: true,
        };
      }
      if (
        context.parentURL?.startsWith(appRoot.href) &&
        specifier.startsWith('.') &&
        !/\.\w+$/.test(specifier)
      ) {
        return next(`${specifier}.ts`, context);
      }
      return next(specifier, context);
    },
  });
  t.after(() => {
    fixture.dispose();
    hooks.deregister();
    delete globalThis.__pluginReloadFixture;
  });
  const { createPlugins } = await import(new URL(`plugins/registry.ts?fixture=${id}`, appRoot));
  const manager = createPlugins();
  await setImmediate();
  assert.equal(manager.runtime.ready(), true);
  const entry = manager.entries()[0];
  const loading = manager.load(entry);
  await setImmediate();
  assert.equal(entry.state().kind, 'loaded');
  manager.activate(entry, fixture.module);
  await loading;
  assert.equal(entry.state().kind, 'active');
  return { fixture, manager };
}

test('a rejected native pause leaves no JS gate to cancel and a later update can retry', async (t) => {
  const failure = new Error('native backend cannot reload');
  let calls = 0;
  const { fixture, manager } = await setup(t, {
    begin: async () => {
      if (++calls === 1) throw failure;
    },
  });
  fixture.publish(catalog(2, 'other'));
  await setImmediate();
  assert.equal(fixture.begins, 1);
  assert.equal(fixture.cancels, 0);
  assert.equal(fixture.prepares, 0);
  assert.equal(manager.runtime.reloading(), false);
  assert.equal(manager.runtime.updateError(), failure);
  assert.equal(manager.runtime.source().revision, 1);
  fixture.publish(catalog(3, 'other'));
  await setImmediate();
  assert.equal(fixture.begins, 2);
  assert.equal(fixture.cancels, 0);
  assert.deepEqual(fixture.reloads, [
    {
      instances: [
        {
          instance: ['plugin'],
          packageId: 'demo.ui',
          state: { draft: '原文😀' },
        },
      ],
    },
  ]);
  assert.equal(manager.runtime.reloading(), true);
});

test('catalog changes while pause is requested use the latest source without overlapping pause', async (t) => {
  const pause = Promise.withResolvers();
  const { fixture, manager } = await setup(t, { begin: () => pause.promise });
  fixture.publish(catalog(2, 'other'));
  await setImmediate();
  assert.equal(fixture.begins, 1);
  assert.equal(fixture.prepares, 0);
  assert.equal(manager.runtime.reloading(), true);
  fixture.publish(catalog(3));
  await setImmediate();
  assert.equal(fixture.begins, 1);
  assert.equal(fixture.cancels, 0);
  pause.resolve();
  await setImmediate();
  assert.equal(fixture.prepares, 1);
  assert.equal(fixture.cancels, 1);
  assert.deepEqual(fixture.reloads, []);
  assert.equal(manager.runtime.reloading(), false);
  assert.equal(manager.runtime.source().revision, 3);
  assert.equal(manager.entries()[0].state().kind, 'active');
});

test('a newly invalid desired catalog releases only the successfully held pause', async (t) => {
  const prepared = Promise.withResolvers();
  const { fixture, manager } = await setup(t, { prepare: () => prepared.promise });
  fixture.publish(catalog(2, 'other'));
  await setImmediate();
  assert.equal(fixture.begins, 1);
  assert.equal(fixture.prepares, 1);
  const invalid = catalog(3, 'other');
  invalid.instances.push({ ...invalid.instances[0], instance: ['second'], path: ['second'] });
  fixture.publish(invalid);
  await setImmediate();
  assert.equal(fixture.begins, 1);
  assert.equal(fixture.cancels, 0);
  prepared.resolve({ draft: 'kept' });
  await setImmediate();
  assert.equal(fixture.cancels, 1);
  assert.deepEqual(fixture.reloads, []);
  assert.equal(manager.runtime.reloading(), false);
  assert.equal(manager.runtime.source().revision, 1);
  assert.equal(
    manager.runtime.updateError().message,
    'Multiple plugins render the same tool presentation: demo',
  );
  fixture.publish(catalog(4));
  await setImmediate();
  assert.equal(manager.runtime.source().revision, 4);
  assert.equal(manager.runtime.updateError(), null);
  assert.equal(fixture.begins, 1);
  assert.equal(fixture.cancels, 1);
});

test('preparation failure returns its held pause and preserves the original error', async (t) => {
  const failure = new Error('original preparation failed');
  const { fixture, manager } = await setup(t, {
    prepare: async () => {
      throw failure;
    },
  });
  fixture.publish(catalog(2, 'other'));
  await setImmediate();
  assert.equal(fixture.begins, 1);
  assert.equal(fixture.prepares, 1);
  assert.equal(fixture.cancels, 1);
  assert.deepEqual(fixture.reloads, []);
  assert.equal(manager.runtime.updateError(), failure);
  assert.equal(manager.runtime.reloading(), false);
});

test('an accepted reload keeps its original snapshot and cannot resume or reconcile again', async (t) => {
  const { fixture, manager } = await setup(t);
  fixture.publish(catalog(2, 'other'));
  await setImmediate();
  assert.deepEqual(fixture.reloads, [
    {
      instances: [
        {
          instance: ['plugin'],
          packageId: 'demo.ui',
          state: { draft: '原文😀' },
        },
      ],
    },
  ]);
  assert.equal(manager.runtime.reloading(), true);
  fixture.publish(catalog(3));
  await setImmediate();
  assert.equal(fixture.begins, 1);
  assert.equal(fixture.prepares, 1);
  assert.equal(fixture.cancels, 0);
  assert.equal(fixture.reloads.length, 1);
  assert.equal(manager.runtime.source().revision, 1);
  fixture.dispose();
  await setImmediate();
  assert.equal(fixture.cancels, 0);
});

test('disposal before pause acknowledgement still returns a subsequently held gate', async (t) => {
  const pause = Promise.withResolvers();
  const { fixture, manager } = await setup(t, { begin: () => pause.promise });
  fixture.publish(catalog(2, 'other'));
  await setImmediate();
  assert.equal(manager.runtime.reloading(), true);
  fixture.dispose();
  assert.equal(fixture.cancels, 0);
  pause.resolve();
  await setImmediate();
  assert.equal(fixture.begins, 1);
  assert.equal(fixture.prepares, 0);
  assert.equal(fixture.cancels, 1);
  assert.deepEqual(fixture.reloads, []);
  assert.equal(manager.runtime.reloading(), false);
});
