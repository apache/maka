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
  },
): ShellRunCompletionWakeCoordinator {
  let id = 0;
  let now = 1_000;
  return new ShellRunCompletionWakeCoordinator({
    activityRegistry,
    store,
    listSessionIds: async () => ['session-1'],
    startTurn: overrides.startTurn,
    inspectTurn: async () => 'missing',
    newId: () => `wake-turn-${++id}`,
    now: () => ++now,
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
