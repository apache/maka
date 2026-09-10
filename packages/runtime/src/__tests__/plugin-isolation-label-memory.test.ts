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
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const SETUP = String.raw`
  import assert from 'node:assert/strict';
  import { setImmediate as tick } from 'node:timers/promises';
  const { MakaCompositionLoader } = await import(process.argv[1]);
  const { Context } = await import(process.argv[2]);
  async function gc() { for (let i = 0; i < 8; i++) { await tick(); global.gc(); } }
  const refs = [];
  const originalIsolate = Context.prototype.isolate;
  Context.prototype.isolate = function(name, label) {
    refs.push(new WeakRef(label));
    return originalIsolate.call(this, name, label);
  };
  // Observe the real cache without adding a production inspection API. Keeping
  // the map itself live also proves that cleanup releases its historical keys.
  const caches = new Set();
  const originalSet = Map.prototype.set;
  Map.prototype.set = function(key, value) {
    if (typeof key === 'string' && key.startsWith('memory-label:') &&
        (typeof value === 'symbol' || value instanceof WeakRef)) caches.add(this);
    return originalSet.call(this, key, value);
  };
  const alive = () => refs.filter(ref => ref.deref() !== undefined).length;
  const cacheSize = () => [...caches].reduce((size, cache) => size + cache.size, 0);
  const pkg = (packageId, host) => ({ packageId, apiVersion: 1, host, contributions: [] });
`;

function runChild(source: string): void {
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '--eval',
      SETUP + source,
      new URL('../plugin-composition-loader.js', import.meta.url).href,
      new URL('../plugin-kernel.js', import.meta.url).href,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

test('removed and failed composition entries release named symbols and cache keys', () => {
  runChild(String.raw`
    const loader = new MakaCompositionLoader();
    await loader.create('profile', { id: 'control', isolate: { fixture: 'memory-label:control' } });
    await gc();
    assert.equal(alive(), 1, 'a live Context must keep its symbol');
    assert.equal(cacheSize(), 1);
    await loader.remove('control');
    await gc();
    assert.equal(alive(), 0, 'released control must collect while the loader remains live');
    assert.equal(cacheSize(), 0, 'collected labels must release their cache keys');

    for (const kind of ['named', 'failed', 'true']) {
      refs.length = 0;
      for (let i = 0; i < 128; i++) {
        const isolate = { fixture: kind === 'true' ? true : 'memory-label:' + kind + i };
        if (kind === 'failed') {
          await assert.rejects(loader.create('profile', { id: 'entry', packageId: 'missing', isolate }));
        } else {
          await loader.create('profile', { id: 'entry', isolate });
          await loader.remove('entry');
        }
      }
      assert.equal(refs.length, 128);
      assert.equal(loader.inspectTree().length, 0);
      assert.equal(loader.root.kernelFibers().length, 1);
      await gc();
      assert.equal(alive(), 0, kind + ' historical symbols must collect');
      assert.equal(cacheSize(), 0, kind + ' historical cache keys must collect');
    }
    await loader.create('profile', { id: 'closing', isolate: { fixture: 'memory-label:closing' } });
    await loader.close();
    await gc();
    assert.equal(alive(), 0, 'closing releases the remaining entry symbols');
    assert.equal(cacheSize(), 0);
  `);
});

test('detached root Contexts preserve shared isolation across entry lifetimes and GC', () => {
  runChild(String.raw`
    const loader = new MakaCompositionLoader();
    let detached;
    let seen;
    const value = { marker: 'provided-after-removal' };
    const reader = ctx => { seen = ctx.get('fixture'); };
    const isolate = { fixture: 'memory-label:shared' };
    await loader.install(pkg('capture', ctx => { detached = ctx.parent; }));
    await loader.install(pkg('reader', reader));
    await loader.create('profile', { id: 'capture', packageId: 'capture', isolate });
    assert.equal(detached.fiber, loader.root.fiber);
    await loader.remove('capture');
    await gc();
    assert.equal(alive(), 1, 'a detached Context still owns the original symbol');
    const cleanup = detached.provide('fixture', value);
    detached = undefined;
    await gc();
    assert.equal(alive(), 1, 'the root-owned service still owns its isolation symbol');
    await loader.create('profile', { id: 'reader', packageId: 'reader', isolate });
    assert.equal(seen, value);
    await loader.create('desktop-ui', { id: 'other-root', packageId: 'reader', isolate });
    assert.equal(seen, value);
    await loader.reload(pkg('reader', reader));
    assert.equal(seen, value);
    await loader.disable('reader');
    await gc();
    await loader.enable('reader');
    assert.equal(seen, value);
    await assert.rejects(loader.apply({ operations: [
      { type: 'remove', entryId: 'reader' },
      { type: 'insert', rootId: 'profile', entry: {
        id: 'bad', packageId: 'missing', isolate: { fixture: 'memory-label:failed-rollback' },
      } },
    ] }));
    assert.equal(loader.inspect('reader').status, 'active');
    assert.equal(seen, value);
    await loader.create('profile', { id: 'private', packageId: 'reader', isolate: { fixture: true } });
    assert.equal(seen, undefined, 'true isolation must remain private');
    await loader.remove('private');
    await loader.reload(pkg('reader', reader));
    assert.equal(seen, value);
    await cleanup();
    await loader.close();
  `);
});

test('a delayed label finalizer cannot remove a newer symbol with the same name', () => {
  runChild(String.raw`
    // Delay notifications deterministically while letting real GC collect the
    // targets. No test-held registration contains a strong target reference.
    const notifications = [];
    globalThis.FinalizationRegistry = class {
      constructor(callback) { this.callback = callback; }
      register(target, held) {
        notifications.push({ callback: this.callback, held, reference: new WeakRef(target) });
      }
    };
    const loader = new MakaCompositionLoader();
    const isolate = { fixture: 'memory-label:reused' };
    await loader.create('profile', { id: 'old', isolate });
    await loader.remove('old');
    await gc();
    assert.equal(refs[0].deref(), undefined);
    assert.equal(notifications.length, 1);
    assert.equal(cacheSize(), 1, 'old notification has not run yet');
    await loader.create('profile', { id: 'new', isolate });
    assert.equal(notifications.length, 2);
    const old = notifications[0];
    assert.equal(old.reference.deref(), undefined);
    old.callback(old.held);
    assert.equal(cacheSize(), 1, 'stale notification must leave the new registration intact');
    await loader.create('desktop-ui', { id: 'shared-new', isolate });
    assert.equal(refs[1].deref(), refs[2].deref(), 'the new incarnation must remain shared');
    assert.equal(notifications.length, 2);
    await loader.remove('new');
    await loader.remove('shared-new');
    await gc();
    assert.equal(alive(), 0);
    const latest = notifications[1];
    latest.callback(latest.held);
    assert.equal(cacheSize(), 0, 'the matching notification must release the key');
    await loader.close();
  `);
});
