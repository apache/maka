import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createSqliteSessionMetadataStore } from '@maka/storage';
import {
  AgentGraphSupervisorContextOverflowError,
  AgentGraphSupervisorWakeCoordinator,
  recoverAgentGraphSupervisorContextOverflow,
  type AgentGraphSupervisorWakeDiagnostic,
  type AgentGraphSupervisorTurnOutcome,
} from '../agent-graph-supervisor-wake.js';
import { SessionActivityRegistry, type GoalTurnOutcome } from '../goal-turn-lifecycle.js';
import type { AgentGraphClientSnapshot } from '../stream-graph-read-model.js';
import type { AgentGraphScheduleReconciliationResult } from '../stream-graph-schedule-reconcile.js';

describe('Agent Graph supervisor wake delivery', () => {
  test('uses the shared aggressive compaction adapter for overflow recovery', async () => {
    const calls: Array<{ sessionId: string; turnId: string; minRecentTurns: number }> = [];
    const recovery = await recoverAgentGraphSupervisorContextOverflow({
      rootSessionId: 'root-session',
      compactTurnId: 'compact-turn',
      abortSignal: new AbortController().signal,
      compactSession: async function* (sessionId, input) {
        calls.push({ sessionId, ...input });
        yield {
          type: 'token_usage',
          id: 'compact-usage',
          turnId: input.turnId,
          ts: 1,
          input: 10,
          output: 2,
          contextBudget: {
            enabled: true,
            estimatedTokensBefore: 700_000,
            estimatedTokensAfter: 12_000,
            keptTurns: 2,
            droppedTurns: 20,
            keptEvents: 4,
            droppedEvents: 80,
            historyCompactedEvents: 75,
            historyCompactBlocksWritten: 1,
          },
        };
      },
    });

    assert.deepEqual(calls, [
      { sessionId: 'root-session', turnId: 'compact-turn', minRecentTurns: 0 },
    ]);
    assert.deepEqual(recovery, {
      estimatedTokensBefore: 700_000,
      estimatedTokensAfter: 12_000,
      droppedTurns: 20,
      droppedEvents: 80,
      historyCompactedEvents: 75,
      historyCompactBlocksWritten: 1,
    });
  });

  test('lets Swarm suppress dispatch wakes and choose a status-only wake turn', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    let ready = false;
    const starts: Array<{ text: string; mode: string | undefined }> = [];
    const coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: new SessionActivityRegistry(),
      wakeStore: store,
      readSnapshot: async () => snapshot(),
      shouldWake: async () => ready,
      renderWake: async () => ({
        text: 'Read compact swarm status only.',
        displayText: 'Agent swarm needs attention.',
        orchestrationMode: 'swarm',
      }),
      startTurn: async (_sessionId, input) => {
        starts.push({ text: input.text, mode: input.turnOrchestration?.mode });
        return { kind: 'completed', turnId: input.turnId };
      },
      inspectAttempt: async () => 'missing',
      newId: sequentialIds(),
    });
    try {
      coordinator.notify('root-session', reconciliation());
      await coordinator.waitForIdle();
      assert.deepEqual(starts, []);

      ready = true;
      coordinator.notify('root-session', reconciliation());
      await coordinator.waitForIdle();
      assert.deepEqual(starts, [{ text: 'Read compact swarm status only.', mode: 'swarm' }]);
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  test('admits a checkpoint-only wake without a reconciliation result', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    let turns = 0;
    const coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: new SessionActivityRegistry(),
      wakeStore: store,
      readSnapshot: async () => snapshot({ orchestrationMode: 'swarm' }),
      shouldWake: async (_rootSessionId, result) => result === undefined,
      startTurn: async (_sessionId, input) => {
        turns += 1;
        return { kind: 'completed', turnId: input.turnId };
      },
      inspectAttempt: async () => 'missing',
      newId: sequentialIds(),
    });
    try {
      coordinator.notify('root-session');
      await coordinator.waitForIdle();
      assert.equal(turns, 1);
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  test('retries failures before and after prompt persistence, delivering only a completed turn', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    const persistedAttempts: string[] = [];
    let attempt = 0;
    const coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: new SessionActivityRegistry(),
      wakeStore: store,
      readSnapshot: async () => snapshot(),
      startTurn: async (_sessionId, input): Promise<GoalTurnOutcome> => {
        attempt += 1;
        if (attempt === 1) throw new Error('failed before prompt persistence');
        persistedAttempts.push(input.origin?.kind === 'agent_graph' ? input.origin.attemptId : '');
        if (attempt === 2) {
          return { kind: 'errored', turnId: input.turnId, reason: 'provider failed' };
        }
        return { kind: 'completed', turnId: input.turnId };
      },
      inspectAttempt: async () => 'missing',
      newId: sequentialIds(),
    });
    try {
      coordinator.notify('root-session', reconciliation());
      await coordinator.waitForIdle();
      const wake = await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1');
      assert.equal(wake?.status, 'delivered');
      assert.equal(wake?.attemptCount, 3);
      assert.equal(new Set(persistedAttempts).size, 2);
      assert.deepEqual(
        (await store.listAgentGraphSupervisorWakeAttempts('graph-1', 'graph-1:snapshot-1')).map(
          (candidate) => candidate.status,
        ),
        ['retryable_failed', 'retryable_failed', 'delivered'],
      );
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  test('aggressively compacts after a context overflow before delivering a fresh turn', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    let turns = 0;
    const recoveries: string[] = [];
    const diagnostics: AgentGraphSupervisorWakeDiagnostic[] = [];
    const coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: new SessionActivityRegistry(),
      wakeStore: store,
      readSnapshot: async () => snapshot(),
      startTurn: async (_sessionId, input): Promise<AgentGraphSupervisorTurnOutcome> => {
        turns += 1;
        return turns === 1
          ? { kind: 'context_overflow', turnId: input.turnId, reason: 'context_overflow' }
          : { kind: 'completed', turnId: input.turnId };
      },
      inspectAttempt: async () => 'missing',
      recoverContextOverflow: async (_rootSessionId, input) => {
        recoveries.push(input.attemptId);
        return {
          estimatedTokensBefore: 700_000,
          estimatedTokensAfter: 12_000,
          droppedEvents: 80,
          historyCompactedEvents: 75,
          historyCompactBlocksWritten: 1,
        };
      },
      newId: sequentialIds(),
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });
    try {
      coordinator.notify('root-session', reconciliation());
      await coordinator.waitForIdle();

      const wake = await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1');
      assert.equal(wake?.status, 'delivered');
      assert.equal(wake?.attemptCount, 2);
      assert.equal(recoveries.length, 1);
      assert.deepEqual(
        diagnostics.map((diagnostic) => diagnostic.event),
        ['context_overflow_detected', 'context_overflow_recovery_completed'],
      );
      assert.deepEqual(diagnostics[1], {
        event: 'context_overflow_recovery_completed',
        graphId: 'graph-1',
        wakeId: 'graph-1:snapshot-1',
        attemptId: recoveries[0],
        recovery: {
          estimatedTokensBefore: 700_000,
          estimatedTokensAfter: 12_000,
          droppedEvents: 80,
          historyCompactedEvents: 75,
          historyCompactBlocksWritten: 1,
        },
      });
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  test('stops after one recovered overflow and reports a bounded durable partial result', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    let turns = 0;
    let recoveries = 0;
    let reportedError: unknown;
    const diagnostics: AgentGraphSupervisorWakeDiagnostic[] = [];
    const coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: new SessionActivityRegistry(),
      wakeStore: store,
      readSnapshot: async () => ({
        ...snapshot(),
        work: [
          {
            workId: 'work-1',
            target: { kind: 'agent', agentId: 'reviewer' },
            inputIds: [],
            status: 'requested',
            instructionPreview: 'review',
            instructionTruncated: false,
            revision: 1,
            committedAt: 1,
          },
        ],
      }),
      startTurn: async (_sessionId, input): Promise<GoalTurnOutcome> => {
        turns += 1;
        return { kind: 'errored', turnId: input.turnId, reason: 'context_overflow' };
      },
      inspectAttempt: async () => 'missing',
      recoverContextOverflow: async () => {
        recoveries += 1;
      },
      newId: sequentialIds(),
      onError: (_rootSessionId, error) => {
        reportedError = error;
      },
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });
    try {
      coordinator.notify('root-session', reconciliation());
      await coordinator.waitForIdle();

      assert.equal(turns, 2);
      assert.equal(recoveries, 1);
      assert.ok(reportedError instanceof AgentGraphSupervisorContextOverflowError);
      assert.equal(reportedError.recoveryAttempted, true);
      assert.deepEqual(reportedError.partialResult.work, [
        {
          workId: 'work-1',
          status: 'requested',
          target: { kind: 'agent', agentId: 'reviewer' },
        },
      ]);
      assert.match(reportedError.message, /graph remains durable and recoverable/);
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1'))?.attemptCount,
        2,
      );
      assert.deepEqual(
        diagnostics.map((diagnostic) => diagnostic.event),
        [
          'context_overflow_detected',
          'context_overflow_recovery_completed',
          'context_overflow_detected',
          'context_overflow_exhausted',
        ],
      );
      assert.deepEqual(diagnostics.at(-1), {
        event: 'context_overflow_exhausted',
        graphId: 'graph-1',
        wakeId: 'graph-1:snapshot-1',
        recoveryAttempted: true,
        partial: {
          status: 'waiting',
          workItems: 1,
          terminalRecordIds: 0,
          omittedWorkItems: 0,
          omittedTerminalRecordIds: 0,
        },
      });
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  test('does not blindly retry an overflow when no recovery path is available', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    let turns = 0;
    let reportedError: unknown;
    const coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: new SessionActivityRegistry(),
      wakeStore: store,
      readSnapshot: async () => snapshot(),
      startTurn: async (_sessionId, input): Promise<GoalTurnOutcome> => {
        turns += 1;
        return { kind: 'errored', turnId: input.turnId, reason: 'Context window exceeded' };
      },
      inspectAttempt: async () => 'missing',
      newId: sequentialIds(),
      onError: (_rootSessionId, error) => {
        reportedError = error;
      },
    });
    try {
      coordinator.notify('root-session', reconciliation());
      await coordinator.waitForIdle();

      assert.equal(turns, 1);
      assert.ok(reportedError instanceof AgentGraphSupervisorContextOverflowError);
      assert.equal(reportedError.recoveryAttempted, false);
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1'))?.attemptCount,
        1,
      );
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  test('parks a suspended outcome without redelivering its persisted prompt', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    let attempt = 0;
    const coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: new SessionActivityRegistry(),
      wakeStore: store,
      readSnapshot: async () => snapshot(),
      startTurn: async (_sessionId, input): Promise<GoalTurnOutcome> => {
        attempt += 1;
        return { kind: 'suspended', turnId: input.turnId, reason: 'permission handoff' };
      },
      inspectAttempt: async () => 'waiting_for_user',
      newId: sequentialIds(),
    });
    try {
      coordinator.notify('root-session', reconciliation());
      await coordinator.waitForIdle();
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1'))?.attemptCount,
        1,
      );
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1'))?.status,
        'waiting_permission',
      );
      assert.equal(attempt, 1);
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  test('retries a parked attempt only after its permission response loses the live waiter', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    let attempt = 0;
    const coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: new SessionActivityRegistry(),
      wakeStore: store,
      readSnapshot: async () => snapshot(),
      startTurn: async (_sessionId, input): Promise<GoalTurnOutcome> => {
        attempt += 1;
        return attempt === 1
          ? { kind: 'suspended', turnId: input.turnId, reason: 'permission handoff' }
          : { kind: 'completed', turnId: input.turnId };
      },
      inspectAttempt: async () => 'waiting_for_user',
      newId: sequentialIds(),
    });
    try {
      coordinator.notify('root-session', reconciliation());
      await coordinator.waitForIdle();
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1'))?.status,
        'waiting_permission',
      );

      coordinator.notifyPermissionResponse('root-session');
      await coordinator.waitForIdle();

      const wake = await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1');
      assert.equal(wake?.status, 'delivered');
      assert.equal(wake?.attemptCount, 2);
      assert.deepEqual(
        (await store.listAgentGraphSupervisorWakeAttempts('graph-1', 'graph-1:snapshot-1')).map(
          (candidate) => candidate.status,
        ),
        ['retryable_failed', 'delivered'],
      );
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  test('does not strand a permission response racing the suspended wake commit', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    let attempt = 0;
    let coordinator!: AgentGraphSupervisorWakeCoordinator;
    coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: new SessionActivityRegistry(),
      wakeStore: store,
      readSnapshot: async () => snapshot(),
      startTurn: async (_sessionId, input, activity): Promise<GoalTurnOutcome> => {
        attempt += 1;
        if (attempt === 1) {
          activity.release();
          coordinator.notifyPermissionResponse('root-session');
          await new Promise<void>((resolve) => setImmediate(resolve));
          return { kind: 'suspended', turnId: input.turnId, reason: 'permission handoff' };
        }
        return { kind: 'completed', turnId: input.turnId };
      },
      inspectAttempt: async () => 'waiting_for_user',
      newId: sequentialIds(),
    });
    try {
      coordinator.notify('root-session', reconciliation());
      await coordinator.waitForIdle();
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1'))?.status,
        'delivered',
      );
      assert.equal(attempt, 2);
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  test('recovers a crash-interrupted running attempt and redelivers it', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    await store.claimAgentGraphSupervisorWake({
      schemaVersion: 1,
      graphId: 'graph-1',
      wakeId: 'graph-1:snapshot-1',
      snapshotVersion: 'snapshot-1',
      rootSessionId: 'root-session',
    });
    await store.beginAgentGraphSupervisorWakeAttempt({
      graphId: 'graph-1',
      wakeId: 'graph-1:snapshot-1',
      attemptId: 'crashed-attempt',
      turnId: 'crashed-turn',
    });
    let delivered = 0;
    const coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: new SessionActivityRegistry(),
      wakeStore: store,
      readSnapshot: async () => snapshot(),
      startTurn: async (_sessionId, input) => {
        delivered += 1;
        return { kind: 'completed', turnId: input.turnId };
      },
      inspectAttempt: async () => 'failed',
      newId: sequentialIds(),
    });
    try {
      assert.equal(await coordinator.recover(), 1);
      await coordinator.waitForIdle();
      assert.equal(delivered, 1);
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1'))?.status,
        'delivered',
      );
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  test('converges a completed crash-window AgentRun without duplicate delivery', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    await createRunningAttempt(store);
    let delivered = 0;
    const coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: new SessionActivityRegistry(),
      wakeStore: store,
      readSnapshot: async () => snapshot(),
      startTurn: async (_sessionId, input) => {
        delivered += 1;
        return { kind: 'completed', turnId: input.turnId };
      },
      inspectAttempt: async () => 'completed',
      newId: sequentialIds(),
    });
    try {
      assert.equal(await coordinator.recover(), 1);
      await coordinator.waitForIdle();
      assert.equal(delivered, 0);
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1'))?.status,
        'delivered',
      );
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  test('supersedes a checkpoint that closes before root admission', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    let snapshotReads = 0;
    let rootAdmissions = 0;
    const coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: new SessionActivityRegistry(),
      wakeStore: store,
      readSnapshot: async () => snapshot(snapshotReads++ > 0 ? { closed: true } : {}),
      startTurn: async (_sessionId, input, _activity, _abortSignal, isCurrent) => {
        if (!(await isCurrent())) {
          return { kind: 'superseded', turnId: input.turnId, reason: 'checkpoint_closed' };
        }
        rootAdmissions += 1;
        return { kind: 'completed', turnId: input.turnId };
      },
      inspectAttempt: async () => 'missing',
      newId: sequentialIds(),
    });
    try {
      coordinator.notify('root-session', reconciliation());
      await coordinator.waitForIdle();

      assert.equal(rootAdmissions, 0);
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1'))?.status,
        'superseded',
      );
      assert.equal(
        (await store.listAgentGraphSupervisorWakeAttempts('graph-1', 'graph-1:snapshot-1'))[0]
          ?.status,
        'superseded',
      );
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  test('terminally supersedes retryable wakes for an unavailable Session during recovery', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    await store.claimAgentGraphSupervisorWake({
      schemaVersion: 1,
      graphId: 'graph-1',
      wakeId: 'graph-1:snapshot-1',
      snapshotVersion: 'snapshot-1',
      rootSessionId: 'root-session',
    });
    let turns = 0;
    let errors = 0;
    const coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: new SessionActivityRegistry(),
      wakeStore: store,
      readSnapshot: async () => snapshot(),
      startTurn: async (_sessionId, input) => {
        turns += 1;
        return { kind: 'completed', turnId: input.turnId };
      },
      inspectAttempt: async () => 'missing',
      isSessionDeliverable: async () => false,
      newId: sequentialIds(),
      onError: () => {
        errors += 1;
      },
    });
    try {
      assert.equal(await coordinator.recover(), 1);
      await coordinator.waitForIdle();
      assert.equal(turns, 0);
      assert.equal(errors, 0);
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1'))?.status,
        'superseded',
      );
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  test('retries a recovered waiting-permission attempt after its live waiter is lost', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    await createRunningAttempt(store);
    let delivered = 0;
    const coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: new SessionActivityRegistry(),
      wakeStore: store,
      readSnapshot: async () => snapshot(),
      startTurn: async (_sessionId, input) => {
        delivered += 1;
        return { kind: 'completed', turnId: input.turnId };
      },
      inspectAttempt: async () => 'waiting_for_user',
      newId: sequentialIds(),
    });
    try {
      assert.equal(await coordinator.recover(), 1);
      await coordinator.waitForIdle();
      assert.equal(delivered, 1);
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1'))?.status,
        'delivered',
      );
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  test('close aborts a queued activity acquisition and never starts a turn afterward', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    const activities = new SessionActivityRegistry();
    const busy = activities.reserve('root-session');
    let turns = 0;
    let residencies = 0;
    const coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: activities,
      wakeStore: store,
      readSnapshot: async () => snapshot(),
      startTurn: async (_sessionId, input) => {
        turns += 1;
        return { kind: 'completed', turnId: input.turnId };
      },
      inspectAttempt: async () => 'missing',
      newId: sequentialIds(),
      acquireResidency: () => {
        residencies += 1;
        let released = false;
        return {
          release: () => {
            if (released) return;
            released = true;
            residencies -= 1;
          },
        };
      },
    });
    try {
      coordinator.notify('root-session', reconciliation());
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(residencies, 1);
      await coordinator.close();
      assert.equal(residencies, 0);
      busy.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(turns, 0);
    } finally {
      busy.release();
      await coordinator.close();
      store.close();
    }
  });

  test('beginDrain aborts an in-flight wake turn and close joins it', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    const started = deferred();
    const coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: new SessionActivityRegistry(),
      wakeStore: store,
      readSnapshot: async () => snapshot(),
      startTurn: async (_sessionId, input, _activity, abortSignal) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) resolve();
          else abortSignal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { kind: 'aborted', turnId: input.turnId };
      },
      inspectAttempt: async () => 'missing',
      newId: sequentialIds(),
    });
    try {
      coordinator.notify('root-session', reconciliation());
      await started.promise;
      coordinator.beginDrain();
      await coordinator.waitForIdle();
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1'))?.status,
        'retryable_failed',
      );
      assert.equal(coordinator.notify('root-session', reconciliation()), undefined);
      await coordinator.close();
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  test('overlapping client stops keep one Session wake suppressed until both settle', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    const started = deferred();
    const firstStopEntered = deferred();
    const secondStopEntered = deferred();
    const releaseFirstStop = deferred();
    const releaseSecondStop = deferred();
    let snapshotVersion = 'snapshot-1';
    let turns = 0;
    const coordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: new SessionActivityRegistry(),
      wakeStore: store,
      readSnapshot: async () => snapshot({ snapshotVersion }),
      startTurn: async (_sessionId, input, _activity, abortSignal) => {
        turns += 1;
        if (turns === 1) {
          started.resolve();
          await new Promise<void>((resolve) => {
            if (abortSignal.aborted) resolve();
            else abortSignal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { kind: 'aborted', turnId: input.turnId };
        }
        return { kind: 'completed', turnId: input.turnId };
      },
      inspectAttempt: async () => 'missing',
      newId: sequentialIds(),
    });
    try {
      coordinator.notify('root-session', reconciliation());
      await started.promise;
      const firstStop = coordinator.runWithSessionWakesSuppressed('root-session', async () => {
        firstStopEntered.resolve();
        await releaseFirstStop.promise;
      });
      await firstStopEntered.promise;
      const secondStop = coordinator.runWithSessionWakesSuppressed('root-session', async () => {
        secondStopEntered.resolve();
        await releaseSecondStop.promise;
      });
      await secondStopEntered.promise;
      releaseFirstStop.resolve();
      await firstStop;

      const stopped = await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1');
      assert.equal(stopped?.status, 'superseded');
      assert.equal(stopped?.attemptCount, 1);
      assert.equal(turns, 1);

      snapshotVersion = 'snapshot-2';
      assert.equal(coordinator.notify('root-session', reconciliation()), undefined);
      releaseSecondStop.resolve();
      await secondStop;
      coordinator.notify('root-session', reconciliation());
      await coordinator.waitForIdle();
      assert.equal(turns, 2);
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-2'))?.status,
        'delivered',
      );
    } finally {
      await coordinator.close();
      store.close();
    }
  });
});

