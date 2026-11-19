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
  summarizeComposerUsage,
  usageSeverity,
  watchComposerUsage,
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
  delete globalThis[Symbol.for('maka.composerToolbarCompact')];
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
      let current = fallback;
      const read = () => current;
      read.Provider = ({ value }) => { current = value; return null; };
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
    delete globalThis[Symbol.for('maka.composerToolbarCompact')];
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
});

test('independent UI bundles share toolbar state, compact context, and keep live edits over startup reads', async (t) => {
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

  // Cross-bundle compact context shares object identity so RecentWorkspaces sees Composer width.
  assert.equal(root.ToolbarCompactProvider, settings.ToolbarCompactProvider);
  root.ToolbarCompactProvider({ value: () => true });
  assert.equal(settings.useToolbarCompact(), true);

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

test('drag reorder pairs pointer move and early release with async measure and ignores cancel', async (t) => {
  const { root } = await setupToolbar(t, {
    getItem: async () => null,
    setItem: async () => {},
  });
  const track = {
    left: 0,
    width: 360,
    slots: [
      { left: 0, width: 60 },
      { left: 60, width: 60 },
      { left: 120, width: 60 },
      { left: 180, width: 60 },
      { left: 240, width: 60 },
      { left: 300, width: 60 },
    ],
    spacer: { left: 120, width: 60 },
  };

  const commits = [];
  const controller = root.createToolbarDragController({
    onPreview() {},
    onCommit(widget, index) {
      commits.push([widget, index]);
    },
  });

  // Release arrives before measure resolves: must commit at release pageX once measure settles.
  const m1 = deferred();
  controller.start('model', 5, 320, m1.promise);
  controller.move(10);
  controller.release(10);
  assert.deepEqual(commits, []);
  m1.resolve(track);
  await setImmediate();
  assert.deepEqual(commits, [['model', 0]]);

  // Move arrives before measure resolves, release arrives after: must preserve latest move.
  const m2 = deferred();
  controller.start('model', 5, 320, m2.promise);
  controller.move(15);
  m2.resolve(track);
  await setImmediate();
  controller.release();
  assert.deepEqual(commits, [
    ['model', 0],
    ['model', 0],
  ]);

  // Cancel before measure resolves: must never commit.
  const m3 = deferred();
  controller.start('model', 5, 320, m3.promise);
  controller.move(15);
  controller.cancel();
  m3.resolve(track);
  await setImmediate();
  assert.equal(commits.length, 2);
});

test('watchComposerUsage guards ABA races, invalidates superseded failures, and recovers after re-enable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const detail = (connectionId, revision, name, enabled = true) => ({
    kind: 'ready',
    enabled,
    name,
    target: { connectionId, revision },
  });
  const ready = (usedPercent) => ({
    kind: 'ready',
    limits: [{ kind: 'window', period: { kind: 'duration', seconds: 18000 }, usedPercent }],
  });

  // 1. ABA race: a stopped watch must not overwrite sourceName or issue follow-up queries.
  const pending = [];
  const abaHost = {
    query(endpoint, method, input) {
      return new Promise((resolve) => pending.push({ endpoint, method, input, resolve }));
    },
  };
  const observations = [];
  const stopOldA = watchComposerUsage(
    abaHost,
    { key: 'model:A', kind: 'connection', connectionId: 'A' },
    (obs) => observations.push(obs),
    null,
  );
  const oldADetail = pending.shift();
  stopOldA();
  const stopNewA = watchComposerUsage(
    abaHost,
    { key: 'model:A', kind: 'connection', connectionId: 'A' },
    (obs) => observations.push(obs),
    null,
  );
  t.after(stopNewA);
  pending.shift().resolve(detail('A', 2, 'Current Account'));
  await setImmediate();
  pending.shift().resolve(ready(25));
  await setImmediate();
  assert.equal(observations.at(-1)?.sourceName, 'Current Account');

  oldADetail.resolve(detail('A', 1, 'Stale Account'));
  await setImmediate();
  assert.equal(observations.at(-1)?.sourceName, 'Current Account');
  assert.equal(pending.length, 0);

  // 2. Superseded followed by failed retry clears stale ready reading; ordinary failure preserves it.
  const replies = [
    detail('B', 1, 'Old Name'),
    ready(40),
    { kind: 'unavailable' },
    { kind: 'superseded' },
    detail('B', 2, 'New Name'),
    { kind: 'unavailable' },
  ];
  const supObs = [];
  const supHost = {
    query() {
      return Promise.resolve(replies.shift());
    },
  };
  t.after(
    watchComposerUsage(
      supHost,
      { key: 'model:B', kind: 'connection', connectionId: 'B' },
      (obs) => supObs.push(obs),
      null,
    ),
  );
  await setImmediate();
  assert.equal(supObs.at(-1)?.reading.result.kind, 'ready');
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(supObs.at(-1)?.reading.result.kind, 'ready');
  assert.equal(supObs.at(-1)?.reading.refreshFailed, true);
  assert.equal(supObs.at(-1)?.sourceName, 'Old Name');

  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(supObs.at(-1)?.reading.result.kind, 'superseded');

  // 3. Temporarily disabled connection recovers on next scheduled poll after re-enabling.
  let enabled = false;
  const disObs = [];
  const disHost = {
    query(_endpoint, method) {
      if (method === 'connection') return Promise.resolve(detail('C', 1, 'Account C', enabled));
      return Promise.resolve(ready(30));
    },
  };
  t.after(
    watchComposerUsage(
      disHost,
      { key: 'model:C', kind: 'connection', connectionId: 'C' },
      (obs) => disObs.push(obs),
      null,
    ),
  );
  await setImmediate();
  assert.equal(disObs.at(-1)?.reading.result.kind, 'superseded');
  enabled = true;
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(disObs.at(-1)?.reading.result.kind, 'ready');
  assert.equal(disObs.at(-1)?.sourceName, 'Account C');
});

test('summarizeComposerUsage aligns severity boundaries with usageSeverity and formats balances', () => {
  const multi = summarizeComposerUsage([
    { kind: 'window', period: { kind: 'duration', seconds: 604800 }, usedPercent: 18 },
    { kind: 'window', period: { kind: 'duration', seconds: 18000 }, usedPercent: 84 },
  ]);
  assert.equal(multi?.kind, 'window');
  assert.equal(multi.shortWindow, '5h');
  assert.equal(multi.remainingPercent, 16);
  assert.equal(multi.tone, 'warning');

  for (const [usedPercent, expected] of [
    [79.75, 'normal'],
    [80, 'warning'],
    [94.75, 'warning'],
    [95, 'danger'],
    [100, 'danger'],
  ]) {
    const summary = summarizeComposerUsage([{ kind: 'window', usedPercent }]);
    assert.equal(summary?.kind, 'window');
    assert.equal(summary.tone, expected);
    assert.equal(usageSeverity(usedPercent), expected);
  }

  const balance = summarizeComposerUsage([{ kind: 'balance', amount: 12.4, unit: '$' }]);
  assert.deepEqual(balance, {
    kind: 'balance',
    limit: { kind: 'balance', amount: 12.4, unit: '$' },
    text: '$12.4',
  });

  assert.equal(summarizeComposerUsage([{ kind: 'unlimited' }]), null);
  assert.equal(summarizeComposerUsage([]), null);
});
