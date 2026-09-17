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
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'node:test';
import {
  ClientPluginRuntime,
  type MakaClientBundleRegistration,
  type MakaClientPluginContext,
  type MakaClientPluginDescriptor,
  type MakaClientPluginSnapshot,
  type MakaClientRemoteRequest,
  MakaClientRoot,
  MakaClientRootOutlet,
} from '../client-plugin-runtime.js';

declare module '@maka/core/client-plugin-bridge' {
  interface MakaClientRemoteStreamMap {
    readonly 'fixture.watch': import('@maka/core/client-plugin-bridge').MakaClientRemoteStream<object, unknown>;
  }
  interface MakaClientRemoteMethodMap {
    readonly 'fixture.echo': import('@maka/core/client-plugin-bridge').MakaClientRemoteMethod<
      { readonly text: string },
      { readonly text: string }
    >;
  }
}

function descriptor(extensionId: string, generation: number): MakaClientPluginDescriptor {
  return Object.freeze({
    entryId: `${extensionId}-entry`,
    extensionId,
    generation,
    contentDigest: `sha256-${String(generation).padStart(64, '0')}`,
    clientDigest: `sha256-${String(generation + 1).padStart(64, '0')}`,
    totalBytes: 1,
    dependencies: Object.freeze([]),
    url: `maka-client-plugin://bundle/${extensionId}/${generation}.js`,
  });
}

function snapshot(revision: number, ...plugins: MakaClientPluginDescriptor[]): MakaClientPluginSnapshot {
  return Object.freeze({
    authorityEpoch: revision,
    revision: `sha256-${String(revision).padStart(64, '0')}`,
    plugins: Object.freeze(plugins),
    failures: Object.freeze([]),
  });
}

function render(root: MakaClientRoot): string {
  return renderToStaticMarkup(
    <MakaClientRootOutlet root={root}>
      <span>built-in</span>
    </MakaClientRootOutlet>,
  );
}

test('Client Runtime loads a factory and composes the typed root Slot', async () => {
  const root = new MakaClientRoot();
  let runtime!: ClientPluginRuntime;
  runtime = new ClientPluginRuntime({
    root,
    staticModules: { react: { createElement } },
    loadBundle: async (plugin) => {
      runtime.registerBundle({
        id: plugin.extensionId,
        factory: (require) => {
          const React = require('react') as typeof import('react');
          return {
            apply(ctx: MakaClientPluginContext) {
              ctx.slots.register({ name: 'root' }, ({ children }) =>
                React.createElement('main', { 'data-plugin': ctx.extensionId }, children),
              );
            },
          };
        },
      });
    },
  });

  await runtime.reconcile(snapshot(1, descriptor('weather', 1)));
  assert.match(render(root), /data-plugin="weather"/u);
  assert.match(render(root), /built-in/u);
  await runtime.close();
  assert.doesNotMatch(render(root), /data-plugin/u);
});

test('Client Runtime stage/swap keeps the previous UI when a candidate fails', async () => {
  const root = new MakaClientRoot();
  const effects: string[] = [];
  const bundles = new Map<number, MakaClientBundleRegistration['factory']>([
    [
      1,
      () => ({
        apply(ctx: MakaClientPluginContext) {
          ctx.effect(() => {
            effects.push('one:setup');
            return () => {
              effects.push('one:dispose');
            };
          });
          ctx.slots.register({ name: 'root' }, ({ children }) => <section>one{children}</section>);
        },
      }),
    ],
    [
      2,
      () => ({
        apply(ctx: MakaClientPluginContext) {
          ctx.effect(() => {
            effects.push('broken:setup');
            return () => {
              effects.push('broken:dispose');
            };
          });
          ctx.slots.register({ name: 'root' }, ({ children }) => <section>broken{children}</section>);
          throw new Error('candidate failed');
        },
      }),
    ],
  ]);
  let runtime!: ClientPluginRuntime;
  runtime = new ClientPluginRuntime({
    root,
    staticModules: {},
    loadBundle: async (plugin) =>
      runtime.registerBundle({ id: plugin.extensionId, factory: bundles.get(plugin.generation)! }),
  });

  await runtime.reconcile(snapshot(1, descriptor('versioned', 1)));
  await runtime.reconcile(snapshot(2, descriptor('versioned', 2)));

  assert.match(render(root), />one/u);
  assert.doesNotMatch(render(root), /broken/u);
  assert.deepEqual(effects, ['one:setup']);
  assert.match(runtime.inspect().failure?.diagnostic ?? '', /candidate failed/u);
  await runtime.close();
  assert.deepEqual(effects, ['one:setup', 'one:dispose']);
});

