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
import { compactVoiceLogEvent } from '../workhub-voice-log.js';

test('voice archive excludes diagnostic streams while keeping compact media evidence', () => {
  for (const kind of ['workhub_event', 'native_notification'])
    assert.equal(compactVoiceLogEvent(kind, { text: 'internal'.repeat(1000) }), undefined);
  assert.equal(compactVoiceLogEvent('transport', { type: 'turn.delta', delta: 'fragment' }), undefined);
  const fact = compactVoiceLogEvent('transport', { type: 'turn.done', turn: { id: 't', role: 'assistant', transcript: 'already stored' } });
  assert.equal(fact?.data.turnId, 't');
  assert.doesNotMatch(JSON.stringify(fact), /already stored/);
  assert.deepEqual(compactVoiceLogEvent('speech_submitted', { deliveryId: 'd', text: 'body' }), { kind: 'speech_submitted', data: { deliveryId: 'd' } });
  assert.equal(compactVoiceLogEvent('transport', { type: 'output_audio_buffer.cleared', response_id: 'r' })?.data.responseId, 'r');
  assert.equal(compactVoiceLogEvent('delegation', { requestId: 'h', userTurnId: 'i', text: 'do task' })?.data.text, 'do task');
});
