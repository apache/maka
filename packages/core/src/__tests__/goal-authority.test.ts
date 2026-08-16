import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeGoalAuthorityRecord, type GoalAuthorityRecord } from '../goal.js';

test('Goal authority decoder rejects cross-authority execution state', () => {
  const valid = goalAuthorityRecord();
  const current = valid.currentExecution;
  assert.ok(current);
  if (!current) return;

  for (const candidate of [
    { ...valid, extra: true },
    {
      ...valid,
      currentExecution: {
        ...current,
        execution: { ...current.execution, sessionId: 'other_session' },
      },
    },
    {
      ...valid,
      currentExecution: {
        ...current,
        checkpoint: { ...current.checkpoint, revision: valid.goal.revision + 1 },
      },
    },
    {
      ...valid,
      currentExecution: {
        ...current,
        controlLease: {
          ...current.controlLease,
          generation: valid.controlLease.generation + 1,
        },
      },
    },
  ]) {
    assert.throws(() => decodeGoalAuthorityRecord(candidate), TypeError);
  }
});

function goalAuthorityRecord(): GoalAuthorityRecord {
  const goalId = 'goal_1';
  const sessionId = 'session_1';
  const controlLease = { goalId, generation: 2 };
  return {
    schemaVersion: 1,
    goal: {
      id: goalId,
      revision: 3,
      sessionId,
      condition: 'Finish the durable Goal.',
      status: 'active',
      setAt: 1,
      iterations: 2,
      maxIterations: 50,
      consecutiveNoProgress: 0,
      blockCap: 8,
      tokensAtStart: 10,
      tokensNow: 20,
      tokensBaselinePending: false,
    },
    controlLease,
    currentExecution: {
      execution: { sessionId, turnId: 'turn_1', runId: 'run_1' },
      checkpoint: { goalId, revision: 2 },
      controlLease: { goalId, generation: 1 },
    },
  };
}
