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
  RuntimeHostPermanentReconnectError,
  RuntimeHostRequestInterruptedError,
  type RuntimeHostSpawnedProcess,
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
  DesktopLocalHostRetirementError,
  RuntimeHostPairingFinalizationInterruptedError,
  RuntimeHostUpgradeCancelledError,
  startRuntimeHostDesktopManager,
} from '../runtime-host-desktop-manager.js';

test('replaces a disconnected Runtime Host generation', { timeout: 10_000 }, async () => {
  const first = candidateHarness({ delayDisconnect: true, hostEpoch: 'host-before' });
  const second = candidateHarness({ hostEpoch: 'host-after' });
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
      interactions.push(input.profileTarget?.sshInteraction);
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
  const replacementReady = owner.waitUntilReady(owner.defaultProfileId(), 'host-before');
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
  await Promise.all([botMessage, stop, replacementReady]);

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

  const retirement = await owner.retireOwnedLocalHost('refuse_active_work');
  assert.equal(retirement.kind, 'retired');
  assert.equal(current.prepareRetirementCalls, 1);
  assert.deepEqual(current.retirementModes, ['refuse_active_work']);
  assert.equal(waitedForPid, 42);
  assert.equal(starts, 1);
  if (retirement.kind === 'retired') retirement.resume();
  await reconnected;
  assert.equal(starts, 2);
  await owner.close();
});

test('quiesces Local reconnect while a managed service changes', async () => {
  const current = candidateHarness({ ownership: 'supervised' });
  const replacement = candidateHarness({
    ownership: 'supervised',
    hostEpoch: 'service-after',
  });
  let starts = 0;
  let finishChange!: () => void;
  const change = new Promise<void>((resolve) => {
    finishChange = resolve;
  });
  const owner = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () => {
        starts += 1;
        return ready(starts === 1 ? current.candidate : replacement.candidate);
      },
    },
  );

  const changing = owner.runManagedLocalHostChange(async () => {
    current.disconnect();
    await change;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);

  finishChange();
  await changing;
  await owner.waitUntilReady('local', 'test-host-epoch');
  assert.equal(starts, 2);
  await owner.close();
});

test('waits through a reconnect gap before quiescing Host retirement', async () => {
  const first = candidateHarness();
  const replacement = candidateHarness({ disconnectOnPrepare: true });
  let starts = 0;
  let reportReplacementStart!: () => void;
  let releaseReplacement!: () => void;
  const replacementStarted = new Promise<void>((resolve) => {
    reportReplacementStart = resolve;
  });
  const replacementReleased = new Promise<void>((resolve) => {
    releaseReplacement = resolve;
  });
  const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => {
      starts += 1;
      if (starts === 1) return ready(first.candidate);
      reportReplacementStart();
      await replacementReleased;
      return ready(replacement.candidate);
    },
    waitForHostExit: async () => {},
  });

  first.disconnect();
  await replacementStarted;
  const retirement = owner.retireOwnedLocalHost('interrupt_active_work');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(replacement.prepareRetirementCalls, 0);

  releaseReplacement();
  assert.equal((await retirement).kind, 'retired');
  assert.equal(replacement.prepareRetirementCalls, 1);
  assert.deepEqual(replacement.retirementModes, ['interrupt_active_work']);
  assert.equal(starts, 2);
  await owner.close();
});

test('does not treat an in-flight replacement as retired after admission times out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = candidateHarness({
    ownedProcess: {
      pid: 42,
      exited: Promise.resolve({ code: 1, signal: null, stderr: '', stderrTruncated: false }),
    },
  });
  const replacement = candidateHarness();
  let starts = 0;
  let reportReconnectStart!: () => void;
  let releaseReconnect!: () => void;
  const reconnectStarted = new Promise<void>((resolve) => {
    reportReconnectStart = resolve;
  });
  const reconnectReleased = new Promise<void>((resolve) => {
    releaseReconnect = resolve;
  });
  const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async (input) => {
      starts += 1;
      if (starts === 1) return ready(first.candidate);
      reportReconnectStart();
      const signal = input.signal;
      assert.ok(signal);
      await Promise.race([
        reconnectReleased,
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      ]);
      return ready(replacement.candidate);
    },
    reconnectBackoff: { minMs: 0, maxMs: 0 },
    waitForHostExit: async () => {},
  });

  first.disconnect();
  await reconnectStarted;
  const retirement = owner.retireOwnedLocalHost('interrupt_active_work');
  t.mock.timers.tick(5_000);
  await assert.rejects(
    retirement,
    (error: unknown) =>
      error instanceof DesktopLocalHostRetirementError &&
      error.facts.pid === undefined &&
      !error.facts.forceTerminationAvailable,
  );

  releaseReconnect();
  await owner.waitUntilReady('local');
  assert.equal(
    (await owner.retireOwnedLocalHost('interrupt_active_work')).kind,
    'retired',
  );
  assert.equal(replacement.prepareRetirementCalls, 1);
  await owner.close();
});

