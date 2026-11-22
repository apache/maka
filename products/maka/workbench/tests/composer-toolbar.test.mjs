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
  remainingPercent,
  summarizeComposerUsage,
  usageSeverity,
} from '../app/composerUsageSummary.ts';

const appRoot = new URL('../app/', import.meta.url);
let sequence = 0;

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function setupToolbar(t, storage) {
  const id = ++sequence;
  globalThis.__composerToolbarFixture = { storage };
  delete globalThis[Symbol.for('maka.composerToolbar')];
  delete globalThis[Symbol.for('maka.composerToolbarCompact')];
  const native = `const fixture = globalThis.__composerToolbarFixture; // ${id}
    export const platform = { idiom: 'desktop' };
    export const Storage = fixture.storage;
    export const signal = (v) => { const r = () => v; r.set = (n) => { v = n; }; return r; };
    export const context = (v) => { const r = () => v; r.Provider = ({ value }) => { v = value; return null; }; return r; };`;
  const hooks = registerHooks({
    resolve(specifier, ctx, next) {
      return specifier === 'nsh'
        ? { url: `data:text/javascript,${encodeURIComponent(native)}`, shortCircuit: true }
        : next(specifier, ctx);
    },
  });
  t.after(() => {
    hooks.deregister();
    delete globalThis.__composerToolbarFixture;
    delete globalThis[Symbol.for('maka.composerToolbar')];
    delete globalThis[Symbol.for('maka.composerToolbarCompact')];
  });
  return {
    root: await import(new URL(`composerToolbar.ts?f=${id}&b=root`, appRoot)),
    settings: await import(new URL(`composerToolbar.ts?f=${id}&b=settings`, appRoot)),
  };
}

test('layout normalization, cross-bundle state/context sharing, and live edits over startup reads', async (t) => {
  const read = deferred();
  const saved = [];
  const { root, settings } = await setupToolbar(t, {
    getItem: () => read.promise,
    async setItem(_key, value) {
      saved.push(JSON.parse(value));
    },
  });

  assert.deepEqual(root.normalizeComposerToolbarLayout(['model', 'bogus', 'model', 'spacer']), [
    'model',
    'spacer',
    'permissions',
    'workspace',
    'usage',
    'context',
  ]);
  assert.equal(root.ToolbarCompactProvider, settings.ToolbarCompactProvider);
  root.ToolbarCompactProvider({ value: () => true });
  assert.equal(settings.useToolbarCompact(), true);

  root.initializeComposerToolbar();
  settings.initializeComposerToolbar();
  settings.composerToolbar.setUsageLimits(true);
  settings.composerToolbar.moveWidget('context', 0);

  read.resolve(
    JSON.stringify({
      layout: ['workspace', 'spacer', 'permissions', 'model', 'usage', 'context'],
      contextUsage: 'high',
      usageLimits: false,
    }),
  );
  await setImmediate();
  await root.composerToolbar.whenIdle();

  assert.equal(root.composerToolbar.usageLimits(), true);
  assert.equal(root.composerToolbar.contextUsage(), 'high');
  assert.equal(root.composerToolbar.layout()[0], 'context');
  assert.deepEqual(saved.at(-1), {
    layout: root.composerToolbar.layout(),
    contextUsage: 'high',
    usageLimits: true,
  });
});

test('drag reorder handles async measure races, cancel, and outside-track release', async (t) => {
  const { root } = await setupToolbar(t, { getItem: async () => null, setItem: async () => {} });
  const track = {
    left: 0,
    top: 100,
    width: 360,
    height: 30,
    slots: [0, 60, 120, 180, 240, 300].map((left) => ({ left, width: 60 })),
    spacer: { left: 120, width: 60 },
  };
  const commits = [];
  const previews = [];
  const drag = root.createToolbarDragController({
    onPreview: (p) => previews.push(p),
    onCommit: (w, i) => commits.push([w, i]),
  });

  // Early release inside track commits once measure resolves.
  const m1 = deferred();
  drag.start('model', 5, { pageX: 320, pageY: 115 }, m1.promise);
  drag.release({ pageX: 10, pageY: 115 });
  m1.resolve(track);
  await setImmediate();
  assert.deepEqual(commits, [['model', 0]]);

  // Cancel before measure resolves never commits.
  const m2 = deferred();
  drag.start('model', 5, { pageX: 320, pageY: 115 }, m2.promise);
  drag.cancel();
  m2.resolve(track);
  await setImmediate();
  assert.equal(commits.length, 1);

  // Dragging or releasing outside the track clears preview and skips commit (before and after measure).
  const m3 = deferred();
  drag.start('model', 5, { pageX: 320, pageY: 115 }, m3.promise);
  m3.resolve(track);
  await setImmediate();
  drag.move({ pageX: 15, pageY: 320 });
  assert.equal(previews.at(-1), null);
  drag.release({ pageX: 15, pageY: 320 });

  const m4 = deferred();
  drag.start('model', 5, { pageX: 320, pageY: 115 }, m4.promise);
  drag.release({ pageX: 15, pageY: 320 });
  m4.resolve(track);
  await setImmediate();
  assert.equal(commits.length, 1);
});

test('summarizeComposerUsage picks hottest window with remainingPercent and formats balance', () => {
  assert.equal(remainingPercent(0), 100);
  assert.equal(remainingPercent(34), 66);
  assert.equal(remainingPercent(120), 0);

  const win = summarizeComposerUsage([
    { kind: 'window', period: { kind: 'duration', seconds: 604800 }, usedPercent: 18 },
    { kind: 'window', period: { kind: 'duration', seconds: 18000 }, usedPercent: 94.75 },
  ]);
  assert.equal(win?.kind, 'window');
  assert.equal(win.shortWindow, '5h');
  assert.equal(win.remainingPercent, 5);
  assert.equal(win.tone, usageSeverity(94.75));
  assert.equal(win.tone, 'warning');

  const groups = [
    { kind: 'window', usedPercent: 8.11, models: ['Gemini 4 Neon'] },
    { kind: 'window', usedPercent: 9.93, models: ['Claude Opus 5.5'] },
  ];
  assert.equal(summarizeComposerUsage(groups, undefined, 'Gemini 4 Neon').remainingPercent, 92);
  assert.equal(summarizeComposerUsage(groups, undefined, 'Unknown').remainingPercent, 90);
  const account = [...groups, { kind: 'window', usedPercent: 50 }];
  assert.equal(summarizeComposerUsage(account, undefined, 'Gemini 4 Neon').remainingPercent, 50);

  const bal = summarizeComposerUsage([{ kind: 'balance', amount: 12.5, unit: '$' }]);
  assert.equal(bal?.kind, 'balance');
  assert.equal(bal.text, '$12.5');
});
