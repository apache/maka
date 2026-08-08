import assert from 'node:assert/strict';
import test from 'node:test';
import type { LlmConnection } from '@maka/core';
import { createDesktopTaskSubmissionReadinessService } from '../task-submission-readiness-main.js';

test('resolves defaults and projects authoritative model and workspace readiness', async () => {
  const service = createDesktopTaskSubmissionReadinessService({
    workspaceRoot: '/workspace',
    runtimeState: () => ({ state: 'ready', checkedAt: 90 }),
    listConnections: async () => [connection()],
    getDefaultSlug: async () => 'provider',
    hasCredential: async () => true,
    inspectWorkspace: async () => 'ready',
    now: () => 100,
  });

  const snapshot = await service.getSnapshot(undefined);
  assert.equal(snapshot.state, 'ready');
  assert.deepEqual(snapshot.dimensions.map(({ id }) => id), [
    'runtime',
    'model_target',
    'workspace',
  ]);
});

test('keeps credential lookup failure unknown instead of inventing a repair failure', async () => {
  const service = createDesktopTaskSubmissionReadinessService({
    workspaceRoot: '/workspace',
    runtimeState: () => ({ state: 'ready', checkedAt: 90 }),
    listConnections: async () => [connection()],
    getDefaultSlug: async () => 'provider',
    hasCredential: async () => { throw new Error('vault unavailable'); },
    inspectWorkspace: async () => 'ready',
    now: () => 100,
  });

  const snapshot = await service.getSnapshot({ model: 'model-a' });
  assert.equal(snapshot.state, 'unknown');
  assert.equal(snapshot.blockers[0]?.blockerCode, 'model_credentials_unknown');
});

test('reports a closed runtime and unavailable requested workspace', async () => {
  const service = createDesktopTaskSubmissionReadinessService({
    workspaceRoot: '/workspace',
    runtimeState: () => ({ state: 'unavailable', checkedAt: 90 }),
    listConnections: async () => [connection()],
    getDefaultSlug: async () => 'provider',
    hasCredential: async () => true,
    inspectWorkspace: async (cwd) => cwd === '/missing' ? 'unavailable' : 'ready',
    now: () => 100,
  });

  const snapshot = await service.getSnapshot({ cwd: '/missing' });
  assert.equal(snapshot.state, 'unavailable');
  assert.deepEqual(snapshot.blockers.map(({ blockerCode }) => blockerCode), [
    'runtime_unavailable',
    'workspace_unavailable',
  ]);
});

test('rejects malformed renderer input before reading stores', async () => {
  let reads = 0;
  const service = createDesktopTaskSubmissionReadinessService({
    workspaceRoot: '/workspace',
    runtimeState: () => ({ state: 'ready', checkedAt: 90 }),
    listConnections: async () => { reads += 1; return []; },
    getDefaultSlug: async () => null,
    hasCredential: async () => false,
  });

  await assert.rejects(service.getSnapshot({ cwd: '', extra: true }), /INVALID_TASK_READINESS_REQUEST/);
  assert.equal(reads, 0);
});

function connection(): LlmConnection {
  return {
    slug: 'provider',
    name: 'Provider',
    providerType: 'openai-compatible',
    enabled: true,
    defaultModel: 'model-a',
    enabledModelIds: ['model-a'],
    models: [{ id: 'model-a' }],
    createdAt: 1,
    updatedAt: 1,
  };
}
