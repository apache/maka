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
  canRegenerateFromText,
  historyFollowPosition,
  historyRowKey,
  historyTurnKey,
  sameHistoryRow,
  mergeChunks,
  openingUserMessage,
  replayStartCursor,
  updateHistoryMetadata,
} from '../app/history.ts';
import { hasSkillToken, skillTextGroups } from '../app/skillTokenText.ts';
import { orderProcessRows, projectProcessGroups } from '../app/processGroups.ts';

const FACTS = {
  1: 'e18e24b1-55b7-4b2a-98a1-000000000001',
  2: 'e18e24b1-55b7-4b2a-98a1-000000000002',
  3: 'e18e24b1-55b7-4b2a-98a1-000000000003',
  4: 'e18e24b1-55b7-4b2a-98a1-000000000004',
  5: 'e18e24b1-55b7-4b2a-98a1-000000000005',
  6: 'e18e24b1-55b7-4b2a-98a1-000000000006',
  7: 'e18e24b1-55b7-4b2a-98a1-000000000007',
  8: 'e18e24b1-55b7-4b2a-98a1-000000000008',
  9: 'e18e24b1-55b7-4b2a-98a1-000000000009',
  10: 'e18e24b1-55b7-4b2a-98a1-00000000000a',
  11: 'e18e24b1-55b7-4b2a-98a1-00000000000b',
  12: 'e18e24b1-55b7-4b2a-98a1-00000000000c',
  13: 'e18e24b1-55b7-4b2a-98a1-00000000000d',
  14: 'e18e24b1-55b7-4b2a-98a1-00000000000e',
  15: 'e18e24b1-55b7-4b2a-98a1-00000000000f',
  16: 'e18e24b1-55b7-4b2a-98a1-000000000010',
  17: 'e18e24b1-55b7-4b2a-98a1-000000000011',
  18: 'e18e24b1-55b7-4b2a-98a1-000000000012',
  19: 'e18e24b1-55b7-4b2a-98a1-000000000013',
  20: 'e18e24b1-55b7-4b2a-98a1-000000000014',
  21: 'e18e24b1-55b7-4b2a-98a1-000000000015',
  22: 'e18e24b1-55b7-4b2a-98a1-000000000016',
  23: 'e18e24b1-55b7-4b2a-98a1-000000000017',
  24: 'e18e24b1-55b7-4b2a-98a1-000000000018',
  25: 'e18e24b1-55b7-4b2a-98a1-000000000019',
};
const livePosition = (sequence, itemIndex = 0) => {
  const fact = FACTS[sequence];
  assert.ok(fact, 'the fixture declares this original fact');
  return { kind: 'live', sequence, fact, itemIndex };
};

const user = (text, turnId, sequence) => ({
  key: String(sequence),
  messageId: String(sequence),
  role: 'user',
  field: 'body',
  text,
  turnId,
  position: livePosition(sequence, 0),
  order: { path: [sequence], itemIndex: 0 },
});

