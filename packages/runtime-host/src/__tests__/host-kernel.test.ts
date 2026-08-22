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

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import { defineInteractiveRuntimeHostComposition } from '../server/host-composition.js';
import assert from 'node:assert/strict';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
  rm,
  unlink,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import {
  connectOrSpawnRuntimeHost,
  connectRuntimeHost,
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
  type RuntimeHostConnection,
} from '../client/index.js';
import { connectOrSpawnRuntimeHostWithDependencies } from '../client/connect-or-spawn.js';
import {
  launchDetachedRuntimeHostCandidate,
  type DetachedCandidateAttempt,
  type DetachedCandidateLaunch,
  type DetachedCandidateInput,
} from '../client/launcher.js';
import { readHostRegistration } from '../control/registration.js';
import {
  readCandidateStartupDiagnostic,
  writeCandidateStartupDiagnostic,
} from '../control/startup-diagnostic.js';
import { removePosixEndpointDirectories } from './fixtures/endpoint-hygiene.js';
import {
  decodeHostFrame,
  encodeProtocolMessage,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type ClientFrame,
} from '../protocol/index.js';
import {
  RuntimeHostKernel,
  RuntimeHostProcessTerminationRequiredError,
  type RuntimeHostComposition,
  type RuntimeHostCompositionContext,
  type RuntimeHostCompositionFactory,
  type RuntimeHostKernelOptions,
} from '../server/host-kernel.js';
import {
  startInteractiveRuntimeHostCandidate,
  type InteractiveRuntimeHostCandidateOptions,
  type InteractiveRuntimeHostCandidateResult,
} from '../server/candidate.js';
import type { RuntimeHostCompositionSource } from '../server/host-composition.js';
import { createUnavailableDomainOperationHandlers } from '../server/operation-dispatcher.js';
import { HostChangeFeed } from '../server/host-change-feed.js';
import { FramedTransport, RuntimeHostTransportError } from '../transport/framed-transport.js';
import {
  prepareStorageRootControlDirectory,
  resolveRootControlNamespace,
  resolveStorageRoot,
  STORAGE_ROOT_MARKER_FILE,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import { bindStateRootComposition } from '@maka/storage/state-root-composition';

const CURRENT_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
const LEGACY_PROTOCOL = { min: 1, max: 1 } as const;
const STARTUP_ATTEMPT_A = '00000000-0000-4000-8000-000000000001';
const STARTUP_ATTEMPT_B = '00000000-0000-4000-8000-000000000002';
const KERNEL_CANDIDATE_ENTRYPOINT = new URL('./fixtures/kernel-candidate.js', import.meta.url);
const KERNEL_COMPOSITION = defineInteractiveRuntimeHostComposition(async () => ({
  handlers: createUnavailableDomainOperationHandlers(),
  beginDrain() {},
  async recover() {},
  async close() {},
}));
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

type IsExact<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;
type AssertTrue<Value extends true> = Value;

export type RuntimeHostInteractiveRootTypeContract = [
  AssertTrue<IsExact<RuntimeHostCompositionContext['owner'], InteractiveRootOwner>>,
  AssertTrue<IsExact<RuntimeHostKernelOptions['owner'], InteractiveRootOwner>>,
];

// @ts-expect-error Runtime Host composition contexts are concretely interactive.
export type GenericRuntimeHostCompositionContext = RuntimeHostCompositionContext<'interactive'>;
// @ts-expect-error Runtime Host composition factories are concretely interactive.
export type GenericRuntimeHostCompositionFactory = RuntimeHostCompositionFactory<'interactive'>;
// @ts-expect-error Runtime Host composition sources are concretely interactive.
export type GenericRuntimeHostCompositionSource = RuntimeHostCompositionSource<'interactive'>;
// @ts-expect-error Runtime Host kernel options are concretely interactive.
export type GenericRuntimeHostKernelOptions = RuntimeHostKernelOptions<'interactive'>;

describe('non-serving Runtime Host kernel', () => {
  test('reports a recovery failure when the election produces no ready Host', async () => {
    await withHostPaths(async (paths) => {
      const result = await connectOrSpawnRuntimeHostWithDependencies(
        {
          rootPath: paths.root,
          protocol: CURRENT_PROTOCOL,
          compositionId: KERNEL_COMPOSITION.descriptor.id,
          candidateEntrypoint: KERNEL_CANDIDATE_ENTRYPOINT,
          electionDeadlineMs: 5_000,
        },
        {
          random: () => 0.5,
          launchCandidate: (input) =>
            launchTestRuntimeHostCandidate(paths, {
              ...input,
              env: {
                MAKA_TEST_STARTUP_ERROR_CODE: 'stored_session_message_incompatible',
              },
            }),
        },
      );

      assert.deepEqual(result, { kind: 'failed', reason: 'stored_data_incompatible' });
    });
  });

  test('reports an operational migration blocker as a permanent election failure', async () => {
    await withHostPaths(async (paths) => {
      let launches = 0;
      const result = await connectOrSpawnRuntimeHostWithDependencies(
        {
          rootPath: paths.root,
          protocol: CURRENT_PROTOCOL,
          compositionId: KERNEL_COMPOSITION.descriptor.id,
          candidateEntrypoint: KERNEL_CANDIDATE_ENTRYPOINT,
          electionDeadlineMs: 1_000,
        },
        {
          random: () => 0.5,
          launchCandidate: () => {
            launches += 1;
            return {
              spawned: Promise.resolve({
                pid: process.pid,
                startupFailure: Promise.resolve({
                  reason: 'operational_state_migration_blocked' as const,
                  startupAttemptId: STARTUP_ATTEMPT_A,
                }),
              }),
            };
          },
        },
      );

      assert.deepEqual(result, { kind: 'failed', reason: 'operational_state_migration_blocked' });
      assert.equal(launches, 1);
    });
  });

  test('treats a rejected Candidate report as unavailable election evidence', async () => {
    await withHostPaths(async (paths) => {
      const result = await connectOrSpawnRuntimeHostWithDependencies(
        {
          rootPath: paths.root,
          protocol: CURRENT_PROTOCOL,
          compositionId: KERNEL_COMPOSITION.descriptor.id,
          candidateEntrypoint: KERNEL_CANDIDATE_ENTRYPOINT,
          electionDeadlineMs: 100,
        },
        {
          random: () => 0.5,
          launchCandidate: () => ({
            spawned: Promise.resolve({
              pid: process.pid,
              startupFailure: Promise.reject(new Error('report failed')),
            }),
          }),
        },
      );

      assert.deepEqual(result, { kind: 'failed', reason: 'startup_timeout' });
    });
  });

  test('publishes the diagnostic from the Candidate failure selected by the election', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      let launches = 0;
      const result = await connectOrSpawnRuntimeHostWithDependencies(
        {
          rootPath: paths.root,
          protocol: CURRENT_PROTOCOL,
          compositionId: KERNEL_COMPOSITION.descriptor.id,
          candidateEntrypoint: KERNEL_CANDIDATE_ENTRYPOINT,
          electionDeadlineMs: 800,
        },
        {
          random: () => 0.5,
          launchCandidate: () => {
            launches += 1;
            if (launches > 2) return { spawned: new Promise(() => undefined) };
            const startupAttemptId = launches === 1 ? STARTUP_ATTEMPT_A : STARTUP_ATTEMPT_B;
            const reason =
              launches === 1
                ? ('local_ipc_security_failed' as const)
                : ('internal_startup_failure' as const);
            return {
              spawned: writeCandidateStartupDiagnostic({
                rootId: capability.rootId,
                startupAttemptId,
                failure: { reason },
                error: new Error(`Candidate ${launches} failed`),
              }).then(() => ({
                pid: process.pid,
                startupFailure: Promise.resolve({ reason, startupAttemptId }),
              })),
            };
          },
        },
      );

      assert.deepEqual(result, { kind: 'failed', reason: 'local_ipc_security_failed' });
      assert.equal(
        (await readCandidateStartupDiagnostic(capability.rootId))?.startupAttemptId,
        STARTUP_ATTEMPT_A,
      );
      assert.equal(
        await readCandidateStartupDiagnostic(capability.rootId, STARTUP_ATTEMPT_B),
        undefined,
      );
    });
  });

  test('accepts a ready successor launched before a migration blocker is observed', async () => {
    await withHostPaths(async (paths) => {
      let launches = 0;
      let reportBlocker:
        | ((failure: {
            reason: 'operational_state_migration_blocked';
            startupAttemptId: string;
          }) => void)
        | undefined;
      const result = await connectOrSpawnRuntimeHostWithDependencies(
        {
          rootPath: paths.root,
          protocol: CURRENT_PROTOCOL,
          compositionId: KERNEL_COMPOSITION.descriptor.id,
          candidateEntrypoint: KERNEL_CANDIDATE_ENTRYPOINT,
          electionDeadlineMs: 5_000,
        },
        {
          random: () => 0.5,
          launchCandidate: (input) => {
            launches += 1;
            if (launches === 1) {
              return {
                spawned: Promise.resolve({
                  pid: process.pid,
                  startupFailure: new Promise((resolve) => {
                    reportBlocker = resolve;
                  }),
                }),
              };
            }
            reportBlocker?.({
              reason: 'operational_state_migration_blocked',
              startupAttemptId: STARTUP_ATTEMPT_A,
            });
            return launchTestRuntimeHostCandidate(paths, {
              ...input,
            });
          },
        },
      );

      assert.equal(result.kind, 'connected');
      assert.ok(launches >= 2);
      if (result.kind === 'connected') await result.connection.close();
    });
  });

  test('rejects a bound composition mismatch without launching a Candidate', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      await bindStateRootComposition(owner.lease, 'maka.other');
      await owner.close();

      let launches = 0;
      const result = await connectOrSpawnRuntimeHostWithDependencies(
        {
          rootPath: paths.root,
          protocol: CURRENT_PROTOCOL,
          compositionId: KERNEL_COMPOSITION.descriptor.id,
          candidateEntrypoint: KERNEL_CANDIDATE_ENTRYPOINT,
          electionDeadlineMs: 100,
        },
        {
          random: () => 0.5,
          launchCandidate: () => {
            launches += 1;
            return { spawned: Promise.resolve({ pid: process.pid }) };
          },
        },
      );

      assert.deepEqual(result, {
        kind: 'failed',
        reason: 'composition_mismatch',
        requiredCompositionId: 'maka.other',
      });
      assert.equal(launches, 0);
    });
  });

  test('service lifecycle remains ready until explicitly closed', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      const host = await RuntimeHostKernel.start({
        owner,
        lifecycleMode: 'service',
        composition: KERNEL_COMPOSITION,
      });

      await sleep(25);
      assert.equal(host.state, 'ready');
      assert.equal(await tryAcquireInteractiveRootOwner(capability), undefined);

      const connected = await connectRuntimeHost({
        rootPath: paths.root,
        protocol: CURRENT_PROTOCOL,
        generation: 'desktop-current',
      });
      assert.equal(connected.kind, 'connected');
      if (connected.kind !== 'connected') return;
      assert.equal(connected.registration.lifecycleMode, 'service');
      await assert.rejects(
        connected.connection.request('host.upgrade.prepare', {
          expectedHostEpoch: connected.connection.hostEpoch,
          allowInterruptActiveTasks: false,
        }),
        (error: unknown) =>
          error instanceof RuntimeHostOperationError && error.code === 'operation_unavailable',
      );
      await connected.connection.close();

      const incompatible = await connectOrSpawnRuntimeHost({
        ...paths,
        rootPath: paths.root,
        protocol: LEGACY_PROTOCOL,
        compositionId: KERNEL_COMPOSITION.descriptor.id,
        candidateEntrypoint: KERNEL_CANDIDATE_ENTRYPOINT,
        electionDeadlineMs: 500,
      });
      assert.equal(incompatible.kind, 'incompatible');
      if (incompatible.kind === 'incompatible') {
        assert.equal(incompatible.handshake.replacement, 'blocked_by_residency');
      }

      await host.close();
      const successor = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(successor);
      await successor.close();
    });
  });

  test('elects one owner, serves status and diagnostics, and releases ownership after true-idle shutdown', async () => {
    await withHostPaths(async (paths) => {
      const winner = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 250,
      });
      assert.equal(winner.kind, 'winner');
      if (winner.kind !== 'winner') return;

      // Connect before the loser assertion: a resident connection cancels the
      // winner's idle timer, so the loser candidate's storage work cannot drain
      // the Host before this bounded connection attempt establishes residency.
      const connected = await retryConnect(paths, CURRENT_PROTOCOL);
      assert.equal(connected.kind, 'connected');
      if (connected.kind !== 'connected') return;

      assert.deepEqual(
        await startTestRuntimeHostCandidate(paths, {
          rootPath: paths.root,
        }),
        { kind: 'loser' },
      );
      const statuses = await Promise.all([
        connected.connection.status(),
        connected.connection.status(),
      ]);
      for (const status of statuses) {
        assert.equal(status.hostEpoch, winner.host.hostEpoch);
        assert.equal(status.state, 'ready');
        assert.equal(status.connections, 1);
      }
      const diagnostics = await connected.connection.queryHostDiagnostics();
      assert.equal(diagnostics.hostEpoch, winner.host.hostEpoch);
      assert.equal(diagnostics.state, 'ready');
      assert.equal(diagnostics.pid, process.pid);
      assert.equal(diagnostics.platform, process.platform);
      assert.equal(diagnostics.protocolVersion, RUNTIME_HOST_PROTOCOL_VERSION);
      assert.equal(diagnostics.compatibilityEpoch, RUNTIME_HOST_COMPATIBILITY_EPOCH);
      assert.ok(Array.isArray(diagnostics.logs));
      await connected.connection.close();
      await winner.host.closed;

      const next = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 0,
      });
      assert.equal(next.kind, 'winner');
      if (next.kind === 'winner') await next.host.closed;
    });
  });

  test('serves bootstrap operations during recovery and rejects ready-only operations', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      let releaseFactory = () => {};
      let markFactoryEntered!: () => void;
      const factoryEntered = new Promise<void>((resolve) => {
        markFactoryEntered = resolve;
      });
      const factoryReleased = new Promise<void>((resolve) => {
        releaseFactory = resolve;
      });
      const unavailable = async () =>
        ({
          ok: false,
          error: {
            code: 'operation_unavailable',
            message: 'not available in this composition',
          },
        }) as const;
      const hostTask = RuntimeHostKernel.start({
        owner,
        idleGraceMs: 10_000,
        composition: defineInteractiveRuntimeHostComposition(async () => {
          markFactoryEntered();
          await factoryReleased;
          return {
            handlers: {
              ...createUnavailableDomainOperationHandlers(),
              'turn.start': unavailable,
              'turn.query': unavailable,
              'turn.stop': unavailable,
              'turn.message.submit': unavailable,
              'queue.retract': unavailable,
              'turn.interrupt': unavailable,
              'interaction.query': unavailable,
              'interaction.answer': unavailable,
              'subscription.open': unavailable,
              'subscription.close': unavailable,
            },
            beginDrain() {},
            async recover() {},
            async close() {},
          };
        }),
      });
      let host: RuntimeHostKernel | undefined;
      let transport: FramedTransport | undefined;
      try {
        await withTimeout(factoryEntered, 1_000, 'Runtime Host did not enter composition');
        const registration = await readHostRegistration(owner.controlDirectory);
        assert.ok(registration);
        assert.equal(registration.state, 'recovering');
        transport = new FramedTransport(await openSocket(registration.endpoint));
        await writeClientFrame(transport, {
          kind: 'hello',
          clientInstanceId: 'lifecycle-test',
          protocolMin: CURRENT_PROTOCOL.min,
          protocolMax: CURRENT_PROTOCOL.max,
          compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
          compositionId: 'maka.interactive',
        });
        const handshake = decodeHostFrame(await transport.read(1_000));
        assert.ok('kind' in handshake && handshake.kind === 'accepted');

        await writeClientFrame(transport, {
          requestId: 'status',
          operation: 'host.status',
          input: {},
        });
        const status = decodeHostFrame(await transport.read(1_000));
        assert.ok(!('kind' in status) && status.operation === 'host.status' && status.ok);
        if (!('kind' in status) && status.operation === 'host.status' && status.ok) {
          assert.equal(status.result.state, 'recovering');
        }

        await writeClientFrame(transport, {
          requestId: 'query',
          operation: 'turn.query',
          input: { sessionId: 'session', turnId: 'turn' },
        });
        const query = decodeHostFrame(await transport.read(1_000));
        assert.ok(!('kind' in query) && query.operation === 'turn.query' && !query.ok);
        if (!('kind' in query) && query.operation === 'turn.query' && !query.ok) {
          assert.equal(query.error.code, 'host_not_ready');
        }
      } finally {
        releaseFactory();
        transport?.abort();
        host = await hostTask.catch(() => undefined);
        await host?.close().catch(() => undefined);
      }
    });
  });

  test('requestDrain synchronously begins composition drain exactly once', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      let context: RuntimeHostCompositionContext | undefined;
      let drainCalls = 0;
      const host = await RuntimeHostKernel.start({
        owner,
        idleGraceMs: 10_000,
        composition: defineInteractiveRuntimeHostComposition(async (value) => {
          context = value;
          return testComposition({
            beginDrain: () => {
              drainCalls += 1;
            },
          });
        }),
      });

      context?.requestDrain();
      assert.equal(drainCalls, 1);
      context?.requestDrain();
      assert.equal(drainCalls, 1);
      await host.closed;
    });
  });

  test('execution settlement can exclude environment resources without releasing Host ownership', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      let accounting!: ReturnType<RuntimeHostCompositionContext['acquireResidency']>;
      let environment!: ReturnType<RuntimeHostCompositionContext['acquireResidency']>;
      let settlement!: Promise<void>;
      const host = await RuntimeHostKernel.start({
        owner,
        idleGraceMs: 10_000,
        composition: defineInteractiveRuntimeHostComposition(async (context) => {
          accounting = context.acquireResidency('usage-accounting');
          environment = context.acquireResidency('runtime-resource');
          settlement = context.waitForResidenciesExcept!('runtime-resource');
          return testComposition();
        }),
      });

      let settled = false;
      void settlement.then(() => {
        settled = true;
      });
      await Promise.resolve();
      assert.equal(settled, false);
      accounting.release();
      await settlement;
      assert.equal(settled, true);

      environment.release();
      await host.close();
    });
  });

  test('local owner prepares an ephemeral Host upgrade against the exact Host Epoch', async () => {
    await withHostPaths(async (paths) => {
      let context: RuntimeHostCompositionContext | undefined;
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const host = await RuntimeHostKernel.start({
        owner,
        idleGraceMs: 10_000,
        composition: defineInteractiveRuntimeHostComposition(async (value) => {
          context = value;
          return testComposition();
        }),
      });
      const connected = await retryConnect(paths, CURRENT_PROTOCOL);
      assert.equal(connected.kind, 'connected');
      if (connected.kind !== 'connected') return;

      await assert.rejects(
        connected.connection.request('host.upgrade.prepare', {
          expectedHostEpoch: 'stale-host-epoch',
          allowInterruptActiveTasks: false,
        }),
        (error: unknown) =>
          error instanceof RuntimeHostOperationError && error.code === 'operation_conflict',
      );
      assert.equal(host.state, 'ready');

      const activity = context?.acquireResidency('hosted-execution');
      assert.ok(activity);
      assert.deepEqual(
        await connected.connection.request('host.upgrade.prepare', {
          expectedHostEpoch: host.hostEpoch,
          allowInterruptActiveTasks: false,
        }),
        { kind: 'active_tasks' },
      );
      assert.equal(host.state, 'ready');

      assert.deepEqual(
        await connected.connection.request('host.upgrade.prepare', {
          expectedHostEpoch: host.hostEpoch,
          allowInterruptActiveTasks: true,
        }),
        { kind: 'prepared', pid: process.pid },
      );
      activity?.release();
      await host.closed;
      const successor = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(successor);
      await successor?.close();
    });
  });

  test('an explicit generation takeover drains only the exact unobserved ephemeral Host', async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        generation: 'desktop-old',
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;

      const observer = await connectRuntimeHost({
        rootPath: paths.root,
        protocol: CURRENT_PROTOCOL,
      });
      assert.equal(observer.kind, 'connected');
      if (observer.kind !== 'connected') return;

      const blocked = await connectRuntimeHost({
        rootPath: paths.root,
        protocol: CURRENT_PROTOCOL,
        generation: 'desktop-new',
        takeoverHostEpoch: candidate.host.hostEpoch,
      });
      assert.equal(blocked.kind, 'upgrade_required');
      if (blocked.kind === 'upgrade_required') {
        assert.equal(blocked.restartable, false);
        assert.equal(blocked.registration.generation, 'desktop-old');
        assert.equal(blocked.handshake?.generation, 'desktop-old');
        assert.equal(blocked.handshake?.activity?.connections, 1);
      }
      assert.equal(candidate.host.state, 'ready');

      await observer.connection.close();
      const restartable = await connectRuntimeHost({
        rootPath: paths.root,
        protocol: CURRENT_PROTOCOL,
        generation: 'desktop-new',
      });
      assert.equal(restartable.kind, 'upgrade_required');
      if (restartable.kind === 'upgrade_required') {
        assert.equal(restartable.restartable, true);
      }
      const takeover = await connectRuntimeHost({
        rootPath: paths.root,
        protocol: CURRENT_PROTOCOL,
        generation: 'desktop-new',
        takeoverHostEpoch: candidate.host.hostEpoch,
      });
      assert.equal(takeover.kind, 'draining');
      await candidate.host.closed;

      const replacement = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        generation: 'desktop-new',
        idleGraceMs: 10_000,
      });
      assert.equal(replacement.kind, 'winner');
      if (replacement.kind !== 'winner') return;
      const attached = await connectRuntimeHost({
        rootPath: paths.root,
        protocol: CURRENT_PROTOCOL,
        generation: 'desktop-new',
      });
      assert.equal(attached.kind, 'connected');
      if (attached.kind === 'connected') {
        assert.equal((await attached.connection.status()).state, 'ready');
        await attached.connection.close();
      }
      await replacement.host.close();
    });
  });

  test('process-exit retention closes admission before requiring termination without releasing ownership', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      const host = await RuntimeHostKernel.start({
        owner,
        idleGraceMs: 10_000,
        shutdownGraceMs: 50,
        composition: defineInteractiveRuntimeHostComposition(async (context) => {
          context.retainUntilProcessExit();
          context.retainUntilProcessExit();
          context.requestDrain();
          return testComposition();
        }),
      });

      try {
        await assert.rejects(
          host.closed,
          (error: unknown) =>
            error instanceof RuntimeHostProcessTerminationRequiredError &&
            error.code === 'process_termination_required',
        );
        await assert.rejects(
          () => openSocket(host.endpoint),
          (error: unknown) =>
            error instanceof Error &&
            'code' in error &&
            ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
              (error as NodeJS.ErrnoException).code === 'ECONNREFUSED'),
        );
        assert.equal(await tryAcquireInteractiveRootOwner(capability), undefined);
      } finally {
        await owner.close();
      }
    });
  });

  test('never-connected ephemeral candidate drains after the initial connection timeout despite a boot residency', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      let releaseBootWork: (() => void) | undefined;
      const host = await RuntimeHostKernel.start({
        owner,
        initialConnectionTimeoutMs: 100,
        idleGraceMs: 10_000,
        composition: defineInteractiveRuntimeHostComposition(async (context) => {
          const residency = context.acquireResidency('boot-work');
          releaseBootWork = () => residency.release();
          return testComposition({
            beginDrain: () => releaseBootWork?.(),
          });
        }),
      });

      await withTimeout(
        host.closed,
        2_000,
        'ephemeral candidate outlived its initial connection timeout',
      );
      const successor = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(successor);
      await successor.close();
    });
  });

  test('never-connected ephemeral candidate with a hung composition startup fails stop at the deadlines', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      const hostTask = RuntimeHostKernel.start({
        owner,
        initialConnectionTimeoutMs: 100,
        idleGraceMs: 10_000,
        shutdownGraceMs: 100,
        composition: defineInteractiveRuntimeHostComposition(() => new Promise(() => {})),
      });

      try {
        const error = await withTimeout(
          hostTask.then(
            () => assert.fail('Runtime Host startup unexpectedly succeeded'),
            (startupError: unknown) => startupError,
          ),
          2_000,
          'hung composition startup was not bounded by the initial connection deadline',
        );
        assert.ok(error instanceof AggregateError);
        assert.ok(
          error.errors.some(
            (candidate: unknown) => candidate instanceof RuntimeHostProcessTerminationRequiredError,
          ),
        );
      } finally {
        await owner.close();
      }
    });
  });

  test('a silent handshake defers the never-connected drain instead of being drained under it', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      const host = await RuntimeHostKernel.start({
        owner,
        initialConnectionTimeoutMs: 500,
        idleGraceMs: 10_000,
        handshakeTimeoutMs: 2_000,
        composition: defineInteractiveRuntimeHostComposition(async () => testComposition()),
      });

      const silent = await openSocket(host.endpoint);
      try {
        // Past the initial connection timeout but inside the handshake
        // deferral window: the pending handshake must keep the Host alive.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        assert.equal(host.state, 'ready');
      } finally {
        silent.destroy();
      }
      // With the handshake gone, the deferred deadline drains the Host.
      await withTimeout(
        host.closed,
        5_000,
        'silently-handshaked ephemeral candidate never drained after the deferral',
      );
      const successor = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(successor);
      await successor.close();
    });
  });

  test('drain requested before factory completion begins drain before recovery exactly once', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      const lifecycle: string[] = [];
      let releaseFactory!: () => void;
      let markFactorySuspended!: () => void;
      const factorySuspended = new Promise<void>((resolve) => {
        markFactorySuspended = resolve;
      });
      const factoryReleased = new Promise<void>((resolve) => {
        releaseFactory = resolve;
      });
      let startSettled = false;
      const hostTask = RuntimeHostKernel.start({
        owner,
        idleGraceMs: 10_000,
        composition: defineInteractiveRuntimeHostComposition(async (context) => {
          context.requestDrain();
          markFactorySuspended();
          await factoryReleased;
          lifecycle.push('factory-return');
          return testComposition({
            beginDrain: () => lifecycle.push('begin-drain'),
            recover: async () => {
              lifecycle.push('recover');
            },
            close: async () => {
              lifecycle.push('close');
            },
          });
        }),
      });
      void hostTask.then(
        () => {
          startSettled = true;
        },
        () => {
          startSettled = true;
        },
      );

      await withTimeout(factorySuspended, 1_000, 'composition factory did not suspend');
      assert.equal(startSettled, false);
      assert.deepEqual(lifecycle, []);
      assert.equal(await tryAcquireInteractiveRootOwner(capability), undefined);

      releaseFactory();
      const host = await withTimeout(hostTask, 1_000, 'Runtime Host startup did not settle');
      await host.closed;
      assert.deepEqual(lifecycle, ['factory-return', 'begin-drain', 'recover', 'close']);
      assert.equal(lifecycle.filter((event) => event === 'begin-drain').length, 1);
    });
  });

  test('startup failure preserves its cause when shutdown reaches the active deadline', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      let releaseClose!: () => void;
      let markCloseEntered!: () => void;
      const closeEntered = new Promise<void>((resolve) => {
        markCloseEntered = resolve;
      });
      const closeReleased = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      const lifecycle: string[] = [];
      const hostTask = RuntimeHostKernel.start({
        owner,
        idleGraceMs: 10_000,
        shutdownGraceMs: 100,
        composition: defineInteractiveRuntimeHostComposition(async (context) => {
          context.requestDrain();
          return testComposition({
            beginDrain: () => lifecycle.push('begin-drain'),
            recover: async () => {
              lifecycle.push('recover');
              throw new Error('forced startup recovery failure');
            },
            close: async () => {
              lifecycle.push('close');
              markCloseEntered();
              await closeReleased;
            },
          });
        }),
      });
      const startupFailure = hostTask.then(
        () => assert.fail('Runtime Host startup unexpectedly succeeded'),
        (error: unknown) => error,
      );

      try {
        await withTimeout(closeEntered, 1_000, 'composition close did not begin');
        const error = await withTimeout(
          startupFailure,
          1_000,
          'Runtime Host startup ignored its shutdown deadline',
        );
        assert.ok(error instanceof AggregateError);
        assert.match(String(error.cause), /forced startup recovery failure/);
        assert.ok(
          error.errors.some(
            (candidate: unknown) => candidate instanceof RuntimeHostProcessTerminationRequiredError,
          ),
        );
        assert.deepEqual(lifecycle, ['begin-drain', 'recover', 'close']);
        assert.equal(await tryAcquireInteractiveRootOwner(capability), undefined);
      } finally {
        releaseClose();
        await owner.close();
      }
    });
  });

  test('blocks incompatible replacement while resident and permits it only after true idle', async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 500,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;
      const resident = await retryConnect(paths, CURRENT_PROTOCOL);
      assert.equal(resident.kind, 'connected');
      if (resident.kind !== 'connected') return;

      const staleWhileResident = new FramedTransport(await openSocket(candidate.host.endpoint));
      await writeRawLocalIpc(
        staleWhileResident,
        encodeLegacyProtocolFrame({
          kind: 'hello',
          clientInstanceId: 'stale-schema-resident',
          protocolMin: CURRENT_PROTOCOL.min,
          protocolMax: CURRENT_PROTOCOL.max,
          compatibilityEpoch: 20,
          compositionId: KERNEL_COMPOSITION.descriptor.id,
        }),
      );
      assert.deepEqual(decodeHostFrame(await staleWhileResident.read(1_000)), {
        kind: 'incompatible',
        hostEpoch: candidate.host.hostEpoch,
        protocolMin: CURRENT_PROTOCOL.min,
        protocolMax: CURRENT_PROTOCOL.max,
        compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
        compositionId: 'maka.interactive',
        compositionRevision: KERNEL_COMPOSITION.descriptor.revision,
        state: 'ready',
        replacement: 'blocked_by_residency',
      });
      staleWhileResident.abort();
      await staleWhileResident.closed;

      const blocked = await connectOrSpawnRuntimeHost({
        ...paths,
        rootPath: paths.root,
        protocol: LEGACY_PROTOCOL,
        compositionId: KERNEL_COMPOSITION.descriptor.id,
        candidateEntrypoint: KERNEL_CANDIDATE_ENTRYPOINT,
        electionDeadlineMs: 2_000,
      });
      assert.equal(blocked.kind, 'incompatible');
      if (blocked.kind === 'incompatible') {
        assert.equal(blocked.handshake.replacement, 'blocked_by_residency');
      }
      await resident.connection.close();

      const staleAtIdle = new FramedTransport(await openSocket(candidate.host.endpoint));
      await writeRawLocalIpc(
        staleAtIdle,
        encodeLegacyProtocolFrame({
          kind: 'hello',
          clientInstanceId: 'stale-schema-idle',
          protocolMin: CURRENT_PROTOCOL.min,
          protocolMax: CURRENT_PROTOCOL.max,
        }),
      );
      const staleIdleResponse = decodeHostFrame(await staleAtIdle.read(1_000));
      assert.ok('kind' in staleIdleResponse && staleIdleResponse.kind === 'incompatible');
      if ('kind' in staleIdleResponse && staleIdleResponse.kind === 'incompatible') {
        assert.equal(staleIdleResponse.replacement, 'wait_for_idle_exit');
      }
      staleAtIdle.abort();
      await staleAtIdle.closed;

      const replaceable = await Promise.all([
        connectRuntimeHost({
          ...paths,
          rootPath: paths.root,
          protocol: LEGACY_PROTOCOL,
        }),
        connectRuntimeHost({
          ...paths,
          rootPath: paths.root,
          protocol: LEGACY_PROTOCOL,
        }),
      ]);
      for (const result of replaceable) {
        assert.equal(result.kind, 'incompatible');
        if (result.kind === 'incompatible') {
          assert.equal(result.handshake.replacement, 'wait_for_idle_exit');
        }
      }
      await candidate.host.closed;
      const replacement = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(replacement.kind, 'winner');
      if (replacement.kind !== 'winner') return;
      assert.notEqual(replacement.host.hostEpoch, candidate.host.hostEpoch);
      const attached = await retryConnect(paths, CURRENT_PROTOCOL);
      assert.equal(attached.kind, 'connected');
      if (attached.kind !== 'connected') return;
      await attached.connection.close();
      await replacement.host.close();
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await retryOwner(capability, paths);
      assert.ok(owner);
      await owner?.close();
    });
  });

  test('two independent Clients with different cache environments attach to one cold-start Host', async () => {
    await withHostPaths(async (paths) => {
      const first = spawnConnectClient(paths, 'a');
      const second = spawnConnectClient(paths, 'b');
      const [firstConnected, secondConnected] = await Promise.all([
        waitForConnectedClient(first),
        waitForConnectedClient(second),
      ]);
      for (const pid of [...firstConnected.candidatePids, ...secondConnected.candidatePids]) {
        paths.resources.trackPid(pid);
      }
      assert.equal(firstConnected.hostEpoch, secondConnected.hostEpoch);
      first.send('close');
      second.send('close');
      await Promise.all([
        waitForSuccessfulExit(first, 'first connect Client'),
        waitForSuccessfulExit(second, 'second connect Client'),
      ]);

      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await retryOwner(capability, paths);
      assert.ok(owner);
      await owner?.close();
    });
  });

  test('Node and Electron Candidates arbitrate in both directions and force-kill releases ownership', async () => {
    const electronPath = require('electron') as string;
    const runtimes = [
      [{}, { executable: electronPath, env: { ELECTRON_RUN_AS_NODE: '1' } }],
      [{ executable: electronPath, env: { ELECTRON_RUN_AS_NODE: '1' } }, {}],
    ] as const;

    for (const [holderRuntime, contenderRuntime] of runtimes) {
      await withHostPaths(async (paths) => {
        let holderPid: number | undefined;
        let contenderPid: number | undefined;
        let successorPid: number | undefined;
        try {
          const holder = await spawnTestRuntimeHostCandidate(paths, {
            ...paths,
            ...holderRuntime,
            rootPath: paths.root,
            idleGraceMs: 10_000,
          });
          holderPid = holder.pid;
          const connected = await retryConnect(paths, CURRENT_PROTOCOL);
          assert.equal(connected.kind, 'connected');
          if (connected.kind !== 'connected') return;
          assert.equal(connected.registration.pid, holderPid);
          const previousEndpoint = connected.registration.endpoint;

          const contender = await spawnTestRuntimeHostCandidate(paths, {
            ...paths,
            ...contenderRuntime,
            rootPath: paths.root,
            idleGraceMs: 10_000,
          });
          contenderPid = contender.pid;
          await waitForProcessExit(contenderPid);
          paths.resources.forgetPid(contenderPid);
          contenderPid = undefined;
          const stillConnected = await connectRuntimeHost({
            ...paths,
            rootPath: paths.root,
            protocol: CURRENT_PROTOCOL,
          });
          assert.equal(stillConnected.kind, 'connected');
          if (stillConnected.kind !== 'connected') return;
          assert.equal(stillConnected.connection.hostEpoch, connected.connection.hostEpoch);
          await stillConnected.connection.close();

          const previousEpoch = connected.connection.hostEpoch;
          process.kill(holderPid, 'SIGKILL');
          await connected.connection.closed;
          await waitForProcessExit(holderPid);
          paths.resources.forgetPid(holderPid);
          holderPid = undefined;

          const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
          const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
          const staleRegistration = await readHostRegistration(controlDirectory);
          assert.equal(staleRegistration?.hostEpoch, previousEpoch);

          let staleLaunchAttempts = 0;
          const staleDiscovery = await connectOrSpawnRuntimeHostWithDependencies(
            {
              rootPath: paths.root,
              protocol: CURRENT_PROTOCOL,
              compositionId: KERNEL_COMPOSITION.descriptor.id,
              candidateEntrypoint: KERNEL_CANDIDATE_ENTRYPOINT,
              electionDeadlineMs: 100,
            },
            {
              random: () => 0.5,
              launchCandidate: () => {
                staleLaunchAttempts += 1;
                return { spawned: Promise.resolve({ pid: process.pid }) };
              },
            },
          );
          assert.deepEqual(staleDiscovery, { kind: 'failed', reason: 'startup_timeout' });
          assert.ok(staleLaunchAttempts > 0);

          const successor = await connectOrSpawnRuntimeHostWithDependencies(
            {
              rootPath: paths.root,
              protocol: CURRENT_PROTOCOL,
              compositionId: KERNEL_COMPOSITION.descriptor.id,
              candidateEntrypoint: KERNEL_CANDIDATE_ENTRYPOINT,
              electionDeadlineMs: 5_000,
            },
            {
              random: Math.random,
              launchCandidate: (input) => {
                const launch = launchTestRuntimeHostCandidate(paths, {
                  ...input,
                  ...contenderRuntime,
                  idleGraceMs: 200,
                });
                return {
                  spawned: launch.spawned.then((attempt) => {
                    successorPid = attempt.pid;
                    return attempt;
                  }),
                };
              },
            },
          );
          assert.equal(successor.kind, 'connected');
          if (successor.kind !== 'connected') return;
          assert.notEqual(successor.connection.hostEpoch, previousEpoch);
          if (process.platform !== 'win32') {
            await assertPathMissing(previousEndpoint);
            await assertPathMissing(dirname(previousEndpoint));
          }
          await successor.connection.close();

          const owner = await retryOwner(capability, paths);
          assert.ok(owner);
          await owner?.close();
          if (successorPid !== undefined) {
            await waitForProcessExit(successorPid);
            paths.resources.forgetPid(successorPid);
          }
          successorPid = undefined;
        } finally {
          terminateProcess(successorPid);
          terminateProcess(contenderPid);
          terminateProcess(holderPid);
        }
      });
    }
  });

  test('a detached Host survives the launcher process that created it', async () => {
    await withHostPaths(async (paths) => {
      const callerCwd = await mkdtemp(join(tmpdir(), 'maka-runtime-host-launcher-cwd-'));
      try {
        const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
        const launcher = paths.resources.trackChild(
          fork(
            new URL('./fixtures/detached-launcher.js', import.meta.url),
            [paths.root, capability.rootId],
            { cwd: callerCwd, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
          ),
        );
        const launchedPid = await waitForLaunch(launcher);
        paths.resources.trackPid(launchedPid);
        await waitForExit(launcher);

        // The detached Host must not retain a caller directory that may be a
        // package verifier, updater, or project-owned temporary workspace.
        await rm(callerCwd, { recursive: true, force: true });

        const connected = await retryConnect(paths, CURRENT_PROTOCOL);
        assert.equal(connected.kind, 'connected');
        if (connected.kind !== 'connected') return;
        assert.equal(connected.registration.pid, launchedPid);
        process.kill(launchedPid, 'SIGKILL');
        await connected.connection.closed;
        await waitForProcessExit(launchedPid);
        paths.resources.forgetPid(launchedPid);
      } finally {
        await rm(callerCwd, { recursive: true, force: true });
      }
    });
  });

  test('an Electron Client using the real Candidate launcher survives its parent process', async () => {
    const electronPath = require('electron') as string;
    await withHostPaths(async (paths) => {
      const parent = paths.resources.trackChild(
        fork(new URL('./fixtures/electron-connect-parent.js', import.meta.url), [paths.root], {
          execPath: electronPath,
          execArgv: [],
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        }),
      );
      const launched = await waitForElectronParentLaunch(parent, (pid) =>
        paths.resources.trackPid(pid),
      );
      await waitForSuccessfulExit(parent, 'Electron connect parent');
      assert.ok(launched.candidatePids.includes(launched.pid));
      for (const pid of launched.candidatePids) {
        if (pid === launched.pid) continue;
        await waitForProcessExit(pid);
        paths.resources.forgetPid(pid);
      }

      const connected = await retryConnect(paths, CURRENT_PROTOCOL);
      assert.equal(connected.kind, 'connected');
      if (connected.kind !== 'connected') return;
      assert.equal(connected.connection.hostEpoch, launched.hostEpoch);
      assert.equal(connected.registration.pid, launched.pid);

      process.kill(launched.pid, 'SIGKILL');
      await connected.connection.closed;
      await waitForProcessExit(launched.pid);
      paths.resources.forgetPid(launched.pid);
    });
  });

  test('Electron Candidate cleanup owns a launch reported before its parent fails', async () => {
    const electronPath = require('electron') as string;
    let candidatePid: number | undefined;
    await withHostPaths(async (paths) => {
      const parent = paths.resources.trackChild(
        fork(
          new URL('./fixtures/electron-connect-parent.js', import.meta.url),
          [paths.root, 'exit-after-candidate-launch'],
          {
            execPath: electronPath,
            execArgv: [],
            stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          },
        ),
      );
      await assert.rejects(
        waitForElectronParentLaunch(parent, (pid) => {
          candidatePid = paths.resources.trackPid(pid);
        }),
        /Electron connect parent exited before reporting its Host: 23/,
      );
      assert.ok(candidatePid);
    });
    assert.ok(candidatePid);
    assert.equal(isProcessAlive(candidatePid), false);
  });

  test('slow domain work preserves multiplexed requests and retires only explicit deadlines', async () => {
    await withHostPaths(async (paths) => {
      let releaseAdmitted!: () => void;
      const admittedGate = new Promise<void>((resolve) => {
        releaseAdmitted = resolve;
      });
      let markAdmitted!: () => void;
      const admittedEntered = new Promise<void>((resolve) => {
        markAdmitted = resolve;
      });
      let releaseLate!: () => void;
      const lateGate = new Promise<void>((resolve) => {
        releaseLate = resolve;
      });
      let markLate!: () => void;
      const lateEntered = new Promise<void>((resolve) => {
        markLate = resolve;
      });
      let markLateHandled!: () => void;
      const lateHandled = new Promise<void>((resolve) => {
        markLateHandled = resolve;
      });
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);
      if (!owner) return;
      const host = paths.resources.trackCloseable(
        await RuntimeHostKernel.start({
          owner,
          idleGraceMs: 10_000,
          composition: defineInteractiveRuntimeHostComposition(async () => ({
            ...testComposition(),
            handlers: {
              ...createUnavailableDomainOperationHandlers(),
              'memory.mutate': async () => {
                markAdmitted();
                await admittedGate;
                return {
                  ok: true,
                  result: { kind: 'rejected', reason: 'invalid_state' },
                };
              },
              'goal.query': async ({ sessionId }) => {
                if (sessionId === 'blocked-session') await admittedGate;
                if (sessionId === 'late-session') {
                  markLate();
                  await lateGate;
                  markLateHandled();
                }
                return { ok: true, result: { sessionId, goal: null } };
              },
            },
          })),
        }),
      );
      // Injected liveness cadence: the admitted request below must stay
      // pending across probe cycles measured in this unit, not the real 2s
      // one. The probe callback makes the premise a fact rather than an
      // assumption: if the injected cadence ever stopped taking effect, the
      // crossing below would time out instead of vacuously passing.
      const livenessIntervalMs = 100;
      let livenessProbes = 0;
      let markProbesCrossed!: () => void;
      const probeWindowCrossed = new Promise<void>((resolve) => {
        markProbesCrossed = resolve;
      });
      const connected = await retryConnect(paths, CURRENT_PROTOCOL, {
        livenessIntervalMs,
        onLivenessProbe: () => {
          livenessProbes += 1;
          if (livenessProbes >= 2) markProbesCrossed();
        },
      });
      assert.equal(connected.kind, 'connected');
      if (connected.kind !== 'connected') return;

      try {
        const admitted = connected.connection.request('memory.mutate', {
          kind: 'replace_begin',
          expectedRevision: `sha256:${'a'.repeat(64)}`,
          totalBytes: 0,
          contentSha256: `sha256:${'b'.repeat(64)}`,
        });
        await admittedEntered;
        const laneWaiter = connected.connection.request('goal.query', {
          sessionId: 'blocked-session',
        });
        assert.deepEqual(
          await withTimeout(
            connected.connection.request('goal.query', { sessionId: 'unrelated-session' }),
            500,
            'unrelated Runtime Host request waited behind admitted work',
          ),
          { sessionId: 'unrelated-session', goal: null },
        );

        // Hold the admitted request pending until two liveness probes have
        // observably round-tripped: surviving them proves probes never retire
        // a request that has no explicit deadline (#2392).
        await withTimeout(
          probeWindowCrossed,
          5_000,
          'liveness probes did not fire on the injected cadence',
        );
        releaseAdmitted();
        assert.deepEqual(await admitted, { kind: 'rejected', reason: 'invalid_state' });
        assert.deepEqual(await laneWaiter, { sessionId: 'blocked-session', goal: null });

        const locallyTimed = connected.connection.request(
          'goal.query',
          { sessionId: 'late-session' },
          50,
        );
        await lateEntered;
        await assert.rejects(
          locallyTimed,
          (error: unknown) =>
            error instanceof RuntimeHostRequestInterruptedError &&
            error.reason === 'timeout' &&
            error.retryable &&
            error.cause instanceof RuntimeHostTransportError &&
            error.cause.code === 'read_timeout',
        );
        assert.equal(
          (await connected.connection.status()).hostEpoch,
          connected.connection.hostEpoch,
        );
        releaseLate();
        await lateHandled;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(
          await connected.connection.request('goal.query', { sessionId: 'after-late-response' }),
          { sessionId: 'after-late-response', goal: null },
        );
      } finally {
        releaseAdmitted();
        releaseLate();
        await connected.connection.close();
        await host.close();
      }
    });
  });

  test('an automatic failed liveness check is connection-fatal and Client close stays local', {
    skip: process.platform === 'win32',
  }, async () => {
    await withHostPaths(async (paths) => {
      const attempt = await spawnTestRuntimeHostCandidate(paths, {
        ...paths,
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      let stopped = false;
      try {
        const connected = await retryConnect(paths, CURRENT_PROTOCOL);
        assert.equal(connected.kind, 'connected');
        if (connected.kind !== 'connected') return;

        process.kill(attempt.pid, 'SIGSTOP');
        stopped = true;
        await waitForProcessStopped(attempt.pid);
        const pending = connected.connection.request('goal.query', {
          sessionId: 'stopped-host-session',
        });
        await withTimeout(
          assert.rejects(
            pending,
            (error: unknown) =>
              error instanceof RuntimeHostRequestInterruptedError &&
              error.reason === 'connection_lost' &&
              error.retryable &&
              error.cause instanceof RuntimeHostTransportError &&
              error.cause.code === 'read_timeout' &&
              error.cause.message.includes('host.status'),
          ),
          5_000,
          'automatic Runtime Host liveness check did not reject pending work',
        );
        await withTimeout(
          connected.connection.closed,
          500,
          'timed-out Runtime Host connection did not close',
        );
        await withTimeout(
          connected.connection.close(),
          500,
          'closing an already failed connection did not settle',
        );

        process.kill(attempt.pid, 'SIGCONT');
        stopped = false;
        const reconnected = await retryConnect(paths, CURRENT_PROTOCOL);
        assert.equal(reconnected.kind, 'connected');
        if (reconnected.kind !== 'connected') return;
        assert.equal(
          (await reconnected.connection.status()).hostEpoch,
          connected.connection.hostEpoch,
        );

        process.kill(attempt.pid, 'SIGSTOP');
        stopped = true;
        await waitForProcessStopped(attempt.pid);
        await withTimeout(
          reconnected.connection.close(),
          500,
          'Client close waited for an unresponsive Host',
        );
      } finally {
        if (stopped) process.kill(attempt.pid, 'SIGCONT');
        terminateProcess(attempt.pid);
      }
    });
  });

  test('bounded election never steals a live owner with no endpoint', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);
      const result = await connectOrSpawnRuntimeHost({
        rootPath: paths.root,
        protocol: CURRENT_PROTOCOL,
        compositionId: KERNEL_COMPOSITION.descriptor.id,
        candidateEntrypoint: KERNEL_CANDIDATE_ENTRYPOINT,
        electionDeadlineMs: 100,
      });
      assert.deepEqual(result, { kind: 'failed', reason: 'startup_timeout' });
      assert.equal(await tryAcquireInteractiveRootOwner(capability), undefined);
      await owner?.close();
    });
  });

  test('rejects a structural owner copy before Host startup can use its lifecycle fields', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);
      assert.equal(Object.isFrozen(owner), true);

      const redirectedControlDirectory = join(paths.base, 'redirected-control');
      let copiedCloseCalled = false;
      const copiedOwner = {
        ...owner,
        controlDirectory: redirectedControlDirectory,
        close: async () => {
          copiedCloseCalled = true;
        },
      };

      await assert.rejects(
        () => RuntimeHostKernel.start({ owner: copiedOwner, composition: KERNEL_COMPOSITION }),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_owner',
      );
      assert.equal(copiedCloseCalled, false);
      await assertPathMissing(redirectedControlDirectory);
      assert.equal(await tryAcquireInteractiveRootOwner(capability), undefined);

      await owner.close();
      const nextOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(nextOwner);
      await nextOwner.close();
    });
  });

  test('releases an authentic owner when live validation fails before Host startup', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);

      const movedRoot = join(paths.base, 'moved-before-host-start');
      await rename(paths.root, movedRoot);
      await mkdir(paths.root);
      await assert.rejects(
        () => RuntimeHostKernel.start({ owner, composition: KERNEL_COMPOSITION }),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'root_identity_changed',
      );
      assert.equal(owner.closed, true);

      const movedCapability = await resolveStorageRoot({ path: movedRoot, kind: 'interactive' });
      assert.equal(movedCapability.rootId, capability.rootId);
      const nextOwner = await tryAcquireInteractiveRootOwner(movedCapability);
      assert.ok(nextOwner);
      await nextOwner.close();
    });
  });

  test('bounded election does not launch a Candidate after handshake exhausts the deadline', {
    skip: process.platform === 'win32',
  }, async () => {
    await withHostPaths(async (paths) => {
      const attempt = await spawnTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      let stopped = false;
      try {
        const connected = await retryConnect(paths, CURRENT_PROTOCOL);
        assert.equal(connected.kind, 'connected');
        if (connected.kind !== 'connected') return;
        await connected.connection.close();

        process.kill(attempt.pid, 'SIGSTOP');
        stopped = true;
        await waitForProcessStopped(attempt.pid);
        let launchCount = 0;
        const result = await withTimeout(
          connectOrSpawnRuntimeHostWithDependencies(
            {
              rootPath: paths.root,
              protocol: CURRENT_PROTOCOL,
              compositionId: KERNEL_COMPOSITION.descriptor.id,
              candidateEntrypoint: KERNEL_CANDIDATE_ENTRYPOINT,
              electionDeadlineMs: 50,
              handshakeTimeoutMs: 5_000,
            },
            {
              random: () => 0.5,
              launchCandidate: () => {
                launchCount += 1;
                return { spawned: Promise.resolve({ pid: process.pid }) };
              },
            },
          ),
          1_000,
          'election exceeded its total deadline',
        );
        assert.deepEqual(result, { kind: 'failed', reason: 'host_unresponsive' });
        assert.equal(launchCount, 0);
      } finally {
        if (stopped) process.kill(attempt.pid, 'SIGCONT');
        terminateProcess(attempt.pid);
      }
    });
  });

  test('answers an admitted bootstrap with draining after shutdown commits', async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;

      const socket = await openSocket(candidate.host.endpoint);
      const transport = new FramedTransport(socket);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const closing = candidate.host.close();
      await writeClientFrame(transport, {
        kind: 'hello',
        clientInstanceId: 'draining-client',
        protocolMin: CURRENT_PROTOCOL.min,
        protocolMax: CURRENT_PROTOCOL.max,
        compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
        compositionId: 'maka.interactive',
      });
      const response = decodeHostFrame(await transport.read(2_000));
      assert.deepEqual(response, {
        kind: 'draining',
        hostEpoch: candidate.host.hostEpoch,
        compositionId: 'maka.interactive',
        compositionRevision: KERNEL_COMPOSITION.descriptor.revision,
      });
      transport.abort();
      await transport.closed;
      await closing;
    });
  });

  test('rejects a previous-epoch Client before admitting ScheduledTask commands', async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;

      const transport = new FramedTransport(await openSocket(candidate.host.endpoint));
      try {
        await writeClientFrame(transport, {
          kind: 'hello',
          clientInstanceId: 'previous-epoch-client',
          protocolMin: CURRENT_PROTOCOL.min,
          protocolMax: CURRENT_PROTOCOL.max,
          compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH - 1,
          compositionId: 'maka.interactive',
        });
        const response = decodeHostFrame(await transport.read(2_000));
        assert.ok('kind' in response && response.kind === 'incompatible');
        if (!('kind' in response) || response.kind !== 'incompatible') return;
        assert.equal(response.compatibilityEpoch, RUNTIME_HOST_COMPATIBILITY_EPOCH);
        assert.equal(response.hostEpoch, candidate.host.hostEpoch);
        await transport.closed;
        await assert.rejects(
          () =>
            writeClientFrame(transport, {
              requestId: 'post-epoch-mismatch-scheduled-task-query',
              operation: 'scheduled-task.query',
              input: { kind: 'list' },
            }),
          (error: unknown) => error instanceof RuntimeHostTransportError && error.code === 'closed',
        );
      } finally {
        transport.abort();
      }
    });
  });

  test('accepts Client hellos with and without the legacy surface identity', async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;

      try {
        for (const hello of [
          {
            kind: 'hello',
            clientInstanceId: 'client-without-surface',
            protocolMin: CURRENT_PROTOCOL.min,
            protocolMax: CURRENT_PROTOCOL.max,
            compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
            compositionId: 'maka.interactive',
          },
          {
            kind: 'hello',
            clientInstanceId: 'legacy-client-with-surface',
            surface: 'tui',
            protocolMin: CURRENT_PROTOCOL.min,
            protocolMax: CURRENT_PROTOCOL.max,
            compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
            compositionId: 'maka.interactive',
          },
        ]) {
          const transport = new FramedTransport(await openSocket(candidate.host.endpoint));
          try {
            await writeRawLocalIpc(transport, encodeLegacyProtocolFrame(hello));
            const response = decodeHostFrame(await transport.read(2_000));
            assert.ok('kind' in response && response.kind === 'accepted');
          } finally {
            transport.abort();
          }
        }
      } finally {
        await candidate.host.close();
      }
    });
  });

  test('releases composition connection resources after admitted requests settle', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;

      let markHandlerEntered!: (connectionId: string) => void;
      const handlerEntered = new Promise<string>((resolve) => {
        markHandlerEntered = resolve;
      });
      let releaseHandler!: () => void;
      const handlerReleased = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      let markConnectionReleased!: (connectionId: string) => void;
      const connectionReleased = new Promise<string>((resolve) => {
        markConnectionReleased = resolve;
      });
      const releasedConnectionIds: string[] = [];
      const host = await RuntimeHostKernel.start({
        owner,
        idleGraceMs: 10_000,
        composition: defineInteractiveRuntimeHostComposition(async () => ({
          handlers: {
            ...createUnavailableDomainOperationHandlers(),
            'memory.mutate': async (_input, context) => {
              markHandlerEntered(context.connectionId);
              await handlerReleased;
              return {
                ok: true,
                result: { kind: 'rejected', reason: 'invalid_state' },
              };
            },
          },
          releaseConnection(connectionId) {
            releasedConnectionIds.push(connectionId);
            markConnectionReleased(connectionId);
          },
          beginDrain() {},
          async recover() {},
          async close() {},
        })),
      });
      const transport = new FramedTransport(await openSocket(host.endpoint));
      try {
        await writeClientFrame(transport, {
          kind: 'hello',
          clientInstanceId: 'composition-connection-release',
          protocolMin: CURRENT_PROTOCOL.min,
          protocolMax: CURRENT_PROTOCOL.max,
          compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
          compositionId: 'maka.interactive',
        });
        const handshake = decodeHostFrame(await transport.read(2_000));
        assert.ok('kind' in handshake && handshake.kind === 'accepted');
        if (!('kind' in handshake) || handshake.kind !== 'accepted') return;

        await writeClientFrame(transport, {
          requestId: 'blocked-memory-mutation',
          operation: 'memory.mutate',
          input: {
            kind: 'replace_begin',
            expectedRevision: `sha256:${'a'.repeat(64)}`,
            totalBytes: 0,
            contentSha256: `sha256:${'b'.repeat(64)}`,
          },
        });
        const admittedConnectionId = await handlerEntered;
        assert.equal(admittedConnectionId, handshake.connectionId);

        transport.abort();
        await transport.closed;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(releasedConnectionIds, []);

        releaseHandler();
        assert.equal(await connectionReleased, handshake.connectionId);
      } finally {
        releaseHandler();
        transport.abort();
        await host.close().catch(() => undefined);
      }
    });
  });

  test('delivers canonical authority changes to a Client admitted during recovery', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const hostChanges = new HostChangeFeed();
      let releaseFactory!: () => void;
      let markFactoryEntered!: () => void;
      const factoryEntered = new Promise<void>((resolve) => {
        markFactoryEntered = resolve;
      });
      const factoryReleased = new Promise<void>((resolve) => {
        releaseFactory = resolve;
      });
      const hostTask = RuntimeHostKernel.start({
        owner,
        idleGraceMs: 10_000,
        composition: defineInteractiveRuntimeHostComposition(async () => {
          markFactoryEntered();
          await factoryReleased;
          return {
            handlers: createUnavailableDomainOperationHandlers(),
            hostChanges,
            beginDrain() {},
            async recover() {},
            async close() {},
          };
        }),
      });
      let host: RuntimeHostKernel | undefined;
      let connection: RuntimeHostConnection | undefined;
      try {
        await withTimeout(factoryEntered, 1_000, 'Runtime Host did not enter composition');
        const connected = await connectRuntimeHost({
          rootPath: paths.root,
          protocol: CURRENT_PROTOCOL,
        });
        assert.equal(connected.kind, 'connected');
        if (connected.kind !== 'connected') return;
        const activeConnection = connected.connection;
        connection = activeConnection;
        const observed = new Promise<number>((resolve) => {
          activeConnection.subscribeConfigurationChanges(resolve);
        });
        const observedCatalog = new Promise<string>((resolve) => {
          activeConnection.subscribeSessionCatalogChanges(({ sessionId }) => resolve(sessionId));
        });
        releaseFactory();
        host = await hostTask;
        hostChanges.publishConfiguration();
        hostChanges.publishSessionCatalog('session-1');
        assert.equal(
          await withTimeout(observed, 1_000, 'Client did not receive configuration change'),
          1,
        );
        assert.equal(
          await withTimeout(
            observedCatalog,
            1_000,
            'Client did not receive Session catalog change',
          ),
          'session-1',
        );
      } finally {
        releaseFactory();
        await connection?.close();
        host ??= await hostTask.catch(() => undefined);
        await host?.close().catch(() => undefined);
      }
    });
  });

  test('shutdown releases ownership after bounded handling of accepted and incomplete Clients', async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;

      const transport = new FramedTransport(await openHalfOpenSocket(candidate.host.endpoint));
      const incompleteSocket = await openHalfOpenSocket(candidate.host.endpoint);
      try {
        await writeClientFrame(transport, {
          kind: 'hello',
          clientInstanceId: 'half-open-client',
          protocolMin: CURRENT_PROTOCOL.min,
          protocolMax: CURRENT_PROTOCOL.max,
          compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
          compositionId: 'maka.interactive',
        });
        const handshake = decodeHostFrame(await transport.read(2_000));
        assert.ok('kind' in handshake);
        assert.equal(handshake.kind, 'accepted');
        incompleteSocket.write('{"kind":"hello"');
        await new Promise<void>((resolve) => setImmediate(resolve));

        await withTimeout(
          candidate.host.close(),
          2_000,
          'Host shutdown did not bound incomplete Clients',
        );
        const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
        const owner = await retryOwner(capability, paths);
        assert.ok(owner);
        await owner?.close();
      } finally {
        transport.abort();
        incompleteSocket.destroy();
      }
    });
  });

  test('a non-reading Client overload is isolated to its connection', {
    skip: process.platform === 'win32',
  }, async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;

      const nonReadingSocket = await openNonReadingStatusSocket(candidate.host.endpoint);
      const observer = await connectRuntimeHost({
        ...paths,
        rootPath: paths.root,
        protocol: CURRENT_PROTOCOL,
      });
      assert.equal(observer.kind, 'connected');
      if (observer.kind !== 'connected') return;
      try {
        const nonReadingClosed = new Promise<void>((resolve) => {
          nonReadingSocket.once('close', () => resolve());
        });
        for (let index = 0; index < 10_000 && !nonReadingSocket.destroyed; index += 8) {
          const batch = Array.from({ length: 8 }, (_, offset) =>
            JSON.stringify({
              requestId: `non-reading-${index + offset}`,
              operation: 'host.status',
              input: {},
            }),
          ).join('\n');
          nonReadingSocket.write(`${batch}\n`);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        await withTimeout(
          nonReadingClosed,
          2_000,
          'Runtime Host did not evict the overloaded non-reading Client',
        );
        assert.equal((await observer.connection.status(2_000)).state, 'ready');

        await observer.connection.close();
        await withTimeout(
          candidate.host.close(),
          2_500,
          'Host shutdown remained blocked after eviction',
        );
        const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
        const owner = await retryOwner(capability, paths);
        assert.ok(owner);
        await owner?.close();
      } finally {
        nonReadingSocket.destroy();
        await observer.connection.close();
      }
    });
  });

  test('reports one shutdown failure through close and closed while releasing ownership', {
    skip: process.platform === 'win32',
  }, async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;

      await unlink(candidate.host.endpoint);
      await mkdir(candidate.host.endpoint);
      await Promise.all([
        assert.rejects(candidate.host.close(), AggregateError),
        assert.rejects(candidate.host.closed, AggregateError),
      ]);

      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await retryOwner(capability, paths);
      assert.ok(owner);
      await owner?.close();
    });
  });

  test('forces an uncooperative command Host to exit before a successor acquires ownership', {
    timeout: 10_000,
  }, async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const child = paths.resources.trackChild(
        fork(
          new URL('./fixtures/uncooperative-host.js', import.meta.url),
          [paths.root, capability.rootId, '2000'],
          { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
        ),
      );
      let transport: FramedTransport | undefined;
      try {
        const ready = await waitForUncooperativeHostMessage(child, 'ready');
        transport = new FramedTransport(await openSocket(ready.endpoint));
        await writeClientFrame(transport, {
          kind: 'hello',
          clientInstanceId: 'bounded-shutdown-test',
          protocolMin: CURRENT_PROTOCOL.min,
          protocolMax: CURRENT_PROTOCOL.max,
          compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
          compositionId: 'maka.interactive',
        });
        const handshake = decodeHostFrame(await transport.read(2_000));
        assert.ok('kind' in handshake);
        assert.equal(handshake.kind, 'accepted');

        const blocked = waitForUncooperativeHostMessage(child, 'operation-blocked');
        await writeClientFrame(transport, {
          requestId: 'blocked-turn-start',
          operation: 'turn.start',
          input: {
            sessionId: 'session',
            turnId: 'turn',
            content: { text: 'block forever' },
          },
        });
        await blocked;
        const shutdownRequested = waitForUncooperativeHostMessage(child, 'shutdown-requested');
        child.send({ type: 'shutdown' });
        await shutdownRequested;

        await writeClientFrame(transport, {
          requestId: 'post-drain-status',
          operation: 'host.status',
          input: {},
        });
        const rejectedOperation = decodeHostFrame(await transport.read(1_000));
        assert.ok(!('kind' in rejectedOperation));
        if (!('kind' in rejectedOperation)) {
          assert.equal(rejectedOperation.requestId, 'post-drain-status');
          assert.equal(rejectedOperation.operation, 'host.status');
          assert.equal(rejectedOperation.ok, false);
          if (!rejectedOperation.ok) assert.equal(rejectedOperation.error.code, 'host_draining');
        }

        const rejectedHandshakeTransport = new FramedTransport(await openSocket(ready.endpoint));
        try {
          await writeClientFrame(rejectedHandshakeTransport, {
            kind: 'hello',
            clientInstanceId: 'post-drain-client',
            protocolMin: CURRENT_PROTOCOL.min,
            protocolMax: CURRENT_PROTOCOL.max,
            compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
            compositionId: 'maka.interactive',
          });
          assert.deepEqual(decodeHostFrame(await rejectedHandshakeTransport.read(1_000)), {
            kind: 'draining',
            hostEpoch: ready.hostEpoch,
            compositionId: 'maka.interactive',
            compositionRevision: KERNEL_COMPOSITION.descriptor.revision,
          });
        } finally {
          rejectedHandshakeTransport.abort();
        }

        assert.equal(child.exitCode, null);
        assert.equal(child.signalCode, null);
        const contender = await tryAcquireInteractiveRootOwner(capability);
        try {
          assert.equal(contender, undefined);
        } finally {
          await contender?.close();
        }
        const exit = await withTimeout(
          waitForChildExitResult(child),
          5_000,
          'uncooperative Runtime Host did not exit within its shutdown bound',
        );
        assert.deepEqual(exit, { code: 1, signal: null });

        const successor = await startTestRuntimeHostCandidate(paths, {
          rootPath: paths.root,
          idleGraceMs: 10_000,
        });
        assert.equal(successor.kind, 'winner');
        if (successor.kind !== 'winner') return;
        assert.notEqual(successor.host.hostEpoch, ready.hostEpoch);
        const connected = await retryConnect(paths, CURRENT_PROTOCOL);
        assert.equal(connected.kind, 'connected');
        if (connected.kind !== 'connected') return;
        const status = await connected.connection.status();
        assert.equal(status.hostEpoch, successor.host.hostEpoch);
        await connected.connection.close();
        await successor.host.close();
      } finally {
        transport?.abort();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await withTimeout(waitForExit(child), 1_000, 'uncooperative Host cleanup did not exit');
      }
    });
  });

  test('startup rejects invalid lifecycle durations and releases the owner lock', async () => {
    await withHostPaths(async (paths) => {
      await assert.rejects(
        () =>
          startTestRuntimeHostCandidate(paths, {
            rootPath: paths.root,
            initialConnectionTimeoutMs: -1,
          }),
        RangeError,
      );
      await assert.rejects(
        () =>
          startTestRuntimeHostCandidate(paths, {
            rootPath: paths.root,
            idleGraceMs: -1,
          }),
        RangeError,
      );
      await assert.rejects(
        () =>
          startTestRuntimeHostCandidate(paths, {
            rootPath: paths.root,
            handshakeTimeoutMs: 0,
          }),
        RangeError,
      );
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);
      if (!owner) return;
      await assert.rejects(
        () =>
          RuntimeHostKernel.start({
            owner,
            shutdownGraceMs: 0,
            composition: KERNEL_COMPOSITION,
          }),
        RangeError,
      );
      const retry = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 0,
      });
      assert.equal(retry.kind, 'winner');
      if (retry.kind === 'winner') await retry.host.closed;
    });
  });

  test('rejects invalid Client configuration before root mutation or Host classification', async () => {
    await withHostPaths(async (paths) => {
      await assert.rejects(
        () =>
          connectRuntimeHost({
            rootPath: paths.root,
            protocol: CURRENT_PROTOCOL,
            connectTimeoutMs: 0,
          }),
        RangeError,
      );
      await assert.rejects(
        () =>
          connectRuntimeHost({
            rootPath: paths.root,
            protocol: CURRENT_PROTOCOL,
            handshakeTimeoutMs: 0,
          }),
        RangeError,
      );
      await assert.rejects(
        () =>
          connectRuntimeHost({
            rootPath: paths.root,
            protocol: CURRENT_PROTOCOL,
            clientInstanceId: '',
          }),
        RuntimeHostProtocolError,
      );
      await assert.rejects(
        () =>
          connectOrSpawnRuntimeHost({
            rootPath: paths.root,
            protocol: CURRENT_PROTOCOL,
            compositionId: 'Invalid Composition',
            candidateEntrypoint: KERNEL_CANDIDATE_ENTRYPOINT,
          }),
        RuntimeHostProtocolError,
      );
      await assertPathMissing(paths.root);

      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;
      await assert.rejects(
        () =>
          connectOrSpawnRuntimeHost({
            rootPath: paths.root,
            protocol: CURRENT_PROTOCOL,
            compositionId: KERNEL_COMPOSITION.descriptor.id,
            candidateEntrypoint: KERNEL_CANDIDATE_ENTRYPOINT,
            clientInstanceId: 'x'.repeat(129),
            electionDeadlineMs: 100,
          }),
        RuntimeHostProtocolError,
      );
      assert.equal(candidate.host.state, 'ready');
      await candidate.host.close();
    });
  });

  test('detached launcher reports an executable spawn failure to its caller', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      await assert.rejects(
        () =>
          launchDetachedRuntimeHostCandidate({
            rootPath: paths.root,
            expectedRootId: capability.rootId,
            executable: join(paths.root, 'missing-node'),
            entrypoint: KERNEL_CANDIDATE_ENTRYPOINT,
          }).spawned,
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          (error as NodeJS.ErrnoException).code === 'ENOENT',
      );
    });
  });

  test('Candidate refuses a replacement root without initializing or owning it', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      await rename(paths.root, join(paths.base, 'original-root'));
      await mkdir(paths.root);

      const attempt = await spawnTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        expectedRootId: capability.rootId,
        idleGraceMs: 10_000,
      });
      await waitForProcessExit(attempt.pid, 2_000);
      paths.resources.forgetPid(attempt.pid);
      await assertPathMissing(join(paths.root, STORAGE_ROOT_MARKER_FILE));

      const replacement = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      assert.notEqual(replacement.rootId, capability.rootId);
      const owner = await tryAcquireInteractiveRootOwner(replacement);
      assert.ok(owner);
      await owner?.close();
    });
  });

  test('invalid registration fails closed without following its endpoint', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
      await writeFile(
        join(controlDirectory, 'registration.json'),
        '{"endpoint":"/tmp/not-authority"}\n',
        {
          mode: 0o600,
        },
      );
      const result = await connectRuntimeHost({
        ...paths,
        rootPath: paths.root,
        protocol: CURRENT_PROTOCOL,
      });
      assert.deepEqual(result, { kind: 'unavailable', reason: 'invalid_registration' });
    });
  });

  test('malformed and oversized bootstrap frames close only the offending connection', async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;

      await sendInvalidBootstrap(candidate.host.endpoint, Buffer.from('not-json\n'));
      await sendInvalidBootstrap(
        candidate.host.endpoint,
        Buffer.alloc(RUNTIME_HOST_MAX_MESSAGE_BYTES + 1, 0x61),
      );

      const connected = await retryConnect(paths, CURRENT_PROTOCOL);
      assert.equal(connected.kind, 'connected');
      if (connected.kind !== 'connected') return;
      assert.equal((await connected.connection.status()).state, 'ready');
      await connected.connection.close();
      await candidate.host.close();
    });
  });

  test('drains after the live storage root identity disappears and releases the moved root', async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;
      const connected = await retryConnect(paths, CURRENT_PROTOCOL);
      assert.equal(connected.kind, 'connected');
      if (connected.kind !== 'connected') return;

      const movedRoot = join(paths.base, 'moved-root');
      await rename(paths.root, movedRoot);
      await assert.rejects(() => connected.connection.status());
      await candidate.host.closed;
      assert.equal(candidate.host.state, 'draining');

      const replacement = await startTestRuntimeHostCandidate(paths, {
        rootPath: movedRoot,
        idleGraceMs: 10_000,
      });
      assert.equal(replacement.kind, 'winner');
      if (replacement.kind === 'winner') await replacement.host.close();
    });
  });

  test('publishes private POSIX endpoint and registration permissions', {
    skip: process.platform === 'win32',
  }, async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
      const registration = await readHostRegistration(controlDirectory);
      assert.ok(registration);
      assert.equal((await stat(registration.endpoint)).mode & 0o077, 0);
      assert.equal((await stat(dirname(registration.endpoint))).mode & 0o077, 0);
      assert.equal((await stat(join(controlDirectory, 'registration.json'))).mode & 0o077, 0);
      await candidate.host.close();
    });
  });
});

