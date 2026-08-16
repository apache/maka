import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentRunMatchesHostedRootExecution, type AgentRunHeader } from '../agent-run.js';

test('regenerate hosted root identity requires both source lineage fields', () => {
  const run: AgentRunHeader = {
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-2',
    status: 'completed',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/workspace',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
    parentTurnId: 'turn-1',
    regeneratedFromTurnId: 'turn-1',
  };

  assert.equal(
    agentRunMatchesHostedRootExecution(run, {
      kind: 'regenerate',
      sourceTurnId: 'turn-1',
    }),
    true,
  );
  assert.equal(
    agentRunMatchesHostedRootExecution(
      { ...run, regeneratedFromTurnId: 'turn-other' },
      { kind: 'regenerate', sourceTurnId: 'turn-1' },
    ),
    false,
  );
  assert.equal(
    agentRunMatchesHostedRootExecution(
      { ...run, scheduledTaskId: 'scheduled-task-1' },
      { kind: 'regenerate', sourceTurnId: 'turn-1' },
    ),
    false,
  );
});

test('context compact hosted root identity rejects message lineage', () => {
  const run: AgentRunHeader = {
    runId: 'run-compact',
    sessionId: 'session-1',
    turnId: 'turn-compact',
    status: 'completed',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/workspace',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
    rootExecutionKind: 'context_compact',
  };

  assert.equal(agentRunMatchesHostedRootExecution(run, { kind: 'context_compact' }), true);
  const { rootExecutionKind: _, ...ordinaryRun } = run;
  assert.equal(agentRunMatchesHostedRootExecution(ordinaryRun, { kind: 'context_compact' }), false);
  assert.equal(
    agentRunMatchesHostedRootExecution(
      { ...run, parentTurnId: 'turn-1' },
      { kind: 'context_compact' },
    ),
    false,
  );
});
