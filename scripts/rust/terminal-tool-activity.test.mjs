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
import {
  updateToolActivity,
  latestToolActivity,
  toolActivitySummary,
} from '../../products/maka/workbench/app/toolActivity.ts';

import {
  canRegenerateFromText,
  mergeChunks,
  replayStartCursor,
  updateHistoryMetadata,
} from '../../products/maka/workbench/app/history.ts';
import { thinkingSummary } from '../../products/maka/workbench/app/thinkingSummary.ts';

test('tool summaries use UI-rendered labels while retaining the tool source details', () => {
  const tool = {
    phase: 'preparing',
    name: '搜索源代码',
    title: { fallback: 'Opaque fallback' },
    detail: ' 搜索\n  原文😀 ',
  };
  assert.equal(
    toolActivitySummary(tool, '正在准备工具', '查找定义'),
    '正在准备工具 · 搜索源代码 · 查找定义 · 搜索 原文😀',
  );
  assert.equal(
    toolActivitySummary({ ...tool, phase: 'running' }, 'Running tool'),
    'Running tool · 搜索源代码 · 搜索 原文😀',
  );
});

test('thinking summary retains the last nonempty paragraph and its Unicode text', () => {
  for (const [source, expected] of [
    ['', ''],
    [' \r\n\t\u2003', ''],
    ['**first**\nline', 'first line'],
    ['old\n\n**最新**\n 行\r\n \t', '最新 行'],
    ['old\r\n\t \r\n**最新**\r\n\t\r\n \t', '最新'],
    ['old\n\n**\n\n', ''],
    ['old\n\r \nnew', 'old new'],
    ['earlier\n\n\n **tail**\n\n\n', 'tail'],
    ['earlier\n\n'.repeat(20000) + '**尾 e\u0301**\nline', '尾 e\u0301 line'],
  ]) {
    assert.equal(thinkingSummary(source), expected);
  }
});

test('unchanged history pages retain rows while fragments and fenced metadata still advance', () => {
  const first = {
    position: { sourceSequence: 10, itemIndex: 0 },
    messageId: 'message',
    turnId: 'turn',
    timestamp: 100,
    field: 'body',
    role: 'user',
    offset: 0,
    text: '界',
    totalBytes: 7,
  };
  const initial = mergeChunks([], [first], false, 20);
  assert.equal(initial[0].text, '界');
  assert.equal(canRegenerateFromText(initial[0]), true);
  assert.strictEqual(mergeChunks(initial, [], false, 99), initial);
  assert.strictEqual(mergeChunks(initial, [structuredClone(first)], false, 20), initial);
  const older = mergeChunks(initial, [{ ...first, text: 'old' }], true, 19);
  assert.strictEqual(older, initial);
  assert.equal(older[0].hasReferences, false);
  assert.equal(canRegenerateFromText(older[0]), true);

  const referenced = mergeChunks([], [{ ...first, hasReferences: true }], false, 20);
  assert.equal(canRegenerateFromText(referenced[0]), false);
  const olderReferenced = mergeChunks(
    referenced,
    [{ ...first, hasReferences: true, text: 'old' }],
    true,
    19,
  );
  assert.strictEqual(olderReferenced, referenced);
  assert.equal(olderReferenced[0].hasReferences, true);
  assert.equal(canRegenerateFromText(olderReferenced[0]), false);

  const extended = mergeChunks(initial, [{ ...first, offset: 3, text: '🙂' }], false, 21);
  assert.equal(extended[0].text, '界🙂');
  assert.deepEqual(extended[0].fragments, [
    { offset: 0, text: '界' },
    { offset: 3, text: '🙂' },
  ]);
  assert.equal(extended[0].metadataThrough, 21);
  const refreshed = {
    ...first,
    text: 'metadata pages must not replace loaded text',
    attachments: [{ name: 'notes.txt', mimeType: 'text/plain', bytes: 12, kind: 'doc' }],
  };
  const reply = {
    ...first,
    position: { sourceSequence: 11, itemIndex: 0 },
    messageId: 'reply',
    role: 'assistant',
    text: 'reply',
    totalBytes: 5,
  };
  const withReply = mergeChunks(extended, [reply], false, 21);
  const completed = {
    ...reply,
    timing: { startedAt: 100, finished: { at: 200, outcome: 'completed' } },
    model: { kind: 'native', requestedModelId: 'requested', reportedModelId: 'reported' },
    finalOutput: true,
  };
  const updated = updateHistoryMetadata(withReply, [refreshed, completed], 22);
  assert.equal(updated[0].text, '界🙂');
  assert.strictEqual(updated[0].fragments, extended[0].fragments);
  assert.deepEqual(updated[0].attachments, [
    { name: 'notes.txt', mimeType: 'text/plain', bytes: 12, kind: 'doc' },
  ]);
  assert.deepEqual(updated[1].timing, {
    startedAt: 100,
    finished: { at: 200, outcome: 'completed' },
  });
  assert.deepEqual(updated[1].model, {
    kind: 'native',
    requestedModelId: 'requested',
    reportedModelId: 'reported',
  });
  assert.equal(updated[1].finalOutput, true);
  assert.equal(updated[0].metadataThrough, 22);
  assert.strictEqual(updateHistoryMetadata(updated, [], 99), updated);
  assert.strictEqual(
    updateHistoryMetadata(updated, structuredClone([refreshed, completed]), 22),
    updated,
  );
  assert.strictEqual(updateHistoryMetadata(updated, [{ ...first, attachments: [] }], 21), updated);
  const advanced = updateHistoryMetadata(updated, [refreshed, completed], 23);
  assert.equal(advanced[0].metadataThrough, 23);
  assert.equal(advanced[0].text, '界🙂');
});

