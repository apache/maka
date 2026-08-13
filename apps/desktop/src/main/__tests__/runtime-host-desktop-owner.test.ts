import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotIncomingMessage } from '@maka/runtime/bots';
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
  RuntimeHostUpgradeCancelledError,
  startRuntimeHostDesktopOwner,
} from '../runtime-host-desktop-owner.js';
import type { RuntimeHostSessionObservationRegistry } from '../runtime-host-session-observation-registry.js';

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
  const owner = await startRuntimeHostDesktopOwner({
    remote: { ...remoteTarget('office'), sshInteraction: 'terminal' },
  } as DesktopRuntimeHostCandidateStartInput, {
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
  assert.equal(second.botMessages, 0);
  assert.deepEqual(second.stoppedSessions, []);
  releaseSecond();
  await Promise.all([botMessage, stop]);

  assert.equal(first.botMessages, 0);
  assert.equal(second.botMessages, 1);
  assert.deepEqual(second.stoppedSessions, ['session-1']);
  assert.deepEqual(readiness, ['connecting', 'ready', 'reconnecting', 'ready']);
  assert.deepEqual(interactions, ['terminal', 'batch']);
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
  const owner = await startRuntimeHostDesktopOwner({} as DesktopRuntimeHostCandidateStartInput, {
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

test('keeps the current Host when update preparation reports active tasks', async () => {
  const current = candidateHarness({ activeTasks: true });
  const owner = await startRuntimeHostDesktopOwner({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => ready(current.candidate),
  });

  assert.deepEqual(await owner.prepareForUpdate(false), { kind: 'active_tasks' });
  await owner.handleBotIncomingMessage({ text: 'still connected' } as BotIncomingMessage);
  assert.equal(current.botMessages, 1);
  assert.deepEqual(current.prepareUpgradeAuthorities, [false]);
  await owner.close();
});

for (const lifecycleMode of ['service', 'remote'] as const) {
  test(`does not retire a ${lifecycleMode} Host for a Desktop update`, async () => {
    const current = candidateHarness({ lifecycleMode });
    const owner = await startRuntimeHostDesktopOwner({} as DesktopRuntimeHostCandidateStartInput, {
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

test('switches Runtime Host targets without replacing the Desktop owner', async () => {
  const local = candidateHarness();
  const remote = candidateHarness({ lifecycleMode: 'remote' });
  const starts: DesktopRuntimeHostCandidateStartInput[] = [];
  const activations: Array<{ epoch: string; profileId: string }> = [];
  const owner = await startRuntimeHostDesktopOwner(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async (input) => {
        starts.push(input);
        return ready(starts.length === 1 ? local.candidate : remote.candidate);
      },
      onTargetStateChanged: ({ epoch, target, readiness }) => {
        if (readiness === 'ready') activations.push({ epoch, profileId: target.profile.id });
      },
    },
  );

  await owner.switchTarget(remoteTarget('office'));
  await owner.handleBotIncomingMessage({ text: 'remote' } as BotIncomingMessage);

  assert.equal(local.closeCalls, 1);
  assert.equal(remote.botMessages, 1);
  assert.equal(starts[1]?.remote?.profile.id, 'office');
  assert.equal(starts[0]?.isTargetActive?.(), false);
  assert.equal(starts[1]?.isTargetActive?.(), true);
  assert.deepEqual(activations.map(({ profileId }) => profileId), ["local", "office"]);
  assert.notEqual(activations[0]?.epoch, activations[1]?.epoch);
  await owner.close();
});

test('does not apply an old Host resource stop after a target switch', async () => {
  const local = candidateHarness({ hostId: 'host-a' });
  const remote = candidateHarness({ hostId: 'host-b', lifecycleMode: 'remote' });
  let releaseRemote!: () => void;
  const remoteGate = new Promise<void>((resolve) => {
    releaseRemote = resolve;
  });
  let starts = 0;
  const owner = await startRuntimeHostDesktopOwner(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () => {
        starts += 1;
        if (starts === 1) return ready(local.candidate);
        await remoteGate;
        return ready(remote.candidate);
      },
    },
  );

  const staleTargetEpoch = owner.current()!.epoch;
  const switching = owner.switchTarget(remoteTarget('office'));
  const stopping = owner.stopSession({
    hostId: 'host-a',
    targetEpoch: staleTargetEpoch,
    sessionId: 'shared-session',
  });
  releaseRemote();
  await Promise.all([switching, stopping]);

  assert.deepEqual(local.stoppedSessions, []);
  assert.deepEqual(remote.stoppedSessions, []);
  await owner.close();
});

test('lets a target switch cancel a stop waiting for reconnect', async () => {
  const local = candidateHarness({ hostId: 'host-a' });
  const remote = candidateHarness({ hostId: 'host-b', lifecycleMode: 'remote' });
  let reconnectStarted!: () => void;
  const reconnecting = new Promise<void>((resolve) => {
    reconnectStarted = resolve;
  });
  let starts = 0;
  const owner = await startRuntimeHostDesktopOwner(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async (input) => {
        starts += 1;
        if (starts === 1) return ready(local.candidate);
        if (starts === 2) {
          reconnectStarted();
          await new Promise<void>((_resolve, reject) => {
            const rejectAborted = () => reject(input.signal?.reason);
            if (input.signal?.aborted) rejectAborted();
            else input.signal?.addEventListener('abort', rejectAborted, { once: true });
          });
          assert.fail('the abandoned reconnect must not produce a candidate');
        }
        return ready(remote.candidate);
      },
      reconnectBackoff: {
        minMs: 1,
        maxMs: 1,
        random: () => 0,
        wait: async () => {},
      },
    },
  );

  local.disconnect();
  await reconnecting;
  const stopping = owner.stopSession({
    hostId: 'host-a',
    targetEpoch: owner.current()!.epoch,
    sessionId: 'shared-session',
  });
  await owner.switchTarget(remoteTarget('office'));
  await stopping;

  assert.equal(starts, 3);
  assert.deepEqual(remote.stoppedSessions, []);
  await owner.close();
});

test('restores the previous Runtime Host when a target switch fails', async () => {
  const first = candidateHarness();
  const restored = candidateHarness();
  const starts: DesktopRuntimeHostCandidateStartInput[] = [];
  const fatalErrors: Error[] = [];
  const states: Array<{
    epoch: string;
    profileId: string;
    readiness: string;
    hostId?: string;
  }> = [];
  const owner = await startRuntimeHostDesktopOwner(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async (input) => {
        starts.push(input);
        if (starts.length === 2) {
          return { kind: 'failed', reason: 'host_unresponsive' };
        }
        if (starts.length === 3) {
          assert.equal(input.isTargetActive?.(), true);
          assert.equal(owner.current()?.epoch, states.at(-1)?.epoch);
          assert.equal(owner.current()?.readiness, 'reconnecting');
        }
        return ready(starts.length === 1 ? first.candidate : restored.candidate);
      },
      onFatalError: (error) => fatalErrors.push(error),
      onTargetStateChanged: (state) => {
        states.push({
          epoch: state.epoch,
          profileId: state.target.profile.id,
          readiness: state.readiness,
          ...('hostId' in state && state.hostId ? { hostId: state.hostId } : {}),
        });
      },
    },
  );

  await assert.rejects(owner.switchTarget(remoteTarget('offline')), /stopped responding/);
  await owner.handleBotIncomingMessage({ text: 'restored' } as BotIncomingMessage);

  assert.equal(first.closeCalls, 1);
  assert.equal(restored.botMessages, 1);
  assert.equal(starts[1]?.remote?.profile.id, 'offline');
  assert.equal(starts[2]?.remote, undefined);
  assert.equal(starts[0]?.isTargetActive?.(), false);
  assert.equal(starts[1]?.isTargetActive?.(), false);
  assert.equal(starts[2]?.isTargetActive?.(), true);
  const activations = states.filter(({ readiness }) => readiness === 'ready');
  assert.deepEqual(activations.map(({ profileId }) => profileId), ['local', 'local']);
  assert.notEqual(activations[0]?.epoch, activations[1]?.epoch);
  const rollbackConnecting = states.at(-2);
  assert.equal(rollbackConnecting?.readiness, 'connecting');
  assert.equal(rollbackConnecting?.epoch, activations[1]?.epoch);
  assert.equal(rollbackConnecting?.hostId, first.candidate.client.hostId);
  assert.deepEqual(fatalErrors, []);
  await owner.close();
});

test('releases a Session observation while a failed target switch rolls back', async () => {
  const first = candidateHarness();
  const restored = candidateHarness();
  const registries: RuntimeHostSessionObservationRegistry[] = [];
  let switchStarted!: () => void;
  let failSwitch!: () => void;
  const switchingStarted = new Promise<void>((resolve) => {
    switchStarted = resolve;
  });
  const switchFailure = new Promise<void>((resolve) => {
    failSwitch = resolve;
  });
  let starts = 0;
  const owner = await startRuntimeHostDesktopOwner(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async (_input, observations) => {
        starts += 1;
        registries.push(observations);
        if (starts === 2) {
          switchStarted();
          await switchFailure;
          return { kind: 'failed', reason: 'host_unresponsive' };
        }
        return ready(starts === 1 ? first.candidate : restored.candidate);
      },
    },
  );
  const observations = registries[0];
  assert.ok(observations);
  const observing = observations.observe('session-1', 'observer-1', {
    id: 1,
    send() {},
    once() {},
    off() {},
  });

  const switching = owner.switchTarget(remoteTarget('offline'));
  await switchingStarted;
  await owner.unobserveSession('observer-1');
  await assert.rejects(observing, /ended before it became ready/);
  failSwitch();
  await assert.rejects(switching, /stopped responding/);
  assert.equal(registries[2], observations);
  await owner.close();
});

test('reports no active Host when both target switch and restoration fail', async () => {
  const first = candidateHarness();
  const recovered = candidateHarness();
  const fatalErrors: Error[] = [];
  const readiness: string[] = [];
  let starts = 0;
  const owner = await startRuntimeHostDesktopOwner(
    {} as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () => {
        starts += 1;
        if (starts === 1) return ready(first.candidate);
        if (starts === 4) return ready(recovered.candidate);
        return { kind: 'failed', reason: 'host_unresponsive' };
      },
      onFatalError: (error) => fatalErrors.push(error),
      onTargetStateChanged: (state) => readiness.push(state.readiness),
    },
  );

  await assert.rejects(
    owner.switchTarget(remoteTarget('offline')),
    /previous Host could not be restored/,
  );

  assert.equal(owner.current(), undefined);
  assert.deepEqual(fatalErrors, []);
  assert.deepEqual(readiness, [
    'connecting',
    'ready',
    'connecting',
    'connecting',
    'unavailable',
  ]);
  await owner.switchTarget(undefined);
  assert.equal(owner.current()?.target.profile.id, 'local');
  assert.deepEqual(readiness.slice(-2), ['connecting', 'ready']);
  await owner.close();
});

test('reconnects when the same profile id resolves to a different target', async () => {
  const first = candidateHarness({ lifecycleMode: 'remote' });
  const second = candidateHarness({ lifecycleMode: 'remote' });
  let starts = 0;
  const owner = await startRuntimeHostDesktopOwner(
    { remote: remoteTarget('office', 'a') } as DesktopRuntimeHostCandidateStartInput,
    {
      startCandidate: async () => ready(starts++ === 0 ? first.candidate : second.candidate),
    },
  );

  await owner.switchTarget(remoteTarget('office', 'b'));
  await owner.handleBotIncomingMessage({ text: 'new target' } as BotIncomingMessage);

  assert.equal(first.closeCalls, 1);
  assert.equal(second.botMessages, 1);
  assert.equal(starts, 2);
  await owner.close();
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
  const owner = await startRuntimeHostDesktopOwner({} as DesktopRuntimeHostCandidateStartInput, {
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
  const owner = await startRuntimeHostDesktopOwner({} as DesktopRuntimeHostCandidateStartInput, {
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
  const owner = await startRuntimeHostDesktopOwner({} as DesktopRuntimeHostCandidateStartInput, {
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
  const ownerTask = startRuntimeHostDesktopOwner({} as DesktopRuntimeHostCandidateStartInput, {
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
    startRuntimeHostDesktopOwner({} as DesktopRuntimeHostCandidateStartInput, {
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
  const prepareUpgradeAuthorities: boolean[] = [];
  const candidate = {
    closed,
    hostLifecycleMode: options.lifecycleMode ?? 'ephemeral',
    client: {
      hostId: options.hostId ?? 'test-host',
      get lifecycleState() {
        return lifecycleState;
      },
      async prepareHostUpgrade(allowInterruptActiveTasks: boolean) {
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
