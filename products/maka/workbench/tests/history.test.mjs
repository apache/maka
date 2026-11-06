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
  mergeChunks,
  openingUserMessage,
  replayStartCursor,
  updateHistoryMetadata,
} from '../app/history.ts';
import { hasSkillToken, skillTextGroups } from '../app/skillTokenText.ts';
import { orderProcessRows, projectProcessGroups } from '../app/processGroups.ts';

const user = (text, turnId, sequence) => ({
  key: String(sequence),
  messageId: String(sequence),
  role: 'user',
  field: 'body',
  text,
  turnId,
  position: { sourceSequence: sequence, itemIndex: 0 },
  order: { sourceSequence: sequence, itemIndex: 0 },
});

test('unchanged history pages retain rows while fragments and fenced metadata still advance', () => {
  const first = {
    position: { sourceSequence: 10, itemIndex: 0 },
    order: { sourceSequence: 10, itemIndex: 0 },
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
    position: { sourceSequence: 11, itemIndex: 0 },
    order: { sourceSequence: 11, itemIndex: 0 },
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
    position: { sourceSequence: source, itemIndex: 0 },
    order: { sourceSequence: anchor, itemIndex: 0 },
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
      ['before', { sourceSequence: 7, itemIndex: 0 }, { sourceSequence: 2, itemIndex: 0 }],
      ['tool', { sourceSequence: 5, itemIndex: 0 }, { sourceSequence: 5, itemIndex: 0 }],
      ['after', { sourceSequence: 12, itemIndex: 0 }, { sourceSequence: 8, itemIndex: 0 }],
    ],
  );
  assert.deepEqual(historyFollowPosition(rows.at(-1), []), {
    kind: 'after',
    cursor: { position: { sourceSequence: 12, itemIndex: 0 }, field: 'body', offset: 0 },
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
    position: { sourceSequence: 1, itemIndex: 0 },
    order: { sourceSequence: 1, itemIndex: 0 },
  };
  const early = {
    messageId: 'early',
    field: 'body',
    role: 'assistant',
    text: 'start',
    modelPart: { stepId: 'step', ordinal: 0 },
    preview: { stepOrder: 1, ordinal: 0, revision: 2 },
  };
  const tool = {
    messageId: 'tool',
    field: 'body',
    role: 'tool_call',
    text: '{}',
    position: { sourceSequence: 20, itemIndex: 0 },
    order: { sourceSequence: 20, itemIndex: 0 },
    modelPart: { stepId: 'step', ordinal: 1 },
  };
  const later = {
    messageId: 'later',
    field: 'body',
    role: 'assistant',
    text: 'tail',
    modelPart: { stepId: 'step', ordinal: 2 },
    preview: { stepOrder: 1, ordinal: 2, revision: 2 },
  };
  assert.deepEqual(
    orderProcessRows([user, tool, early, later]).map((row) => row.messageId),
    ['user', 'early', 'tool', 'later'],
  );
  const canonicalEarly = {
    ...early,
    preview: undefined,
    position: { sourceSequence: 25, itemIndex: 0 },
    order: { sourceSequence: 25, itemIndex: 0 },
  };
  assert.deepEqual(
    orderProcessRows([user, tool, canonicalEarly, later]).map((row) => row.messageId),
    ['user', 'early', 'tool', 'later'],
  );
});

test('a message the Host wrote keeps its origin so the Bot Chat can tell it from the user', () => {
  const chunk = (origin) => ({
    position: { sourceSequence: 1, itemIndex: 0 },
    order: { sourceSequence: 1, itemIndex: 0 },
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
    const position = { sourceSequence: sequence, itemIndex: 0 };
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