test('Client Runtime retries the same snapshot revision after a transient apply failure', async () => {
  const root = new MakaClientRoot();
  let attempts = 0;
  let runtime!: ClientPluginRuntime;
  runtime = new ClientPluginRuntime({
    root,
    staticModules: {},
    loadBundle: async (plugin) =>
      runtime.registerBundle({
        id: plugin.extensionId,
        factory: () => ({
          apply(ctx: MakaClientPluginContext) {
            attempts++;
            if (attempts === 1) throw new Error('transient apply failure');
            ctx.slots.register({ name: 'root' }, ({ children }) => (
              <section data-recovered="true">{children}</section>
            ));
          },
        }),
      }),
  });
  const candidate = snapshot(7, descriptor('retry', 1));
  await runtime.reconcile(candidate);
  assert.match(runtime.inspect().failure?.diagnostic ?? '', /transient apply failure/u);
  await runtime.reconcile(candidate);
  assert.equal(attempts, 2);
  assert.match(render(root), /data-recovered="true"/u);
  await runtime.close();
});

test('Client Runtime re-materializes consumers when a dependency generation changes', async () => {
  const root = new MakaClientRoot();
  let runtime!: ClientPluginRuntime;
  runtime = new ClientPluginRuntime({
    root,
    staticModules: {},
    loadBundle: async (plugin) => {
      runtime.registerBundle({
        id: plugin.extensionId,
        factory:
          plugin.extensionId === 'dependency'
            ? () => ({ apply() {}, value: plugin.generation === 1 ? 'one' : 'two' })
            : (require) => {
                const dependency = require(plugin.dependencies[0] ?? '') as {
                  readonly value: string;
                };
                return {
                  apply(ctx: MakaClientPluginContext) {
                    ctx.slots.register({ name: 'root' }, ({ children }) => (
                      <section data-dependency={dependency.value}>{children}</section>
                    ));
                  },
                };
              },
      });
    },
  });
  const consumer = Object.freeze({
    ...descriptor('consumer', 1),
    dependencies: Object.freeze(['dependency']),
  });

  await runtime.reconcile(snapshot(1, consumer, descriptor('dependency', 1)));
  assert.equal(runtime.inspect().failure, null);
  assert.match(render(root), /data-dependency="one"/u);
  await runtime.reconcile(snapshot(2, consumer, descriptor('dependency', 2)));
  assert.match(render(root), /data-dependency="two"/u);
  await runtime.close();
});

test('Client Runtime atomically keeps the previous typed Slots when a candidate fails', async () => {
  const root = new MakaClientRoot();
  let runtime!: ClientPluginRuntime;
  runtime = new ClientPluginRuntime({
    root,
    staticModules: {},
    loadBundle: async (plugin) => {
      runtime.registerBundle({
        id: plugin.extensionId,
        factory: () => ({
          apply(ctx: MakaClientPluginContext) {
            ctx.slots.register(
              { name: 'sidebar.footer', id: `generation-${plugin.generation}` },
              () => null,
            );
            if (plugin.generation === 2) throw new Error('slot candidate failed');
          },
        }),
      });
    },
  });

  await runtime.reconcile(snapshot(1, descriptor('slots', 1)));
  await runtime.reconcile(snapshot(2, descriptor('slots', 2)));

  const sidebar = runtime.inspect().slots.find((slot) => slot.name === 'sidebar.footer');
  assert.equal(sidebar?.occupants[0]?.id, 'generation-1');
  assert.match(runtime.inspect().failure?.diagnostic ?? '', /slot candidate failed/u);
  await runtime.close();
});

