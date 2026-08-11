import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodePlanQueryResult,
  decodeRequestFrame,
  decodeResponseFrame,
  HOST_OPERATION_SPECS,
  PLAN_PAGE_MAX_ITEMS,
} from '../protocol/index.js';

const proposal = {
  planId: 'plan-1',
  proposalId: 'proposal-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  revision: 1,
  title: 'Host-owned Plan',
  steps: [{ id: 'step-1', title: 'Own state', description: 'Persist the Plan in the Host' }],
  status: 'pending_approval' as const,
  submittedAt: 1,
};

test('Plan controls preserve request and result correlation', () => {
  assert.deepEqual(
    decodeRequestFrame({
      requestId: 'request-1',
      operation: 'plan.control',
      input: {
        kind: 'approve_proposal',
        sessionId: 'session-1',
        proposalId: 'proposal-1',
        expectedRevision: 1,
        expectedStoreVersion: 1,
        operationId: 'approve-1',
      },
    }),
    {
      requestId: 'request-1',
      operation: 'plan.control',
      input: {
        kind: 'approve_proposal',
        sessionId: 'session-1',
        proposalId: 'proposal-1',
        expectedRevision: 1,
        expectedStoreVersion: 1,
        operationId: 'approve-1',
      },
    },
  );
  assert.deepEqual(
    decodeResponseFrame({
      requestId: 'request-1',
      operation: 'plan.control',
      ok: true,
      result: {
        sessionId: 'session-1',
        storeVersion: 2,
        eventType: 'plan_approved',
        proposalId: 'proposal-1',
        executionId: 'execution-1',
      },
    }),
    {
      requestId: 'request-1',
      operation: 'plan.control',
      ok: true,
      result: {
        sessionId: 'session-1',
        storeVersion: 2,
        eventType: 'plan_approved',
        proposalId: 'proposal-1',
        executionId: 'execution-1',
      },
    },
  );
  assert.throws(() =>
    HOST_OPERATION_SPECS['plan.control'].assertOutputForInput?.(
      {
        kind: 'approve_proposal',
        sessionId: 'session-1',
        proposalId: 'proposal-1',
        expectedRevision: 1,
        expectedStoreVersion: 1,
        operationId: 'approve-1',
      },
      {
        sessionId: 'session-1',
        storeVersion: 2,
        eventType: 'plan_approved',
        proposalId: 'proposal-1',
        executionId: null,
      },
    ),
  );
});

test('Plan Turn start closes approve and resume into one correlated command', () => {
  const input = {
    kind: 'approve_proposal' as const,
    sessionId: 'session-1',
    proposalId: 'proposal-1',
    expectedRevision: 1,
    expectedStoreVersion: 2,
    turnId: 'turn-2',
  };
  assert.deepEqual(
    decodeRequestFrame({ requestId: 'request-1', operation: 'plan.turn.start', input }),
    { requestId: 'request-1', operation: 'plan.turn.start', input },
  );
  const result = {
    plan: {
      sessionId: 'session-1',
      storeVersion: 3,
      eventType: 'plan_approved' as const,
      proposalId: 'proposal-1',
      executionId: 'execution-1',
    },
    turn: {
      sessionId: 'session-1',
      turnId: 'turn-2',
      runId: 'run-1',
      status: 'running' as const,
    },
  };
  assert.deepEqual(
    decodeResponseFrame({
      requestId: 'request-1',
      operation: 'plan.turn.start',
      ok: true,
      result,
    }),
    { requestId: 'request-1', operation: 'plan.turn.start', ok: true, result },
  );
  assert.throws(() =>
    HOST_OPERATION_SPECS['plan.turn.start'].assertOutputForInput?.(input, {
      ...result,
      turn: { ...result.turn, turnId: 'turn-other' },
    }),
  );
});

test('Plan pages reject open shapes, oversized pages, and malformed nested state', () => {
  const page = {
    kind: 'page',
    sessionId: 'session-1',
    storeVersion: 1,
    latestProposalId: 'proposal-1',
    activeExecutionId: null,
    items: [{ kind: 'proposal', proposal }],
    nextCursor: null,
  };
  assert.deepEqual(decodePlanQueryResult(page), page);
  assert.throws(() => decodePlanQueryResult({ ...page, extra: true }));
  assert.throws(() =>
    decodePlanQueryResult({
      ...page,
      items: Array.from({ length: PLAN_PAGE_MAX_ITEMS + 1 }, () => ({
        kind: 'proposal',
        proposal,
      })),
    }),
  );
  assert.throws(() =>
    decodePlanQueryResult({
      ...page,
      items: [{ kind: 'proposal', proposal: { ...proposal, unknown: true } }],
    }),
  );
  assert.throws(() =>
    decodePlanQueryResult({
      ...page,
      items: [
        {
          kind: 'proposal',
          proposal: {
            ...proposal,
            steps: [{ ...proposal.steps[0], id: 'step one' }],
          },
        },
      ],
    }),
  );
  assert.throws(() =>
    decodeRequestFrame({
      requestId: 'request-2',
      operation: 'plan.control',
      input: {
        kind: 'resume_execution',
        sessionId: 'session-1',
        executionId: 'execution-1',
      },
    }),
  );
});