test('retires the owned ephemeral Host before Desktop quit', async () => {
  const events: string[] = [];
  const current = candidateHarness({
    activeTasks: true,
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

  await owner.retireOwnedLocalHost('interrupt_active_work');

  assert.deepEqual(current.retirementModes, ['interrupt_active_work']);
  assert.deepEqual(events, [
    'pause-launches',
    'retire-except:42',
    'prepare-host',
    'wait:42',
  ]);
  await owner.close();
  assert.equal(events.at(-1), 'release-launches');
  assert.ok(!events.includes('resume-launches'));
});

test('does not retire the local Host twice when an update handoff triggers quit', async () => {
  const current = candidateHarness({ disconnectOnPrepare: true });
  const waitedFor: number[] = [];
  const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => ready(current.candidate),
    waitForHostExit: async (pid) => {
      waitedFor.push(pid);
    },
  });

  const update = await owner.retireOwnedLocalHost('refuse_active_work');
  assert.equal(update.kind, 'retired');
  await owner.retireOwnedLocalHost('interrupt_active_work');

  assert.equal(current.prepareRetirementCalls, 1);
  assert.deepEqual(waitedFor, [42]);
  await owner.close();
});

test('does not block quit after a retired Local Host hands off to an unavailable supervisor', async () => {
  const current = candidateHarness({ disconnectOnPrepare: true });
  let starts = 0;
  let reportFatal!: (error: Error) => void;
  const fatalReported = new Promise<Error>((resolve) => {
    reportFatal = resolve;
  });
  const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => {
      starts += 1;
      return starts === 1 ? ready(current.candidate) : incompatibleHost('wait_for_idle_exit');
    },
    waitForHostExit: async () => undefined,
    onFatalError: reportFatal,
  });

  const handoff = await owner.retireOwnedLocalHost('interrupt_active_work');
  assert.equal(handoff.kind, 'retired');
  if (handoff.kind === 'retired') handoff.resume();
  await fatalReported;

  assert.deepEqual(await owner.retireOwnedLocalHost('interrupt_active_work'), {
    kind: 'not_owned',
  });
  await owner.close();
});

test('coalesces concurrent retirement intents onto one exact Host request', async () => {
  const current = candidateHarness({ disconnectOnPrepare: true });
  let releaseExitWait!: () => void;
  let reportExitWait!: () => void;
  const exitWaitStarted = new Promise<void>((resolve) => {
    reportExitWait = resolve;
  });
  const exitWait = new Promise<void>((resolve) => {
    releaseExitWait = resolve;
  });
  const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => ready(current.candidate),
    waitForHostExit: async () => {
      reportExitWait();
      await exitWait;
    },
  });

  const update = owner.retireOwnedLocalHost('refuse_active_work');
  await exitWaitStarted;
  const quit = owner.retireOwnedLocalHost('interrupt_active_work');
  releaseExitWait();
  assert.deepEqual(
    (await Promise.all([update, quit])).map(({ kind }) => kind),
    ['retired', 'retired'],
  );

  assert.equal(current.prepareRetirementCalls, 1);
  assert.deepEqual(current.retirementModes, ['refuse_active_work']);
  await owner.close();
});

test('reissues a concurrent strong retirement when weak retirement is refused', async () => {
  let reportWeakPrepare!: () => void;
  let releaseWeakPrepare!: () => void;
  const weakPrepareStarted = new Promise<void>((resolve) => {
    reportWeakPrepare = resolve;
  });
  const weakPrepareGate = new Promise<void>((resolve) => {
    releaseWeakPrepare = resolve;
  });
  const current = candidateHarness({
    activeTasks: true,
    disconnectOnPrepare: true,
    onPrepare: async (mode) => {
      if (mode !== 'refuse_active_work') return;
      reportWeakPrepare();
      await weakPrepareGate;
    },
  });
  const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => ready(current.candidate),
    waitForHostExit: async () => {},
  });

  const update = owner.retireOwnedLocalHost('refuse_active_work');
  await weakPrepareStarted;
  const quit = owner.retireOwnedLocalHost('interrupt_active_work');
  releaseWeakPrepare();

  assert.deepEqual(await update, { kind: 'active_tasks' });
  assert.equal((await quit).kind, 'retired');
  assert.deepEqual(current.retirementModes, [
    'refuse_active_work',
    'interrupt_active_work',
  ]);
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

  const retirement = await owner.retireOwnedLocalHost('refuse_active_work');
  assert.equal(retirement.kind, 'retired');
  assert.deepEqual(events, [
    'pause-launches',
    'retire-except:42',
    'prepare-host',
    'wait:42',
  ]);
  if (retirement.kind === 'retired') retirement.resume();
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

  assert.deepEqual(await owner.retireOwnedLocalHost('refuse_active_work'), {
    kind: 'active_tasks',
  });
  assert.deepEqual(events, ['pause', 'retire', 'resume']);
  await owner.close();
  assert.equal(events.at(-1), 'release');
});

