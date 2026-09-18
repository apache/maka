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
import { applyLiveTurnBufferEvent, reconcileLiveTurnBuffer, type LiveTurnBuffer } from '../live-turn-buffer.js';
import { createTranscriptProjection } from '../transcript-projection.js';

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