function testComposition(
  overrides: Partial<Pick<RuntimeHostComposition, 'beginDrain' | 'recover' | 'close'>> = {},
): RuntimeHostComposition {
  return {
    handlers: createUnavailableDomainOperationHandlers(),
    beginDrain() {},
    async recover() {},
    async close() {},
    ...overrides,
  };
}

interface HostPaths {
  base: string;
  root: string;
  resources: HostTestResources;
}

interface CloseableTestResource {
  close(): Promise<void>;
}

class HostTestResources {
  readonly #closeables = new Set<CloseableTestResource>();
  readonly #children = new Set<ChildProcess>();
  readonly #pids = new Set<number>();

  trackCloseable<T extends CloseableTestResource | undefined>(resource: T): T {
    if (resource) this.#closeables.add(resource);
    return resource;
  }

  trackChild<T extends ChildProcess>(child: T): T {
    this.#children.add(child);
    return child;
  }

  trackPid(pid: number): number {
    this.#pids.add(pid);
    return pid;
  }

  forgetPid(pid: number): void {
    this.#pids.delete(pid);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#closeables].reverse().map((resource) => resource.close()));
    for (const child of this.#children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = waitForExit(child);
      child.kill('SIGKILL');
      await withTimeout(exited, 1_000, 'test launcher did not exit during cleanup').catch(
        () => undefined,
      );
    }
    for (const pid of this.#pids) {
      if (!isProcessAlive(pid)) continue;
      terminateProcess(pid);
      await waitForProcessExit(pid, 1_000).catch(() => undefined);
    }
  }
}

