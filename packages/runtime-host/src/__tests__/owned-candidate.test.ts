import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '../protocol/index.js';
import { connectOwnedRuntimeHostWithDependencies } from '../client/connect-or-spawn.js';
import { runHostedExecution } from '../client/hosted-execution.js';
import { launchOwnedRuntimeHostCandidate } from '../client/launcher.js';

test('owned connection keeps a fresh Host alive for its full election window', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-owned-first-connection-'));
  const result = await connectOwnedRuntimeHostWithDependencies(
    {
      rootPath,
      surface: 'run',
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      electionDeadlineMs: 6_000,
    },
    {
      launchCandidate(input) {
        const launch = launchOwnedRuntimeHostCandidate(input);
        return {
          spawned: Promise.all([
            launch.spawned,
            new Promise((resolve) => setTimeout(resolve, 3_000)),
          ]).then(([candidate]) => candidate),
        };
      },
    },
  );

  try {
    assert.equal(result.kind, 'connected');
  } finally {
    if (result.kind === 'connected') {
      await result.connection.close();
      await result.host.settle(3_000);
    }
  }
});

test('owned Host exits promptly after its first connection closes', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-owned-first-disconnect-'));
  const result = await connectOwnedRuntimeHostWithDependencies(
    {
      rootPath,
      surface: 'run',
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      electionDeadlineMs: 2_000,
    },
    { launchCandidate: launchOwnedRuntimeHostCandidate },
  );

  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') return;
  await result.connection.close();
  assert.equal(await result.host.settle(500), true);
});

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

test('owned candidate can be released to the enclosing environment without termination', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-owned-candidate-'));
  const launch = launchOwnedRuntimeHostCandidate({
    rootPath,
    expectedRootId: '00000000-0000-4000-8000-000000000001',
    entrypoint: new URL('./fixtures/owned-candidate-wait.js', import.meta.url),
  });
  const candidate = await launch.spawned;

  candidate.releaseToEnvironment();
  assert.doesNotThrow(() => process.kill(candidate.pid, 0));

  process.kill(candidate.pid, 'SIGTERM');
  assert.equal(await candidate.settle(2_000), false);
});

test('owned hosted execution closes its fresh Host after configuration fails', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-owned-hosted-execution-'));
  const result = await runHostedExecution({
    rootPath,
    execution: {
      executionId: '00000000-0000-4000-8000-000000000002',
      session: {
        workspace: { kind: 'host_path', path: rootPath },
        modelTarget: { kind: 'explicit', connectionSlug: 'missing', model: 'missing' },
      },
      content: { text: 'This request must not reach a provider.' },
    },
    baseUrl: 'http://127.0.0.1:1',
    hostSettlementTimeoutMs: 5_000,
  });

  assert.equal(result.kind, 'indeterminate');
});

test('pre-cancelled hosted execution does not start a Runtime Host', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-owned-hosted-execution-'));
  const abort = new AbortController();
  abort.abort();

  const result = await runHostedExecution({
    rootPath,
    execution: {
      executionId: '00000000-0000-4000-8000-000000000003',
      session: {
        workspace: { kind: 'host_path', path: rootPath },
        modelTarget: { kind: 'default' },
      },
      content: { text: 'This request must not start a Runtime Host.' },
    },
    signal: abort.signal,
  });

  assert.equal(result.kind, 'indeterminate');
  assert.deepEqual(await readdir(rootPath), []);
});
