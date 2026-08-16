import assert from 'node:assert/strict';
import test from 'node:test';
import { HostHostedExecutionCoordinator } from '../server/hosted-execution-coordinator.js';

test('cancel before start prevents the hosted execution from running', async () => {
  let runs = 0;
  const coordinator = new HostHostedExecutionCoordinator(
    async (input) => {
      runs += 1;
      return settled(input.executionId, 'completed');
    },
    () => {},
  );

  const cancelled = await coordinator.handlers['hosted.execution.cancel'](
    { executionId: ID },
    context(),
  );
  const started = await coordinator.handlers['hosted.execution.start'](input(), context());

  assert.equal(cancelled.ok, true);
  assert.equal(started.ok, true);
  if (started.ok) assert.equal(started.result.kind, 'indeterminate');
  assert.equal(runs, 0);
});

test('cancelling a settled subject reclaims its verification environment', async () => {
  let drains = 0;
  const coordinator = new HostHostedExecutionCoordinator(
    async (execution) => settled(execution.executionId, 'failed'),
    () => {
      drains += 1;
    },
  );
  await coordinator.handlers['hosted.execution.start'](input(), context());

  await coordinator.handlers['hosted.execution.cancel']({ executionId: ID }, context());

  assert.equal(drains, 1);
});

const ID = '00000000-0000-4000-8000-000000000001';

function settled(executionId: string, status: 'completed' | 'failed') {
  return {
    executionId,
    kind: 'settled' as const,
    status,
    ...(status === 'failed' ? { failureReason: 'subject failed' } : {}),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    costUsd: 0,
  };
}

function input() {
  return {
    executionId: ID,
    session: {
      workspace: { kind: 'host_path' as const, path: '/workspace' },
      modelTarget: { kind: 'explicit' as const, connectionSlug: 'env-openai', model: 'model' },
    },
    content: { text: 'solve' },
  };
}

function context() {
  return {
    hostEpoch: 'host-epoch',
    connectionId: 'hosted-execution',
    surface: 'run' as const,
    principal: 'runtime_host' as const,
    acquireResidency: () => ({ release() {} }),
  };
}
