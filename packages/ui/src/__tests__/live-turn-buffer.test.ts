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
import type { StoredMessage } from '@maka/core/session';
import { applyLiveTurnBufferEvent, reconcileLiveTurnBuffer, type LiveTurnBuffer } from '../live-turn-buffer.js';
import { createTranscriptProjection } from '../transcript-projection.js';

for (const outcome of ['compacted', 'failed', 'interrupted'] as const) {
  test(`hands off a durable answer and ${outcome} compaction in one reconciliation`, () => {
    let buffer = applyLiveTurnBufferEvent(undefined, {
      type: 'context_compaction_started', id: 'start', turnId: 'a', ts: 1,
      compactionId: 'compact-a', scope: 'step',
    }, 'en');
    const reason = outcome === 'interrupted' ? 'interrupted' : 'write_failed';
    buffer = applyLiveTurnBufferEvent(buffer, outcome === 'compacted' ? {
      type: 'context_compaction_applied', id: 'applied', turnId: 'a', ts: 2,
      compactionId: 'compact-a', scope: 'step',
    } : {
      type: 'context_compaction_failed', id: 'failed', turnId: 'a', ts: 2,
      compactionId: 'compact-a', scope: 'step', reason,
    }, 'en');
    buffer = applyLiveTurnBufferEvent(buffer, {
      type: 'text_delta', id: 'delta', turnId: 'a', messageId: 'answer-a', ts: 3,
      text: 'Answer', startOffset: 0,
    }, 'en');
    buffer = applyLiveTurnBufferEvent(buffer, {
      type: 'complete', id: 'complete', turnId: 'a', ts: 4,
      stopReason: outcome === 'interrupted' ? 'user_stop' : 'end_turn',
    }, 'en');
    assert.ok(buffer);

    const messages: StoredMessage[] = [
      {
        type: 'system_note', id: 'compact-terminal', turnId: 'a', ts: 2,
        kind: outcome === 'compacted' ? 'context_compaction_applied' : 'context_compaction_failed_open',
        data: { compactionId: 'compact-a', scope: 'step', ...(outcome === 'compacted' ? {} : { failOpenReason: reason }) },
      },
      { type: 'assistant', id: 'answer-a', turnId: 'a', ts: 3, text: 'Answer', modelId: 'test' },
      { type: 'turn_state', id: 'terminal-a', turnId: 'a', ts: 4, status: outcome === 'interrupted' ? 'aborted' : 'completed' },
    ];

    // Answer durability alone must not erase a compaction outcome still missing from history.
    const pending = reconcileLiveTurnBuffer(buffer, messages.filter((message) => message.type !== 'system_note'));
    assert.equal(pending?.[0]?.steps.length, 0);
    assert.equal(pending?.[0]?.compactions?.[0]?.state, outcome);

    assert.equal(reconcileLiveTurnBuffer(buffer, messages), undefined,
      'complete history must finish both handoffs without another refresh or React effect');
    assert.equal(reconcileLiveTurnBuffer(pending!, messages), undefined,
      'a later durable compaction must release an outcome retained during the answer handoff');

    const withSuccessor = applyLiveTurnBufferEvent(buffer, {
      type: 'text_delta', id: 'next-delta', turnId: 'b', messageId: 'answer-b', ts: 5,
      text: 'Next answer', startOffset: 0,
    }, 'en');
    const successor = withSuccessor?.find((turn) => turn.turnId === 'b');
    const reconciled = reconcileLiveTurnBuffer(withSuccessor!, messages);
    assert.equal(reconciled?.length, 1);
    assert.equal(reconciled?.[0], successor, 'releasing the predecessor must preserve the live successor');
  });
}

test('a successor and a delayed predecessor seed retain separate text and settlement', () => {
  let buffer: LiveTurnBuffer | undefined;
  const text = (turnId: string, value: string, startOffset: number) => {
    buffer = applyLiveTurnBufferEvent(buffer, { type: 'text_delta', id: turnId + startOffset,
      turnId, messageId: turnId + '-answer', ts: 1, text: value, startOffset }, 'en');
  };
  text('a', 'Alpha', 0);
  buffer = applyLiveTurnBufferEvent(buffer, { type: 'complete', id: 'a-terminal', turnId: 'a', ts: 2, stopReason: 'end_turn' }, 'en');
  text('b', 'Beta', 0);
  const b = buffer?.find((turn) => turn.turnId === 'b');
  text('a', 'Alpha', 0); // A seed reply can arrive after B has started.
  assert.equal(buffer?.find((turn) => turn.turnId === 'b'), b);
  text('b', ' continued', 4);
  const transcript = createTranscriptProjection().project({ locale: 'en', messages: [], liveTurns: buffer });
  assert.deepEqual(transcript.map((turn) => [turn.turnId, turn.timeline.filter((item) => item.kind === 'text').map((item) => item.text).join('')]), [['a', 'Alpha'], ['b', 'Beta continued']]);
  buffer = reconcileLiveTurnBuffer(buffer!, [{ type: 'assistant', id: 'a-answer', turnId: 'a', ts: 3, text: 'Alpha', modelId: 'test' }]);
  assert.deepEqual(buffer?.map((turn) => turn.turnId), ['b']);
  assert.equal(buffer?.[0]?.steps[0]?.text?.text, 'Beta continued');
  buffer = applyLiveTurnBufferEvent(buffer, { type: 'complete', id: 'late-a-terminal', turnId: 'a', ts: 3, stopReason: 'end_turn' }, 'en');
  assert.equal(buffer?.[0]?.terminal, undefined);
});
