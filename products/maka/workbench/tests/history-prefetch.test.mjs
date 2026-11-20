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
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { HistoryRows, mergeHistoryPage } from '../app/history.ts';

const { createHistoryPrefetch } = await import(
  '../../../../plugins/agent/conversations/ui/historyPrefetch.ts'
);

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
    nearEdge: () => offset <= 800,
    async loadPage() {
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
  const pending = pager();
  await pager();
  assert.deepEqual(
    reads.map((read) => read.before),
    ['tool-tail'],
  );

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
});

test('continuous scrolling reads past several folded pages without another edge event', async (t) => {
  const { pager, reads, page } = reader(t);
  const pending = pager();
  await page(0, 'tool-2');
  await page(1, 'tool-3');
  await page(2, 'tool-4');
  await page(3, 'tool-5');
  assert.deepEqual(
    reads.map((read) => read.before),
    ['tool-tail', 'tool-2', 'tool-3', 'tool-4', 'tool-5'],
  );

  reads[4].resolve(null);
  await pending;
  await pager();
  assert.equal(reads.length, 5);
});

test('a superseded or failed read leaves the active window free to page', async (t) => {
  const { pager, reads, replaceWindow } = reader(t);
  const stale = pager();
  replaceWindow('search-result');
  const current = pager();
  reads[0].resolve('old-window');
  await stale;
  await pager();
  assert.equal(reads.length, 2);

  reads[1].resolve(undefined);
  await current;

  const retry = pager();
  assert.deepEqual(
    reads.map((read) => read.before),
    ['tool-tail', 'search-result', 'search-result'],
  );
  reads[2].resolve(null);
  await retry;
});

test('prepending a partial row preserves later rows and the original tool seat', () => {
  const at = (sequence) => ({ kind: 'live', sequence, fact: 'fact', itemIndex: 0 });
  const chunk = (sequence, turnId, role, text, extra = {}) => ({
    position: at(sequence),
    order: { path: [sequence], itemIndex: 0 },
    field: 'body',
    messageId: String(sequence),
    turnId,
    role,
    text,
    totalBytes: text.length,
    offset: 0,
    ...extra,
  });
  const history = new HistoryRows();
  const publish = (chunks, older, through) =>
    history.put(mergeHistoryPage(chunks, (key) => history.byKey.get(key), older, through));
  const call = { toolUseId: 'read', call: { position: at(3) } };
  const result = { ...call, result: { position: at(6) } };
  publish(
    [
      chunk(2, 'first', 'user', 'piece', { offset: 6, totalBytes: 11 }),
      chunk(3, 'first', 'tool_call', '', { tool: call }),
      chunk(4, 'second', 'user', 'later'),
      chunk(6, 'first', 'tool_result', '', { tool: result }),
    ],
    false,
    9,
  );
  const later = history.byMessage.get('4/body');
  const tool = [...history.byId.values()].find((row) => row.tool);
  assert.equal(tool.role, 'tool_result');
  publish(
    [
      chunk(1, 'older', 'user', 'older'),
      chunk(2, 'first', 'user', 'first ', { totalBytes: 11, attachments: [] }),
    ],
    true,
    8,
  );
  assert.deepEqual(
    history.ordered.map((row) => row.text),
    ['older', 'first piece', '', 'later', ''],
  );
  assert.equal(history.byMessage.get('4/body'), later);
  assert.deepEqual(
    history.byTurn.get('first').map((row) => row.role),
    ['user', 'tool_call', 'tool_result'],
  );
  assert.equal(
    [...history.byId.values()].find((row) => row.tool),
    tool,
  );
  assert.equal(history.byMessage.get('2/body').metadataThrough, 9);
  assert.equal(history.missingAttachments.size, 0);
});

test('opposite history windows display overlapping UTF-8 fragments once in either order', () => {
  const at = { kind: 'live', sequence: 5, fact: 'fact', itemIndex: 0 };
  const row = {
    position: at,
    order: { path: [5], itemIndex: 0 },
    role: 'assistant',
    field: 'thinking',
    totalBytes: 11,
  };
  const head = { ...row, offset: 0, text: '甲🙂' };
  const tail = { ...row, offset: 3, text: '🙂乙!' };
  for (const [initial, next, older] of [
    [head, tail, false],
    [tail, head, true],
  ]) {
    const [prior] = mergeHistoryPage([initial], () => undefined, false, 9);
    const [merged] = mergeHistoryPage([next], () => prior, older, 9);
    assert.equal(merged.text, '甲🙂乙!');
  }
});
