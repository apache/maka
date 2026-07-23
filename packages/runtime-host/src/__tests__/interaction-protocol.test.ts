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
  RuntimeHostProtocolError,
} from '../protocol/index.js';
import {
  answerOutcome,
  projectInteractionRecord,
  projectSessionInteractions,
} from '../server/interaction-projection.js';

describe('Runtime Host Interaction protocol', () => {
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
          interactionId: 'interaction-1',
          answer: { kind: 'question', answers: ['Yes'] },
        },
      }),
      {
        requestId: 'answer-1',
        operation: 'interaction.answer',
        input: {
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
