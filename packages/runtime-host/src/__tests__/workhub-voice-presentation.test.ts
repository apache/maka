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
import { WORKHUB_COORDINATION_SESSION_ID as sessionId } from '@maka/core/session';
import { projectRuntimeEventsToStoredMessages } from '@maka/runtime/runtime-event-read-model';
import { decodeVoiceObservation } from '../protocol/workhub-voice-state.js';
const turnId = 'opaque-id';
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
