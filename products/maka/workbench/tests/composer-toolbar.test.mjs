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
import {
  isExternalUsageRuntime,
  shortUsagePeriod,
  summarizeComposerUsage,
} from '../app/composerUsageSummary.ts';

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

async function setupToolbar(t, storage, idiom = 'desktop') {
  const id = ++sequence;
  globalThis.__composerToolbarFixture = { storage, idiom };
  delete globalThis[Symbol.for('maka.composerToolbar')];
  const native = `const fixture = globalThis.__composerToolbarFixture;
    // fixture ${id}
    export const platform = { idiom: fixture.idiom };
    export const Storage = fixture.storage;
    export const signal = initial => {
      let value = initial;
      const read = () => value;
      read.set = next => { value = next; };
      return read;
    };
    export const context = fallback => {
      const read = () => fallback;
      read.Provider = () => null;
      return read;
    };`;
  const hooks = registerHooks({
    resolve(specifier, ctx, next) {
      if (specifier === 'nsh') {
        return {
          url: `data:text/javascript,${encodeURIComponent(native)}`,
          shortCircuit: true,
        };
      }
      return next(specifier, ctx);
    },
  });
  t.after(() => {
    hooks.deregister();
    delete globalThis.__composerToolbarFixture;
    delete globalThis[Symbol.for('maka.composerToolbar')];
  });
  const root = await import(new URL(`composerToolbar.ts?fixture=${id}&bundle=root`, appRoot));
  const settings = await import(
    new URL(`composerToolbar.ts?fixture=${id}&bundle=settings`, appRoot)
  );
  return { root, settings };
}

test('layout helpers normalize malformed storage and move widgets across the spacer', async (t) => {
  const { root } = await setupToolbar(t, {
    getItem: async () => null,
    setItem: async () => {},
  });

  assert.deepEqual(root.normalizeComposerToolbarLayout(null), root.DEFAULT_COMPOSER_TOOLBAR_LAYOUT);
  assert.deepEqual(root.normalizeComposerToolbarLayout(['model', 'bogus', 'model', 'spacer']), [
    'model',
    'spacer',
    'permissions',
    'workspace',
    'usage',
    'context',
  ]);

  const movedLeft = root.moveComposerToolbarSlot(root.DEFAULT_COMPOSER_TOOLBAR_LAYOUT, 'model', 1);
  assert.deepEqual(root.splitComposerToolbarLayout(movedLeft), {
    left: ['permissions', 'model', 'workspace'],
    right: ['usage', 'context'],
  });

  const stepped = root.stepComposerToolbarSlot(
    root.DEFAULT_COMPOSER_TOOLBAR_LAYOUT,
    'workspace',
    1,
  );
  assert.deepEqual(root.splitComposerToolbarLayout(stepped), {
    left: ['permissions'],
    right: ['workspace', 'usage', 'context', 'model'],
  });
  assert.equal(root.isDefaultComposerToolbarLayout(stepped), false);

  const drop = root.computeDropSlot(145, 100, 300, [
    { left: 100, width: 60 },
    { left: 164, width: 60 },
    { left: 228, width: 72 },
  ]);
  assert.equal(drop.index, 1);
  assert.equal(drop.indicatorX, 62);
});

test('independent UI bundles share composer toolbar state and keep live edits over delayed startup reads', async (t) => {
  const reads = new Map();
  const saved = new Map();
  const { root, settings } = await setupToolbar(t, {
    getItem(key) {
      const read = deferred();
      reads.set(key, read);
      return read.promise;
    },
    async setItem(key, value) {
      saved.set(key, value);
    },
  });

  assert.equal(root.composerToolbar.contextUsage(), 'always');
  assert.equal(root.composerToolbar.usageLimits(), false);

  root.initializeComposerToolbar();
  settings.initializeComposerToolbar();
  settings.composerToolbar.setUsageLimits(true);
  settings.composerToolbar.moveWidget('context', 0);

  reads.get('composer-usage-limits').resolve('0');
  reads.get('composer-context-usage').resolve('high');
  reads
    .get('composer-toolbar-layout')
    .resolve(JSON.stringify(['workspace', 'spacer', 'permissions', 'model', 'usage', 'context']));

  await setImmediate();
  await root.composerToolbar.whenIdle();

  assert.equal(root.composerToolbar.usageLimits(), true);
  assert.equal(root.composerToolbar.contextUsage(), 'high');
  assert.equal(root.composerToolbar.layout()[0], 'context');
  assert.equal(saved.get('composer-usage-limits'), '1');
});

test('summarizeComposerUsage picks the most constrained window and formats balances', () => {
  assert.equal(isExternalUsageRuntime('codex'), true);
  assert.equal(isExternalUsageRuntime('claude'), true);
  assert.equal(isExternalUsageRuntime('unknown'), false);
  assert.equal(shortUsagePeriod({ kind: 'duration', seconds: 18000 }), '5h');
  assert.equal(shortUsagePeriod({ kind: 'duration', seconds: 604800 }), '7d');
  assert.equal(shortUsagePeriod({ kind: 'monthly' }), '1m');

  const multi = summarizeComposerUsage([
    { kind: 'window', period: { kind: 'duration', seconds: 604800 }, usedPercent: 18 },
    { kind: 'window', period: { kind: 'duration', seconds: 18000 }, usedPercent: 84 },
  ]);
  assert.equal(multi?.kind, 'window');
  assert.equal(multi.shortWindow, '5h');
  assert.equal(multi.remainingPercent, 16);
  assert.equal(multi.tone, 'warning');

  const exhausted = summarizeComposerUsage([
    { kind: 'window', period: { kind: 'duration', seconds: 18000 }, usedPercent: 100 },
  ]);
  assert.equal(exhausted?.kind, 'window');
  assert.equal(exhausted.remainingPercent, 0);
  assert.equal(exhausted.tone, 'danger');

  const balance = summarizeComposerUsage([{ kind: 'balance', amount: 12.4, unit: '$' }]);
  assert.deepEqual(balance, {
    kind: 'balance',
    limit: { kind: 'balance', amount: 12.4, unit: '$' },
    text: '$12.4',
  });

  assert.equal(summarizeComposerUsage([{ kind: 'unlimited' }]), null);
  assert.equal(summarizeComposerUsage([]), null);
});
