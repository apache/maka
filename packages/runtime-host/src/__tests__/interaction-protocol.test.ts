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

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { InteractionRecord, StoredInteractionRequest } from '@maka/storage/interaction-store';
import {
  decodeClientFrame,
  decodeHostFrame,
  decodeInteractionSnapshot,
  decodeSessionInteractionProjection,
  HOST_OPERATION_SPECS,
  INTERACTION_MAX_PENDING_PER_SESSION,
  decodeRuntimeResourceHandoffInput,
  decodeRuntimeResourceHandoffResult,
} from '../protocol/index.js';
import { decodeInteractionAnswer } from '@maka/core/interaction';
import {
  answerOutcome,
  projectInteractionRecord,
  projectSessionInteractions,
} from '../server/interaction-projection.js';

describe('Runtime Host Interaction protocol', () => {
  test('handoff outcomes distinguish rejected input and closure without private display', () => {
    const rejected = {
      status: 'rejected',
      phase: 'human',
      nextSequence: 1,
      rejection: 'invalid_input',
    };
    assert.deepEqual(decodeRuntimeResourceHandoffResult(rejected), rejected);
    const closed = { status: 'closed', phase: 'closed', nextSequence: 2, closure: 'exited' };
    assert.deepEqual(decodeRuntimeResourceHandoffResult(closed), closed);
    assert.throws(() =>
      decodeRuntimeResourceHandoffResult({
        ...closed,
        display: { sequence: 1, text: 'private', inputOpen: false },
      }),
    );
    assert.throws(() => decodeRuntimeResourceHandoffResult({ ...rejected, status: 'written' }));
    assert.throws(() =>
      decodeRuntimeResourceHandoffResult({ ...closed, closure: 'wrong_password' }),
    );
    const cleared = {
      status: 'observed',
      phase: 'resumed',
      nextSequence: 2,
      display: { sequence: 3, text: '', inputOpen: false },
    };
    assert.deepEqual(decodeRuntimeResourceHandoffResult(cleared), cleared);
  });
  test('private terminal bytes use nonjournalled control and cannot be stored in an Interaction answer', () => {
    assert.equal(HOST_OPERATION_SPECS['runtime.resource.handoff'].mode, 'control');
    const input = {
      action: 'input',
      sessionId: 'session-1',
      requestId: 'request-1',
      controllerId: 'card-1',
      sequence: 1,
      input: 'synthetic-private-value',
    };
    assert.deepEqual(decodeRuntimeResourceHandoffInput(input), input);
    assert.throws(() =>
      decodeRuntimeResourceHandoffInput({ ...input, input: 'x'.repeat(32 * 1024 + 1) }),
    );
    for (const field of ['input', 'password', 'values', 'text']) {
      assert.throws(() =>
        decodeInteractionAnswer({
          kind: 'terminal_handoff',
          action: 'resume',
          controllerId: 'card-1',
          [field]: 'synthetic-private-value',
        }),
      );
    }
    assert.deepEqual(
      decodeInteractionAnswer({
        kind: 'terminal_handoff',
        action: 'resume',
        controllerId: 'card-1',
      }),
      { kind: 'terminal_handoff', action: 'resume', controllerId: 'card-1' },
    );
  });

  test('decodes a closed snapshot and rejects extra fields', () => {
    const closed = {
      ...snapshotBase('interaction-1'),
      revision: 2,
      status: 'closed',
      outcome: { kind: 'closure', reason: 'turn_stopped', committedAt: 5 },
    } as const;
    assert.deepEqual(decodeInteractionSnapshot(closed), closed);
    assert.throws(
      () => decodeInteractionSnapshot({ ...closed, privateState: true }),
      isInvalidFrame,
    );
  });

  test('accepts only a bounded pending-only Session projection', () => {
    const pending = Array.from({ length: INTERACTION_MAX_PENDING_PER_SESSION }, (_, index) => ({
      ...snapshotBase(`interaction-${index}`),
      revision: 1,
      status: 'pending',
      outcome: null,
    }));
    assert.deepEqual(decodeSessionInteractionProjection({ pending }, 'session-1'), { pending });
    assert.throws(
      () =>
        decodeSessionInteractionProjection(
          {
            pending: [
              ...pending,
              {
                ...snapshotBase('interaction-overflow'),
                revision: 1,
                status: 'pending',
                outcome: null,
              },
            ],
          },
          'session-1',
        ),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeSessionInteractionProjection(
          {
            pending: [
              {
                ...snapshotBase('interaction-closed'),
                revision: 2,
                status: 'closed',
                outcome: { kind: 'closure', reason: 'turn_terminal', committedAt: 6 },
              },
            ],
          },
          'session-1',
        ),
      isInvalidFrame,
    );
  });

  test('routes query and answer with their exact ready operation declarations', () => {
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'query-1',
        operation: 'interaction.query',
        input: { sessionId: 'session-1', interactionId: 'interaction-1' },
      }),
      {
        requestId: 'query-1',
        operation: 'interaction.query',
        input: { sessionId: 'session-1', interactionId: 'interaction-1' },
      },
    );
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'answer-1',
        operation: 'interaction.answer',
        input: {
          sessionId: 'session-1',
          interactionId: 'interaction-1',
          answer: { kind: 'question', answers: ['Yes'] },
        },
      }),
      {
        requestId: 'answer-1',
        operation: 'interaction.answer',
        input: {
          sessionId: 'session-1',
          interactionId: 'interaction-1',
          answer: { kind: 'question', answers: ['Yes'] },
        },
      },
    );

    assert.deepEqual(operationDeclaration('interaction.query'), {
      mode: 'query',
      availability: 'ready',
      errors: [
        'host_not_ready',
        'host_draining',
        'operation_unavailable',
        'not_found',
        'internal_failure',
      ],
    });
    assert.deepEqual(operationDeclaration('interaction.answer'), {
      mode: 'command',
      availability: 'ready',
      errors: [
        'host_not_ready',
        'host_draining',
        'operation_unavailable',
        'not_found',
        'operation_conflict',
        'already_resolved',
        'internal_failure',
      ],
    });
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'answer-1',
        operation: 'interaction.answer',
        ok: false,
        error: { code: 'already_resolved', message: 'Interaction already resolved' },
      }),
      {
        requestId: 'answer-1',
        operation: 'interaction.answer',
        ok: false,
        error: { code: 'already_resolved', message: 'Interaction already resolved' },
      },
    );
  });

  test('decodes a form snapshot and exact form answer without widening the wire', () => {
    const snapshot = {
      schemaVersion: 1,
      interactionId: 'form-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      revision: 1,
      status: 'pending',
      outcome: null,
      request: {
        kind: 'form',
        toolUseId: 'tool-1',
        message: 'Choose settings',
        requester: { name: 'deploy', source: 'Example server' },
        fields: [
          {
            kind: 'boolean',
            name: 'confirm',
            label: 'Confirm',
            required: true,
          },
        ],
      },
    } as const;
    assert.deepEqual(decodeInteractionSnapshot(snapshot), snapshot);

    const frame = {
      requestId: 'answer-form',
      operation: 'interaction.answer',
      input: {
        sessionId: 'session-1',
        interactionId: 'form-1',
        answer: { kind: 'form', action: 'accept', values: { confirm: true } },
      },
    } as const;
    assert.deepEqual(decodeClientFrame(frame), frame);
    assert.throws(
      () =>
        decodeClientFrame({
          ...frame,
          input: {
            ...frame.input,
            answer: { ...frame.input.answer, requestState: 'must-not-cross-host-wire' },
          },
        }),
      isInvalidFrame,
    );
  });

  test('returns the canonical winner only for an equivalent normalized answer retry', () => {
    const request = storedRequest('interaction-1', 10);
    const answered: InteractionRecord & { outcome: NonNullable<InteractionRecord['outcome']> } = {
      request,
      outcome: {
        sessionId: request.sessionId,
        turnId: request.turnId,
        runId: request.runId,
        requestId: request.requestId,
        outcome: { kind: 'question_answer', answers: ['Yes'], committedAt: 20 },
      },
    };
    const same = answerOutcome(answered, { kind: 'question', answers: ['Yes'] });
    assert.deepEqual(same, { ok: true, result: projectInteractionRecord(answered) });
    assert.equal(answerOutcome(answered, { kind: 'question', answers: ['No'] }).ok, false);

    const closed = {
      ...answered,
      outcome: {
        ...answered.outcome,
        outcome: { kind: 'closure', reason: 'turn_terminal', committedAt: 21 } as const,
      },
    };
    assert.deepEqual(answerOutcome(closed, { kind: 'question', answers: ['Yes'] }), {
      ok: false,
      error: { code: 'already_resolved', message: 'Interaction was already closed' },
    });

    assert.deepEqual(
      projectSessionInteractions([
        storedRequest('interaction-b', 2),
        storedRequest('interaction-c', 1),
        storedRequest('interaction-a', 2),
      ]).pending.map((snapshot) => snapshot.interactionId),
      ['interaction-c', 'interaction-a', 'interaction-b'],
    );
  });
});

function snapshotBase(interactionId: string) {
  return {
    schemaVersion: 1 as const,
    interactionId,
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    request: questionRequest(),
  };
}

function questionRequest() {
  return {
    kind: 'question' as const,
    toolUseId: 'tool-1',
    questions: [
      {
        question: 'Continue?',
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
    ],
  };
}

function storedRequest(requestId: string, createdAt: number): StoredInteractionRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    requestId,
    createdAt,
    request: questionRequest(),
  };
}

function operationDeclaration(operation: 'interaction.query' | 'interaction.answer') {
  const spec = HOST_OPERATION_SPECS[operation];
  return { mode: spec.mode, availability: spec.availability, errors: spec.errors };
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