test('unchanged history pages retain rows while fragments and fenced metadata still advance', () => {
  const first = {
    position: livePosition(10, 0),
    order: { path: [10], itemIndex: 0 },
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
  const older = mergeChunks(initial, [{ ...first, text: 'old' }], true, 19);
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
    position: livePosition(11, 0),
    order: { path: [11], itemIndex: 0 },
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
  const advanced = updateHistoryMetadata(updated, [refreshed, completed], 23);
  assert.equal(advanced[0].metadataThrough, 23);
  assert.equal(advanced[0].text, '界🙂');
});

test('canonical order sorts MessageEnd-sourced text before earlier-source tools without changing cursor identity', () => {
  const chunk = (messageId, source, anchor, text) => ({
    messageId,
    position: livePosition(source, 0),
    order: { path: [anchor], itemIndex: 0 },
    field: 'body',
    role: 'assistant',
    offset: 0,
    totalBytes: Buffer.byteLength(text),
    text,
  });
  const rows = mergeChunks(
    [],
    [chunk('tool', 5, 5, 'tool'), chunk('A', 7, 2, 'before'), chunk('C', 12, 8, 'after')],
    false,
    12,
  );
  assert.deepEqual(
    rows.map((row) => [row.text, row.position, row.order]),
    [
      ['before', livePosition(7), { path: [2], itemIndex: 0 }],
      ['tool', livePosition(5), { path: [5], itemIndex: 0 }],
      ['after', livePosition(12), { path: [8], itemIndex: 0 }],
    ],
  );
  assert.deepEqual(historyFollowPosition(rows.at(-1), []), {
    kind: 'after',
    cursor: { position: livePosition(12, 0), field: 'body', offset: 0 },
  });
  assert.deepEqual(historyFollowPosition(rows.at(-1), [], [3, 9], 5), {
    kind: 'event',
    sequence: 9,
  });
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
test('turn actions require a proven opening message across history windows', () => {
  const earlier = user('Previous request', 'earlier', 1);
  const opening = user('Build the application', 'current', 2);
  const followup = user('Keep the public API unchanged', 'current', 3);
  const before = { field: 'body', position: earlier.position, offset: 0 };
  assert.equal(openingUserMessage([followup], 'current', before), null);
  assert.equal(openingUserMessage([opening, followup], 'current', before), null);
  assert.equal(
    openingUserMessage([opening, followup], 'current', null)?.text,
    'Build the application',
  );
  assert.equal(
    openingUserMessage([earlier, opening, followup], 'current', before)?.text,
    'Build the application',
  );
});

test('regeneration waits for original metadata and retains reference exclusions across fragments', () => {
  const first = {
    ...user('Original request', 'current', 2),
    offset: 0,
    totalBytes: 20,
    attachments: [],
  };
  const later = { ...first, text: 'tail', offset: 16 };
  const [tail] = mergeChunks([], [later], false, 10);
  assert.equal(canRegenerateFromText(tail), false);
  const [plain] = updateHistoryMetadata([tail], [{ ...first, hasReferences: false }], 10);
  assert.equal(canRegenerateFromText(plain), true);
  const [referenced] = updateHistoryMetadata([tail], [{ ...first, hasReferences: true }], 10);
  assert.equal(canRegenerateFromText(referenced), false);
  const [continued] = mergeChunks([referenced], [later], false, 11);
  assert.equal(canRegenerateFromText(continued), false);
  const [attached] = updateHistoryMetadata(
    [tail],
    [{ ...first, attachments: [{ name: 'image.png' }] }],
    10,
  );
  assert.equal(canRegenerateFromText(attached), false);
});

test('early open model text retains its ordinal seat across later canonical tool admission', () => {
  const user = {
    messageId: 'user',
    field: 'body',
    role: 'user',
    text: 'go',
    position: livePosition(1, 0),
    order: { path: [1], itemIndex: 0 },
  };
  const early = {
    messageId: 'early',
    field: 'body',
    role: 'assistant',
    text: 'start',
    modelPart: {
      stepId: 'b1111111-1111-4111-8111-111111111111',
      attemptId: 'c1111111-1111-4111-8111-111111111111',
      ordinal: 0,
    },
    preview: { stepOrder: 1, ordinal: 0, revision: 2 },
  };
  const tool = {
    messageId: 'tool',
    field: 'body',
    role: 'tool_call',
    text: '{}',
    position: livePosition(20, 0),
    order: { path: [20], itemIndex: 0 },
    modelPart: {
      stepId: 'b1111111-1111-4111-8111-111111111111',
      attemptId: 'c1111111-1111-4111-8111-111111111111',
      ordinal: 1,
    },
  };
  const later = {
    messageId: 'later',
    field: 'body',
    role: 'assistant',
    text: 'tail',
    modelPart: {
      stepId: 'b1111111-1111-4111-8111-111111111111',
      attemptId: 'c1111111-1111-4111-8111-111111111111',
      ordinal: 2,
    },
    preview: { stepOrder: 1, ordinal: 2, revision: 2 },
  };
  assert.deepEqual(
    orderProcessRows([user, tool, early, later]).map((row) => row.messageId),
    ['user', 'early', 'tool', 'later'],
  );
  const canonicalEarly = {
    ...early,
    preview: undefined,
    position: livePosition(25, 0),
    order: { path: [25], itemIndex: 0 },
  };
  assert.deepEqual(
    orderProcessRows([user, tool, canonicalEarly, later]).map((row) => row.messageId),
    ['user', 'early', 'tool', 'later'],
  );
});

test('a message the Host wrote keeps its origin so the Bot Chat can tell it from the user', () => {
  const chunk = (origin) => ({
    position: livePosition(1, 0),
    order: { path: [1], itemIndex: 0 },
    field: 'body',
    role: 'user',
    offset: 0,
    text: 'The conversation you delegated to finished.',
    messageId: 'm_1',
    turnId: 't_1',
    timestamp: 1,
    totalBytes: 42,
    origin,
  });
  const [wake] = mergeChunks([], [chunk({ kind: 'bot_worker', sessionId: 'ma_worker' })], false, 1);
  assert.deepEqual(wake.origin, { kind: 'bot_worker', sessionId: 'ma_worker' });
  const [typed] = mergeChunks([], [chunk(null)], false, 1);
  assert.equal(typed.origin, undefined);
});

test('a script is shown as the tools it ran, and as itself only when it fails', () => {
  const tool = (toolUseId, sequence, ancestorToolUseIds, result, origin = 'code_mode') => {
    const position = livePosition(sequence, 0);
    return {
      messageId: toolUseId,
      role: 'tool_call',
      field: 'body',
      turnId: 'turn',
      position,
      tool: { toolUseId, call: { position, ancestorToolUseIds, origin }, result },
    };
  };
  const group = (...rows) =>
    projectProcessGroups({ rows, toolActivity: [], activeTurnId: null }).entries[0];
  const read = tool('read', 2, ['cell', 'exec']);
  const fetch = tool('fetch', 1, [], { isError: false }, 'provider');
  const http = tool('http', 2, ['fetch'], { isError: false }, 'host_sdk');
  assert.deepEqual(
    group(fetch, http).toolIds,
    ['fetch', 'http'],
    "a tool's own work does not replace it",
  );
  const running = group(tool('exec', 1, []), read);
  const returned = group(tool('exec', 1, [], { isError: false }), read);
  const failed = group(tool('exec', 1, [], { isError: true }), read);
  assert.deepEqual(running.toolIds, ['read']);
  assert.deepEqual(returned.toolIds, ['read']);
  assert.deepEqual(failed.toolIds, ['exec', 'read']);
  assert.equal(failed.key, running.key, 'showing the script keeps the group open');
  assert.deepEqual(group(tool('exec', 1, [], { isError: false })).toolIds, ['exec']);
});

test('skill messages preserve adjacent UTF-8 chunks and do not join across unloaded gaps', () => {
  const groups = skillTextGroups([
    { offset: 0, text: '前😀 /ski' },
    { offset: 12, text: 'll:review 后' },
    { offset: 100, text: '/skill:partial' },
  ]);
  assert.deepEqual(groups, [
    { offset: 0, text: '前😀 /skill:review 后' },
    { offset: 100, text: '/skill:partial' },
  ]);
  assert.deepEqual(groups.map(hasSkillToken), [true, false]);
});

test('foreign chunks preserve missing original identity, author and qualified order without a Root event', () => {
  const source = {
    kind: 'imported',
    path: ['a7777777-7777-4777-8777-777777777777'],
    snapshot: 's-import-one',
    messageOrdinal: 0,
    partOrdinal: 0,
  };
  const chunk = {
    position: source,
    order: { path: [2, 1000000], itemIndex: 0 },
    messageId: null,
    turnId: null,
    timestamp: null,
    importedTurn: 0,
    role: 'tool',
    field: 'body',
    text: 'foreign',
    offset: 0,
    totalBytes: 7,
  };
  const other = {
    ...chunk,
    position: { ...source, snapshot: 's-import-two' },
    order: { path: [3, 1], itemIndex: 0 },
  };
  const root = {
    ...chunk,
    position: livePosition(5),
    order: { path: [5], itemIndex: 0 },
    messageId: 'root',
    turnId: 'root-turn',
    importedTurn: null,
    role: 'assistant',
    text: 'root',
    totalBytes: 4,
  };
  const rows = mergeChunks([], [root, other, chunk], false, null);
  assert.deepEqual(
    rows.map((row) => row.text),
    ['foreign', 'foreign', 'root'],
  );
  assert.equal(rows[0].messageId, undefined);
  assert.equal(rows[0].turnId, undefined);
  assert.equal(rows[0].timestamp, undefined);
  assert.equal(rows[0].role, 'tool');
  assert.equal(rows[0].metadataThrough, null);
  assert.notEqual(rows[0].key, rows[1].key);
  assert.notEqual(historyTurnKey(rows[0]), historyTurnKey(rows[1]));
  assert.notEqual(historyTurnKey(rows[0]), rows[0].turnId);
  assert.deepEqual(historyFollowPosition(rows[0], []), {
    kind: 'after',
    cursor: { position: source, field: 'body', offset: 0 },
  });
  const reordered = {
    partOrdinal: 0,
    messageOrdinal: 0,
    snapshot: source.snapshot,
    path: source.path,
    kind: 'imported',
  };
  assert.equal(sameHistoryRow(source, reordered), true);
  assert.equal(historyRowKey(source), historyRowKey(reordered));
  const [emptyOriginal] = mergeChunks([], [{ ...chunk, messageId: '', turnId: '' }], false, null);
  assert.equal(emptyOriginal.messageId, '');
  assert.equal(emptyOriginal.turnId, '');
  assert.equal(historyTurnKey(emptyOriginal), historyTurnKey(rows[0]));
});
