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
import { describe, test } from 'node:test';
import {
  isPromptRecord,
  resolveTranscriptLineage,
  transcriptParentUuid,
  type TranscriptRecord,
} from '../claude-code-transcript-lineage.js';

function user(uuid: string, parentUuid: string | null, text: string): TranscriptRecord {
  return { type: 'user', uuid, parentUuid, message: { role: 'user', content: text } };
}

function assistant(
  uuid: string,
  parentUuid: string | null,
  messageId: string,
  content: readonly Record<string, unknown>[],
): TranscriptRecord {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    message: { role: 'assistant', id: messageId, content },
  };
}

function toolResult(uuid: string, parentUuid: string, toolUseId: string): TranscriptRecord {
  return {
    type: 'user',
    uuid,
    parentUuid,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
  };
}

/** The boundary as Claude Code writes it: no parent, and a *forward* logical link. */
function compactBoundary(uuid: string, preservedTailUuid: string): TranscriptRecord {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid,
    parentUuid: null,
    logicalParentUuid: preservedTailUuid,
    compactMetadata: { trigger: 'manual', preservedSegment: { tailUuid: preservedTailUuid } },
  };
}

const uuids = (result: { records: readonly TranscriptRecord[] }): readonly unknown[] =>
  result.records.map((record) => record.uuid);