test('preserves Host facts when authorized retirement is refused', async () => {
  const current = candidateHarness({ activeTasks: 'always' });
  const owner = await startRuntimeHostDesktopManager({
    rootPath: '/test-root',
  } as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => ready(current.candidate),
  });

  await assert.rejects(
    owner.retireOwnedLocalHost('interrupt_active_work'),
    (error: unknown) =>
      error instanceof DesktopLocalHostRetirementError &&
      error.facts.hostId === 'test-host' &&
      error.facts.hostEpoch === 'test-host-epoch' &&
      error.facts.rootPath === '/test-root' &&
      error.facts.pid === 42 &&
      error.cause instanceof Error &&
      error.cause.message === 'Runtime Host refused authorized retirement',
  );
  await owner.close();
});

test('fences replacement launches while force-terminating the exact failed retirement', async () => {
  const events: string[] = [];
  const current = candidateHarness({
    ownedProcess: {
      pid: 42,
      exited: new Promise(() => {}),
    },
  });
  const owner = await startRuntimeHostDesktopManager({
    rootPath: '/test-root',
    candidateLaunchBarrier: {
      connect: async () => assert.fail('mocked candidate startup bypasses the barrier'),
      pause: () => events.push('pause'),
      retireExcept: async (pid: number) => {
        events.push(`retire:${pid}`);
      },
      resume: () => events.push('resume'),
      release: () => events.push('release'),
    },
  } as unknown as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => ready(current.candidate),
    forceTerminateHost: async (identity, stillOwnsProcess) => {
      assert.deepEqual(identity, {
        rootPath: '/test-root',
        rootId: 'test-host',
        hostEpoch: 'test-host-epoch',
        pid: 42,
      });
      assert.equal(stillOwnsProcess(), true);
      events.push('terminate');
      return true;
    },
  });

  assert.equal(
    await owner.forceTerminateOwnedLocalHost({
      hostId: 'test-host',
      hostEpoch: 'test-host-epoch',
      lifecycleMode: 'ephemeral',
      rootPath: '/test-root',
      pid: 42,
      forceTerminationAvailable: true,
    }),
    true,
  );
  assert.deepEqual(events, ['pause', 'retire:42', 'terminate']);
  assert.equal((await owner.retireOwnedLocalHost('refuse_active_work')).kind, 'retired');
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

  await assert.rejects(
    owner.retireOwnedLocalHost('refuse_active_work'),
    (error: unknown) =>
      error instanceof DesktopLocalHostRetirementError &&
      error.facts.pid === 42 &&
      error.cause instanceof Error &&
      error.cause.message === 'retirement failed',
  );
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

  assert.deepEqual(await owner.retireOwnedLocalHost('refuse_active_work'), {
    kind: 'active_tasks',
  });
  await owner.handleBotIncomingMessage({ text: 'still connected' } as BotIncomingMessage);
  assert.equal(current.botMessages, 1);
  const authorized = await owner.retireOwnedLocalHost('interrupt_active_work');
  assert.equal(authorized.kind, 'retired');
  assert.deepEqual(current.retirementModes, ['refuse_active_work', 'interrupt_active_work']);
  assert.deepEqual(waitedFor, [42]);
  await owner.close();
});

for (const ownership of ['supervised', 'external'] as const) {
  test(`leaves ${ownership} Host ownership intact during a Desktop update`, async () => {
    const current = candidateHarness({ ownership });
    const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
      startCandidate: async () => ready(current.candidate),
      waitForHostExit: async () => assert.fail(`${ownership} Host exit must not be awaited`),
    });

    const retirement = await owner.retireOwnedLocalHost('refuse_active_work');
    assert.equal(retirement.kind, 'not_owned');
    assert.equal(current.prepareRetirementCalls, 0);
    await owner.handleBotIncomingMessage({ text: 'still connected' } as BotIncomingMessage);
    assert.equal(current.botMessages, 1);
    await owner.close();
  });
}

test('keeps Local and remote Hosts active and routes work by owning Host', async () => {
  const local = candidateHarness({ hostId: 'host-a' });
  const remote = candidateHarness({ hostId: 'host-b', ownership: 'external' });
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

test('does not poll a remote service PID when the Host cannot be replaced', async () => {
  const local = candidateHarness({ hostId: 'host-local' });
  const observed = upgradeRequired(false);
  const conflict = {
    ...observed,
    registration: { ...observed.registration, lifecycleMode: 'service' as const },
  };
  const manager = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async (input) =>
        input.profileTarget ? conflict : ready(local.candidate),
      upgradePrompts: {
        restartable: async () => assert.fail('non-restartable conflict used restart prompt'),
        nonRestartable: async (_conflict, action) => {
          assert.equal(action, 'cancel_only');
          return 'cancel';
        },
      },
      waitForHostRetirement: async () => assert.fail('remote PID must not be polled locally'),
    },
  );

  await assert.rejects(
    manager.enable(remoteTarget('legacy-service')),
    RuntimeHostUpgradeCancelledError,
  );
  await manager.close();
});

