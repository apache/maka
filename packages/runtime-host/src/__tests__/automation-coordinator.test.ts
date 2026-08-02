import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, test } from 'node:test';
import type { AgentRunHeader, SessionHeader } from '@maka/core';
import type { AutomationDefinition, AutomationPendingFire } from '@maka/core/automation';
import {
  RuntimeHostedRootConflictError,
  RuntimeHostedRootUnavailableError,
  type MakaToolContext,
  type RuntimeHostedRootExecutionInput,
  type SessionManager,
} from '@maka/runtime';
import {
  openInteractiveAutomationAuthorityForWrite,
  type InteractiveAutomationAuthorityWriter,
} from '@maka/storage/automation-authority';
import type {
  ExecutionAgentRunWriter,
  ExecutionSessionWriter,
  RootTurnAdmission,
} from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import { HostAutomationCoordinator } from '../server/automation-coordinator.js';
import { HostAutomationFireCoordinator } from '../server/automation-fire-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const CONNECTION_CONTEXT: ConnectionContext = {
  hostEpoch: 'automation-test',
  connectionId: 'automation-test-connection',
  surface: 'tui',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

const ASYNC_STATE_TIMEOUT_MS = 5_000;
const ASYNC_STATE_POLL_MS = 5;

describe('Host Automation coordinator', () => {
  test('atomically admits one heartbeat fire and settles the same durable Run identity', async () => {
    await withHarness(async (harness) => {
      await harness.coordinator.prepareRecovery();
      await harness.coordinator.recover();
      harness.coordinator.start();

      const created = await harness.coordinator.create({
        kind: 'heartbeat',
        name: 'check build',
        prompt: 'Check the build.',
        sessionId: 'creator-session',
        schedule: { type: 'once', delaySeconds: 5 },
      });
      assert.ok(!('error' in created));
      if ('error' in created) return;
      harness.now = created.nextFireAt ?? assert.fail('Expected a scheduled fire');

      harness.fireTimer();
      await waitFor(
        'heartbeat fire to enter running state',
        async () => (await harness.store.read()).pendingFires[0]?.status === 'running',
      );
      const admitted = await harness.store.read();
      assert.equal(admitted.pendingFires.length, 1);
      assert.equal(admitted.automations[0]?.fireCount, 1);
      assert.equal(admitted.automations[0]?.nextFireAt, null);
      assert.equal(harness.rootInputs.length, 1);
      const fire = admitted.pendingFires[0];
      assert.ok(fire);
      assert.equal(harness.rootInputs[0]?.runId, fire.runId);
      assert.equal(harness.rootInputs[0]?.userMessageId, fire.userMessageId);

      harness.finishRun();
      await waitFor(
        'heartbeat fire to settle',
        async () => (await harness.store.read()).pendingFires.length === 0,
      );
      const settled = await harness.store.read();
      assert.equal(settled.automations[0]?.status, 'completed');
      assert.equal(settled.automations[0]?.lastRunId, fire.runId);
      assert.equal(settled.automations[0]?.lastError, null);
      assert.equal(harness.residencyCount, 0);
    });
  });

  test('recovers a pre-Run pending fire without allocating any new identity', async () => {
    await withHarness(async (harness) => {
      const automation = startedDefinition();
      const fire = pendingFire();
      await harness.store.commit({
        expectedRevision: 0,
        automations: [automation],
        pendingFires: [fire],
      });

      await harness.coordinator.prepareRecovery();
      await harness.coordinator.recover();
      await waitFor(
        'recovered fire to enter the root coordinator',
        () => harness.rootInputs.length === 1,
      );
      const input = harness.rootInputs[0];
      assert.ok(input);
      assert.deepEqual(
        {
          sessionId: input.sessionId,
          turnId: input.turnId,
          runId: input.runId,
          userMessageId: input.userMessageId,
          execution: input.execution,
        },
        {
          sessionId: fire.targetSessionId,
          turnId: fire.turnId,
          runId: fire.runId,
          userMessageId: fire.userMessageId,
          execution: { kind: 'automation', automationId: fire.automationId },
        },
      );

      harness.finishRun();
      await waitFor(
        'recovered fire to settle',
        async () => (await harness.store.read()).pendingFires.length === 0,
      );
      assert.equal((await harness.store.read()).automations[0]?.lastRunId, fire.runId);
    });
  });

  test('settles a terminal Run during recovery without executing it again', async () => {
    await withHarness(async (harness) => {
      const automation = startedDefinition();
      const fire = pendingFire();
      harness.runs.set(fire.runId, runHeader(fire, 'failed'));
      await harness.store.commit({
        expectedRevision: 0,
        automations: [automation],
        pendingFires: [fire],
      });

      await harness.coordinator.prepareRecovery();
      await harness.coordinator.recover();
      assert.equal(harness.rootInputs.length, 0);
      const recovered = await harness.store.read();
      assert.deepEqual(recovered.pendingFires, []);
      assert.equal(recovered.automations[0]?.status, 'paused');
      assert.equal(recovered.automations[0]?.lastRunId, fire.runId);
      assert.equal(recovered.automations[0]?.consecutiveFailures, 1);
    });
  });

  test('settles a terminal Run whose backend recorded an empty failure diagnostic', async () => {
    await withHarness(async (harness) => {
      const automation = startedDefinition();
      const fire = pendingFire();
      harness.runs.set(fire.runId, { ...runHeader(fire, 'failed'), failureMessage: '' });
      await harness.store.commit({
        expectedRevision: 0,
        automations: [automation],
        pendingFires: [fire],
      });

      await harness.coordinator.prepareRecovery();
      await harness.coordinator.recover();
      const recovered = await harness.store.read();
      assert.deepEqual(recovered.pendingFires, []);
      assert.equal(recovered.automations[0]?.lastError, 'Automation run failed');
    });
  });

  test('bounds a multibyte terminal failure while preserving its diagnostic prefix', async () => {
    await withHarness(async (harness) => {
      const automation = startedDefinition();
      const fire = pendingFire();
      const failureMessage = '故'.repeat(4_000);
      harness.runs.set(fire.runId, {
        ...runHeader(fire, 'failed'),
        failureMessage,
      });
      await harness.store.commit({
        expectedRevision: 0,
        automations: [automation],
        pendingFires: [fire],
      });

      await harness.coordinator.prepareRecovery();
      await harness.coordinator.recover();
      const settled = (await harness.store.read()).automations[0];
      assert.equal(settled?.lastError, '故'.repeat(2_000));
      assert.equal(Buffer.byteLength(settled?.lastError ?? '', 'utf8'), 6_000);
      assert.deepEqual((await harness.store.read()).pendingFires, []);
    });
  });

  test('recovers a running fire through the same root and Run identity', async () => {
    await withHarness(async (harness) => {
      const automation = startedDefinition();
      const fire: AutomationPendingFire = {
        ...pendingFire(),
        status: 'running',
        startedAt: 6_001,
        updatedAt: 6_001,
      };
      harness.runs.set(fire.runId, runHeader(fire, 'running'));
      await harness.store.commit({
        expectedRevision: 0,
        automations: [automation],
        pendingFires: [fire],
      });

      await harness.coordinator.prepareRecovery();
      await harness.coordinator.recover();
      assert.equal(harness.rootInputs.length, 1);
      assert.equal(harness.rootInputs[0]?.turnId, fire.turnId);
      assert.equal(harness.rootInputs[0]?.runId, fire.runId);
      assert.equal(harness.rootInputs[0]?.userMessageId, fire.userMessageId);

      harness.finishRun();
      await waitFor(
        'recovered running fire to settle',
        async () => (await harness.store.read()).pendingFires.length === 0,
      );
      assert.equal((await harness.store.read()).automations[0]?.lastRunId, fire.runId);
    });
  });

  test('keeps one busy pending fire retryable and validates its recovery admission', async () => {
    await withHarness(
      async (harness) => {
        const automation = startedDefinition();
        const fire = pendingFire();
        await harness.store.commit({
          expectedRevision: 0,
          automations: [automation],
          pendingFires: [fire],
        });
        harness.rootMode = 'busy';

        await harness.coordinator.prepareRecovery();
        harness.coordinator.assertRecoveryAdmission(rootAdmission(fire));
        assert.throws(
          () =>
            harness.coordinator.assertRecoveryAdmission({
              ...rootAdmission(fire),
              runId: 'different-run',
            }),
          /no matching pending fire/,
        );
        await harness.coordinator.recover();
        assert.equal(harness.rootInputs.length, 1);
        assert.deepEqual((await harness.store.read()).pendingFires, [fire]);

        harness.coordinator.start();
        harness.fireTimer();
        await waitFor(
          'busy fire retry to enter the root coordinator',
          () => harness.rootInputs.length === 2,
        );
        assert.equal(harness.rootInputs[1]?.runId, fire.runId);
        assert.equal((await harness.store.read()).pendingFires[0]?.id, fire.id);
      },
      { rootMode: 'busy' },
    );
  });

  test('keeps an unavailable target retryable without changing its durable fire identity', async () => {
    await withHarness(
      async (harness) => {
        const automation = startedDefinition();
        const fire = pendingFire();
        await harness.store.commit({
          expectedRevision: 0,
          automations: [automation],
          pendingFires: [fire],
        });

        await harness.coordinator.prepareRecovery();
        await harness.coordinator.recover();
        assert.equal(harness.rootInputs.length, 1);
        assert.deepEqual((await harness.store.read()).pendingFires, [fire]);

        harness.coordinator.start();
        harness.fireTimer();
        await waitFor(
          'unavailable fire retry to enter the root coordinator',
          () => harness.rootInputs.length === 2,
        );
        assert.equal(harness.rootInputs[1]?.runId, fire.runId);
        assert.equal((await harness.store.read()).pendingFires[0]?.id, fire.id);
      },
      { rootMode: 'unavailable' },
    );
  });

  test('creates one stable cron Session from the frozen execution template', async () => {
    await withHarness(async (harness) => {
      await harness.coordinator.prepareRecovery();
      await harness.coordinator.recover();
      harness.coordinator.start();
      const created = await harness.coordinator.create({
        kind: 'cron',
        name: 'daily summary',
        prompt: 'Summarize the workspace.',
        sessionId: 'creator-session',
        schedule: { type: 'once', delaySeconds: 5 },
      });
      assert.ok(!('error' in created));
      if ('error' in created) return;
      harness.now = created.nextFireAt ?? assert.fail('Expected a scheduled fire');

      harness.fireTimer();
      await waitFor('cron Session creation', () => harness.stableCreates.length === 1);
      const request = harness.stableCreates[0];
      assert.ok(request);
      assert.match(request.sessionId, /^automation_session_[0-9a-f]{48}$/);
      assert.match(request.requestFingerprint, /^sha256:[0-9a-f]{64}$/);
      assert.equal(request.input.cwd, '/workspace');
      assert.equal(request.input.llmConnectionSlug, 'openrouter');
      assert.equal(request.input.model, 'openrouter/free');
      assert.equal(request.input.permissionMode, 'explore');

      harness.finishRun();
      await waitFor(
        'cron fire to settle',
        async () => (await harness.store.read()).pendingFires.length === 0,
      );
    });
  });

  test('rejects new Automations whose creator Session cannot execute hosted roots', async () => {
    await withHarness(
      async (harness) => {
        await harness.coordinator.prepareRecovery();
        const result = await harness.coordinator.handlers['automation.mutate'](
          {
            kind: 'create',
            sessionId: 'creator-session',
            automationKind: 'heartbeat',
            name: 'unsupported heartbeat',
            prompt: 'This cannot execute here.',
            schedule: { type: 'interval', seconds: 60 },
          },
          CONNECTION_CONTEXT,
        );
        assert.deepEqual(result, {
          ok: false,
          error: {
            code: 'operation_unavailable',
            message: 'Plan sessions are not yet supported by Runtime Host.',
          },
        });
        assert.deepEqual(await harness.store.read(), {
          revision: 0,
          automations: [],
          pendingFires: [],
        });
      },
      { creatorHeader: { collaborationMode: 'plan' } },
    );
  });

  test('defers a due fire while incognito without admitting execution', async () => {
    await withHarness(
      async (harness) => {
        await harness.coordinator.prepareRecovery();
        await harness.coordinator.recover();
        harness.coordinator.start();
        const created = await harness.coordinator.create({
          kind: 'cron',
          name: 'daily summary',
          prompt: 'Summarize the workspace.',
          sessionId: 'creator-session',
          schedule: { type: 'once', delaySeconds: 5 },
        });
        assert.ok(!('error' in created));
        if ('error' in created) return;
        harness.now = created.nextFireAt ?? assert.fail('Expected a scheduled fire');

        harness.fireTimer();
        await waitFor('deferred heartbeat retry timer', () => harness.timerCount() === 1);
        const snapshot = await harness.store.read();
        assert.equal(snapshot.automations[0]?.deferredFireCount, 1);
        assert.equal(snapshot.automations[0]?.fireCount, 0);
        assert.equal(snapshot.automations[0]?.nextFireAt, created.nextFireAt);
        assert.deepEqual(snapshot.pendingFires, []);
        assert.equal(harness.rootInputs.length, 0);
      },
      { readIncognito: async () => true },
    );
  });

  test('drain cancels the timer residency and rejects new mutations', async () => {
    await withHarness(async (harness) => {
      await harness.coordinator.prepareRecovery();
      await harness.coordinator.recover();
      harness.coordinator.start();
      const created = await harness.coordinator.create({
        kind: 'heartbeat',
        name: 'check build',
        prompt: 'Check the build.',
        sessionId: 'creator-session',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in created));
      assert.equal(harness.timerCount(), 1);
      assert.equal(harness.residencyCount, 1);

      harness.coordinator.beginDrain();
      assert.equal(harness.timerCount(), 0);
      assert.equal(harness.residencyCount, 0);
      assert.deepEqual(
        await harness.coordinator.create({
          kind: 'heartbeat',
          name: 'second check',
          prompt: 'Check again.',
          sessionId: 'creator-session',
          schedule: { type: 'interval', seconds: 60 },
        }),
        { error: 'Automation authority is unavailable.' },
      );
    });
  });

  test('model mutation persistence failure drains and rolls back canonical state', async () => {
    await withHarness(async (harness) => {
      await harness.coordinator.prepareRecovery();
      await harness.coordinator.recover();
      const concurrentCommit = await harness.store.commit({
        expectedRevision: 0,
        automations: [],
        pendingFires: [],
      });
      assert.equal(concurrentCommit.kind, 'committed');

      const output = await harness.coordinator.modelTool.impl(
        {
          mode: 'create',
          kind: 'heartbeat',
          name: 'check build',
          prompt: 'Check the build.',
          schedule: { type: 'interval', seconds: 60 },
        },
        {
          sessionId: 'creator-session',
          turnId: 'turn-model',
          cwd: '/workspace',
          toolCallId: 'tool-model',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        } satisfies MakaToolContext,
      );

      assert.equal(output, 'Error: Automation authority is unavailable.');
      assert.equal(harness.drainCount, 1);
      assert.deepEqual(await harness.store.read(), {
        revision: 1,
        automations: [],
        pendingFires: [],
      });
      assert.deepEqual(await harness.coordinator.listVisibleForSession('creator-session'), []);
    });
  });

  test('drain waits for a scheduler admission already crossing the durable commit boundary', async () => {
    const admitEntered = deferred();
    const releaseAdmission = deferred();
    const timers: Array<() => void> = [];
    const fire = pendingFire();
    const due: AutomationDefinition = {
      ...startedDefinition(),
      schedule: { type: 'interval', seconds: 60 },
      updatedAt: 1,
      nextFireAt: 6_000,
      lastFireAt: null,
      fireCount: 0,
    };
    let rootCalls = 0;
    const coordinator = new HostAutomationFireCoordinator({
      state: {
        listPendingFires: async () => [],
        listDueAutomations: async () => [due],
        recordDeferredFire: async () => false,
        admitFire: async () => {
          admitEntered.resolve();
          await releaseAdmission.promise;
          return fire;
        },
        assertPendingFire: async () => undefined,
        markFireRunning: async () => undefined,
        settleFire: async () => undefined,
        residencyState: () => ({ pending: false, scheduled: false }),
      },
      sessions: {
        readHeaderSnapshot: async () => sessionHeader('creator-session'),
        createStableSession: async () => assert.fail('Heartbeat must not create a Session'),
      },
      runs: {
        readRun: async () => {
          throw missingRecord('Run not found');
        },
      },
      runtime: {
        sendMessage: async function* () {
          assert.fail('Draining fire must not enter Runtime');
        },
      },
      root: {
        executeRoot: async (input) => {
          rootCalls += 1;
          await input.admitExecution?.();
        },
      },
      runtimePolicy: runtimePolicyStores(),
      isSessionActive: () => false,
      acquireResidency: () => ({ release() {} }),
      requestDrain: () => undefined,
      now: () => 6_000,
      setTimeout: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimeout: () => undefined,
    });

    await coordinator.recover();
    coordinator.start();
    timers.shift()?.();
    await admitEntered.promise;
    let closed = false;
    const closing = coordinator.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    releaseAdmission.resolve();
    await closing;
    assert.equal(rootCalls, 1);
  });

  test('close waits for an accepted fire to settle', async () => {
    await withHarness(async (harness) => {
      await harness.coordinator.prepareRecovery();
      await harness.coordinator.recover();
      harness.coordinator.start();
      const created = await harness.coordinator.create({
        kind: 'heartbeat',
        name: 'check build',
        prompt: 'Check the build.',
        sessionId: 'creator-session',
        schedule: { type: 'once', delaySeconds: 5 },
      });
      assert.ok(!('error' in created));
      if ('error' in created) return;
      harness.now = created.nextFireAt ?? assert.fail('Expected a scheduled fire');
      harness.fireTimer();
      await waitFor(
        'accepted fire to enter running state',
        async () => (await harness.store.read()).pendingFires[0]?.status === 'running',
      );

      let closed = false;
      const closing = harness.coordinator.close().then(() => {
        closed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(closed, false);
      harness.finishRun();
      await closing;
      assert.equal(closed, true);
      assert.deepEqual((await harness.store.read()).pendingFires, []);
      assert.equal(harness.residencyCount, 0);
    });
  });

  test('records an accepted fire outcome after the definition is paused', async () => {
    await withHarness(async (harness) => {
      await harness.coordinator.prepareRecovery();
      await harness.coordinator.recover();
      harness.coordinator.start();
      const created = await harness.coordinator.create({
        kind: 'heartbeat',
        name: 'check build',
        prompt: 'Check the build.',
        sessionId: 'creator-session',
        schedule: { type: 'once', delaySeconds: 5 },
      });
      assert.ok(!('error' in created));
      if ('error' in created) return;
      harness.now = created.nextFireAt ?? assert.fail('Expected a scheduled fire');
      harness.fireTimer();
      await waitFor(
        'draining fire to enter running state',
        async () => (await harness.store.read()).pendingFires[0]?.status === 'running',
      );
      const pendingRunId = (await harness.store.read()).pendingFires[0]?.runId;
      assert.ok(pendingRunId);

      const paused = await harness.coordinator.pause(created.id, 'creator-session');
      assert.equal(paused?.status, 'paused');
      harness.finishRun();
      await waitFor(
        'draining fire to settle',
        async () => (await harness.store.read()).pendingFires.length === 0,
      );
      const settled = (await harness.store.read()).automations[0];
      assert.equal(settled?.status, 'paused');
      assert.equal(settled?.lastRunId, pendingRunId);
      assert.equal(settled?.lastError, null);
      assert.equal(settled?.consecutiveFailures, 0);
    });
  });

  test('rejects deletion while an accepted fire still owns its definition', async () => {
    await withHarness(async (harness) => {
      await harness.coordinator.prepareRecovery();
      await harness.coordinator.recover();
      harness.coordinator.start();
      const created = await harness.coordinator.create({
        kind: 'heartbeat',
        name: 'check build',
        prompt: 'Check the build.',
        sessionId: 'creator-session',
        schedule: { type: 'once', delaySeconds: 5 },
      });
      assert.ok(!('error' in created));
      if ('error' in created) return;
      harness.now = created.nextFireAt ?? assert.fail('Expected a scheduled fire');
      harness.fireTimer();
      await waitFor(
        'closing fire to enter running state',
        async () => (await harness.store.read()).pendingFires[0]?.status === 'running',
      );

      assert.deepEqual(
        await harness.coordinator.handlers['automation.mutate'](
          {
            kind: 'delete',
            sessionId: 'creator-session',
            automationId: created.id,
          },
          CONNECTION_CONTEXT,
        ),
        { ok: true, result: { kind: 'rejected', reason: 'fire_pending' } },
      );
      const pending = await harness.store.read();
      assert.equal(pending.automations[0]?.id, created.id);
      assert.equal(pending.pendingFires[0]?.automationId, created.id);

      harness.finishRun();
      await waitFor(
        'closing fire to settle',
        async () => (await harness.store.read()).pendingFires.length === 0,
      );
    });
  });

  test('ignores a stale deferred decision after the schedule is re-armed', async () => {
    const policyEntered = deferred();
    const releasePolicy = deferred();
    await withHarness(
      async (harness) => {
        await harness.coordinator.prepareRecovery();
        await harness.coordinator.recover();
        harness.coordinator.start();
        const created = await harness.coordinator.create({
          kind: 'cron',
          name: 'daily summary',
          prompt: 'Summarize the workspace.',
          sessionId: 'creator-session',
          schedule: { type: 'once', delaySeconds: 5 },
        });
        assert.ok(!('error' in created));
        if ('error' in created) return;
        harness.now = created.nextFireAt ?? assert.fail('Expected a scheduled fire');

        harness.fireTimer();
        await policyEntered.promise;
        let resumed: AutomationDefinition | undefined;
        try {
          assert.ok(await harness.coordinator.pause(created.id, 'creator-session'));
          resumed = await harness.coordinator.resume(created.id, 'creator-session');
          assert.ok(resumed);
        } finally {
          releasePolicy.resolve();
        }
        await waitFor('policy-unblocked scheduler timer', () => harness.timerCount() === 1);

        const snapshot = await harness.store.read();
        assert.equal(snapshot.revision, 3);
        assert.equal(snapshot.automations[0]?.nextFireAt, resumed?.nextFireAt);
        assert.equal(snapshot.automations[0]?.deferredFireCount, undefined);
        assert.deepEqual(snapshot.pendingFires, []);
      },
      {
        readIncognito: async () => {
          policyEntered.resolve();
          await releasePolicy.promise;
          return true;
        },
      },
    );
  });
});

interface Harness {
  coordinator: HostAutomationCoordinator;
  readonly store: InteractiveAutomationAuthorityWriter;
  readonly runs: Map<string, AgentRunHeader>;
  readonly rootInputs: RuntimeHostedRootExecutionInput[];
  readonly stableCreates: Parameters<ExecutionSessionWriter['createStableSession']>[0][];
  now: number;
  rootMode: 'run' | 'busy' | 'unavailable';
  residencyCount: number;
  drainCount: number;
  fireTimer(): void;
  finishRun(): void;
  timerCount(): number;
}

async function withHarness(
  run: (harness: Harness) => Promise<void>,
  options: {
    rootMode?: Harness['rootMode'];
    readIncognito?: () => Promise<boolean>;
    creatorHeader?: Partial<SessionHeader>;
  } = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-automation-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'interactive'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const store = await openInteractiveAutomationAuthorityForWrite(owner.lease);
  const runs = new Map<string, AgentRunHeader>();
  const rootInputs: RuntimeHostedRootExecutionInput[] = [];
  const stableCreates: Parameters<ExecutionSessionWriter['createStableSession']>[0][] = [];
  const sessionHeaders = new Map<string, SessionHeader>([
    ['creator-session', sessionHeader('creator-session', options.creatorHeader)],
  ]);
  const timers: Array<() => void> = [];
  let finishRun = deferred();
  const harness: Harness = {
    coordinator: undefined as unknown as HostAutomationCoordinator,
    store,
    runs,
    rootInputs,
    stableCreates,
    now: 1_000,
    rootMode: options.rootMode ?? 'run',
    residencyCount: 0,
    drainCount: 0,
    fireTimer: () => {
      const timer = timers.shift();
      assert.ok(timer, 'Expected an Automation scheduler timer');
      timer();
    },
    finishRun: () => finishRun.resolve(),
    timerCount: () => timers.length,
  };
  const sessions = {
    readHeaderSnapshot: async (sessionId: string) => {
      const header = sessionHeaders.get(sessionId);
      if (!header) throw missingRecord(`Session not found: ${sessionId}`);
      return structuredClone(header);
    },
    createStableSession: async (
      request: Parameters<ExecutionSessionWriter['createStableSession']>[0],
    ) => {
      stableCreates.push(structuredClone(request));
      const existing = sessionHeaders.get(request.sessionId);
      if (existing) {
        return {
          kind: 'existing' as const,
          record: { header: structuredClone(existing), revision: 1, committedAt: harness.now },
        };
      }
      const header = sessionHeader(request.sessionId, request.input);
      sessionHeaders.set(request.sessionId, header);
      return {
        kind: 'created' as const,
        record: { header: structuredClone(header), revision: 1, committedAt: harness.now },
      };
    },
  } as Pick<ExecutionSessionWriter, 'createStableSession' | 'readHeaderSnapshot'>;
  const runtime = {
    sendMessage: async function* (
      sessionId: string,
      input: { turnId: string; origin?: { automationId: string } },
      turnOptions: {
        runId?: string;
        onRunStarted?: (runId: string, header: SessionHeader) => Promise<void> | void;
      },
    ) {
      const fire = [...(await store.read()).pendingFires].find(
        (candidate) => candidate.runId === turnOptions.runId,
      );
      assert.ok(fire);
      assert.equal(input.turnId, fire.turnId);
      assert.equal(input.origin?.automationId, fire.automationId);
      runs.set(fire.runId, runHeader(fire, 'running'));
      await turnOptions.onRunStarted?.(fire.runId, sessionHeaders.get(sessionId)!);
      await finishRun.promise;
      runs.set(fire.runId, runHeader(fire, 'completed'));
    },
  } as unknown as Pick<SessionManager, 'sendMessage'>;
  const root = {
    executeRoot: async (input: RuntimeHostedRootExecutionInput) => {
      rootInputs.push(input);
      if (harness.rootMode === 'busy') {
        throw new RuntimeHostedRootConflictError(input.sessionId, 'Session is busy');
      }
      if (harness.rootMode === 'unavailable') {
        throw new RuntimeHostedRootUnavailableError(input.sessionId, 'Session is unavailable');
      }
      assert.equal(await input.admitExecution?.(), 'executing');
      const stream = input.start({
        runId: input.runId,
        userMessageId: input.userMessageId,
        onRunStarted: async () => input.onReady?.(),
      });
      for await (const _event of stream) {
        assert.fail('Automation test runtime emitted an unexpected event');
      }
    },
  };
  harness.coordinator = new HostAutomationCoordinator({
    store,
    sessions,
    runs: {
      readRun: async (_sessionId, runId) => {
        const header = runs.get(runId);
        if (!header) throw missingRecord(`Run not found: ${runId}`);
        return structuredClone(header);
      },
    } as Pick<ExecutionAgentRunWriter, 'readRun'>,
    runtime,
    root,
    runtimePolicy: runtimePolicyStores(options.readIncognito),
    isSessionActive: () => false,
    acquireResidency: () => {
      harness.residencyCount += 1;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          harness.residencyCount -= 1;
        },
      };
    },
    requestDrain: () => {
      harness.drainCount += 1;
    },
    newId: sequentialIds(),
    now: () => harness.now,
    random: () => 0,
    setTimeout: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimeout: (timer) => {
      const index = timers.indexOf(timer as () => void);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  try {
    await run(harness);
  } finally {
    harness.rootMode = 'busy';
    finishRun.resolve();
    await harness.coordinator.close();
    store.close();
    if (!owner.closed) await owner.close();
    await rm(base, { recursive: true, force: true });
  }
}

function sessionHeader(id: string, input: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id,
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Session',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'openrouter',
    connectionLocked: false,
    model: 'openrouter/free',
    permissionMode: 'explore',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    schemaVersion: 1,
    ...input,
  };
}

function startedDefinition(): AutomationDefinition {
  return {
    id: 'automation-1',
    kind: 'heartbeat',
    name: 'check build',
    status: 'active',
    prompt: 'Check the build.',
    sessionId: 'creator-session',
    schedule: { type: 'once', delaySeconds: 5 },
    createdAt: 1,
    updatedAt: 6_000,
    nextFireAt: null,
    lastFireAt: 6_000,
    lastRunId: null,
    fireCount: 1,
    maxFires: null,
    expiresAt: 604_800_001,
    lastError: null,
    consecutiveFailures: 0,
  };
}

function pendingFire(): AutomationPendingFire {
  return {
    id: 'fire-1',
    automationId: 'automation-1',
    automationKind: 'heartbeat',
    automationName: 'check build',
    prompt: 'Check the build.',
    scheduledFor: 6_000,
    targetSessionId: 'creator-session',
    turnId: 'turn-1',
    runId: 'run-1',
    userMessageId: 'message-1',
    status: 'admitted',
    admittedAt: 6_000,
    updatedAt: 6_000,
  };
}

function runHeader(fire: AutomationPendingFire, status: AgentRunHeader['status']): AgentRunHeader {
  return {
    runId: fire.runId,
    sessionId: fire.targetSessionId,
    turnId: fire.turnId,
    status,
    backendKind: 'ai-sdk',
    llmConnectionSlug: 'openrouter',
    modelId: 'openrouter/free',
    cwd: '/workspace',
    permissionMode: 'explore',
    createdAt: 6_000,
    updatedAt: 6_001,
    automationId: fire.automationId,
    ...(status === 'failed'
      ? { completedAt: 6_001, failureClass: 'provider_error', failureMessage: 'Provider failed' }
      : status === 'completed'
        ? { completedAt: 6_001 }
        : {}),
  };
}

function rootAdmission(fire: AutomationPendingFire): RootTurnAdmission {
  return {
    schemaVersion: 1,
    sessionId: fire.targetSessionId,
    turnId: fire.turnId,
    runId: fire.runId,
    userMessageId: fire.userMessageId,
    execution: { kind: 'automation', automationId: fire.automationId },
    previousRootTurnId: null,
    normalizedInput: {
      text: `[Automation: ${fire.automationName}]\n\n${fire.prompt}`,
    },
    sourceMessages: [],
    admittedAt: fire.admittedAt,
  };
}

function runtimePolicyStores(
  readIncognito: () => Promise<boolean> = async () => false,
): RuntimePolicyStoresWriter {
  return {
    runtimePolicy: {
      getSnapshot: async () => ({
        revision: 0,
        policy: {
          networkProxy: {
            enabled: false,
            protocol: 'http',
            host: '',
            port: 0,
            authEnabled: false,
            username: '',
            bypassList: [],
            autoBypassDomains: [],
          },
          personalization: { displayName: '', assistantTone: '' },
          memory: { enabled: false, agentReadEnabled: false },
          workspaceInstructions: { enabled: true },
          privacy: { incognitoActive: await readIncognito() },
          chatDefaults: { permissionMode: 'explore' },
          webSearch: { enabled: false, defaultProvider: 'tavily' },
        },
      }),
    },
  } as unknown as RuntimePolicyStoresWriter;
}

function sequentialIds(): () => string {
  let next = 0;
  return () => `generated-${++next}`;
}

function missingRecord(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = performance.now() + ASYNC_STATE_TIMEOUT_MS;
  while (true) {
    if (await predicate()) return;
    if (performance.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, ASYNC_STATE_POLL_MS));
  }
  assert.fail(`Timed out waiting for ${description}`);
}