describe('resolveTranscriptLineage', () => {
  test('a withdrawn prompt and its answer are dropped, the edit kept', () => {
    // The corpus shape, 72 times: the user typed a prompt, edited it, and
    // resubmitted. Both are written under the same parent. Importing both
    // presents a question the user withdrew, and its answer, as conversation.
    const result = resolveTranscriptLineage([
      { type: 'system', uuid: 'p0', parentUuid: null },
      user('u1', 'p0', 'StreamVByte 是什么类型？我忘了'),
      assistant('a1', 'u1', 'msg_1', [{ type: 'text', text: 'answer to the withdrawn one' }]),
      user('u2', 'p0', 'StreamVByte 是什么方式？我忘了'),
      assistant('a2', 'u2', 'msg_2', [{ type: 'text', text: 'answer to the one asked' }]),
    ]);
    assert.deepEqual(uuids(result), ['p0', 'u2', 'a2']);
    assert.equal(result.withdrawnPrompts, 1);
    assert.equal(result.abandoned, 2);
  });

  test('the whole withdrawn subtree goes, not just its head', () => {
    const result = resolveTranscriptLineage([
      { type: 'system', uuid: 'p0', parentUuid: null },
      user('u1', 'p0', 'withdrawn'),
      assistant('a1', 'u1', 'msg_1', [{ type: 'tool_use', id: 'call_dead', name: 'Read' }]),
      toolResult('r1', 'a1', 'call_dead'),
      assistant('a2', 'r1', 'msg_2', [{ type: 'text', text: 'abandoned' }]),
      user('u2', 'p0', 'asked'),
      assistant('a3', 'u2', 'msg_3', [{ type: 'text', text: 'kept' }]),
    ]);
    assert.deepEqual(uuids(result), ['p0', 'u2', 'a3']);
    assert.equal(result.abandoned, 4);
  });

  test('three siblings leave only the last', () => {
    // Measured 3 times in the corpus: a prompt edited twice.
    const result = resolveTranscriptLineage([
      { type: 'system', uuid: 'p0', parentUuid: null },
      user('u1', 'p0', 'first try'),
      user('u2', 'p0', 'second try'),
      user('u3', 'p0', 'third try'),
      assistant('a3', 'u3', 'msg_3', [{ type: 'text', text: 'kept' }]),
    ]);
    assert.deepEqual(uuids(result), ['p0', 'u3', 'a3']);
    assert.equal(result.withdrawnPrompts, 2);
  });

  test('an ordinary tool fork survives whole', () => {
    // 281 of 358 forks in the corpus are this: a `tool_use` record has two
    // children — the next fragment of the same response, and the result of
    // the call it just made. Nothing was abandoned, and a walk that picked
    // one child would strand the other.
    const result = resolveTranscriptLineage([
      user('u1', null, 'prompt'),
      assistant('a1', 'u1', 'msg_1', [{ type: 'tool_use', id: 'call_1', name: 'Read' }]),
      assistant('a2', 'a1', 'msg_1', [{ type: 'tool_use', id: 'call_2', name: 'Read' }]),
      toolResult('r1', 'a1', 'call_1'),
      toolResult('r2', 'a2', 'call_2'),
    ]);
    assert.deepEqual(uuids(result), ['u1', 'a1', 'a2', 'r1', 'r2']);
    assert.equal(result.abandoned, 0);
  });

  test('two tool results under one parent are both kept', () => {
    // Sibling `user` records are a rewind only when they are prompts. A tool
    // result is the harness answering the model, not the user asking again.
    const result = resolveTranscriptLineage([
      user('u1', null, 'prompt'),
      assistant('a1', 'u1', 'msg_1', [
        { type: 'tool_use', id: 'call_1', name: 'Read' },
        { type: 'tool_use', id: 'call_2', name: 'Read' },
      ]),
      toolResult('r1', 'a1', 'call_1'),
      toolResult('r2', 'a1', 'call_2'),
    ]);
    assert.deepEqual(uuids(result), ['u1', 'a1', 'r1', 'r2']);
    assert.equal(result.abandoned, 0);
    assert.equal(result.withdrawnPrompts, 0);
  });

  test('an assistant fork with no prompt in it is left alone', () => {
    const result = resolveTranscriptLineage([
      user('u1', null, 'prompt'),
      assistant('a1', 'u1', 'msg_1', [{ type: 'text', text: 'one' }]),
      assistant('a2', 'u1', 'msg_2', [{ type: 'text', text: 'two' }]),
    ]);
    assert.deepEqual(uuids(result), ['u1', 'a1', 'a2']);
    assert.equal(result.abandoned, 0);
  });

  test('a tool result is not a prompt', () => {
    assert.equal(isPromptRecord(user('u1', null, 'ask')), true);
    assert.equal(isPromptRecord(toolResult('r1', 'a1', 'call_1')), false);
    assert.equal(isPromptRecord(assistant('a1', 'u1', 'm', [])), false);
  });

  test('both sides of a compaction boundary survive', () => {
    // The boundary starts a new root because the model's context restarted
    // there. Both sides are conversation that happened.
    const result = resolveTranscriptLineage([
      user('u1', null, 'before compaction'),
      assistant('a1', 'u1', 'msg_1', [{ type: 'text', text: 'pre-boundary reply' }]),
      compactBoundary('b1', 'a1'),
      { type: 'user', uuid: 's1', parentUuid: 'b1', isCompactSummary: true, message: {} },
      user('u2', 's1', 'after compaction'),
      assistant('a2', 'u2', 'msg_2', [{ type: 'text', text: 'post-boundary reply' }]),
    ]);
    assert.deepEqual(uuids(result), ['u1', 'a1', 'b1', 's1', 'u2', 'a2']);
    assert.equal(result.abandoned, 0);
    assert.equal(result.compactBoundaries, 1);
  });

  test("a boundary's logicalParentUuid is not followed as a parent", () => {
    // It holds `preservedSegment.tailUuid` — a record written AFTER the
    // boundary. Reading it as a parent points forward and closes a cycle
    // through the summary.
    assert.equal(transcriptParentUuid(compactBoundary('b1', 'later')), undefined);
    const result = resolveTranscriptLineage([
      user('u1', null, 'before'),
      assistant('a1', 'u1', 'msg_1', [{ type: 'text', text: 'pre' }]),
      compactBoundary('b1', 'u2'),
      { type: 'user', uuid: 's1', parentUuid: 'b1', isCompactSummary: true, message: {} },
      user('u2', 's1', 'after'),
    ]);
    assert.deepEqual(uuids(result), ['u1', 'a1', 'b1', 's1', 'u2']);
    assert.equal(result.abandoned, 0);
  });

  test('a rewind before a compaction boundary does not disturb what follows', () => {
    const result = resolveTranscriptLineage([
      { type: 'system', uuid: 'p0', parentUuid: null },
      user('u1', 'p0', 'withdrawn before'),
      assistant('a_dead', 'u1', 'msg_dead', [{ type: 'text', text: 'abandoned pre-boundary' }]),
      user('u1b', 'p0', 'asked before'),
      assistant('a1', 'u1b', 'msg_1', [{ type: 'text', text: 'kept pre-boundary' }]),
      compactBoundary('b1', 'a1'),
      user('u2', 'b1', 'after'),
      assistant('a2', 'u2', 'msg_2', [{ type: 'text', text: 'kept post-boundary' }]),
    ]);
    assert.deepEqual(uuids(result), ['p0', 'u1b', 'a1', 'b1', 'u2', 'a2']);
    assert.equal(result.abandoned, 2);
  });

  test('a repeated uuid is kept once', () => {
    const first = user('u1', null, 'prompt');
    const result = resolveTranscriptLineage([first, { ...first }, assistant('a1', 'u1', 'm', [])]);
    assert.deepEqual(uuids(result), ['u1', 'a1']);
    assert.equal(result.duplicates, 1);
  });

  test('a record the graph cannot place is kept', () => {
    // Silence from the graph is not evidence of abandonment. Dropping history
    // is the failure that cannot be undone once it is canonical.
    const result = resolveTranscriptLineage([
      { type: 'user', message: { role: 'user', content: 'no uuid' } },
      user('u1', null, 'prompt'),
      assistant('a1', 'u1', 'msg_1', [{ type: 'text', text: 'reply' }]),
    ]);
    assert.equal(result.records.length, 3);
    assert.equal(result.abandoned, 0);
  });

  test('a sidechain record is passed through untouched', () => {
    const result = resolveTranscriptLineage([
      user('u1', null, 'prompt'),
      { type: 'assistant', uuid: 'sc1', parentUuid: 'nothing', isSidechain: true, message: {} },
    ]);
    assert.equal(result.records.length, 2);
    assert.equal(result.abandoned, 0);
  });

  test('a parent cycle terminates instead of hanging the import', () => {
    // These links are written by another process; a cycle has to fail the
    // walk, not spin in it.
    const result = resolveTranscriptLineage([
      { type: 'user', uuid: 'x', parentUuid: 'y', message: { role: 'user', content: 'a' } },
      { type: 'user', uuid: 'y', parentUuid: 'x', message: { role: 'user', content: 'b' } },
    ]);
    assert.equal(result.records.length, 2);
  });

  test('an empty transcript resolves to nothing rather than throwing', () => {
    const result = resolveTranscriptLineage([]);
    assert.deepEqual(result.records, []);
    assert.equal(result.abandoned, 0);
  });
});