test('keeps independent shared-session credentials active for the same Host', async () => {
  const candidates = [
    candidateHarness({ hostId: 'host-local' }).candidate,
    candidateHarness({ hostId: 'a'.repeat(64), ownership: 'external' }).candidate,
    candidateHarness({ hostId: 'a'.repeat(64), ownership: 'external' }).candidate,
    candidateHarness({ hostId: 'a'.repeat(64), ownership: 'external' }).candidate,
  ];
  const manager = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    { startCandidate: async () => ready(candidates.shift()!) },
  );

  await manager.mountGuest(remoteTarget('shared-one', 'shared', 'session_guest'), () => undefined);
  await manager.mountGuest(remoteTarget('shared-two', 'shared', 'session_guest'), () => undefined);
  await manager.enable(remoteTarget('owner', 'shared'));

  assert.deepEqual(manager.entries().map(({ target }) => target.profile.id), [
    'local',
    'shared-one',
    'shared-two',
    'owner',
  ]);
  assert.notEqual(manager.current('shared-one')?.epoch, manager.current('shared-two')?.epoch);
  await manager.close();
});

test('aborts an in-flight Guest mount without publishing a late target', async () => {
  const local = candidateHarness({ hostId: 'host-local' }).candidate;
  let guestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    guestStarted = resolve;
  });
  const manager = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async (input) => {
        if (!input.profileTarget) return ready(local);
        guestStarted();
        const signal = input.signal;
        assert.ok(signal);
        return new Promise<DesktopRuntimeHostCandidateStartResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    },
  );
  const abort = new AbortController();
  const mounting = manager.mountGuest(
    remoteTarget('shared-cancelled', 'shared', 'session_guest'),
    () => undefined,
    abort.signal,
  );
  await started;
  abort.abort(new Error('cancelled'));
  await assert.rejects(mounting, /cancelled/u);
  await manager.unmountGuest('shared-cancelled');

  assert.deepEqual(manager.entries().map(({ target }) => target.profile.id), ['local']);
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

test('reconnects after a pairing candidate becomes bound to this Client', async () => {
  const local = candidateHarness({ hostId: 'host-a' });
  const remoteHostId = 'a'.repeat(64);
  const candidate = candidateHarness({
    hostId: remoteHostId,
    finalizeReconnectRequired: true,
  });
  const claimed = candidateHarness({ hostId: remoteHostId });
  const queue = [local.candidate, candidate.candidate, claimed.candidate];
  const manager = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () => ready(queue.shift()!),
      reconnectBackoff: { minMs: 0, maxMs: 0 },
    },
  );
  await manager.enable(remoteTarget('office'));

  await manager.finalizePairing('office');

  assert.equal(candidate.finalizeCalls, 1);
  assert.equal(candidate.closeCalls, 1);
  assert.equal(manager.current('office')?.candidate, claimed.candidate);
  await manager.close();
});

test('completes Guest import at credential activation while reconnect continues', async () => {
  const local = candidateHarness({ hostId: 'host-a' });
  const remoteHostId = 'a'.repeat(64);
  const pending = candidateHarness({
    hostId: remoteHostId,
    finalizeReconnectRequired: true,
  });
  const active = candidateHarness({ hostId: remoteHostId });
  let releaseActive!: () => void;
  const activeReleased = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  let starts = 0;
  const phases: string[] = [];
  const routeRefreshes: Array<boolean | undefined> = [];
  const manager = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async (input) => {
        starts += 1;
        if (input.profileTarget) {
          routeRefreshes.push(input.refreshPeerRoutes);
          input.onConnectionPhase?.('discovering');
          input.onConnectionPhase?.('connecting');
        }
        if (starts === 1) return ready(local.candidate);
        if (starts === 2) return ready(pending.candidate);
        await activeReleased;
        return ready(active.candidate);
      },
      reconnectBackoff: { minMs: 0, maxMs: 0 },
    },
  );
  await manager.mountGuest(
    peerGuestTarget('shared-session'),
    () => undefined,
    undefined,
    (phase) => phases.push(phase),
  );
  let activations = 0;

  const result = await manager.finalizeGuestAccess('shared-session', undefined, () => {
    activations += 1;
  });

  assert.equal(result, 'reconnecting');
  assert.equal(manager.current('shared-session')?.readiness, 'reconnecting');
  assert.deepEqual(phases, ['discovering', 'connecting']);
  assert.equal(activations, 1);
  assert.equal(pending.closeCalls, 1);
  releaseActive();
  await manager.waitUntilReady('shared-session');
  assert.deepEqual(routeRefreshes, [undefined, false]);
  assert.equal(manager.current('shared-session')?.candidate, active.candidate);
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

