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
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  WORKHUB_COORDINATION_SESSION_ID as sessionId,
  type StoredMessage,
  decodeCanonicalMessage,
} from '@maka/core/session';
import { projectRuntimeEventsToStoredMessages } from '@maka/runtime/runtime-event-read-model';
import { annotateVoicePresentation } from '../server/workhub-voice-presentation.js';
import { decodeVoiceObservation } from '../protocol/workhub-voice-state.js';
const turnId = 'opaque-id';
test('maintenance remains internal after a real voice request steers into it', () => {
  const events = [
    {
      id: 'a',
      turnId,
      role: 'user',
      content: { kind: 'text', text: 'maintain', workhubSource: 'voice_maintenance' },
    },
    { id: 'b', turnId, role: 'model' },
    {
      id: 'c',
      turnId,
      role: 'user',
      content: { kind: 'text', text: 'Top5', workhubSource: 'voice_request', steering: true },
    },
    { id: 'd', turnId, role: 'model' },
    { id: 'e', turnId, role: 'tool' },
  ] as RuntimeEvent[];
  const messages: StoredMessage[] = [
    { type: 'user', id: 'a', turnId, ts: 1, text: 'maintain', workhubSource: 'voice_maintenance' },
    { type: 'assistant', id: 'b', turnId, ts: 2, text: '队列为空', modelId: 'model' },
    { type: 'user', id: 'c', turnId, ts: 3, text: 'Top5', workhubSource: 'voice_request' },
    { type: 'assistant', id: 'd', turnId, ts: 4, text: '仍在维护', modelId: 'model' },
    {
      type: 'assistant',
      id: 'public',
      turnId,
      ts: 5,
      text: 'Top5 已修改',
      modelId: '',
      presentation: 'public',
    },
  ];
  const result = annotateVoicePresentation(
    sessionId,
    messages,
    events,
    events.map((e) => e.id),
  );
  assert.deepEqual(
    result.map((m) => m.presentation),
    ['internal', 'internal', undefined, 'internal', 'public'],
  );
  for (const message of result)
    assert.deepEqual(decodeCanonicalMessage(JSON.parse(JSON.stringify(message))), message);
  const oldEvents = structuredClone(events);
  if (oldEvents[0]!.content?.kind === 'text') delete oldEvents[0]!.content.workhubSource;
  const oldMessages = structuredClone(messages);
  if (oldMessages[0]!.type === 'user') delete oldMessages[0]!.workhubSource;
  assert.deepEqual(
    annotateVoicePresentation(
      sessionId,
      oldMessages,
      oldEvents,
      events.map((e) => e.id),
      new Map([[turnId, 'voice_maintenance']]),
    ),
    result,
  );
  assert.equal(oldMessages[0]!.type === 'user' && oldMessages[0]!.workhubSource, undefined);
  assert.deepEqual(
    annotateVoicePresentation(
      'ordinary',
      messages,
      events,
      events.map((e) => e.id),
    ),
    messages,
  );
});
test('Host registered publisher creates the same public receipt in live and stored projections', () => {
  const base = { invocationId: 'run', runId: 'run', sessionId, turnId, ts: 1, partial: false };
  const events: RuntimeEvent[] = [
    {
      ...base,
      id: 'call',
      role: 'model',
      author: 'agent',
      content: { kind: 'function_call', id: 'tool', name: 'renamed_publisher', args: {} },
      actions: { stateDelta: { presentation: 'internal', resultPresentation: 'public_message' } },
    },
    {
      ...base,
      id: 'result',
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'tool',
        name: 'renamed_publisher',
        result: { kind: 'json', value: { publication: { id: 'one', text: 'Actual answer' } } },
      },
    },
  ];
  const projected = projectRuntimeEventsToStoredMessages(events, { invocations: [] });
  assert.deepEqual(projected.diagnostics, []);
  assert.deepEqual(
    projected.messages.map((m) => m.presentation),
    ['internal', 'internal', 'public'],
  );
  assert.equal(projected.messages[2]!.id, 'workhub-public-one');
  assert.equal(projected.sourceEventIds[2], 'result');
  assert.deepEqual(
    projectRuntimeEventsToStoredMessages(JSON.parse(JSON.stringify(events)), { invocations: [] })
      .messages,
    projected.messages,
  );
  const untrusted = structuredClone(events);
  delete untrusted[0]!.actions;
  assert.equal(
    projectRuntimeEventsToStoredMessages(untrusted, { invocations: [] }).messages.length,
    2,
  );
  const failed = structuredClone(events);
  (failed[1]!.content as { isError?: boolean }).isError = true;
  assert.equal(
    projectRuntimeEventsToStoredMessages(failed, { invocations: [] }).messages.length,
    2,
  );
});