async function withHostPaths(run: (paths: HostPaths) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-'));
  const resources = new HostTestResources();
  const paths = {
    base,
    root: join(base, 'root'),
    resources,
  };
  try {
    await run(paths);
  } finally {
    await resources.close();
    await removeControlDirectoriesForRootsUnder(base);
    await chmod(base, 0o700).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

function spawnConnectClient(paths: HostPaths, environmentSuffix: string): ChildProcess {
  const fakeHome = join(paths.base, `fake-home-${environmentSuffix}`);
  return paths.resources.trackChild(
    fork(new URL('./fixtures/connect-client.js', import.meta.url), [paths.root], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: {
        ...process.env,
        HOME: fakeHome,
        XDG_CACHE_HOME: join(fakeHome, 'cache'),
        XDG_RUNTIME_DIR: join(fakeHome, 'runtime'),
        LOCALAPPDATA: join(fakeHome, 'local-app-data'),
      },
    }),
  );
}

function waitForConnectedClient(
  child: ChildProcess,
): Promise<{ hostEpoch: string; candidatePids: number[] }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('connect Client did not report readiness'));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`connect Client exited before readiness: ${code ?? signal}`));
    };
    const onMessage = (message: unknown) => {
      if (!isConnectedClientMessage(message)) return;
      cleanup();
      resolve({ hostEpoch: message.hostEpoch, candidatePids: message.candidatePids });
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
}

