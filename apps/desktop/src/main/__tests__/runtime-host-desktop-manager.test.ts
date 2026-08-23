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
import type { BotIncomingMessage } from '@maka/runtime/bots';
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
} from '@maka/runtime-host/protocol';
import type {
  DesktopRuntimeHostCandidate,
  DesktopRuntimeHostCandidateStartInput,
  DesktopRuntimeHostCandidateStartResult,
} from '../runtime-host-desktop-candidate.js';
import {
  RuntimeHostPairingFinalizationInterruptedError,
  RuntimeHostUpgradeCancelledError,
  startRuntimeHostDesktopManager,
} from '../runtime-host-desktop-manager.js';

test('replaces a disconnected Runtime Host generation', { timeout: 10_000 }, async () => {
  const first = candidateHarness({ delayDisconnect: true });
  const second = candidateHarness();
  const queue = [ready(first.candidate), ready(second.candidate)];
  let starts = 0;
  const interactions: Array<string | undefined> = [];
  let resolveSecondStart!: () => void;
  let releaseSecond!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    resolveSecondStart = resolve;
  });
  const secondReleased = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const readiness: string[] = [];
  const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async (input) => {
      starts += 1;
      interactions.push(input.remote?.sshInteraction);
      if (starts === 2) {
        resolveSecondStart();
        await secondReleased;
      }
      const result = queue.shift();
      assert.ok(result);
      return result;
    },
    onTargetStateChanged: (state) => readiness.push(state.readiness),
  });

  first.disconnect();
  const botMessage = owner.handleBotIncomingMessage({ text: 'hello' } as BotIncomingMessage);
  const stop = owner.stopSession({
    hostId: 'test-host',
    targetEpoch: owner.current()!.epoch,
    sessionId: 'session-1',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(first.botMessages, 0);
  assert.deepEqual(first.stoppedSessions, []);
  first.finishDisconnect();
  await secondStarted;
  assert.equal(owner.current()?.hostId, 'test-host');
  assert.equal(
    owner.ownsScope({
      hostId: 'test-host',
      targetEpoch: owner.current()!.epoch,
    }),
    true,
    'the target still owns its scope while its candidate is reconnecting',
  );
  assert.equal(second.botMessages, 0);
  assert.deepEqual(second.stoppedSessions, []);
  releaseSecond();
  await Promise.all([botMessage, stop]);

  assert.equal(first.botMessages, 0);
  assert.equal(second.botMessages, 1);
  assert.deepEqual(second.stoppedSessions, ['session-1']);
  assert.deepEqual(readiness, ['connecting', 'ready', 'reconnecting', 'ready']);
  assert.deepEqual(interactions, [undefined, undefined]);
  await owner.close();
  assert.equal(second.closeCalls, 1);
});

test('quiesces reconnect and waits for the Host process before update install', async () => {
  const current = candidateHarness({ disconnectOnPrepare: true });
  const replacement = candidateHarness();
  let starts = 0;
  let waitedForPid: number | undefined;
  let resolveReconnected!: () => void;
  const reconnected = new Promise<void>((resolve) => {
    resolveReconnected = resolve;
  });
  const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => {
      starts += 1;
      if (starts === 1) return ready(current.candidate);
      resolveReconnected();
      return ready(replacement.candidate);
    },
    waitForHostExit: async (pid) => {
      waitedForPid = pid;
    },
  });

  const preparation = await owner.prepareForUpdate(false);
  assert.equal(preparation.kind, 'prepared');
  assert.equal(current.prepareUpgradeCalls, 1);
  assert.deepEqual(current.prepareUpgradeAuthorities, [false]);
  assert.equal(waitedForPid, 42);
  assert.equal(starts, 1);
  if (preparation.kind === 'prepared') preparation.rollback();
  await reconnected;
  assert.equal(starts, 2);
  await owner.close();
});

test('retires unadopted candidates before draining the tracked Host', async () => {
  const events: string[] = [];
  const current = candidateHarness({
    disconnectOnPrepare: true,
    onPrepare: () => events.push('prepare-host'),
  });
  const owner = await startRuntimeHostDesktopManager({
    candidateLaunchBarrier: {
      connect: async () => assert.fail('mocked candidate startup bypasses the barrier'),
      pause: () => events.push('pause-launches'),
      retireExcept: async (pid: number) => {
        events.push(`retire-except:${pid}`);
      },
      resume: () => events.push('resume-launches'),
      release: () => events.push('release-launches'),
    },
  } as unknown as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => ready(current.candidate),
    waitForHostExit: async (pid) => {
      events.push(`wait:${pid}`);
    },
  });

  const preparation = await owner.prepareForUpdate(false);
  assert.equal(preparation.kind, 'prepared');
  assert.deepEqual(events, [
    'pause-launches',
    'retire-except:42',
    'prepare-host',
    'wait:42',
  ]);
  if (preparation.kind === 'prepared') preparation.rollback();
  assert.equal(events.at(-1), 'resume-launches');
  await owner.close();
  assert.equal(events.at(-1), 'release-launches');
});

