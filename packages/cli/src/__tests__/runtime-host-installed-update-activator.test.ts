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
import test from 'node:test';
import { LocalHostDeploymentAuthorityError } from '@maka/runtime-host/operator';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type HostRegistration,
} from '@maka/runtime-host/protocol';
import {
  RuntimeHostDurableSettlementError,
  runRuntimeHostInstalledUpdateActivator,
  settleTargetFromDurableAuthority,
} from '../runtime-host-installed-update-activator.js';

const ROOT_ID = 'a'.repeat(64);

test('accepts Ready evidence only from the exact target generation and process', async () => {
  let closed = false;
  const exitCode = await runRuntimeHostInstalledUpdateActivator(
    {
      rootPath: '/state',
      expectedRootId: ROOT_ID,
      generation: 'target-generation',
      candidateEntrypoint: '/staged/candidate.js',
      takeoverHostEpoch: 'old-host',
    },
    {
      connectOrSpawn: async (input) => ({
        kind: 'connected',
        registration: registration({
          hostEpoch: 'target-host',
          pid: 84,
          generation: input.generation,
        }),
        spawnedProcess: { pid: 84, exited: new Promise(() => undefined) },
        connection: {
          close: async () => {
            closed = true;
          },
        } as never,
      }),
    },
  );
  assert.equal(exitCode, 0);
  assert.equal(closed, true);
});

test('reports active work and operator-owned lifecycle without forcing takeover', async () => {
  const active = await runRuntimeHostInstalledUpdateActivator(
    {
      rootPath: '/state',
      expectedRootId: ROOT_ID,
      generation: 'target-generation',
      candidateEntrypoint: '/staged/candidate.js',
      takeoverHostEpoch: 'old-host',
    },
    {
      connectOrSpawn: async () => ({
        kind: 'upgrade_required',
        registration: registration(),
        restartable: false,
      }),
    },
  );
  assert.equal(active, 3);

  const service = await runRuntimeHostInstalledUpdateActivator(
    {
      rootPath: '/state',
      expectedRootId: ROOT_ID,
      generation: 'target-generation',
      candidateEntrypoint: '/staged/candidate.js',
      takeoverHostEpoch: 'old-host',
    },
    {
      connectOrSpawn: async () => ({
        kind: 'upgrade_required',
        registration: registration({ lifecycleMode: 'service' }),
        restartable: false,
      }),
    },
  );
  assert.equal(service, 4);
});

test('keeps the short-lived activator through the coordinator durable-commit boundary', async () => {
  let closed = false;
  let observedExpectation:
    | {
        readonly expectedRootId: string;
        readonly ownerInstallationId: string;
        readonly targetVersion: string;
        readonly targetIntegrity: string;
      }
    | undefined;
  const exitCode = await runRuntimeHostInstalledUpdateActivator(
    {
      rootPath: '/state',
      expectedRootId: ROOT_ID,
      generation: 'target-generation',
      candidateEntrypoint: '/staged/candidate.js',
      awaitCoordinatorCommit: true,
      expectedOwnerInstallationId: 'npm-global:slot',
      targetVersion: '2.0.0',
      targetIntegrity: `sha512-${Buffer.alloc(64, 4).toString('base64')}`,
    },
    {
      connectOrSpawn: async () => ({
        kind: 'connected',
        registration: registration({ generation: 'target-generation', pid: 84 }),
        spawnedProcess: { pid: 84, exited: new Promise(() => undefined) },
        connection: { close: async () => (closed = true) } as never,
      }),
      awaitCoordinatorCommit: async (input) => {
        observedExpectation = {
          expectedRootId: input.expectedRootId,
          ownerInstallationId: input.ownerInstallationId,
          targetVersion: input.targetVersion,
          targetIntegrity: input.targetIntegrity,
        };
      },
    },
  );
  assert.equal(exitCode, 0);
  assert.equal(closed, true);
  assert.deepEqual(observedExpectation, {
    expectedRootId: ROOT_ID,
    ownerInstallationId: 'npm-global:slot',
    targetVersion: '2.0.0',
    targetIntegrity: `sha512-${Buffer.alloc(64, 4).toString('base64')}`,
  });
});