test('bounds an in-flight pairing finalization and preserves its unknown outcome', async () => {
  const local = candidateHarness({ hostId: 'host-a' });
  const remote = candidateHarness({
    hostId: 'a'.repeat(64),
    finalizeFailures: [
      new RuntimeHostRequestInterruptedError(
        'access.credential.finalize',
        'command',
        'dispatched',
        'timeout',
      ),
    ],
  });
  let starts = 0;
  const manager = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () => ready(starts++ === 0 ? local.candidate : remote.candidate),
      pairingFinalizationTimeoutMs: 25,
    },
  );
  await manager.enable(remoteTarget('office'));

  await assert.rejects(
    () => manager.finalizePairing('office'),
    RuntimeHostPairingFinalizationInterruptedError,
  );

  assert.equal(remote.finalizeCalls, 1);
  assert.equal(remote.finalizeTimeouts.length, 1);
  assert.ok(remote.finalizeTimeouts[0]! > 0 && remote.finalizeTimeouts[0]! <= 25);
  await manager.close();
});

test('coalesces concurrent enable requests for one remote profile', async () => {
  const local = candidateHarness({ hostId: 'host-a' });
  const remote = candidateHarness({ hostId: 'host-b', ownership: 'external' });
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
  const remote = candidateHarness({ hostId: 'host-b', ownership: 'external' });
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

test('keeps an initially unavailable Direct target live and wakes it on new routes', async () => {
  const local = candidateHarness();
  const remote = candidateHarness({ hostId: 'a'.repeat(64), ownership: 'external' });
  let starts = 0;
  let routeListener: (() => void) | undefined;
  let reportBackoff!: () => void;
  const waitingForBackoff = new Promise<void>((resolve) => {
    reportBackoff = resolve;
  });
  const manager = await startRuntimeHostDesktopManager(
    {
      peerClient: {
        subscribeRoutes: (peerId: string, listener: () => void) => {
          assert.equal(peerId, '12D3KooWpeer');
          routeListener = listener;
          return () => undefined;
        },
      },
    } as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () => {
        starts += 1;
        if (starts === 1) return ready(local.candidate);
        if (starts <= 3) return { kind: 'failed', reason: 'host_unresponsive' };
        return ready(remote.candidate);
      },
      reconnectBackoff: {
        minMs: 30_000,
        maxMs: 30_000,
        wait: (_delayMs, signal) =>
          new Promise<void>((_resolve, reject) => {
            reportBackoff();
            const onAbort = () => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          }),
      },
    },
  );

  await manager.enable(peerTarget('office'));
  await waitingForBackoff;
  assert.equal(
    manager.entries().find((state) => state.target.profile.id === 'office')?.readiness,
    'reconnecting',
  );
  assert.equal(manager.current('office')?.readiness, 'reconnecting');
  assert.equal(manager.current('office')?.candidate, undefined);
  assert.ok(routeListener);

  routeListener();
  await manager.waitUntilReady('office');
  assert.equal(manager.current('office')?.candidate, remote.candidate);
  assert.equal(starts, 4);
  await manager.close();
});

test('does not activate a Direct target whose immediate retry fails permanently', async () => {
  const local = candidateHarness();
  const permanent = new RuntimeHostPermanentReconnectError('credential rejected');
  let starts = 0;
  const manager = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () => {
        starts += 1;
        if (starts === 1) return ready(local.candidate);
        if (starts === 2) throw new Error('route is temporarily unavailable');
        throw permanent;
      },
    },
  );

  await assert.rejects(manager.enable(peerTarget('office')), (error: unknown) => error === permanent);
  assert.equal(starts, 3);
  assert.equal(manager.current('office'), undefined);
  const state = manager.entries().find((entry) => entry.target.profile.id === 'office');
  assert.equal(state?.readiness, 'unavailable');
  if (state?.readiness === 'unavailable') assert.equal(state.error, permanent);
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

test('reconciles interrupted managed setup after a Local discovery result', async () => {
  const managed = candidateHarness({ ownership: 'supervised' });
  const events: string[] = [];
  let starts = 0;
  const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => {
      starts += 1;
      events.push(`discover:${starts}`);
      return starts === 1
        ? { kind: 'failed', reason: 'managed_root_requires_operator' }
        : ready(managed.candidate);
    },
    recoverLocalHost: async () => {
      events.push('reconcile');
      return true;
    },
  });

  assert.deepEqual(events, ['discover:1', 'reconcile', 'discover:2']);
  assert.equal(owner.current('local')?.candidate?.hostOwnership, 'supervised');
  await owner.close();
});

test('reconciles interrupted managed setup after Local discovery throws', async () => {
  const managed = candidateHarness({ ownership: 'supervised' });
  const events: string[] = [];
  let starts = 0;
  const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => {
      starts += 1;
      events.push(`discover:${starts}`);
      if (starts === 1) throw new Error('managed deployment transition is in progress');
      return ready(managed.candidate);
    },
    recoverLocalHost: async () => {
      events.push('reconcile');
      return true;
    },
  });

  assert.deepEqual(events, ['discover:1', 'reconcile', 'discover:2']);
  assert.equal(owner.current('local')?.candidate?.hostOwnership, 'supervised');
  await owner.close();
});

