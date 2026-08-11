import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, test } from 'node:test';
import type { AgentRunHeader, SessionHeader } from '@maka/core';
import type { AutomationDefinition, AutomationPendingFire } from '@maka/core/automation';
import {
  DEFER_WINDOW_MS,
  RuntimeHostedRootConflictError,
  RuntimeHostedRootUnavailableError,
  type MakaToolContext,
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
import {
  HostAutomationCoordinator,
  HostAutomationSessionBusyError,
  type HostAutomationCoordinatorInput,
} from '../server/automation-coordinator.js';
import { HostAutomationFireCoordinator } from '../server/automation-fire-coordinator.js';
import type {
  HostedExecutionAdmission,
  HostedExecutionAdmissionResult,
  HostedExecutionListener,
  HostedExecutionRef,
  HostedExecutionSnapshot,
} from '../server/hosted-execution-authority.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const CONNECTION_CONTEXT: ConnectionContext = {
  hostEpoch: 'automation-test',
  connectionId: 'automation-test-connection',
  surface: 'tui',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

const ASYNC_STATE_TIMEOUT_MS = 5_000;
const ASYNC_STATE_POLL_MS = 5;

function modelToolContext(sessionId = 'creator-session'): MakaToolContext {
  return {
    sessionId,
    turnId: 'turn-model',
    cwd: '/workspace',
    toolCallId: 'tool-model',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

describe('Host Automation coordinator', () => {
  test('atomically admits one heartbeat fire and settles the same durable Run identity', async () => {
    await withHarness(async (harness) => {
      await harness.coordinator.prepareRecovery();
      await harness.coordinator.recover();
      harness.coordinator.start();

      const created = await harness.coordinator.create({
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
      harness.runs.set(fire.runId, {
        ...runHeader(fire, 'failed'),
        failureMessage: '',
      });
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

  test('reconciles a running fire without duplicating its root admission', async () => {
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
      assert.equal(harness.rootInputs.length, 0);

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
        const pending = pendingFire();
        const fire = { ...pending, transientDeferredSince: pending.admittedAt };
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
        assert.equal((await harness.store.read()).automations[0]?.deferredFireCount, 1);

        const paused = await harness.coordinator.pause(automation.id, automation.sessionId);
        assert.equal(paused?.status, 'paused');
        harness.coordinator.start();
        harness.fireTimer();
        await waitFor(
          'busy fire retry to enter the root coordinator',
          () => harness.rootInputs.length === 2,
        );
        assert.equal(harness.rootInputs[1]?.runId, fire.runId);
        assert.equal((await harness.store.read()).pendingFires[0]?.id, fire.id);
        const retried = (await harness.store.read()).automations[0];
        assert.equal(retried?.status, 'paused');
        assert.equal(retried?.deferredFireCount, 2);
      },
      { rootMode: 'busy' },
    );
  });

  test('fails a recovered admitted fire after its durable retry window expires', async () => {
    await withHarness(
      async (harness) => {
        const automation = startedDefinition();
        const pending = pendingFire();
        const fire = { ...pending, transientDeferredSince: pending.admittedAt };
        await harness.store.commit({
          expectedRevision: 0,
          automations: [automation],
          pendingFires: [fire],
        });
        harness.now = fire.admittedAt + DEFER_WINDOW_MS;

        await harness.coordinator.prepareRecovery();
        await harness.coordinator.recover();

        const snapshot = await harness.store.read();
        assert.deepEqual(snapshot.pendingFires, []);
        assert.equal(snapshot.automations[0]?.status, 'paused');
        assert.equal(snapshot.automations[0]?.consecutiveFailures, 1);
        assert.equal(
          snapshot.automations[0]?.lastError,
          'Automation execution could not enter Runtime within its retry window: Session is busy',
        );
        assert.equal(harness.rootInputs.length, 1);
        assert.equal(harness.drainCount, 0);
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
        const deferred = (await harness.store.read()).pendingFires[0];
        assert.equal(deferred?.id, fire.id);
        assert.equal(deferred?.runId, fire.runId);
        assert.equal(deferred?.turnId, fire.turnId);

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

  test('rejects new Automations whose creator Session cannot execute hosted roots', async () => {
    for (const scenario of [
      {
        creatorHeader: { collaborationMode: 'plan' as const },
        message: 'Automations cannot execute while the target Session is in Plan mode.',
      },
      {
        creatorHeader: { transcriptLedgerVersion: 0 as const },
        message: 'Imported Session history is still being prepared.',
      },
    ]) {
      await withHarness(
        async (harness) => {
          await harness.coordinator.prepareRecovery();
          const result = await harness.coordinator.handlers['automation.mutate'](
            {
              kind: 'create',
              sessionId: 'creator-session',
              name: 'unsupported heartbeat',
              prompt: 'This cannot execute here.',
              schedule: { type: 'interval', seconds: 60 },
            },
            CONNECTION_CONTEXT,
          );
          assert.deepEqual(result, {
            ok: false,
            error: { code: 'operation_unavailable', message: scenario.message },
          });
          assert.deepEqual(await harness.store.read(), {
            revision: 0,
            automations: [],
            pendingFires: [],
          });
        },
        { creatorHeader: scenario.creatorHeader },
      );
    }
  });

  test('defers a due fire while incognito without admitting execution', async () => {
    await withHarness(
      async (harness) => {
        await harness.coordinator.prepareRecovery();
        await harness.coordinator.recover();
        harness.coordinator.start();
        const created = await harness.coordinator.create({
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

  test('persists provider waiting state and resumes with the frozen capability contract', async () => {
    const requirement = {
      principalId: 'automation-provider',
      clientInstanceId: 'provider-instance',
      contractId: 'provider-contract',
    } as const;
    let available = false;
    await withHarness(
      async (harness) => {
        await harness.coordinator.prepareRecovery();
        await harness.coordinator.recover();
        harness.coordinator.start();
        const created = await harness.coordinator.create({
          name: 'provider task',
          prompt: 'Use the provider.',
          sessionId: 'creator-session',
          schedule: { type: 'once', delaySeconds: 5 },
          requiredCapabilityGroups: ['provider-contract'],
        });
        assert.ok(!('error' in created));
        if ('error' in created) return;
        assert.deepEqual(created.capabilityRequirements, [requirement]);
        harness.now = created.nextFireAt ?? assert.fail('Expected a scheduled fire');

        harness.fireTimer();
        await waitFor('provider waiting state', async () => {
          const automation = (await harness.store.read()).automations[0];
          return automation?.waiting?.reason === 'client_capability_provider_unavailable';
        });
        assert.equal(harness.rootInputs.length, 0);

        harness.now += DEFER_WINDOW_MS + 1;
        harness.fireTimer();
        await waitFor('persistent provider waiting state', async () => {
          const automation = (await harness.store.read()).automations[0];
          return automation?.status === 'active' && automation.waiting !== undefined;
        });

        available = true;
        harness.fireTimer();
        await waitFor(
          'provider-backed Automation admission',
          () => harness.rootInputs.length === 1,
        );
        harness.finishRun();
        await waitFor('provider-backed Automation settlement', async () => {
          const automation = (await harness.store.read()).automations[0];
          return automation?.status === 'completed' && automation.waiting === undefined;
        });
      },
      {
        clientCapabilities: {
          requirementsForAutomation: async (_sessionId, groups) => {
            assert.deepEqual(groups, ['provider-contract']);
            return { ok: true, requirements: [requirement] };
          },
          checkAutomationRequirements: async (requirements) => {
            assert.deepEqual(requirements, [requirement]);
            return available
              ? { ok: true }
              : { ok: false, message: 'Capability provider is offline' };
          },
          bindAutomationSession: async (_sessionId, requirements) => {
            assert.deepEqual(requirements, [requirement]);
            return available
              ? { ok: true }
              : { ok: false, message: 'Capability provider is offline' };
          },
        },
      },
    );
  });

  test('keeps an admitted fire pending beyond the retry window while its provider is offline', async () => {
    const requirement = {
      principalId: 'automation-provider',
      clientInstanceId: 'provider-instance',
      contractId: 'provider-contract',
    } as const;
    let available = false;
    await withHarness(
      async (harness) => {
        await harness.coordinator.prepareRecovery();
        await harness.coordinator.recover();
        harness.coordinator.start();
        const created = await harness.coordinator.create({
          name: 'provider task',
          prompt: 'Use the provider.',
          sessionId: 'creator-session',
          schedule: { type: 'once', delaySeconds: 5 },
          requiredCapabilityGroups: ['provider-contract'],
        });
        assert.ok(!('error' in created));
        if ('error' in created) return;
        harness.now = created.nextFireAt ?? assert.fail('Expected a scheduled fire');

        harness.fireTimer();
        await waitFor('admitted provider waiting state', async () => {
          const snapshot = await harness.store.read();
          return (
            snapshot.pendingFires.length === 1 &&
            snapshot.automations[0]?.waiting?.reason === 'client_capability_provider_unavailable'
          );
        });
        harness.now += DEFER_WINDOW_MS + 1;
        harness.fireTimer();
        await waitFor('durable admitted provider waiting state', async () => {
          const snapshot = await harness.store.read();
          return snapshot.pendingFires.length === 1 && snapshot.automations[0]?.status === 'active';
        });

        available = true;
        harness.rootMode = 'busy';
        harness.fireTimer();
        await waitFor('post-provider transient deferral', async () => {
          const snapshot = await harness.store.read();
          return (
            harness.rootInputs.length === 1 &&
            snapshot.pendingFires[0]?.transientDeferredSince === harness.now
          );
        });
        assert.equal((await harness.store.read()).automations[0]?.status, 'active');

        harness.rootMode = 'run';
        harness.fireTimer();
        await waitFor('provider-backed admitted fire', () => harness.rootInputs.length === 2);
        harness.finishRun();
        await waitFor(
          'provider-backed admitted fire settlement',
          async () => (await harness.store.read()).automations[0]?.status === 'completed',
        );
        assert.equal((await harness.store.read()).automations[0]?.fireCount, 1);
      },
      {
        clientCapabilities: {
          requirementsForAutomation: async () => ({ ok: true, requirements: [requirement] }),
          checkAutomationRequirements: async () => ({ ok: true }),
          bindAutomationSession: async () =>
            available ? { ok: true } : { ok: false, message: 'Capability provider is offline' },
        },
      },
    );
  });

  test('drain cancels the timer residency and rejects new mutations', async () => {
    await withHarness(async (harness) => {
      await harness.coordinator.prepareRecovery();
      await harness.coordinator.recover();
      harness.coordinator.start();
      const created = await harness.coordinator.create({
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
          name: 'second check',
          prompt: 'Check again.',
          sessionId: 'creator-session',
          schedule: { type: 'interval', seconds: 60 },
        }),
        { error: 'Automation authority is unavailable.' },
      );
    });
  });

  test('session retirement requires its heartbeat automations to be removed', async () => {
    await withHarness(async (harness) => {
      await harness.coordinator.prepareRecovery();
      const created = await harness.coordinator.create({
        name: 'session check',
        prompt: 'Check the workspace.',
        sessionId: 'creator-session',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in created));
      if ('error' in created) return;
      await assert.rejects(
        harness.coordinator.beginSessionRetirement(['creator-session']),
        HostAutomationSessionBusyError,
      );
      assert.equal(await harness.coordinator.delete(created.id, 'creator-session'), true);
      const retirement = await harness.coordinator.beginSessionRetirement(['creator-session']);
      retirement.rollback();
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
      assert.deepEqual(await harness.coordinator.listForSession('creator-session'), []);
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
        recordPrerequisiteWaiting: async () => false,
        admitFire: async () => {
          admitEntered.resolve();
          await releaseAdmission.promise;
          return fire;
        },
        assertPendingFire: async () => undefined,
        recordFireDeferred: async () => undefined,
        recordFirePrerequisiteWaiting: async () => undefined,
        failFire: async () => undefined,
        markFireRunning: async () => undefined,
        settleFire: async () => undefined,
        residencyState: () => ({ pending: false, scheduled: false }),
      },
      sessions: {
        readHeaderSnapshot: async () => sessionHeader('creator-session'),
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
        admit: async (input) => {
          rootCalls += 1;
          await input.admitExecution?.();
          throw new Error('Draining fire unexpectedly entered Runtime');
        },
        reconcile: async () => assert.fail('Draining fire must not reconcile a Run'),
        subscribe: () => () => undefined,
      },
      runtimePolicy: runtimePolicyStores(),
      clientCapabilities: availableClientCapabilities(),
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
  readonly rootInputs: HostedExecutionAdmission[];
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
    clientCapabilities?: HostAutomationCoordinatorInput['clientCapabilities'];
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
  const rootInputs: HostedExecutionAdmission[] = [];
  const sessionHeaders = new Map<string, SessionHeader>([
    ['creator-session', sessionHeader('creator-session', options.creatorHeader)],
  ]);
  const timers: Array<() => void> = [];
  const executionListeners = new Set<HostedExecutionListener>();
  let finishRun = deferred();
  const harness: Harness = {
    coordinator: undefined as unknown as HostAutomationCoordinator,
    store,
    runs,
    rootInputs,
    now: 1_000,
    rootMode: options.rootMode ?? 'run',
    residencyCount: 0,
    drainCount: 0,
    fireTimer: () => {
      const timer = timers.shift();
      assert.ok(timer, 'Expected an Automation scheduler timer');
      timer();
    },
    finishRun: () => {
      for (const [runId, run] of runs) {
        if (run.status !== 'running') continue;
        runs.set(runId, {
          ...run,
          status: 'completed',
          completedAt: harness.now,
        });
        for (const listener of executionListeners) {
          listener({
            sessionId: run.sessionId,
            turnId: run.turnId,
            runId: run.runId,
          });
        }
      }
      finishRun.resolve();
    },
    timerCount: () => timers.length,
  };
  const sessions = {
    readHeaderSnapshot: async (sessionId: string) => {
      const header = sessionHeaders.get(sessionId);
      if (!header) throw missingRecord(`Session not found: ${sessionId}`);
      return structuredClone(header);
    },
  } as Pick<ExecutionSessionWriter, 'readHeaderSnapshot'>;
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
    admit: async (input: HostedExecutionAdmission): Promise<HostedExecutionAdmissionResult> => {
      rootInputs.push(input);
      if (harness.rootMode === 'busy') {
        throw new RuntimeHostedRootConflictError(input.sessionId, 'Session is busy');
      }
      if (harness.rootMode === 'unavailable') {
        throw new RuntimeHostedRootUnavailableError(input.sessionId, 'Session is unavailable');
      }
      assert.equal(await input.admitExecution?.(), 'executing');
      const started = deferred();
      const stream = input.start({
        runId: input.runId,
        userMessageId: input.userMessageId,
        onRunStarted: async () => {
          await input.onReady?.();
          started.resolve();
        },
      });
      const settled = (async () => {
        for await (const _event of stream) {
          assert.fail('Automation test runtime emitted an unexpected event');
        }
      })();
      void settled.catch((error) => started.reject(error));
      await started.promise;
      return {
        snapshot: executionSnapshot(input, runs.get(input.runId)),
        completion: settled.then(
          () => ({
            kind: 'terminal',
            snapshot: executionSnapshot(input, runs.get(input.runId)),
          }),
          (error: unknown) => ({
            kind: 'authority_error',
            execution: input,
            reason: error instanceof Error ? error.message : String(error),
          }),
        ),
        settled,
      };
    },
    reconcile: async (input: HostedExecutionRef) => executionSnapshot(input, runs.get(input.runId)),
    subscribe: (listener: HostedExecutionListener) => {
      executionListeners.add(listener);
      return () => executionListeners.delete(listener);
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
    clientCapabilities: options.clientCapabilities ?? availableClientCapabilities(),
    isSessionActive: () => false,
    sessionAdmission: new SessionAdmissionGate(),
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
    harness.finishRun();
    await harness.coordinator.close();
    store.close();
    if (!owner.closed) await owner.close();
    await rm(base, { recursive: true, force: true });
  }
}

function availableClientCapabilities() {
  return {
    requirementsForAutomation: async () => ({ ok: true as const, requirements: [] }),
    checkAutomationRequirements: async () => ({ ok: true as const }),
    bindAutomationSession: async () => ({ ok: true as const }),
  };
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
      ? {
          completedAt: 6_001,
          failureClass: 'provider_error',
          failureMessage: 'Provider failed',
        }
      : status === 'completed'
        ? { completedAt: 6_001 }
        : {}),
  };
}

function executionSnapshot(
  execution: HostedExecutionRef,
  run: AgentRunHeader | undefined,
): HostedExecutionSnapshot {
  if (!run) throw missingRecord(`Run not found: ${execution.runId}`);
  const identity = {
    sessionId: execution.sessionId,
    turnId: execution.turnId,
    runId: execution.runId,
  };
  if (run.status === 'completed') {
    return {
      ...identity,
      status: 'completed',
      terminalEventId: `terminal-${run.runId}`,
    };
  }
  if (run.status === 'failed') {
    return {
      ...identity,
      status: 'failed',
      terminalEventId: `terminal-${run.runId}`,
      failureClass: run.failureClass ?? 'unknown',
    };
  }
  if (run.status === 'cancelled') {
    return {
      ...identity,
      status: 'cancelled',
      terminalEventId: `terminal-${run.runId}`,
      abortSource: 'test',
    };
  }
  return { ...identity, status: run.status };
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

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
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
