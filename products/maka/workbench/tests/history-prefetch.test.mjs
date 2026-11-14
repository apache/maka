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
import { HistoryRows, mergeHistoryPage, readHistoryTail } from '../app/history.ts';

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

const chunk = (sequence, role, text, offset = 0) => ({
  position: { kind: 'live', sequence, fact: `fact-${sequence}`, itemIndex: 0 },
  order: { path: [sequence], itemIndex: 0 },
  field: 'body',
  turnId: 'latest',
  role,
  text,
  offset,
  totalBytes: offset + text.length,
});
const historyPage = (chunks, before) => ({
  kind: 'ready',
  through: 12,
  chunks,
  before,
  after: null,
});

test('opening a tail publishes the latest turn together after its older pages arrive', async () => {
  const tail = historyPage([chunk(12, 'assistant', 'Final answer')], 'tools');
  const tools = Promise.withResolvers();
  const opening = Promise.withResolvers();
  const reads = [];
  let visible = [];
  const pending = readHistoryTail(tail, (cursor) => {
    reads.push(cursor);
    return reads.length === 1 ? tools.promise : opening.promise;
  }).then((page) => {
    visible = mergeHistoryPage(page.chunks, () => undefined, false, page.through).map(
      (row) => row.text,
    );
    return page;
  });
  assert.deepEqual(visible, []);
  tools.resolve(historyPage([chunk(11, 'tool_result', 'Tool output')], 'opening'));
  await setImmediate();
  assert.deepEqual(visible, []);
  opening.resolve(historyPage([chunk(10, 'user', 'Question')], 'previous-turn'));
  const page = await pending;
  assert.deepEqual(reads, ['tools', 'opening']);
  assert.deepEqual(visible, ['Question', 'Tool output', 'Final answer']);
  assert.equal(page.before, 'previous-turn');
  assert.equal(page.after, null);
  assert.deepEqual(
    tail.chunks.map((row) => row.text),
    ['Final answer'],
  );
});

test('a tail with its complete opening needs no extra read, including imported turns', async () => {
  const opening = {
    ...chunk(10, 'user', 'Question'),
    position: { kind: 'imported', path: [], snapshot: 'import', messageOrdinal: 0, partOrdinal: 0 },
    turnId: null,
    importedTurn: 4,
  };
  const answer = {
    ...chunk(12, 'assistant', 'Final answer'),
    position: { ...opening.position, messageOrdinal: 1 },
    turnId: null,
    importedTurn: 4,
  };
  const tail = historyPage([opening, answer], 'previous-turn');
  const page = await readHistoryTail(tail, () => assert.fail('The latest turn is already loaded'));
  assert.deepEqual(page.chunks, [opening, answer]);
});

test('an opening fragment is completed before display and a revoked read publishes nothing', async () => {
  const tail = historyPage(
    [chunk(10, 'user', 'tion', 4), chunk(12, 'assistant', 'Answer')],
    'prefix',
  );
  const page = await readHistoryTail(tail, async () =>
    historyPage([chunk(10, 'user', 'Ques')], null),
  );
  assert.deepEqual(
    mergeHistoryPage(page.chunks, () => undefined, false, page.through).map((row) => row.text),
    ['Question', 'Answer'],
  );
  assert.equal(await readHistoryTail(tail, async () => null), null);
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