test('fails closed through the authenticated connection when its coordinator channel is absent', async () => {
  let retirement:
    | { readonly hostEpoch: string; readonly mode: 'refuse_active_work' | 'interrupt_active_work' }
    | undefined;
  await assert.rejects(
    runRuntimeHostInstalledUpdateActivator(
      {
        rootPath: '/state',
        expectedRootId: ROOT_ID,
        generation: 'target-generation',
        candidateEntrypoint: '/staged/candidate.js',
        awaitCoordinatorCommit: true,
        expectedOwnerInstallationId: 'npm-global:slot',
        targetVersion: '2.0.0',
        targetIntegrity: `sha512-${Buffer.alloc(64, 4).toString('base64')}`,
      },
      {
        connectOrSpawn: async () => ({
          kind: 'connected',
          registration: registration({ generation: 'target-generation', pid: 84 }),
          connection: {
            hostEpoch: 'target-host',
            close: async () => {},
          } as never,
        }),
        retireTarget: async (connection, mode) => {
          retirement = { hostEpoch: connection.hostEpoch, mode };
          return { kind: 'prepared', pid: 84 };
        },
        readRecord: async () => undefined,
      },
    ),
    /lost its coordinator before ownership committed/u,
  );
  assert.deepEqual(retirement, { hostEpoch: 'target-host', mode: 'interrupt_active_work' });
});

test('durable committed ownership releases the launch barrier after an ambiguous record read', async () => {
  const events: string[] = [];
  let reads = 0;
  const settlement = await settleTargetFromDurableAuthority(
    {
      connection: {} as never,
      expectedRootId: ROOT_ID,
      ownerInstallationId: 'npm-global:slot',
      targetVersion: '2.0.0',
      targetIntegrity: `sha512-${Buffer.alloc(64, 4).toString('base64')}`,
      ownsCandidate: true,
      launchBarrier: {
        connect: async () => assert.fail('settlement must not connect'),
        pause: () => events.push('pause'),
        retireExcept: async () => {
          events.push('retire');
        },
        resume: () => events.push('resume'),
        release: () => events.push('release'),
      },
      retireTarget: async () => assert.fail('an owned committed target must not retire'),
      readRecord: async () => {
        reads += 1;
        if (reads === 1) throw new Error('fsync confirmation unavailable');
        return {
          schemaVersion: 1,
          rootId: ROOT_ID,
          revision: '00000000-0000-4000-8000-000000000000',
          state: {
            kind: 'owned',
            owner: { kind: 'cli', installationId: 'npm-global:slot' },
            selected: {
              kind: 'npm_registry',
              version: '2.0.0',
              integrity: `sha512-${Buffer.alloc(64, 4).toString('base64')}`,
            },
          },
        };
      },
    },
    {
      retryRead: async () => {
        events.push('retry-read');
      },
    },
  );

  assert.equal(settlement, 'committed');
  assert.equal(reads, 2);
  assert.deepEqual(events, ['retry-read', 'release']);
});

test('permanent invalid durable ownership fails closed without retrying', async () => {
  let retries = 0;
  await assert.rejects(
    settleTargetFromDurableAuthority(
      {
        connection: {} as never,
        expectedRootId: ROOT_ID,
        ownerInstallationId: 'npm-global:slot',
        targetVersion: '2.0.0',
        targetIntegrity: `sha512-${Buffer.alloc(64, 4).toString('base64')}`,
        ownsCandidate: true,
        launchBarrier: {
          connect: async () => assert.fail('settlement must not connect'),
          pause: () => assert.fail('an unreadable record must not guess retirement'),
          retireExcept: async () => assert.fail('an unreadable record must not guess retirement'),
          resume: () => assert.fail('an unreadable record must not resume admission'),
          release: () => assert.fail('an unreadable record must not release admission'),
        },
        retireTarget: async () => assert.fail('an unreadable record must not guess retirement'),
        readRecord: async () => {
          throw new LocalHostDeploymentAuthorityError(
            'invalid_record',
            'The owner record is malformed',
          );
        },
      },
      {
        retryRead: async () => {
          retries += 1;
        },
      },
    ),
    (error: unknown) =>
      error instanceof RuntimeHostDurableSettlementError && error.code === 'invalid_record',
  );
  assert.equal(retries, 0);
});