test('complete active tool identities survive 129 starts, updates and exact terminal removal', () => {
  let active = [];
  const event = (index, fact, invocationId = 'invocation') => ({
    invocationId,
    turnId: 'turn',
    sequence: index + 1,
    fact,
  });
  const id = (index) => 'tool_' + index.toString(16).padStart(64, '0');
  for (let index = 0; index < 129; index++) {
    active = updateToolActivity(
      active,
      event(index, {
        kind: 'executor_tool_start',
        toolUseId: id(index),
        name: 'echo',
      }),
    );
  }
  assert.deepEqual(
    active.map((tool) => tool.toolUseId),
    Array.from({ length: 129 }, (_, index) => id(index)),
  );
  assert.equal(latestToolActivity(active, 'invocation', 'turn').toolUseId, id(128));
  active = updateToolActivity(
    active,
    event(130, {
      kind: 'executor_tool_progress',
      toolUseId: id(128),
      text: 'original progress',
    }),
  );
  assert.equal(active.length, 129);
  assert.equal(active[128].detail, 'original progress');
  assert.equal(active[128].startSequence, 129);
  active = updateToolActivity(
    active,
    event(131, { kind: 'executor_tool_start', toolUseId: id(0), name: 'independent' }, 'other'),
  );
  assert.equal(active.length, 130);
  active = updateToolActivity(
    active,
    event(132, { kind: 'executor_tool_result', toolUseId: id(128) }),
  );
  assert.equal(active.length, 129);
  assert.equal(latestToolActivity(active, 'invocation', 'turn').toolUseId, id(127));
  assert.equal(latestToolActivity(active, 'other', 'turn').name, 'independent');
  active = updateToolActivity(active, event(133, { kind: 'ended' }));
  assert.deepEqual(
    active.map((tool) => [tool.invocationId, tool.toolUseId, tool.name]),
    [['other', id(0), 'independent']],
  );
});

test('replay cursor preserves the earliest complete part and tool seed without argument limits', () => {
  assert.equal(replayStartCursor(9, [], []), 9);
  assert.equal(replayStartCursor(2, [{ startSequence: 8 }], [{ startSequence: 7 }]), 2);
  assert.equal(
    replayStartCursor(100, [{ startSequence: 9 }, { startSequence: 3 }], [{ startSequence: 8 }]),
    2,
  );
  assert.equal(
    replayStartCursor(100, [{ startSequence: 9 }], [{ startSequence: 8 }, { startSequence: 2 }]),
    1,
  );
  const parts = Array.from({ length: 200000 }, (_, index) => ({
    startSequence: index + 100,
  }));
  const tools = Array.from({ length: 200000 }, (_, index) => ({
    startSequence: index + 200,
  }));
  parts[parts.length - 1] = { startSequence: 3 };
  assert.equal(replayStartCursor(900000, parts, tools), 2);
  tools[tools.length - 1] = { startSequence: 1 };
  assert.equal(replayStartCursor(900000, parts, tools), 0);
});
