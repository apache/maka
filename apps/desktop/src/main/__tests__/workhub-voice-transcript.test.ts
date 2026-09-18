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
import { test } from 'node:test';
import { VoiceTranscriptCollector } from '../../renderer/features/workhub/testing.js';

test('legacy fragments display once without clearing the other speaker', () => {
  const collector = new VoiceTranscriptCollector();
  const fragment = (role: string, id: string, text: string) => ({ type: `${role}_transcript.added`, item: { id, text } });
  assert.deepEqual(collector.accept(fragment('input', '1', '检查')), { input: '检查', output: '' });
  assert.equal(collector.accept(fragment('input', '1', '检查')), undefined);
  assert.deepEqual(collector.accept(fragment('input', '2', '连接')), { input: '检查连接', output: '' });
  assert.deepEqual(collector.accept(fragment('output', '3', '好的')), { input: '检查连接', output: '好的' });
  assert.deepEqual(collector.accept(fragment('input', '4', '先暂停')), { input: '检查连接先暂停', output: '好的' });
  assert.equal(collector.accept({ type: 'input_transcript.added', item: { text: 123 } }), undefined);
});

test('Realtime API completed input and streamed output use the same live display', () => {
  const collector = new VoiceTranscriptCollector();
  assert.deepEqual(collector.accept({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: '你好' }), { input: '你好', output: '' });
  assert.deepEqual(collector.accept({ type: 'response.output_audio_transcript.delta', event_id: 'a', delta: '你好呀' }), { input: '你好', output: '你好呀' });
  assert.deepEqual(collector.accept({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'two', transcript: '检查任务' }), { input: '检查任务', output: '你好呀' });
});

test('overlapping native turns accumulate separately and keep final captions until the next turn', () => {
  const collector = new VoiceTranscriptCollector();
  const turn = (type: string, id: string, role: string, transcript: string) => ({ type, turn: { id, role, transcript } });
  assert.deepEqual(collector.accept(turn('turn.created', 'a', 'assistant', '火箭')), { input: '', output: '火箭' });
  assert.deepEqual(collector.accept(turn('turn.created', 'u', 'user', '等')), { input: '等', output: '火箭' });
  assert.deepEqual(collector.accept({ type: 'turn.delta', turn_id: 'a', delta: '入轨' }), { input: '等', output: '火箭入轨' });
  assert.deepEqual(collector.accept({ type: 'turn.delta', turn_id: 'u', delta: '一下' }), { input: '等一下', output: '火箭入轨' });
  assert.equal(collector.accept({ type: 'output_transcript.added', item: { id: 'fragment', text: '入轨' } }), undefined);
  assert.equal(collector.accept(turn('turn.done', 'a', 'assistant', '火箭入轨')), undefined);
  assert.equal(collector.accept(turn('turn.done', 'u', 'user', '等一下')), undefined);
  assert.deepEqual(collector.accept(turn('turn.created', 'a2', 'assistant', '好的')), { input: '等一下', output: '好的' });
  assert.equal(collector.accept(turn('turn.done', 'a', 'assistant', '火箭入轨')), undefined);
  assert.deepEqual(collector.accept({ type: 'turn.delta', turn_id: 'a2', delta: '，你说' }), { input: '等一下', output: '好的，你说' });
});