test('stops reconnecting when the replacement Host is incompatible', async () => {
  const first = candidateHarness({
    ownedProcess: { pid: 42, exited: new Promise(() => undefined) },
  });
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
  await assert.rejects(
    owner.retireOwnedLocalHost('interrupt_active_work'),
    (error: unknown) =>
      error instanceof DesktopLocalHostRetirementError &&
      error.facts.pid === 42 &&
      error.cause === fatal,
  );
  await owner.close();
});

test('does not retain manual-stop authority after the owned Host process exits', async () => {
  const first = candidateHarness({
    ownedProcess: {
      pid: 42,
      exited: Promise.resolve({ code: 0, signal: null, stderr: '', stderrTruncated: false }),
    },
  });
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
  await fatalReported;
  assert.deepEqual(await owner.retireOwnedLocalHost('interrupt_active_work'), {
    kind: 'not_owned',
  });
  await owner.close();
});

test('does not block quit after a supervised Local Host becomes permanently unavailable', async () => {
  const first = candidateHarness({ ownership: 'supervised' });
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
  await fatalReported;
  assert.deepEqual(await owner.retireOwnedLocalHost('interrupt_active_work'), {
    kind: 'not_owned',
  });
  await owner.close();
});

test('restarts an idle generation-aware Host without prompting', async () => {
  const replacement = candidateHarness();
  const starts: DesktopRuntimeHostCandidateStartInput[] = [];
  const conflict = upgradeRequired(true);
  const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async (input) => {
      starts.push(input);
      return starts.length === 1 ? conflict : ready(replacement.candidate);
    },
    upgradePrompts: {
      restartable: async () => assert.fail('idle Host must not prompt before restart'),
      nonRestartable: async () => assert.fail('restartable conflict used non-restartable prompt'),
    },
  });

  assert.equal(starts.length, 2);
  assert.equal(starts[1]?.takeoverHostEpoch, conflict.registration.hostEpoch);
  await owner.close();
});

test('prompts before restarting a generation-aware Host with observed activity', async () => {
  const conflicts = [
    ['operation', upgradeRequired(true, 1)],
    ['residency', upgradeRequired(true, 0, [{ label: 'goal', count: 1 }])],
    ['connection', upgradeRequired(true, 0, [], 1)],
  ] as const;

  for (const [activity, conflict] of conflicts) {
    const replacement = candidateHarness();
    let prompts = 0;
    const owner = await startRuntimeHostDesktopManager(
      {} as DesktopRuntimeHostCandidateStartInput,
      {
        startCandidate: async (input) =>
          input.takeoverHostEpoch ? ready(replacement.candidate) : conflict,
        upgradePrompts: {
          restartable: async () => {
            prompts += 1;
            return 'restart';
          },
          nonRestartable: async () =>
            assert.fail('restartable conflict used non-restartable prompt'),
        },
      },
    );

    assert.equal(prompts, 1, activity);
    await owner.close();
  }
});

test('prompts when a restartable Host has no activity snapshot', async () => {
  const replacement = candidateHarness();
  const conflict = upgradeRequired(true, 0, [], 0, false);
  let prompts = 0;
  const owner = await startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async (input) =>
      input.takeoverHostEpoch ? ready(replacement.candidate) : conflict,
    upgradePrompts: {
      restartable: async () => {
        prompts += 1;
        return 'restart';
      },
      nonRestartable: async () => assert.fail('restartable conflict used non-restartable prompt'),
    },
  });

  assert.equal(prompts, 1);
  await owner.close();
});