test('resumes candidate launches when active tasks block the update', async () => {
  const events: string[] = [];
  const current = candidateHarness({ activeTasks: true });
  const owner = await startRuntimeHostDesktopManager({
    candidateLaunchBarrier: {
      connect: async () => assert.fail('mocked candidate startup bypasses the barrier'),
      pause: () => events.push('pause'),
      retireExcept: async () => {
        events.push('retire');
      },
      resume: () => events.push('resume'),
      release: () => events.push('release'),
    },
  } as unknown as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => ready(current.candidate),
  });

  assert.deepEqual(await owner.prepareForUpdate(false), { kind: 'active_tasks' });
  assert.deepEqual(events, ['pause', 'retire', 'resume']);
  await owner.close();
  assert.equal(events.at(-1), 'release');
});

test('resumes candidate launches when candidate retirement fails', async () => {
  const events: string[] = [];
  const current = candidateHarness();
  const owner = await startRuntimeHostDesktopManager({
    candidateLaunchBarrier: {
      connect: async () => assert.fail('mocked candidate startup bypasses the barrier'),
      pause: () => events.push('pause'),
      retireExcept: async () => {
        events.push('retire');
        throw new Error('retirement failed');
      },
      resume: () => events.push('resume'),
      release: () => events.push('release'),
    },
  } as unknown as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => ready(current.candidate),
  });

  await assert.rejects(owner.prepareForUpdate(false), /retirement failed/);
  assert.deepEqual(events, ['pause', 'retire', 'resume']);
  await owner.handleBotIncomingMessage({ text: 'still connected' } as BotIncomingMessage);
  assert.equal(current.botMessages, 1);
  await owner.close();
});

test('keeps active-task confirmation bound to the current Host', async () => {
  const current = candidateHarness({ activeTasks: true, disconnectOnPrepare: true });
  const waitedFor: number[] = [];
  const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => ready(current.candidate),
    waitForHostExit: async (pid) => {
      waitedFor.push(pid);
    },
  });

  assert.deepEqual(await owner.prepareForUpdate(false), { kind: 'active_tasks' });
  await owner.handleBotIncomingMessage({ text: 'still connected' } as BotIncomingMessage);
  assert.equal(current.botMessages, 1);
  const authorized = await owner.prepareForUpdate(true);
  assert.equal(authorized.kind, 'prepared');
  assert.deepEqual(current.prepareUpgradeAuthorities, [false, true]);
  assert.deepEqual(waitedFor, [42]);
  await owner.close();
});

for (const lifecycleMode of ['service', 'remote'] as const) {
  test(`does not retire a ${lifecycleMode} Host for a Desktop update`, async () => {
    const current = candidateHarness({ lifecycleMode });
    const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
      startCandidate: async () => ready(current.candidate),
      waitForHostExit: async () => assert.fail(`${lifecycleMode} Host exit must not be awaited`),
    });

    const preparation = await owner.prepareForUpdate(false);
    assert.equal(preparation.kind, 'prepared');
    assert.equal(current.prepareUpgradeCalls, 0);
    if (preparation.kind === 'prepared') preparation.rollback();
    await owner.handleBotIncomingMessage({ text: 'still connected' } as BotIncomingMessage);
    assert.equal(current.botMessages, 1);
    await owner.close();
  });
}