test('Client Runtime binds Remote identity and owns product-event subscriptions', async () => {
  const root = new MakaClientRoot();
  const calls: MakaClientRemoteRequest[] = [];
  const subscriptions: string[] = [];
  let context!: MakaClientPluginContext;
  let runtime!: ClientPluginRuntime;
  runtime = new ClientPluginRuntime({
    root,
    staticModules: {},
    remote: {
      call: async (input) => {
        calls.push(input);
        return { value: input.input };
      },
      open: async () => ({ streamId: 'unused' }),
      next: async () => ({ done: true }),
      close: async () => undefined,
    },
    productEvents: {
      subscribe: (name) => {
        subscriptions.push(`open:${name}`);
        return () => subscriptions.push(`close:${name}`);
      },
    },
    loadBundle: async (plugin) => {
      runtime.registerBundle({
        id: plugin.extensionId,
        factory: () => ({
          apply(ctx: MakaClientPluginContext) {
            context = ctx;
            ctx.events.on('session.changed', {}, () => undefined);
          },
        }),
      });
    },
  });

  const plugin = descriptor('remote-owner', 7);
  await runtime.reconcile(snapshot(9, plugin));
  assert.deepEqual(subscriptions, ['open:session.changed']);
  assert.deepEqual(await context.remote.call('fixture.echo', { text: 'hello' }), {
    text: 'hello',
  });
  assert.deepEqual(calls[0], {
    authorityEpoch: 9,
    revision: `sha256-${String(9).padStart(64, '0')}`,
    entryId: plugin.entryId,
    extensionId: plugin.extensionId,
    generation: plugin.generation,
    contentDigest: plugin.contentDigest,
    clientDigest: plugin.clientDigest,
    method: 'fixture.echo',
    input: { text: 'hello' },
  });
  await runtime.close();
  assert.deepEqual(subscriptions, ['open:session.changed', 'close:session.changed']);
});

test('Client Runtime retirement aborts streams opened after activation', { timeout: 1000 }, async () => {
  let context!: MakaClientPluginContext;
  let started!: () => void;
  const pulling = new Promise<void>(resolve => { started = resolve; });
  const closed: string[] = [];
  let runtime!: ClientPluginRuntime;
  runtime = new ClientPluginRuntime({
    root: new MakaClientRoot(), staticModules: {},
    remote: {
      call: async () => ({ value: null }), open: async () => ({ streamId: 'owned' }),
      next: () => { started(); return new Promise(() => {}); },
      close: async ({ streamId }) => { closed.push(streamId); },
    },
    loadBundle: async plugin => { runtime.registerBundle({
      id: plugin.extensionId, factory: () => ({ apply(ctx: MakaClientPluginContext) { context = ctx; } }),
    }); },
  });
  await runtime.reconcile(snapshot(1, descriptor('streams', 1)));
  const iterator = context.remote.stream('fixture.watch', {})[Symbol.asyncIterator]();
  const rejected = assert.rejects(iterator.next(), { name: 'AbortError' });
  await pulling;
  await runtime.close();
  await rejected;
  assert.deepEqual(closed, ['owned']);
});


