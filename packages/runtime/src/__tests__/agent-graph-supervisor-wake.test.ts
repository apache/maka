import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createSqliteSessionMetadataStore } from '@maka/storage';
import {
  AgentGraphSupervisorContextOverflowError,
  AgentGraphSupervisorWakeCoordinator,
  type AgentGraphSupervisorWakeDiagnostic,
} from '../agent-graph-supervisor-wake.js';
import { SessionActivityRegistry, type GoalTurnOutcome } from '../goal-turn-lifecycle.js';
import type { AgentGraphClientSnapshot } from '../stream-graph-read-model.js';
import type { AgentGraphScheduleReconciliationResult } from '../stream-graph-schedule-reconcile.js';

describe('Agent Graph supervisor wake delivery', () => {
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
      startTurn: async (_sessionId, input): Promise<GoalTurnOutcome> => {
        turns += 1;
        return turns === 1
          ? { kind: 'errored', turnId: input.turnId, reason: 'Context window exceeded' }
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
    });
    try {
      coordinator.notify('root-session', reconciliation());
      await new Promise<void>((resolve) => setImmediate(resolve));
      await coordinator.close();
      busy.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(turns, 0);
    } finally {
      busy.release();
      await coordinator.close();
      store.close();
    }
  });

  test('close aborts an in-flight wake turn and leaves its attempt retryable', async () => {
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
      await coordinator.close();
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-1', 'graph-1:snapshot-1'))?.status,
        'retryable_failed',
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

function snapshot(): AgentGraphClientSnapshot {
  return {
    schemaVersion: 1,
    rootSessionId: 'root-session',
    graphId: 'graph-1',
    snapshotVersion: 'snapshot-1',
    status: 'waiting',
    scheduleRevision: 1,
    topologyFingerprint: 'topology-1',
    closed: false,
    operators: [],
    edges: [],
    work: [],
    stoppedTargets: [],
    claims: [],
    recentControlDecisions: [],
    recentActivity: [],
    terminalHistory: { records: [] },
    omitted: {
      operators: 0,
      edges: 0,
      work: 0,
      stoppedTargets: 0,
      claims: 0,
      controlDecisions: 0,
      recentActivity: 0,
    },
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