test('keeps Local and remote Hosts active and routes work by owning Host', async () => {
  const local = candidateHarness({ hostId: 'host-a' });
  const remote = candidateHarness({ hostId: 'host-b', lifecycleMode: 'remote' });
  let starts = 0;
  const manager = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () => ready(starts++ === 0 ? local.candidate : remote.candidate),
    },
  );

  await manager.enable(remoteTarget('office'));
  manager.setDefaultProfile('office');
  await manager.handleBotIncomingMessage({ text: 'remote' } as BotIncomingMessage);
  await manager.stopSession({
    hostId: 'host-a',
    targetEpoch: manager.current('local')!.epoch,
    sessionId: 'shared-session',
  });
  await manager.stopSession({
    hostId: 'host-b',
    targetEpoch: manager.current('office')!.epoch,
    sessionId: 'shared-session',
  });

  assert.equal(local.closeCalls, 0);
  assert.equal(remote.botMessages, 1);
  assert.deepEqual(local.stoppedSessions, ['shared-session']);
  assert.deepEqual(remote.stoppedSessions, ['shared-session']);
  assert.deepEqual(manager.entries().map((state) => state.target.profile.id), [
    'local',
    'office',
  ]);
  await assert.rejects(
    () => manager.enable(remoteTarget('duplicate', 'other-endpoint')),
    /already enabled/,
  );
  await manager.close();
});

test('replays pairing finalization after an unknown commit and reconnect', async () => {
  const local = candidateHarness({ hostId: 'host-a' });
  const remoteHostId = 'a'.repeat(64);
  const first = candidateHarness({
    hostId: remoteHostId,
    finalizeFailures: [
      new RuntimeHostOperationError(
        'access.credential.finalize',
        'commit_outcome_unknown',
        'finalization outcome is unknown',
      ),
    ],
    disconnectOnFinalizeFailure: true,
  });
  const replacement = candidateHarness({ hostId: remoteHostId });
  const queue = [local.candidate, first.candidate, replacement.candidate];
  const manager = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () => ready(queue.shift()!),
      reconnectBackoff: { minMs: 0, maxMs: 0 },
    },
  );
  await manager.enable(remoteTarget('office'));

  await manager.finalizePairing('office');

  assert.equal(first.finalizeCalls, 1);
  assert.equal(replacement.finalizeCalls, 1);
  await manager.close();
});

for (const dispatch of ['not_dispatched', 'dispatched'] as const) {
  test(`replays ${dispatch} pairing finalization after connection loss`, async () => {
    const local = candidateHarness({ hostId: 'host-a' });
    const remoteHostId = 'a'.repeat(64);
    const first = candidateHarness({
      hostId: remoteHostId,
      finalizeFailures: [
        new RuntimeHostRequestInterruptedError(
          'access.credential.finalize',
          'command',
          dispatch,
          'connection_lost',
        ),
      ],
      disconnectOnFinalizeFailure: true,
    });
    const replacement = candidateHarness({ hostId: remoteHostId });
    const queue = [local.candidate, first.candidate, replacement.candidate];
    const manager = await startRuntimeHostDesktopManager(
      {} as DesktopRuntimeHostCandidateStartInput,
      {
        startCandidate: async () => ready(queue.shift()!),
        reconnectBackoff: { minMs: 0, maxMs: 0 },
      },
    );
    await manager.enable(remoteTarget('office'));

    await manager.finalizePairing('office');

    assert.equal(first.finalizeCalls, 1);
    assert.equal(replacement.finalizeCalls, 1);
    await manager.close();
  });
}

test('defers reconnecting pairing finalization when the manager closes', async () => {
  const local = candidateHarness({ hostId: 'host-a' });
  const remoteHostId = 'a'.repeat(64);
  const remote = candidateHarness({
    hostId: remoteHostId,
    finalizeFailures: [
      new RuntimeHostOperationError(
        'access.credential.finalize',
        'commit_outcome_unknown',
        'finalization outcome is unknown',
      ),
    ],
    disconnectOnFinalizeFailure: true,
  });
  let reconnectStarted!: () => void;
  const reconnecting = new Promise<void>((resolve) => {
    reconnectStarted = resolve;
  });
  let starts = 0;
  const manager = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async (input) => {
        starts += 1;
        if (starts === 1) return ready(local.candidate);
        if (starts === 2) return ready(remote.candidate);
        reconnectStarted();
        const signal = input.signal;
        assert.ok(signal);
        return await new Promise<DesktopRuntimeHostCandidateStartResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      reconnectBackoff: { minMs: 0, maxMs: 0 },
    },
  );
  await manager.enable(remoteTarget('office'));

  const finalization = assert.rejects(
    () => manager.finalizePairing('office'),
    RuntimeHostPairingFinalizationInterruptedError,
  );
  await reconnecting;
  await manager.close();
  await finalization;

  assert.equal(remote.finalizeCalls, 1);
  assert.equal(starts, 3);
});

