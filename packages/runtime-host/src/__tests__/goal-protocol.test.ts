import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeGoalProjection,
  decodeRequestFrame,
  decodeResponseFrame,
  decodeSessionContinuitySnapshot,
  HOST_OPERATION_SPECS,
  SESSION_CONTINUITY_SCHEMA_VERSION,
} from '../protocol/index.js';

const goal = {
  goalId: 'goal-1',
  revision: 3,
  sessionId: 'session-1',
  condition: 'Ship the complete slice',
  status: 'paused' as const,
  setAt: 1,
  iterations: 2,
  maxIterations: 50,
  consecutiveNoProgress: 0,
  blockCap: 8,
  tokenBudget: 10_000,
  tokensSpent: 500,
  lastReason: 'Waiting for an exact resume',
  achievedAt: null,
  pausedAt: 2,
};

test('Goal query and exact-revision control frames round-trip', () => {
  assert.deepEqual(
    decodeRequestFrame({
      requestId: 'request-query',
      operation: 'goal.query',
      input: { sessionId: 'session-1' },
    }),
    {
      requestId: 'request-query',
      operation: 'goal.query',
      input: { sessionId: 'session-1' },
    },
  );
  assert.deepEqual(
    decodeRequestFrame({
      requestId: 'request-control',
      operation: 'goal.control',
      input: {
        sessionId: 'session-1',
        goalId: 'goal-1',
        expectedRevision: 3,
        action: 'resume',
      },
    }),
    {
      requestId: 'request-control',
      operation: 'goal.control',
      input: {
        sessionId: 'session-1',
        goalId: 'goal-1',
        expectedRevision: 3,
        action: 'resume',
      },
    },
  );
  assert.deepEqual(
    decodeResponseFrame({
      requestId: 'request-control',
      operation: 'goal.control',
      ok: true,
      result: { sessionId: 'session-1', goal },
    }),
    {
      requestId: 'request-control',
      operation: 'goal.control',
      ok: true,
      result: { sessionId: 'session-1', goal },
    },
  );
  assert.throws(() =>
    HOST_OPERATION_SPECS['goal.control'].assertOutputForInput?.(
      {
        sessionId: 'session-1',
        goalId: 'another-goal',
        expectedRevision: 3,
        action: 'resume',
      },
      { sessionId: 'session-1', goal },
    ),
  );
});

test('Goal projection is part of the exact Session continuity schema', () => {
  const snapshot = decodeSessionContinuitySnapshot({
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId: 'session-1',
      metadataRevision: 1,
      status: 'running',
      createdAt: 1,
      lastUsedAt: 2,
      isArchived: false,
    },
    projectionRevision: 1,
    rootTurn: null,
    goal,
    queue: { hostEpoch: 'epoch-1', queueRevision: 0, steering: [], followup: [] },
    interactions: { pending: [] },
  });
  assert.deepEqual(snapshot.goal, goal);
  assert.throws(() =>
    decodeSessionContinuitySnapshot({
      ...snapshot,
      goal: { ...goal, sessionId: 'session-2' },
    }),
  );
});

test('Goal projection rejects unknown fields and text beyond the shared UTF-8 boundary', () => {
  assert.throws(() => decodeGoalProjection({ ...goal, extra: true }));
  assert.throws(() => decodeGoalProjection({ ...goal, condition: '界'.repeat(501) }));
  assert.throws(() => decodeGoalProjection({ ...goal, lastReason: '界'.repeat(501) }));
});
