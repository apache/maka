import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { ShellRunRecord } from '@maka/core';
import { createSqliteShellRunStore, type ClosableShellRunStore } from '@maka/storage';

import { SessionActivityRegistry } from '../goal-turn-lifecycle.js';
import {
  ShellRunCompletionWakeCoordinator,
  renderShellRunCompletionWakePrompt,
} from '../shell-run-completion-wake.js';
import { shellRunUpdate } from '../shell-run-tool-result.js';

const workspaces: string[] = [];
const stores: ClosableShellRunStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('ShellRun completion notification', () => {
  test('waits for the active turn, then delivers one event-driven continuation without polling', async () => {
    const store = await createStore();
    const record = await store.createShellRun(terminalRecord());
    const activities = new SessionActivityRegistry();
    const activeTurn = activities.reserve(record.sessionId);
    const prompts: string[] = [];
    const coordinator = coordinatorFor(store, activities, {
      startTurn: async (_sessionId, input) => {
        prompts.push(input.text);
        return { kind: 'completed', turnId: input.turnId };
      },
    });
    try {
      coordinator.notify(shellRunUpdate(record));
      await Promise.resolve();
      assert.equal(prompts.length, 0, 'completion wake must queue behind the active turn');

      activeTurn.release();
      await coordinator.waitForIdle();

      assert.equal(prompts.length, 1);
      assert.match(prompts[0]!, /event-driven completion wake/);
      assert.match(prompts[0]!, /Do not sleep or poll/);
      const delivered = await store.readShellRun(record.sessionId, record.shellRunId);
      assert.equal(delivered.completionWake?.attemptCount, 1);
      assert.equal(delivered.completionWake?.attemptTurnId, 'wake-turn-1');
      assert.equal(delivered.completionWake?.deliveredAt, 1_002);
      assert.equal(delivered.observedAt, 1_002);
    } finally {
      await coordinator.close();
    }
  });

  test('comparison: an unsubscribed background completion requires reads while notification uses one wake', async () => {
    const store = await createStore();
    const legacy = await store.createShellRun(
      terminalRecord({ shellRunId: 'legacy-run', notifyOnComplete: undefined }),
    );
    const notified = await store.createShellRun(
      terminalRecord({ shellRunId: 'notified-run', sourceToolCallId: 'tool-2' }),
    );
    let continuationTurns = 0;
    const coordinator = coordinatorFor(store, new SessionActivityRegistry(), {
      startTurn: async (_sessionId, input) => {
        continuationTurns += 1;
        return { kind: 'completed', turnId: input.turnId };
      },
    });
    try {
      coordinator.notify(shellRunUpdate(legacy));
      coordinator.notify(shellRunUpdate(notified));
      await coordinator.waitForIdle();

      // Legacy callers can only discover completion by explicitly reading the ref.
      let legacyModelPolls = 0;
      legacyModelPolls += 1;
      const legacySnapshot = await store.readShellRun(legacy.sessionId, legacy.shellRunId);
      assert.equal(legacySnapshot.status, 'completed');

      assert.equal(legacyModelPolls, 1);
      assert.equal(continuationTurns, 1);
      assert.equal(
        (await store.readShellRun(notified.sessionId, notified.shellRunId)).observedAt,
        1_002,
        'notification delivers the terminal snapshot without any model Read call',
      );
    } finally {
      await coordinator.close();
    }
  });

  test('recovery delivers a persisted terminal subscription after restart', async () => {
    const store = await createStore();
    await store.createShellRun(terminalRecord());
    let turns = 0;
    const coordinator = coordinatorFor(store, new SessionActivityRegistry(), {
      startTurn: async (_sessionId, input) => {
        turns += 1;
        return { kind: 'completed', turnId: input.turnId };
      },
    });
    try {
      assert.equal(await coordinator.recover(), 1);
      await coordinator.waitForIdle();
      assert.equal(turns, 1);
    } finally {
      await coordinator.close();
    }
  });

  test('deduplicates repeated terminal notifications before and after delivery', async () => {
    const store = await createStore();
    const record = await store.createShellRun(terminalRecord());
    let turns = 0;
    const coordinator = coordinatorFor(store, new SessionActivityRegistry(), {
      startTurn: async (_sessionId, input) => {
        turns += 1;
        return { kind: 'completed', turnId: input.turnId };
      },
    });
    try {
      coordinator.notify(shellRunUpdate(record));
      coordinator.notify(shellRunUpdate(record));
      await coordinator.waitForIdle();
      coordinator.notify(shellRunUpdate(record));
      await coordinator.waitForIdle();

      assert.equal(turns, 1);
      assert.equal(
        (await store.readShellRun(record.sessionId, record.shellRunId)).completionWake
          ?.attemptCount,
        1,
      );
    } finally {
      await coordinator.close();
    }
  });

  test('lets a foreground observation win while the completion wake waits for the session lane', async () => {
    const store = await createStore();
    const record = await store.createShellRun(terminalRecord());
    const activities = new SessionActivityRegistry();
    const activeTurn = activities.reserve(record.sessionId);
    let turns = 0;
    const coordinator = coordinatorFor(store, activities, {
      startTurn: async (_sessionId, input) => {
        turns += 1;
        return { kind: 'completed', turnId: input.turnId };
      },
    });
    try {
      coordinator.notify(shellRunUpdate(record));
      await store.updateShellRun(record.sessionId, record.shellRunId, { observedAt: 500 });
      activeTurn.release();
      await coordinator.waitForIdle();

      assert.equal(turns, 0);
      assert.equal(await coordinator.recover(), 0);
    } finally {
      activeTurn.release();
      await coordinator.close();
    }
  });

  test('marks a recovered completed attempt delivered without starting another turn', async () => {
    const store = await createStore();
    const record = await store.createShellRun(
      terminalRecord({
        completionWake: { attemptCount: 1, attemptTurnId: 'previous-turn' },
      }),
    );
    let turns = 0;
    const coordinator = coordinatorFor(store, new SessionActivityRegistry(), {
      inspectTurn: async () => 'completed',
      startTurn: async (_sessionId, input) => {
        turns += 1;
        return { kind: 'completed', turnId: input.turnId };
      },
    });
    try {
      assert.equal(await coordinator.recover(), 1);
      await coordinator.waitForIdle();

      const delivered = await store.readShellRun(record.sessionId, record.shellRunId);
      assert.equal(turns, 0);
      assert.equal(delivered.completionWake?.attemptCount, 1);
      assert.equal(delivered.completionWake?.attemptTurnId, 'previous-turn');
      assert.ok(delivered.completionWake?.deliveredAt !== undefined);
    } finally {
      await coordinator.close();
    }
  });

  test('watches an active recovered attempt and retries when it later fails', async () => {
    const store = await createStore();
    const record = await store.createShellRun(
      terminalRecord({
        completionWake: { attemptCount: 1, attemptTurnId: 'previous-turn' },
      }),
    );
    const statuses: Array<'active' | 'failed'> = ['active', 'active', 'failed'];
    let inspections = 0;
    let turns = 0;
    const coordinator = coordinatorFor(store, new SessionActivityRegistry(), {
      activeTurnCheckIntervalMs: 1,
      inspectTurn: async () => {
        inspections += 1;
        return statuses.shift() ?? 'failed';
      },
      startTurn: async (_sessionId, input) => {
        turns += 1;
        return { kind: 'completed', turnId: input.turnId };
      },
    });
    try {
      assert.equal(await coordinator.recover(), 1);
      await coordinator.waitForIdle();

      const delivered = await store.readShellRun(record.sessionId, record.shellRunId);
      assert.ok(inspections >= 3);
      assert.equal(turns, 1);
      assert.equal(delivered.completionWake?.attemptCount, 2);
      assert.equal(delivered.completionWake?.attemptTurnId, 'wake-turn-1');
    } finally {
      await coordinator.close();
    }
  });

  for (const previousStatus of ['failed', 'missing'] as const) {
    test(`retries a recovered ${previousStatus} attempt within the durable budget`, async () => {
      const store = await createStore();
      const record = await store.createShellRun(
        terminalRecord({
          completionWake: { attemptCount: 1, attemptTurnId: 'previous-turn' },
        }),
      );
      let turns = 0;
      const coordinator = coordinatorFor(store, new SessionActivityRegistry(), {
        inspectTurn: async () => previousStatus,
        startTurn: async (_sessionId, input) => {
          turns += 1;
          return { kind: 'completed', turnId: input.turnId };
        },
      });
      try {
        assert.equal(await coordinator.recover(), 1);
        await coordinator.waitForIdle();

        const delivered = await store.readShellRun(record.sessionId, record.shellRunId);
        assert.equal(turns, 1);
        assert.equal(delivered.completionWake?.attemptCount, 2);
      } finally {
        await coordinator.close();
      }
    });
  }

  test('persists thrown and errored attempts across retries before delivery', async () => {
    const store = await createStore();
    const record = await store.createShellRun(terminalRecord());
    let turns = 0;
    const coordinator = coordinatorFor(store, new SessionActivityRegistry(), {
      startTurn: async (_sessionId, input) => {
        turns += 1;
        if (turns === 1) throw new Error('provider unavailable');
        if (turns === 2) return { kind: 'errored', turnId: input.turnId, reason: 'stream failed' };
        return { kind: 'completed', turnId: input.turnId };
      },
    });
    try {
      coordinator.notify(shellRunUpdate(record));
      await coordinator.waitForIdle();

      const delivered = await store.readShellRun(record.sessionId, record.shellRunId);
      assert.equal(turns, 3);
      assert.equal(delivered.completionWake?.attemptCount, 3);
      assert.equal(delivered.completionWake?.lastFailure, 'stream failed');
      assert.ok(delivered.completionWake?.deliveredAt !== undefined);
    } finally {
      await coordinator.close();
    }
  });

  test('durably exhausts the retry budget so restart recovery cannot reset it', async () => {
    const store = await createStore();
    const record = await store.createShellRun(terminalRecord());
    const errors: unknown[] = [];
    let turns = 0;
    const coordinator = coordinatorFor(store, new SessionActivityRegistry(), {
      maxDeliveryAttempts: 2,
      onError: (_sessionId, error) => {
        errors.push(error);
      },
      startTurn: async (_sessionId, input) => {
        turns += 1;
        return { kind: 'errored', turnId: input.turnId, reason: `failure-${turns}` };
      },
    });
    try {
      coordinator.notify(shellRunUpdate(record));
      await coordinator.waitForIdle();

      const exhausted = await store.readShellRun(record.sessionId, record.shellRunId);
      assert.equal(turns, 2);
      assert.equal(errors.length, 1);
      assert.equal(exhausted.completionWake?.attemptCount, 2);
      assert.equal(exhausted.completionWake?.lastFailure, 'failure-2');
      assert.ok(exhausted.completionWake?.exhaustedAt !== undefined);
      assert.equal(exhausted.completionWake?.deliveredAt, undefined);
      assert.equal(await coordinator.recover(), 0);
    } finally {
      await coordinator.close();
    }
  });

  test('close aborts an active-attempt watcher without starting or reporting another turn', async () => {
    const store = await createStore();
    const record = await store.createShellRun(
      terminalRecord({
        completionWake: { attemptCount: 1, attemptTurnId: 'previous-turn' },
      }),
    );
    let observedActive!: () => void;
    const activeObserved = new Promise<void>((resolve) => {
      observedActive = resolve;
    });
    let turns = 0;
    const errors: unknown[] = [];
    const coordinator = coordinatorFor(store, new SessionActivityRegistry(), {
      activeTurnCheckIntervalMs: 60_000,
      inspectTurn: async () => {
        observedActive();
        return 'active';
      },
      onError: (_sessionId, error) => {
        errors.push(error);
      },
      startTurn: async (_sessionId, input) => {
        turns += 1;
        return { kind: 'completed', turnId: input.turnId };
      },
    });

    coordinator.notify(shellRunUpdate(record));
    await activeObserved;
    await coordinator.close();

    assert.equal(turns, 0);
    assert.equal(errors.length, 0);
  });

  test('renders a bounded terminal result rather than polling instructions', () => {
    const prompt = renderShellRunCompletionWakePrompt(terminalRecord());
    assert.match(prompt, /"status":"completed"/);
    assert.match(prompt, /compile finished/);
    assert.doesNotMatch(prompt, /Read\(ref\)|sleep \d/);
  });
});