test('defers pairing finalization when reconnect does not complete in time', async () => {
  const local = candidateHarness({ hostId: 'host-a' });
  const remoteHostId = 'a'.repeat(64);
  const remote = candidateHarness({
    hostId: remoteHostId,
    finalizeFailures: [
      new RuntimeHostOperationError(
        'access.credential.finalize',
        'commit_outcome_unknown',
        'finalization outcome is unknown',
      ),
    ],
    disconnectOnFinalizeFailure: true,
  });
  let starts = 0;
  const manager = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async (input) => {
        starts += 1;
        if (starts === 1) return ready(local.candidate);
        if (starts === 2) return ready(remote.candidate);
        const signal = input.signal;
        assert.ok(signal);
        return await new Promise<DesktopRuntimeHostCandidateStartResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      reconnectBackoff: { minMs: 0, maxMs: 0 },
      pairingFinalizationTimeoutMs: 10,
    },
  );
  await manager.enable(remoteTarget('office'));

  await assert.rejects(
    () => manager.finalizePairing('office'),
    RuntimeHostPairingFinalizationInterruptedError,
  );

  assert.equal(remote.finalizeCalls, 1);
  assert.equal(starts, 3);
  await manager.close();
});

test('coalesces concurrent enable requests for one remote profile', async () => {
  const local = candidateHarness({ hostId: 'host-a' });
  const remote = candidateHarness({ hostId: 'host-b', lifecycleMode: 'remote' });
  let starts = 0;
  let releaseRemote!: () => void;
  const remoteReady = new Promise<void>((resolve) => {
    releaseRemote = resolve;
  });
  const manager = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () => {
        starts += 1;
        if (starts === 1) return ready(local.candidate);
        await remoteReady;
        return ready(remote.candidate);
      },
    },
  );

  const first = manager.enable(remoteTarget('office'));
  const second = manager.enable(remoteTarget('office'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 2);
  releaseRemote();
  await Promise.all([first, second]);
  assert.equal(starts, 2);
  await manager.close();
});

test('waits for an in-flight remote enable before closing', async () => {
  const local = candidateHarness({ hostId: 'host-a' });
  const remote = candidateHarness({ hostId: 'host-b', lifecycleMode: 'remote' });
  let starts = 0;
  let releaseRemote!: () => void;
  const remoteReady = new Promise<void>((resolve) => {
    releaseRemote = resolve;
  });
  const manager = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () => {
        starts += 1;
        if (starts === 1) return ready(local.candidate);
        await remoteReady;
        return ready(remote.candidate);
      },
    },
  );

  const enabling = manager.enable(remoteTarget('office'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  let closed = false;
  const closing = manager.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  releaseRemote();
  await assert.rejects(enabling, /manager is closed/);
  await closing;
  assert.equal(remote.closeCalls, 1);
});

test('keeps Local explicitly usable without routing default work away from an unavailable remote', async () => {
  const local = candidateHarness();
  let starts = 0;
  const removedDefaults: boolean[] = [];
  const manager = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () =>
        starts++ === 0 ? ready(local.candidate) : { kind: 'failed', reason: 'host_unresponsive' },
      onTargetRemoved: (state) => {
        removedDefaults.push(manager.defaultProfileId() === state.target.profile.id);
      },
    },
  );

  await assert.rejects(manager.enable(remoteTarget('offline')), /did not become ready/);
  manager.setDefaultProfile('offline');
  await assert.rejects(
    manager.handleBotIncomingMessage({ text: 'default' } as BotIncomingMessage),
    /did not become ready/,
  );

  assert.equal(local.botMessages, 0);
  assert.equal(manager.current(), undefined);
  assert.equal(manager.current('local')?.readiness, 'ready');
  assert.equal(manager.current('offline'), undefined);
  assert.equal(
    manager.entries().find((state) => state.target.profile.id === 'offline')?.readiness,
    'unavailable',
  );
  await manager.disable('offline');
  assert.deepEqual(removedDefaults, [true]);
  assert.equal(manager.defaultProfileId(), 'offline');
  assert.equal(manager.current(), undefined);
  await manager.close();
});