test('waits passively for a Host that cannot be taken over', async () => {
  const observed = upgradeRequired(false);
  const conflict = {
    ...observed,
    registration: { ...observed.registration, lifecycleMode: 'service' as const },
  };
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
      nonRestartable: async (_conflict, action) => {
        assert.equal(action, 'wait');
        return 'wait';
      },
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

test('offers to stop an exact local ephemeral Host before retrying startup', async () => {
  const observed = incompatibleHost('blocked_by_residency');
  const conflict = {
    ...observed,
    registration: { ...observed.registration, lifecycleMode: 'ephemeral' as const },
    processIdentity: {
      startIdentity: 'darwin:1700000000:123456',
    },
    handshake: {
      ...observed.handshake,
      activity: {
        connections: 0,
        activeOperations: 0,
        processUptimeSeconds: 60,
        residencies: [],
      },
    },
  };
  const replacement = candidateHarness();
  let starts = 0;
  let prompts = 0;
  let terminations = 0;
  const owner = await startRuntimeHostDesktopManager(
    { rootPath: '/workspace' } as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () => {
        starts += 1;
        return starts === 1 ? conflict : ready(replacement.candidate);
      },
      upgradePrompts: {
        restartable: async () => assert.fail('incompatible Host used restart prompt'),
        nonRestartable: async (_conflict, action) => {
          prompts += 1;
          assert.equal(action, 'replace_may_interrupt_work');
          return 'replace';
        },
      },
      forceTerminateObservedHost: async (identity, authority) => {
        terminations += 1;
        assert.deepEqual(identity, {
          rootPath: '/workspace',
          registration: conflict.registration,
        });
        assert.deepEqual(authority.processIdentity, conflict.processIdentity);
        assert.equal(authority.isCurrent(), true);
        return true;
      },
    },
  );

  assert.equal(prompts, 1, 'even an idle snapshot must not authorize a forced stop');
  assert.equal(terminations, 1);
  assert.equal(starts, 2);
  await owner.close();
});

test('silently replaces an idle non-restartable Local Host and retries', async () => {
  const observed = upgradeRequired(true);
  const conflict = {
    ...observed,
    restartable: false as const,
    registration: { ...observed.registration, lifecycleMode: 'service' as const },
  };
  const replacement = candidateHarness();
  let starts = 0;
  let replaced: typeof observed.registration | undefined;
  const policies: string[] = [];
  const owner = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () => {
        starts += 1;
        return starts === 1 ? conflict : ready(replacement.candidate);
      },
      upgradePrompts: {
        restartable: async () => assert.fail('non-restartable conflict used restart prompt'),
        nonRestartable: async () => assert.fail('idle replaceable Host must not prompt'),
      },
      resolveLocalHostReplacement: async (registration) => ({
        replace: async (policy) => {
          policies.push(policy);
          replaced = registration;
          return 'replaced';
        },
      }),
    },
  );
  assert.equal(starts, 2);
  assert.equal(replaced?.hostEpoch, conflict.registration.hostEpoch);
  assert.deepEqual(policies, ['refuse_active_work']);
  await owner.close();
});

test('prompts if a non-restartable Local Host omits its activity snapshot', async () => {
  const observed = upgradeRequired(false);
  const conflict = {
    ...observed,
    registration: { ...observed.registration, lifecycleMode: 'service' as const },
  };
  const replacement = candidateHarness();
  const policies: string[] = [];
  let starts = 0;
  let prompts = 0;
  const owner = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () => {
        starts += 1;
        return starts === 1 ? conflict : ready(replacement.candidate);
      },
      upgradePrompts: {
        restartable: async () => assert.fail('non-restartable conflict used restart prompt'),
        nonRestartable: async (_conflict, action) => {
          prompts += 1;
          assert.equal(action, 'replace_may_interrupt_work');
          return 'replace';
        },
      },
      resolveLocalHostReplacement: async () => ({
        replace: async (policy) => {
          policies.push(policy);
          return 'replaced';
        },
      }),
    },
  );

  assert.equal(prompts, 1);
  assert.equal(starts, 2);
  assert.deepEqual(policies, ['interrupt_active_work']);
  await owner.close();
});

test('prompts if an observed-idle Host becomes active before replacement', async () => {
  const observed = upgradeRequired(true);
  const conflict = {
    ...observed,
    restartable: false as const,
    registration: { ...observed.registration, lifecycleMode: 'service' as const },
  };
  const replacement = candidateHarness();
  const policies: string[] = [];
  let starts = 0;
  let prompts = 0;
  const owner = await startRuntimeHostDesktopManager(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () => {
        starts += 1;
        return starts === 1 ? conflict : ready(replacement.candidate);
      },
      upgradePrompts: {
        restartable: async () => assert.fail('non-restartable conflict used restart prompt'),
        nonRestartable: async (_conflict, action) => {
          prompts += 1;
          assert.equal(action, 'replace_may_interrupt_work');
          return 'replace';
        },
      },
      resolveLocalHostReplacement: async () => ({
        replace: async (policy) => {
          policies.push(policy);
          return policy === 'refuse_active_work' ? 'active_tasks' : 'replaced';
        },
      }),
    },
  );

  assert.equal(prompts, 1);
  assert.equal(starts, 2);
  assert.deepEqual(policies, ['refuse_active_work', 'interrupt_active_work']);
  await owner.close();
});

test('does not authorize active-work interruption when replacement is cancelled', async () => {
  const observed = upgradeRequired(false);
  const conflict = {
    ...observed,
    registration: { ...observed.registration, lifecycleMode: 'service' as const },
  };
  const policies: string[] = [];

  await assert.rejects(
    startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
      startCandidate: async () => conflict,
      upgradePrompts: {
        restartable: async () => assert.fail('non-restartable conflict used restart prompt'),
        nonRestartable: async () => 'cancel',
      },
      resolveLocalHostReplacement: async () => ({
        replace: async (policy) => {
          policies.push(policy);
          return 'active_tasks';
        },
      }),
      onFatalError: () => undefined,
    }),
    RuntimeHostUpgradeCancelledError,
  );
  assert.deepEqual(policies, []);
});