function isConnectedClientMessage(
  value: unknown,
): value is { type: 'connected'; hostEpoch: string; candidatePids: number[] } {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'connected' &&
    typeof message.hostEpoch === 'string' &&
    Array.isArray(message.candidatePids) &&
    message.candidatePids.every((pid) => Number.isSafeInteger(pid) && pid > 0)
  );
}

async function retryConnect(
  paths: HostPaths,
  protocol: { min: number; max: number },
  options?: { livenessIntervalMs?: number; onLivenessProbe?: () => void },
) {
  const deadline = Date.now() + 5_000;
  let result = await connectRuntimeHost({
    ...paths,
    ...options,
    rootPath: paths.root,
    protocol,
  });
  while (result.kind !== 'connected' && Date.now() < deadline) {
    await sleep(20);
    result = await connectRuntimeHost({
      ...paths,
      ...options,
      rootPath: paths.root,
      protocol,
    });
  }
  return result;
}

async function retryOwner(capability: StorageRootCapability<'interactive'>, paths: HostPaths) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    if (owner) return paths.resources.trackCloseable(owner);
    await sleep(20);
  }
  return undefined;
}

async function startTestRuntimeHostCandidate(
  paths: HostPaths,
  options: Omit<InteractiveRuntimeHostCandidateOptions, 'expectedRootId'> & {
    expectedRootId?: string;
  },
): Promise<InteractiveRuntimeHostCandidateResult> {
  const expectedRootId =
    options.expectedRootId ??
    (await resolveStorageRoot({ path: options.rootPath, kind: 'interactive' })).rootId;
  const result = await startInteractiveRuntimeHostCandidate(
    { ...options, expectedRootId },
    KERNEL_COMPOSITION,
  );
  if (result.kind === 'winner') paths.resources.trackCloseable(result.host);
  return result;
}

