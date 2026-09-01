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

import type {
  SandboxBoundaryRequestEvent,
  UserQuestionRequestEvent,
} from '@maka/core/events';
import {
  activeInteractionFor,
  clearInteractions,
  dequeueInteractionByRequestId,
  dequeueInteractionByToolUseId,
  enqueueInteraction,
  reconcileInteractions,
  reduceInteractionQueues,
  type InteractionQueues,
} from '../interaction-queue.js';

function boundary(requestId: string): SandboxBoundaryRequestEvent {
  return {
    type: 'sandbox_boundary_request',
    id: `evt_${requestId}`,
    turnId: 'turn_1',
    ts: 0,
    requestId,
    toolUseId: `call_${requestId}`,
    justification: 'Read an external file.',
    expansion: {
      filesystem: {
        entries: [{ path: '/outside/file', access: 'read', scope: 'exact' }],
      },
    },
  };
}

function question(requestId: string): UserQuestionRequestEvent {
  return {
    type: 'user_question_request',
    id: `evt_${requestId}`,
    ts: 0,
    requestId,
    toolUseId: `call_${requestId}`,
    turnId: 'turn_1',
    questions: [{ question: 'Choose', options: [{ label: 'A' }] }],
  };
}

describe('composer interaction queue', () => {
  test('boundary and question requests share one FIFO per session', () => {
    let queues: InteractionQueues = {};
    queues = enqueueInteraction(queues, 's', boundary('boundary'));
    queues = enqueueInteraction(queues, 's', question('question'));

    assert.equal(activeInteractionFor(queues, 's')?.requestId, 'boundary');
    queues = dequeueInteractionByRequestId(queues, 's', 'boundary');
    assert.equal(activeInteractionFor(queues, 's')?.requestId, 'question');
  });

  test('Client Capability requests enter and leave the shared queue', () => {
    let queues = reduceInteractionQueues({}, 's', {
      type: 'client_capability_request',
      id: 'evt_capability',
      turnId: 'turn_1',
      ts: 0,
      requestId: 'capability',
      toolUseId: 'call_capability',
      capability: 'browser',
      scope: { kind: 'browser_origin', origin: 'https://example.com' },
    });
    assert.equal(activeInteractionFor(queues, 's')?.requestId, 'capability');

    queues = reduceInteractionQueues(queues, 's', {
      type: 'client_capability_decision_ack',
      id: 'evt_ack',
      turnId: 'turn_1',
      ts: 1,
      requestId: 'capability',
      toolUseId: 'call_capability',
      decision: 'allow',
    });
    assert.equal(activeInteractionFor(queues, 's'), undefined);
  });

  test('deduplicates replays and isolates sessions', () => {
    let queues: InteractionQueues = {};
    queues = enqueueInteraction(queues, 's1', question('a'));
    queues = enqueueInteraction(queues, 's1', question('a'));
    queues = enqueueInteraction(queues, 's2', boundary('b'));

    assert.equal(queues.s1.length, 1);
    assert.equal(activeInteractionFor(queues, 's2')?.requestId, 'b');
  });

  test('tool completion and terminal events drain stale interactions', () => {
    let queues: InteractionQueues = {};
    queues = enqueueInteraction(queues, 's', boundary('a'));
    queues = enqueueInteraction(queues, 's', question('b'));

    queues = dequeueInteractionByToolUseId(queues, 's', 'call_a');
    assert.equal(activeInteractionFor(queues, 's')?.requestId, 'b');
    assert.equal(dequeueInteractionByToolUseId(queues, 's', 'missing'), queues);

    queues = clearInteractions(queues, 's');
    assert.equal(activeInteractionFor(queues, 's'), undefined);
  });

  test('rehydration keeps the shown order and drops what the runtime settled', () => {
    let queues: InteractionQueues = {};
    queues = enqueueInteraction(queues, 's', boundary('stale'));
    queues = enqueueInteraction(queues, 's', question('answered'));
    queues = enqueueInteraction(queues, 's', boundary('live'));

    const reconciled = reconcileInteractions(queues, 's', [
      boundary('live'),
      question('unseen'),
      boundary('new'),
    ]);

    assert.deepEqual(
      reconciled.s.map((interaction) => interaction.requestId),
      ['live', 'unseen', 'new'],
    );
  });

  test('rehydration adds a question the surface never saw live', () => {
    const reconciled = reconcileInteractions({}, 's', [question('missed')]);

    assert.equal(activeInteractionFor(reconciled, 's')?.type, 'user_question_request');
    assert.equal(activeInteractionFor(reconciled, 's')?.requestId, 'missed');
  });
});