test('persistent durable authority I/O fails closed after its bounded deadline', async () => {
  let now = 1_000;
  let reads = 0;
  const delays: number[] = [];
  await assert.rejects(
    settleTargetFromDurableAuthority(
      {
        connection: {} as never,
        expectedRootId: ROOT_ID,
        ownerInstallationId: 'npm-global:slot',
        targetVersion: '2.0.0',
        targetIntegrity: `sha512-${Buffer.alloc(64, 4).toString('base64')}`,
        ownsCandidate: true,
        launchBarrier: {
          connect: async () => assert.fail('settlement must not connect'),
          pause: () => assert.fail('an unreadable record must not guess retirement'),
          retireExcept: async () => assert.fail('an unreadable record must not guess retirement'),
          resume: () => assert.fail('an unreadable record must not resume admission'),
          release: () => assert.fail('an unreadable record must not release admission'),
        },
        retireTarget: async () => assert.fail('an unreadable record must not guess retirement'),
        readRecord: async () => {
          reads += 1;
          throw new LocalHostDeploymentAuthorityError(
            'authority_io_failed',
            'The owner record cannot be read',
          );
        },
      },
      {
        now: () => now,
        retryRead: async (delayMs) => {
          delays.push(delayMs);
          now += delayMs;
        },
        timeoutMs: 250,
      },
    ),
    (error: unknown) =>
      error instanceof RuntimeHostDurableSettlementError && error.code === 'authority_unavailable',
  );
  assert.equal(reads, 4);
  assert.deepEqual(delays, [100, 100, 50]);
});

test('a readable uncommitted handoff retires the guarded target', async () => {
  const events: string[] = [];
  const settlement = await settleTargetFromDurableAuthority({
    connection: {} as never,
    expectedRootId: ROOT_ID,
    ownerInstallationId: 'npm-global:slot',
    targetVersion: '2.0.0',
    targetIntegrity: `sha512-${Buffer.alloc(64, 4).toString('base64')}`,
    ownsCandidate: true,
    launchBarrier: {
      connect: async () => assert.fail('settlement must not connect'),
      pause: () => events.push('pause'),
      retireExcept: async () => {
        events.push('retire');
      },
      resume: () => events.push('resume'),
      release: () => events.push('release'),
    },
    retireTarget: async () => assert.fail('the launch barrier owns this candidate'),
    readRecord: async () => ({
      schemaVersion: 1,
      rootId: ROOT_ID,
      revision: '00000000-0000-4000-8000-000000000000',
      state: {
        kind: 'handoff',
        transactionId: 'transaction',
        from: { kind: 'cli', installationId: 'npm-global:slot' },
        to: { kind: 'cli', installationId: 'npm-global:slot' },
        selected: {
          kind: 'npm_registry',
          version: '1.0.0',
          integrity: `sha512-${Buffer.alloc(64, 3).toString('base64')}`,
        },
        target: {
          kind: 'npm_registry',
          version: '2.0.0',
          integrity: `sha512-${Buffer.alloc(64, 4).toString('base64')}`,
        },
      },
    }),
  });

  assert.equal(settlement, 'retired');
  assert.deepEqual(events, ['pause', 'retire']);
});

function registration(overrides: Partial<HostRegistration> = {}): HostRegistration {
  return {
    kind: 'maka-runtime-host',
    schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
    rootId: ROOT_ID,
    hostEpoch: 'old-host',
    endpoint: '/tmp/maka.sock',
    protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
    protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    compositionRevision: 'revision',
    lifecycleMode: 'ephemeral',
    state: 'ready',
    pid: 42,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}