test('same-id publication revisions replace text in both live and serialized event projections', () => {
  const base = { invocationId: 'run', runId: 'run', sessionId, turnId, ts: 1, partial: false };
  const events: RuntimeEvent[] = [];
  for (const [index, text] of ['Original joke', 'Revised joke', 'Revised joke'].entries()) {
    const id = `tool-${index}`;
    events.push(
      {
        ...base,
        id: `call-${index}`,
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id, name: 'publisher', args: {} },
        actions: { stateDelta: { presentation: 'internal', resultPresentation: 'public_message' } },
      },
      {
        ...base,
        id: `result-${index}`,
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id,
          name: 'publisher',
          result: { kind: 'json', value: { publication: { id: 'joke', text } } },
        },
      },
    );
  }
  const projected = projectRuntimeEventsToStoredMessages(events, { invocations: [] });
  const rows = projected.messages.filter((message) => message.presentation === 'public');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.type === 'assistant' && rows[0]!.text, 'Revised joke');
  assert.equal(rows[0]!.id, 'workhub-public-joke');
  assert.equal(projected.sourceEventIds[projected.messages.indexOf(rows[0]!)], 'result-0');
  assert.deepEqual(
    projectRuntimeEventsToStoredMessages(JSON.parse(JSON.stringify(events)), { invocations: [] }),
    projected,
  );
});

test('task-result input keeps its source through storage without hiding ordinary WorkHub result output', () => {
  const messages: StoredMessage[] = [
    {
      type: 'user',
      id: 'result-in',
      turnId,
      ts: 1,
      text: 'Native result',
      workhubSource: 'task_result',
    },
    {
      type: 'assistant',
      id: 'result-out',
      turnId,
      ts: 2,
      text: 'The task is complete',
      modelId: 'model',
    },
  ];
  const events = [
    {
      id: 'result-in',
      turnId,
      role: 'user',
      content: { kind: 'text', text: 'Native result', workhubSource: 'task_result' },
    },
    {
      id: 'result-out',
      turnId,
      role: 'model',
      content: { kind: 'text', text: 'The task is complete' },
    },
  ] as RuntimeEvent[];
  const projected = annotateVoicePresentation(sessionId, messages, events, [
    'result-in',
    'result-out',
  ]);
  assert.equal(projected[0]!.presentation, 'internal');
  assert.equal(projected[1]!.presentation, undefined);
  assert.equal(decodeCanonicalMessage(projected[0]!)?.type, 'user');
});

test('voice log writes carry facts and an optional idle review, without legacy windows', () => {
  const input = {
    id: 'write',
    callId: 'call',
    entries: [{ id: 'entry', kind: 'transcript_delta', data: { role: 'user', delta: 'hello' } }],
  };
  assert.deepEqual(decodeVoiceObservation(input), input);
  assert.equal(decodeVoiceObservation({ ...input, review: true }).review, true);
  assert.throws(() => decodeVoiceObservation({ ...input, context: 'old window' }));
  assert.throws(() => decodeVoiceObservation({ ...input, review: 'yes' }));
});
