import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runHostedExecution } from '../client/hosted-execution.js';
import { launchOwnedRuntimeHostCandidate } from '../client/launcher.js';

test('owned candidate settlement requires a clean process exit', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-owned-candidate-'));
  const launch = launchOwnedRuntimeHostCandidate({
    rootPath,
    expectedRootId: '00000000-0000-4000-8000-000000000001',
    entrypoint: new URL('./fixtures/owned-candidate-exit.js', import.meta.url),
    env: { MAKA_TEST_EXIT_CODE: '1' },
  });

  const candidate = await launch.spawned;
  assert.equal(await candidate.settle(2_000), false);
});

test('owned hosted execution closes its fresh Host after configuration fails', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-owned-hosted-execution-'));
  const result = await runHostedExecution({
    rootPath,
    execution: {
      executionId: '00000000-0000-4000-8000-000000000002',
      session: {
        cwd: rootPath,
        modelTarget: { kind: 'explicit', connectionSlug: 'missing', model: 'missing' },
      },
      content: { text: 'This request must not reach a provider.' },
    },
    baseUrl: 'http://127.0.0.1:1',
    hostSettlementTimeoutMs: 5_000,
  });

  assert.equal(result.kind, 'indeterminate');
});