async function createRunningAttempt(
  store: ReturnType<typeof createSqliteSessionMetadataStore>,
): Promise<void> {
  await store.claimAgentGraphSupervisorWake({
    schemaVersion: 1,
    graphId: 'graph-1',
    wakeId: 'graph-1:snapshot-1',
    snapshotVersion: 'snapshot-1',
    rootSessionId: 'root-session',
  });
  await store.beginAgentGraphSupervisorWakeAttempt({
    graphId: 'graph-1',
    wakeId: 'graph-1:snapshot-1',
    attemptId: 'crashed-attempt',
    turnId: 'crashed-turn',
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function snapshot(overrides: Partial<AgentGraphClientSnapshot> = {}): AgentGraphClientSnapshot {
  return {
    schemaVersion: 1,
    rootSessionId: 'root-session',
    graphId: 'graph-1',
    orchestrationMode: 'graph',
    snapshotVersion: 'snapshot-1',
    status: 'waiting',
    scheduleRevision: 1,
    topologyFingerprint: 'topology-1',
    closed: false,
    operators: [],
    edges: [],
    work: [],
    reconciliationFailures: [],
    stoppedTargets: [],
    claims: [],
    recentControlDecisions: [],
    recentActivity: [],
    terminalHistory: { records: [] },
    omitted: {
      operators: 0,
      edges: 0,
      work: 0,
      reconciliationFailures: 0,
      stoppedTargets: 0,
      claims: 0,
      controlDecisions: 0,
      recentActivity: 0,
    },
    ...overrides,
  };
}

function reconciliation(): AgentGraphScheduleReconciliationResult {
  return {
    status: 'reconciled',
    dispatches: [{}],
    failures: [],
  } as unknown as AgentGraphScheduleReconciliationResult;
}

function sequentialIds(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}
