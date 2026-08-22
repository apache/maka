/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '../protocol/index.js';
import {
  connectOrSpawnRuntimeHostWithDependencies,
  connectOwnedRuntimeHostWithDependencies,
} from '../client/connect-or-spawn.js';
import { runHostedExecution } from '../client/hosted-execution.js';
import { launchOwnedRuntimeHostCandidate, type OwnedCandidateAttempt } from '../client/launcher.js';

test('owned connection keeps a fresh Host alive for its full election window', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-owned-first-connection-'));
  const result = await connectOwnedRuntimeHostWithDependencies(
    {
      rootPath,
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

test('owned connect returns a missed election without waiting for a late candidate', {
  timeout: 15_000,
}, async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-owned-startup-timeout-'));
  let launched = 0;
  let released = 0;
  let settled = 0;
  let resolveSpawned!: (host: OwnedCandidateAttempt) => void;
  let rejectSpawned!: (error: Error) => void;
  let spawnedSettled = false;
  const spawned = new Promise<OwnedCandidateAttempt>((resolve, reject) => {
    resolveSpawned = resolve;
    rejectSpawned = reject;
  });
  void spawned.then(
    () => {
      spawnedSettled = true;
    },
    () => {
      spawnedSettled = true;
    },
  );

  try {
    const result = await connectOwnedRuntimeHostWithDependencies(
      {
        rootPath,
        protocol: {
          min: RUNTIME_HOST_PROTOCOL_VERSION,
          max: RUNTIME_HOST_PROTOCOL_VERSION,
        },
        compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
        electionDeadlineMs: 250,
      },
      {
        launchCandidate: () => {
          launched += 1;
          return { spawned };
        },
      },
    );

    assert.ok(launched >= 1, 'launchCandidate must run before the election ends');
    assert.equal(result.kind, 'failed');
    assert.equal(connectFailure(result), 'failed:startup_timeout');
    assert.equal(spawnedSettled, false);

    resolveSpawned({
      pid: 4_242,
      releaseToEnvironment() {
        released += 1;
      },
      async settle() {
        settled += 1;
        return true;
      },
    });
    await spawned;
    assert.equal(released, 1);
    assert.equal(settled, 0);
  } finally {
    if (!spawnedSettled) rejectSpawned(new Error('abandoned after election'));
  }
});

test('a late owned candidate stays alive after another client adopts it', {
  timeout: 25_000,
}, async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-owned-late-adopt-'));
  let launchedHost: OwnedCandidateAttempt | undefined;
  let resolveLate!: (host: OwnedCandidateAttempt) => void;
  let rejectLate!: (error: Error) => void;
  let lateDelivered = false;
  const lateSpawned = new Promise<OwnedCandidateAttempt>((resolve, reject) => {
    resolveLate = resolve;
    rejectLate = reject;
  });

  try {
    const missed = await connectOwnedRuntimeHostWithDependencies(
      {
        rootPath,
        protocol: {
          min: RUNTIME_HOST_PROTOCOL_VERSION,
          max: RUNTIME_HOST_PROTOCOL_VERSION,
        },
        compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
        electionDeadlineMs: 500,
      },
      {
        launchCandidate(input) {
          const launch = launchOwnedRuntimeHostCandidate({
            ...input,
            initialConnectionTimeoutMs: 10_000,
          });
          void launch.spawned.then((host) => {
            launchedHost = host;
          });
          return { spawned: lateSpawned };
        },
      },
    );

    assert.equal(missed.kind, 'failed');
    assert.equal(connectFailure(missed), 'failed:startup_timeout');

    const host = await waitForDefined(
      () => launchedHost,
      8_000,
      'late owned candidate did not spawn',
    );
    const adopted = await connectOrSpawnRuntimeHostWithDependencies(
      {
        rootPath,
        protocol: {
          min: RUNTIME_HOST_PROTOCOL_VERSION,
          max: RUNTIME_HOST_PROTOCOL_VERSION,
        },
        compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
        candidateEntrypoint: new URL('../execution-candidate-main.js', import.meta.url),
        electionDeadlineMs: 8_000,
      },
      {
        random: Math.random,
        launchCandidate() {
          throw new Error('adopter must use the late owned candidate');
        },
      },
    );

    try {
      assert.equal(adopted.kind, 'connected', connectFailure(adopted));
      if (adopted.kind !== 'connected') return;

      let released = 0;
      let settled = 0;
      lateDelivered = true;
      resolveLate({
        ...host,
        releaseToEnvironment() {
          released += 1;
          host.releaseToEnvironment();
        },
        async settle(timeoutMs) {
          settled += 1;
          return host.settle(timeoutMs);
        },
      });
      await lateSpawned;
      assert.equal(released, 1);
      assert.equal(settled, 0);

      const diagnostics = await adopted.connection.queryHostDiagnostics();
      assert.equal(diagnostics.pid, host.pid);
      assert.doesNotThrow(() => process.kill(host.pid, 0));
    } finally {
      if (adopted.kind === 'connected') await adopted.connection.close();
    }
  } finally {
    if (!lateDelivered) rejectLate(new Error('abandoned after election'));
    if (launchedHost) await launchedHost.settle(5_000);
  }
});

test('owned Host exits promptly after its first connection closes', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-owned-first-disconnect-'));
  const result = await connectOwnedRuntimeHostWithDependencies(
    {
      rootPath,
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      // Connection is not the promptness claim. Two seconds is enough on an
      // idle machine and too little under a full CI suite, where spawn plus
      // handshake routinely miss the window and surface as `failed`.
      electionDeadlineMs: 8_000,
    },
    { launchCandidate: launchOwnedRuntimeHostCandidate },
  );

  assert.equal(result.kind, 'connected', connectFailure(result));
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

function connectFailure(
  result:
    | Awaited<ReturnType<typeof connectOwnedRuntimeHostWithDependencies>>
    | Awaited<ReturnType<typeof connectOrSpawnRuntimeHostWithDependencies>>,
): string {
  if (result.kind === 'connected') return 'connected';
  if (result.kind === 'failed') return `failed:${result.reason}`;
  if (result.kind === 'upgrade_required') return 'upgrade_required';
  return `incompatible:${result.handshake.replacement}`;
}

async function waitForDefined<T>(
  read: () => T | undefined,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (performance.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}