async function spawnTestRuntimeHostCandidate(
  paths: HostPaths,
  input: Omit<DetachedCandidateInput, 'expectedRootId' | 'entrypoint'> & {
    expectedRootId?: string;
    entrypoint?: string | URL;
  },
): Promise<DetachedCandidateAttempt> {
  const expectedRootId =
    input.expectedRootId ??
    (await resolveStorageRoot({ path: input.rootPath, kind: 'interactive' })).rootId;
  return launchTestRuntimeHostCandidate(paths, {
    ...input,
    expectedRootId,
    entrypoint: input.entrypoint ?? KERNEL_CANDIDATE_ENTRYPOINT,
  }).spawned;
}

function launchTestRuntimeHostCandidate(
  paths: HostPaths,
  input: DetachedCandidateInput,
): DetachedCandidateLaunch {
  const launch = launchDetachedRuntimeHostCandidate(input);
  return {
    spawned: launch.spawned.then((attempt) => {
      paths.resources.trackPid(attempt.pid);
      return attempt;
    }),
  };
}

function waitForLaunch(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('launcher did not report')), 5_000);
    child.once('message', (message) => {
      if (
        !message ||
        typeof message !== 'object' ||
        (message as { type?: unknown }).type !== 'launched'
      )
        return;
      clearTimeout(timer);
      resolve((message as { pid: number }).pid);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0) reject(new Error(`launcher exited: ${code ?? signal}`));
    });
  });
}