test('keeps reconnecting through transient startup failures until the Desktop adapter is restored', async () => {
  const first = candidateHarness();
  const replacement = candidateHarness();
  let starts = 0;
  const delays: number[] = [];
  let resolveRestored!: () => void;
  const restored = new Promise<void>((resolve) => {
    resolveRestored = resolve;
  });
  const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async (): Promise<DesktopRuntimeHostCandidateStartResult> => {
      starts += 1;
      if (starts === 1) return ready(first.candidate);
      if (starts === 2) return { kind: 'failed', reason: 'internal_startup_failure' };
      if (starts < 4) return { kind: 'failed', reason: 'host_unresponsive' };
      resolveRestored();
      return ready(replacement.candidate);
    },
    reconnectBackoff: {
      minMs: 100,
      maxMs: 150,
      random: () => 0.5,
      wait: async (delayMs) => {
        delays.push(delayMs);
      },
    },
  });

  first.disconnect();
  await restored;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 4);
  assert.deepEqual(delays, [100, 150]);
  await owner.handleBotIncomingMessage({ text: 'restored' } as BotIncomingMessage);
  assert.equal(replacement.botMessages, 1);
  await owner.close();
});

test('stops reconnecting when the replacement Host is incompatible', async () => {
  const first = candidateHarness();
  let reportFatal!: (error: Error) => void;
  const fatalReported = new Promise<Error>((resolve) => {
    reportFatal = resolve;
  });
  const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () =>
      first.closeCalls === 0
        ? ready(first.candidate)
        : incompatibleHost('wait_for_idle_exit'),
    onFatalError: reportFatal,
  });

  await first.candidate.close();
  const fatal = await fatalReported;
  assert.match(fatal.message, /older Runtime Host/);
  await owner.close();
});

test('restarts a generation-aware Host through its exact takeover handshake', async () => {
  const replacement = candidateHarness();
  const starts: DesktopRuntimeHostCandidateStartInput[] = [];
  const conflict = upgradeRequired(true);
  const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async (input) => {
      starts.push(input);
      return starts.length === 1 ? conflict : ready(replacement.candidate);
    },
    upgradePrompts: {
      restartable: async () => 'restart',
      waitOnly: async () => assert.fail('restartable conflict used wait-only prompt'),
    },
  });

  assert.equal(starts.length, 2);
  assert.equal(starts[1]?.takeoverHostEpoch, conflict.registration.hostEpoch);
  await owner.close();
});

test('waits passively for a Host that cannot be taken over', async () => {
  const conflict = upgradeRequired(false);
  let starts = 0;
  let finishRetirement!: () => void;
  const retirement = new Promise<void>((resolve) => {
    finishRetirement = resolve;
  });
  const replacement = candidateHarness();
  const ownerTask = startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => {
      starts += 1;
      return starts === 1 ? conflict : ready(replacement.candidate);
    },
    upgradePrompts: {
      restartable: async () => assert.fail('wait-only conflict used restart prompt'),
      waitOnly: async () => 'wait',
    },
    waitForHostRetirement: async (registration) => {
      assert.equal(registration.hostEpoch, conflict.registration.hostEpoch);
      await retirement;
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  finishRetirement();
  const owner = await ownerTask;
  assert.equal(starts, 2);
  await owner.close();
});

test('lets the user cancel startup when an incompatible Host owns the root', async () => {
  const conflict = incompatibleHost('blocked_by_residency');
  let presented: DesktopRuntimeHostCandidateStartResult | undefined;
  await assert.rejects(
    startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
      startCandidate: async () => conflict,
      upgradePrompts: {
        restartable: async () => assert.fail('incompatible Host used restart prompt'),
        waitOnly: async (actual) => {
          presented = actual;
          return 'cancel';
        },
      },
      onFatalError: () => undefined,
    }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeHostUpgradeCancelledError);
      assert.equal(error.message, 'Runtime Host restart was cancelled');
      return true;
    },
  );
  assert.equal(presented, conflict);
});

function incompatibleHost(
  replacement: 'wait_for_idle_exit' | 'blocked_by_residency',
): DesktopRuntimeHostCandidateStartResult {
  return {
    kind: 'incompatible',
    registration: hostRegistration({ compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH - 1 }),
    handshake: {
      kind: 'incompatible',
      hostEpoch: 'older-host',
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      compositionRevision: 'legacy',
      protocolMin: 0,
      protocolMax: 0,
      compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH - 1,
      state: 'ready',
      replacement,
    },
  };
}