test('lets the user cancel startup when an incompatible Host owns the root', async () => {
  const conflict = incompatibleHost('blocked_by_residency');
  let presented: DesktopRuntimeHostCandidateStartResult | undefined;
  await assert.rejects(
    startRuntimeHostDesktopManager({} as DesktopRuntimeHostCandidateStartInput, {
      startCandidate: async () => conflict,
      upgradePrompts: {
        restartable: async () => assert.fail('incompatible Host used restart prompt'),
        nonRestartable: async (actual, action) => {
          presented = actual;
          assert.equal(action, 'wait');
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
): Extract<DesktopRuntimeHostCandidateStartResult, { kind: 'incompatible' }> {
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
  activeOperations = 0,
  residencies: readonly { readonly label: string; readonly count: number }[] = [],
  connections = 0,
  includeActivity = true,
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
      ...(includeActivity
        ? {
            activity: {
              connections,
              activeOperations,
              processUptimeSeconds: 60,
              residencies,
            },
          }
        : {}),
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
    activeTasks?: boolean | 'always';
    ownership?: 'owned_ephemeral' | 'supervised' | 'external';
    ownedProcess?: RuntimeHostSpawnedProcess;
    hostId?: string;
    hostEpoch?: string;
    finalizeFailures?: Error[];
    finalizeReconnectRequired?: boolean;
    disconnectOnFinalizeFailure?: boolean;
    onPrepare?: (mode: string) => unknown | Promise<unknown>;
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
  let prepareRetirementCalls = 0;
  let finalizeCalls = 0;
  const finalizeTimeouts: number[] = [];
  const retirementModes: string[] = [];
  const candidate = {
    closed,
    hostOwnership: options.ownership ?? 'owned_ephemeral',
    hostPid: 42,
    ...(options.ownedProcess ? { ownedProcess: options.ownedProcess } : {}),
    client: {
      hostId: options.hostId ?? 'test-host',
      hostEpoch: options.hostEpoch ?? 'test-host-epoch',
      get lifecycleState() {
        return lifecycleState;
      },
      async queryHostDiagnostics() {
        return { pid: 42 };
      },
      async prepareHostRetirement(mode: string) {
        prepareRetirementCalls += 1;
        retirementModes.push(mode);
        await options.onPrepare?.(mode);
        if (
          (options.activeTasks && mode === 'refuse_active_work') ||
          options.activeTasks === 'always'
        ) {
          return { kind: 'active_tasks' as const };
        }
        if (options.disconnectOnPrepare) {
          lifecycleState = 'unavailable';
          resolveClosed?.();
        }
        return { kind: 'prepared' as const, pid: 42 };
      },
      async finalizeAccessCredential(timeoutMs?: number) {
        finalizeCalls += 1;
        if (timeoutMs !== undefined) finalizeTimeouts.push(timeoutMs);
        const failure = options.finalizeFailures?.shift();
        if (failure) {
          if (options.disconnectOnFinalizeFailure) {
            lifecycleState = 'unavailable';
            resolveClosed?.();
          }
          throw failure;
        }
        return { reconnectRequired: options.finalizeReconnectRequired ?? false };
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
    get prepareRetirementCalls() {
      return prepareRetirementCalls;
    },
    get retirementModes() {
      return retirementModes;
    },
    get finalizeCalls() {
      return finalizeCalls;
    },
    finalizeTimeouts,
  };
}

function ready(candidate: DesktopRuntimeHostCandidate): DesktopRuntimeHostCandidateStartResult {
  return { kind: 'ready', candidate };
}

function remoteTarget(
  id: string,
  target = 'default',
  access?: 'session_guest',
): NonNullable<DesktopRuntimeHostCandidateStartInput['profileTarget']> {
  return {
    profile: {
      id,
      name: id,
      kind: 'remote',
      transport: { kind: 'tls', url: `wss://${target}.example.com/` },
      rootId: 'a'.repeat(64),
      ...(access ? { access } : {}),
    },
    credential: `credential-${target}`,
  };
}

function peerGuestTarget(
  id: string,
): NonNullable<DesktopRuntimeHostCandidateStartInput['profileTarget']> {
  return peerTarget(id, 'session_guest');
}

function peerTarget(
  id: string,
  access?: 'session_guest',
): NonNullable<DesktopRuntimeHostCandidateStartInput['profileTarget']> {
  return {
    profile: {
      id,
      name: id,
      kind: 'remote',
      transport: {
        kind: 'libp2p-direct',
        reachability: testPeerReachability('12D3KooWpeer'),
      },
      rootId: 'a'.repeat(64),
      ...(access ? { access } : {}),
    },
    credential: 'credential-peer',
  };
}

function testPeerReachability(peerId: string) {
  return {
    lease: {
      version: 1 as const,
      peerId,
      revision: 1,
      issuedAt: 1,
      expiresAt: 2,
      directRoutes: ['/ip4/192.0.2.1/udp/41000/quic-v1'],
      coordinationRoutes: [],
    },
    publicKey: Buffer.from('public').toString('base64url'),
    signature: Buffer.from('signature').toString('base64url'),
  };
}