function waitForElectronParentLaunch(
  child: ChildProcess,
  onCandidateLaunched: (pid: number) => void,
): Promise<{ hostEpoch: string; pid: number; candidatePids: number[] }> {
  return new Promise((resolve, reject) => {
    const candidatePids: number[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Electron connect parent did not report its Host'));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(`Electron connect parent exited before reporting its Host: ${code ?? signal}`),
      );
    };
    const onMessage = (message: unknown) => {
      if (isElectronCandidateLaunch(message)) {
        candidatePids.push(message.pid);
        onCandidateLaunched(message.pid);
        return;
      }
      if (!isElectronParentLaunch(message)) return;
      cleanup();
      resolve({
        hostEpoch: message.hostEpoch,
        pid: message.pid,
        candidatePids,
      });
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
}

function isElectronCandidateLaunch(
  value: unknown,
): value is { type: 'electron-candidate-launched'; pid: number } {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'electron-candidate-launched' &&
    Number.isSafeInteger(message.pid) &&
    (message.pid as number) > 0
  );
}

function isElectronParentLaunch(value: unknown): value is {
  type: 'electron-parent-launched';
  hostEpoch: string;
  pid: number;
} {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'electron-parent-launched' &&
    typeof message.hostEpoch === 'string' &&
    Number.isSafeInteger(message.pid) &&
    (message.pid as number) > 0
  );
}

