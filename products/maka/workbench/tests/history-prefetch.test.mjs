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
import { setImmediate } from 'node:timers/promises';

const signal = `export function signal(value) {
  const read = () => value;
  read.set = next => { value = next; };
  return read;
}`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'nsh'
      ? { url: `data:text/javascript,${encodeURIComponent(signal)}`, shortCircuit: true }
      : next(specifier, context);
  },
});
const { createHistoryPrefetch } = await import(
  '../../../../plugins/agent/conversations/ui/historyPrefetch.ts'
);
hooks.deregister();

function reader(t) {
  const frames = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  t.after(() => {
    delete globalThis.requestAnimationFrame;
  });

  const reads = [];
  let window = { identity: {}, before: 'tool-tail' };
  let offset = 600;
  const pager = createHistoryPrefetch({
    owner: () => (window.before === null ? null : window.identity),
    nearStart: () => offset <= 800,
    async loadOlder() {
      const owner = window;
      const reply = Promise.withResolvers();
      reads.push({ before: owner.before, ...reply });
      const before = await reply.promise;
      if (window !== owner || before === undefined) return false;
      owner.before = before;
      return true;
    },
  });
  return {
    pager,
    reads,
    setOffset(next) {
      offset = next;
    },
    replaceWindow(before) {
      window = { identity: {}, before };
    },
    async page(index, next) {
      reads[index].resolve(next);
      await setImmediate();
      const frame = frames.shift();
      assert.equal(typeof frame, 'function');
      frame();
      t.mock.timers.tick(0);
      await Promise.resolve();
    },
  };
}

test('a delayed page coalesces edge signals and continues across folded rows', async (t) => {
  const { pager, reads, page, setOffset } = reader(t);
  const pending = pager.start();
  await pager.start();
  assert.deepEqual(
    reads.map((read) => read.before),
    ['tool-tail'],
  );
  assert.equal(pager.loading(), true);

  // Folded work advances the history cursor while the viewport stays in place.
  await page(0, 'older-tool');
  assert.deepEqual(
    reads.map((read) => read.before),
    ['tool-tail', 'older-tool'],
  );

  // The next page has visible messages, and the list compensates the prepend.
  setOffset(1050);
  await page(1, 'user-message');
  await pending;
  assert.deepEqual(
    reads.map((read) => read.before),
    ['tool-tail', 'older-tool'],
  );
  assert.equal(pager.loading(), false);
});

test('a long stretch of folded pages yields after three and can continue on demand', async (t) => {
  const { pager, reads, page } = reader(t);
  const pending = pager.start();
  await page(0, 'tool-2');
  await page(1, 'tool-3');
  await page(2, 'tool-4');
  await pending;
  assert.deepEqual(
    reads.map((read) => read.before),
    ['tool-tail', 'tool-2', 'tool-3'],
  );

  const next = pager.start();
  assert.equal(reads[3].before, 'tool-4');
  reads[3].resolve(null);
  await next;
  await pager.start();
  assert.equal(reads.length, 4);
});

test('a superseded or failed read leaves the active window free to page', async (t) => {
  const { pager, reads, replaceWindow } = reader(t);
  const stale = pager.start();
  replaceWindow('search-result');
  const current = pager.start();
  reads[0].resolve('old-window');
  await stale;
  assert.equal(pager.loading(), true);

  reads[1].resolve(undefined);
  await current;
  assert.equal(pager.loading(), false);

  const retry = pager.start();
  assert.deepEqual(
    reads.map((read) => read.before),
    ['tool-tail', 'search-result', 'search-result'],
  );
  reads[2].resolve(null);
  await retry;
});