async function createStore(): Promise<ClosableShellRunStore> {
  const root = await mkdtemp(join(tmpdir(), 'maka-shell-wake-'));
  workspaces.push(root);
  const store = createSqliteShellRunStore(root);
  stores.push(store);
  await store.ready();
  return store;
}

function coordinatorFor(
  store: ClosableShellRunStore,
  activityRegistry: SessionActivityRegistry,
  overrides: {
    startTurn: ConstructorParameters<typeof ShellRunCompletionWakeCoordinator>[0]['startTurn'];
    inspectTurn?: ConstructorParameters<typeof ShellRunCompletionWakeCoordinator>[0]['inspectTurn'];
    maxDeliveryAttempts?: number;
    activeTurnCheckIntervalMs?: number;
    onError?: ConstructorParameters<typeof ShellRunCompletionWakeCoordinator>[0]['onError'];
  },
): ShellRunCompletionWakeCoordinator {
  let id = 0;
  let now = 1_000;
  return new ShellRunCompletionWakeCoordinator({
    activityRegistry,
    store,
    listSessionIds: async () => ['session-1'],
    startTurn: overrides.startTurn,
    inspectTurn: overrides.inspectTurn ?? (async () => 'missing'),
    newId: () => `wake-turn-${++id}`,
    now: () => ++now,
    ...(overrides.maxDeliveryAttempts !== undefined
      ? { maxDeliveryAttempts: overrides.maxDeliveryAttempts }
      : {}),
    ...(overrides.activeTurnCheckIntervalMs !== undefined
      ? { activeTurnCheckIntervalMs: overrides.activeTurnCheckIntervalMs }
      : {}),
    ...(overrides.onError ? { onError: overrides.onError } : {}),
  });
}

function terminalRecord(overrides: Partial<ShellRunRecord> = {}): ShellRunRecord {
  return {
    shellRunId: 'shell-run-1',
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    cwd: '/tmp',
    command: 'cargo build',
    status: 'completed',
    exitCode: 0,
    startedAt: 100,
    updatedAt: 200,
    completedAt: 200,
    notifyOnComplete: true,
    revision: 3,
    output: {
      mode: 'pipes',
      stdout: 'compile finished',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
    ...overrides,
  };
}