function upgradeRequired(
  restartable: boolean,
): Extract<DesktopRuntimeHostCandidateStartResult, { kind: 'upgrade_required' }> {
  const registration = hostRegistration(
    restartable ? { lifecycleMode: 'ephemeral' } : {},
  );
  if (!restartable) {
    return { kind: 'upgrade_required', registration, restartable: false };
  }
  return {
    kind: 'upgrade_required',
    registration,
    restartable: true,
    handshake: {
      kind: 'incompatible',
      hostEpoch: registration.hostEpoch,
      protocolMin: 0,
      protocolMax: 0,
      compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
      compositionId: registration.compositionId,
      compositionRevision: registration.compositionRevision,
      generation: 'desktop-old',
      state: 'ready',
      replacement: 'blocked_by_residency',
      activity: {
        connections: 0,
        activeOperations: 0,
        processUptimeSeconds: 60,
        residencies: [],
      },
    },
  };
}

function hostRegistration(
  overrides: Partial<{
    compatibilityEpoch: number;
    lifecycleMode: 'ephemeral' | 'service';
  }> = {},
) {
  return {
    kind: 'maka-runtime-host' as const,
    schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
    rootId: 'root-id',
    hostEpoch: 'older-host',
    endpoint: '/tmp/runtime-host.sock',
    protocolMin: 0,
    protocolMax: 0,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    compositionRevision: '2',
    state: 'ready' as const,
    pid: 42,
    createdAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

function candidateHarness(
  options: {
    delayDisconnect?: boolean;
    disconnectOnPrepare?: boolean;
    activeTasks?: boolean;
    lifecycleMode?: 'ephemeral' | 'service' | 'remote';
    hostId?: string;
    finalizeFailures?: Error[];
    disconnectOnFinalizeFailure?: boolean;
    onPrepare?: () => void;
  } = {},
) {
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closeCalls = 0;
  let botMessages = 0;
  const stoppedSessions: string[] = [];
  let lifecycleState: 'ready' | 'unavailable' = 'ready';
  let prepareUpgradeCalls = 0;
  let finalizeCalls = 0;
  const prepareUpgradeAuthorities: boolean[] = [];
  const candidate = {
    closed,
    hostLifecycleMode: options.lifecycleMode ?? 'ephemeral',
    client: {
      hostId: options.hostId ?? 'test-host',
      get lifecycleState() {
        return lifecycleState;
      },
      async queryHostDiagnostics() {
        return { pid: 42 };
      },
      async prepareHostUpgrade(allowInterruptActiveTasks: boolean) {
        options.onPrepare?.();
        prepareUpgradeCalls += 1;
        prepareUpgradeAuthorities.push(allowInterruptActiveTasks);
        if (options.activeTasks && !allowInterruptActiveTasks) {
          return { kind: 'active_tasks' as const };
        }
        if (options.disconnectOnPrepare) {
          lifecycleState = 'unavailable';
          resolveClosed?.();
        }
        return { kind: 'prepared' as const, pid: 42 };
      },
      async finalizeAccessCredential() {
        finalizeCalls += 1;
        const failure = options.finalizeFailures?.shift();
        if (failure) {
          if (options.disconnectOnFinalizeFailure) {
            lifecycleState = 'unavailable';
            resolveClosed?.();
          }
          throw failure;
        }
        return {};
      },
    },
    botIncoming: {
      async handleBotIncomingMessage() {
        botMessages += 1;
      },
    },
    async close() {
      closeCalls += 1;
      lifecycleState = 'unavailable';
      resolveClosed?.();
    },
    async stopSession(sessionId: string) {
      stoppedSessions.push(sessionId);
    },
  } as unknown as DesktopRuntimeHostCandidate;
  return {
    candidate,
    disconnect: () => {
      lifecycleState = 'unavailable';
      if (!options.delayDisconnect) resolveClosed?.();
    },
    finishDisconnect: () => resolveClosed?.(),
    get closeCalls() {
      return closeCalls;
    },
    get botMessages() {
      return botMessages;
    },
    get stoppedSessions() {
      return stoppedSessions;
    },
    get prepareUpgradeCalls() {
      return prepareUpgradeCalls;
    },
    get prepareUpgradeAuthorities() {
      return prepareUpgradeAuthorities;
    },
    get finalizeCalls() {
      return finalizeCalls;
    },
  };
}

function ready(candidate: DesktopRuntimeHostCandidate): DesktopRuntimeHostCandidateStartResult {
  return { kind: 'ready', candidate };
}

function remoteTarget(
  id: string,
  target = 'default',
): NonNullable<DesktopRuntimeHostCandidateStartInput['remote']> {
  return {
    profile: {
      id,
      name: id,
      kind: 'remote',
      transport: { kind: 'tls', url: `wss://${target}.example.com/` },
      rootId: 'a'.repeat(64),
    },
    credential: `credential-${target}`,
  };
}
