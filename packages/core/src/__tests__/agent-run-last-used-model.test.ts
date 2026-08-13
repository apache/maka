import assert from 'node:assert/strict';
import test from 'node:test';
import {
  latestStartedSessionInlineRun,
  modelChangeBetweenRuns,
  type AgentRunHeader,
} from '../agent-run.js';

test('selects the latest started inline run and ignores non-execution rows', () => {
  const latest = latestStartedSessionInlineRun([
    run('completed', 1, { modelId: 'model-a' }),
    run('created', 4, { runId: 'created-only', modelId: 'unused-model' }),
    run('completed', 5, {
      runId: 'compact',
      modelId: 'maintenance',
      rootExecutionKind: 'context_compact',
    }),
    run('failed', 3, { runId: 'failed-turn', modelId: 'model-b' }),
    run('completed', 6, { runId: 'child', modelId: 'child-model', parentRunId: 'parent' }),
  ]);

  assert.equal(latest?.runId, 'failed-turn');
  assert.equal(latest?.modelId, 'model-b');
});

test('projects a model change only when the admitted identity differs', () => {
  assert.equal(modelChangeBetweenRuns(run('failed', 1), run('created', 2)), undefined);
  assert.deepEqual(
    modelChangeBetweenRuns(
      run('failed', 1, { llmConnectionSlug: 'provider-a', modelId: 'model-a' }),
      run('created', 2, { llmConnectionSlug: 'provider-b', modelId: 'model-b' }),
    ),
    {
      from: { connectionSlug: 'provider-a', model: 'model-a' },
      to: { connectionSlug: 'provider-b', model: 'model-b' },
    },
  );
});

function run(
  status: AgentRunHeader['status'],
  createdAt: number,
  overrides: Partial<AgentRunHeader> = {},
): AgentRunHeader {
  return {
    runId: `run-${createdAt}`,
    sessionId: 'session-1',
    turnId: `turn-${createdAt}`,
    status,
    backendKind: 'fake',
    llmConnectionSlug: 'provider',
    modelId: 'model',
    cwd: '/workspace',
    permissionMode: 'ask',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}