type UncooperativeHostMessage =
  | { type: 'ready'; hostEpoch: string; endpoint: string }
  | { type: 'operation-blocked' }
  | { type: 'shutdown-requested' };

function waitForUncooperativeHostMessage<T extends UncooperativeHostMessage['type']>(
  child: ChildProcess,
  type: T,
): Promise<Extract<UncooperativeHostMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`uncooperative Host did not report ${type}`));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`uncooperative Host exited before ${type}: ${code ?? signal}`));
    };
    const onMessage = (message: unknown) => {
      if (!isUncooperativeHostMessage(message) || message.type !== type) return;
      cleanup();
      resolve(message as Extract<UncooperativeHostMessage, { type: T }>);
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
}

function isUncooperativeHostMessage(value: unknown): value is UncooperativeHostMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'operation-blocked' || message.type === 'shutdown-requested') return true;
  return (
    message.type === 'ready' &&
    typeof message.hostEpoch === 'string' &&
    typeof message.endpoint === 'string'
  );
}

function waitForChildExitResult(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

function waitForSuccessfulExit(child: ChildProcess, label: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`${label} exited: ${child.exitCode ?? child.signalCode}`));
  }
  return new Promise((resolve, reject) =>
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited: ${code ?? signal}`));
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) await sleep(20);
  if (isProcessAlive(pid)) throw new Error(`process ${pid} did not exit`);
}

async function waitForProcessStopped(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout } = await execFileAsync('ps', ['-o', 'state=', '-p', String(pid)]);
    if (/^[Tt]/.test(stdout.trim())) return;
    if (!isProcessAlive(pid)) throw new Error(`Process ${pid} exited before it stopped`);
    await sleep(5);
  }
  throw new Error(`Process ${pid} did not enter a stopped state`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    ) {
      return false;
    }
    throw error;
  }
}

function terminateProcess(pid: number | undefined): void {
  if (pid === undefined || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ESRCH'
      )
    ) {
      throw error;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function openHalfOpenSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket({ allowHalfOpen: true });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
    socket.connect(path);
  });
}

async function openNonReadingStatusSocket(path: string): Promise<Socket> {
  const socket = new Socket();
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.connect(path);
  });
  const handshake = await new Promise<ReturnType<typeof decodeHostFrame>>((resolve, reject) => {
    let buffered = '';
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      cleanup();
      socket.pause();
      try {
        resolve(decodeHostFrame(JSON.parse(buffered.slice(0, newline))));
      } catch (error) {
        reject(error);
      }
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(
      `${JSON.stringify({
        kind: 'hello',
        clientInstanceId: 'non-reading-client',
        protocolMin: CURRENT_PROTOCOL.min,
        protocolMax: CURRENT_PROTOCOL.max,
        compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
        compositionId: 'maka.interactive',
      })}\n`,
    );
  });
  assert.ok('kind' in handshake);
  assert.equal(handshake.kind, 'accepted');
  socket.on('error', () => undefined);
  return socket;
}

async function sendInvalidBootstrap(path: string, payload: Buffer): Promise<void> {
  const socket = await openSocket(path);
  socket.on('error', () => undefined);
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.write(payload);
  await withTimeout(closed, 1_000, 'Runtime Host did not close an invalid bootstrap connection');
}

function encodeLegacyProtocolFrame(frame: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8');
}

function writeRawLocalIpc(transport: FramedTransport, frame: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    transport.socket.write(frame, (error) => (error ? reject(error) : resolve()));
  });
}

function writeClientFrame(transport: FramedTransport, frame: ClientFrame): Promise<void> {
  return transport.write(encodeProtocolMessage(frame));
}

async function removeControlDirectoriesForRootsUnder(base: string): Promise<void> {
  const rootIds = new Set<string>();
  await collectRootIds(base, rootIds);
  await Promise.all(
    [...rootIds].map(async (rootId) => {
      await rm(join(resolveRootControlNamespace(), rootId), { recursive: true, force: true });
      await removePosixEndpointDirectories(rootId);
    }),
  );
}

async function collectRootIds(directory: string, rootIds: Set<string>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    const marker = await readFile(join(path, STORAGE_ROOT_MARKER_FILE), 'utf8').catch(
      () => undefined,
    );
    if (marker) {
      try {
        const rootId = (JSON.parse(marker) as { rootId?: unknown }).rootId;
        if (typeof rootId === 'string' && /^[a-f0-9]{64}$/.test(rootId)) rootIds.add(rootId);
      } catch {
        // Invalid markers never reach the Runtime Host control namespace.
      }
    }
    await collectRootIds(path, rootIds);
  }
}

async function assertPathMissing(path: string): Promise<void> {
  await assert.rejects(
    () => lstat(path),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT',
  );
}