test('failed Client Plugin apply aborts streams before the instance is staged', { timeout: 1000 }, async () => {
  let started!: () => void;
  const pulling = new Promise<void>(resolve => { started = resolve; });
  const closed: string[] = [];
  let rejected!: Promise<void>;
  let runtime!: ClientPluginRuntime;
  runtime = new ClientPluginRuntime({
    root: new MakaClientRoot(), staticModules: {},
    remote: {
      call: async () => ({ value: null }), open: async () => ({ streamId: 'failed-apply' }),
      next: () => { started(); return new Promise(() => {}); },
      close: async ({ streamId }) => { closed.push(streamId); },
    },
    loadBundle: async plugin => { runtime.registerBundle({
      id: plugin.extensionId, factory: () => ({ async apply(ctx: MakaClientPluginContext) {
        rejected = assert.rejects(ctx.remote.stream('fixture.watch', {})[Symbol.asyncIterator]().next(), { name: 'AbortError' });
        await pulling;
        throw new Error('apply failed after opening stream');
      } }),
    }); },
  });
  await runtime.reconcile(snapshot(1, descriptor('streams', 1)));
  await rejected;
  assert.match(runtime.inspect().failure?.diagnostic ?? '', /apply failed/);
  assert.deepEqual(closed, ['failed-apply']);
  await runtime.close();
});


test('effects registered after activation start and dispose exactly once, including CSS and events', async () => {
  const { document } = parseHTML('<html><head></head><body></body></html>');
  let ctx!: MakaClientPluginContext;
  let subscribed = 0;
  let cleaned = 0;
  let effects = 0;
  let runtime!: ClientPluginRuntime;
  runtime = new ClientPluginRuntime({
    root: new MakaClientRoot(), staticModules: {}, document,
    productEvents: { subscribe() { subscribed++; return () => { cleaned++; }; } },
    loadBundle: async (plugin) => runtime.registerBundle({ id: plugin.extensionId, factory: () => ({
      apply(context: MakaClientPluginContext) { ctx = context; },
    }) }),
  });
  await runtime.reconcile(snapshot(1, descriptor('effects', 1)));
  const stop = ctx.events.on('session.changed', {}, () => undefined);
  const css = ctx.style('body { color: red; }');
  const effect = ctx.effect(() => { effects++; return () => { effects--; }; });
  assert.equal(subscribed, 1);
  assert.equal(document.head.querySelectorAll('style').length, 1);
  assert.equal(effects, 1);
  stop(); stop(); css(); effect();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(cleaned, 1);
  assert.equal(effects, 0);
  assert.equal(document.head.querySelectorAll('style').length, 0);
  ctx.events.on('session.changed', {}, () => undefined);
  await runtime.close();
  assert.equal(cleaned, 2);
  assert.throws(() => ctx.effect(() => {}), /disposed/);
  assert.throws(() => ctx.style('body {}'), /disposed/);
});

test('a throwing plugin root preserves the app and other roots and recovers on a new generation', async () => {
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = new MakaClientRoot();
  const container = window.document.getElementById('app')!;
  const mounted = createRoot(container, { onCaughtError() {} });
  let runtime!: ClientPluginRuntime;
  runtime = new ClientPluginRuntime({ root, staticModules: {}, loadBundle: async (plugin) => {
    runtime.registerBundle({ id: plugin.extensionId, factory: () => ({ apply(ctx: MakaClientPluginContext) {
      ctx.slots.register({ name: 'root' }, ({ children }) => {
        if (plugin.extensionId === 'broken' && plugin.generation === 1) throw new Error('root failure');
        return <section data-plugin={plugin.extensionId}>{children}</section>;
      });
    } }) });
  } });
  const originalError = console.error;
  console.error = () => {};
  try {
    await runtime.reconcile(snapshot(1, descriptor('broken', 1), descriptor('healthy', 1)));
    await act(() => mounted.render(<MakaClientRootOutlet root={root}><button>app</button></MakaClientRootOutlet>));
    assert.equal(container.querySelector('button')?.textContent, 'app');
    assert.ok(container.querySelector('[data-plugin="healthy"]'));
    assert.equal(container.querySelector('[data-plugin="broken"]'), null);
    await act(() => runtime.reconcile(snapshot(2, descriptor('broken', 2), descriptor('healthy', 1))));
    assert.ok(container.querySelector('[data-plugin="broken"]'));
  } finally {
    await act(() => runtime.close());
    await act(() => mounted.unmount());
    console.error = originalError;
    for (const key of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
