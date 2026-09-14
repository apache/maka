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
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'node:test';
import {
  ClientPluginRuntime,
  type MakaClientBundleRegistration,
  type MakaClientPluginContext,
  type MakaClientPluginDescriptor,
  type MakaClientPluginSnapshot,
  MakaClientRoot,
  MakaClientRootOutlet,
} from '../client-plugin-runtime.js';

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
