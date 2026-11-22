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
async function setup(t, storage) {
  const id = ++sequence;
  const fixture = { storage, previews: [] };
  globalThis.__uiScaleFixture = fixture;
  const native = {
    nsh: `const fixture = globalThis.__uiScaleFixture;
      // fixture ${id}
      export const signal = initial => {
        let value = initial;
        const read = () => value;
        read.set = next => { value = next; };
        return read;
      };
      export const Storage = fixture.storage;`,
    'maka/host': `const fixture = globalThis.__uiScaleFixture;
      // fixture ${id}
      export const host = {
        uiScaleSupported: true,
        previewUiScale(value) {
          if (!Number.isFinite(value) || value <= 0) throw Error('invalid renderer scale');
          fixture.previews.push(value);
        },
      };`,
    text: `export const message = key => key;
      export const createText = () => {
        let value = '';
        const read = () => value;
        read.set = next => { value = next; };
        return read;
      };`,
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const key =
        context.parentURL?.startsWith(appRoot.href) && specifier === './text' ? 'text' : specifier;
      if (key in native)
        return {
          url: `data:text/javascript,${encodeURIComponent(native[key])}`,
          shortCircuit: true,
        };
      return next(specifier, context);
    },
  });
  t.after(() => {
    hooks.deregister();
    delete globalThis.__uiScaleFixture;
  });
  const module = await import(new URL(`uiScale.ts?fixture=${id}`, appRoot));
  return { ...module, fixture };
}

test('scale previews remain separate from the saved value until the original save finishes', async (t) => {
  const write = deferred();
  const saved = new Map();
  const { uiScale, initializeUiScale, fixture } = await setup(t, {
    getItem: async () => '125',
    async setItem(key, value) {
      await write.promise;
      saved.set(key, value);
    },
  });
  initializeUiScale();
  await setImmediate();
  uiScale.preview('150');
  assert.deepEqual(uiScale.snapshot(), { saved: 125, current: 150, text: '150', ready: true });
  const original = uiScale.save();
  const idle = uiScale.whenIdle();
  let settled = false;
  void idle.then(() => {
    settled = true;
  });
  await setImmediate();
  assert.equal(settled, false);
  assert.deepEqual(uiScale.snapshot(), { saved: 125, current: 150, text: '150', ready: true });
  write.resolve();
  await Promise.all([original, idle]);
  assert.equal(saved.get('interface-scale'), '150');
  assert.deepEqual(uiScale.snapshot(), { saved: 150, current: 150, text: '150', ready: true });
  uiScale.preview('200');
  uiScale.cancel();
  assert.deepEqual(uiScale.snapshot(), { saved: 150, current: 150, text: '150', ready: true });
  assert.equal(fixture.previews.at(-1), 1.5);
});

test('a failed scale save keeps the preview cancellable and a later save can finish', async (t) => {
  const firstWrite = deferred();
  const saved = new Map();
  let first = true;
  const { uiScale, initializeUiScale, fixture } = await setup(t, {
    getItem: async () => '125',
    async setItem(key, value) {
      if (first) {
        first = false;
        await firstWrite.promise;
      }
      saved.set(key, value);
    },
  });
  initializeUiScale();
  await setImmediate();
  uiScale.preview('175');
  const original = uiScale.save();
  const idle = uiScale.whenIdle();
  firstWrite.reject(new Error('storage unavailable'));
  await original;
  await idle;
  assert.deepEqual(uiScale.snapshot(), { saved: 125, current: 175, text: '175', ready: true });
  assert.equal(uiScale.error(), 'Interface scale could not be saved.');
  assert.equal(uiScale.saving(), false);
  uiScale.cancel();
  assert.equal(fixture.previews.at(-1), 1.25);
  assert.deepEqual(uiScale.snapshot(), { saved: 125, current: 125, text: '125', ready: true });
  uiScale.change('180');
  await uiScale.save();
  assert.deepEqual(uiScale.snapshot(), { saved: 180, current: 180, text: '180', ready: true });
  assert.equal(saved.get('interface-scale'), '180');
  assert.equal(uiScale.error(), '');
});

test('reload restores the applied preview and the independently edited input', async (t) => {
  const { uiScale, initializeUiScale, fixture } = await setup(t, {
    getItem: async () => '90',
    setItem: async () => {},
  });
  initializeUiScale({ saved: 110, current: 125, text: '12', ready: true });
  assert.deepEqual(uiScale.snapshot(), { saved: 110, current: 125, text: '12', ready: true });
  assert.equal(fixture.previews.at(-1), 1.25);
  uiScale.cancel();
  assert.deepEqual(uiScale.snapshot(), { saved: 110, current: 110, text: '110', ready: true });
  assert.equal(fixture.previews.at(-1), 1.1);
});

test('invalid stored scale is removed before the default becomes editable', async (t) => {
  const removal = deferred();
  const removed = [];
  const { uiScale, initializeUiScale, fixture } = await setup(t, {
    getItem: async () => 'not a scale',
    async removeItem(key) {
      removed.push(key);
      await removal.promise;
    },
    setItem: async () => {},
  });
  initializeUiScale();
  await setImmediate();
  assert.equal(uiScale.ready(), false);
  removal.resolve();
  await setImmediate();
  assert.deepEqual(removed, ['interface-scale']);
  assert.deepEqual(uiScale.snapshot(), { saved: 100, current: 100, text: '100', ready: true });
  assert.equal(fixture.previews.at(-1), 1);
  assert.equal(uiScale.error(), '');
});
