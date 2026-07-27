import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import {
  TOOL_RECOVERY_BUNDLE_CAPABILITY_V1,
  canonicalToolArgsHash,
  type RuntimeEvent,
} from '@maka/core';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';
import type { SqliteRuntimeStoreFailpoint } from '../sqlite-runtime-store.js';

const ARGS_HASH = canonicalToolArgsHash('Write', {
  path: 'notes.txt',
  content: 'after',
});
const OBSERVATION_DIGEST =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

describe('SQLite recovery persistence authority', () => {
  it('upgrades a populated mainline schema 4 database without losing immutable events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-recovery-mainline-upgrade-'));
    const dbPath = join(root, 'runtime.sqlite');
    const store = createSqliteRuntimeStore(dbPath);
    await store.appendRuntimeEvent('session-1', 'run-1', userEvent());
    store.close();

    const db = new DatabaseSync(dbPath);
    db.exec('DROP TABLE runtime_capabilities; PRAGMA user_version = 4;');
    db.close();

    try {
      const upgraded = createSqliteRuntimeStore(dbPath);
      try {
        assert.deepEqual(await upgraded.readImmutableRuntimeEvents('session-1', 'run-1'), [
          userEvent(),
        ]);
        assert.equal(upgraded.recoveryBundleCapability, TOOL_RECOVERY_BUNDLE_CAPABILITY_V1);
      } finally {
        upgraded.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects the old experimental capability marker instead of guessing compatibility', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-recovery-epoch-'));
    const dbPath = join(root, 'runtime.sqlite');
    const store = createSqliteRuntimeStore(dbPath);
    store.close();
    const db = new DatabaseSync(dbPath);
    db.prepare('DELETE FROM runtime_capabilities').run();
    db.prepare('INSERT INTO runtime_capabilities(capability, version) VALUES (?, ?)').run(
      'tool_recovery_bundle',
      1,
    );
    db.close();
    try {
      assert.throws(
        () => createSqliteRuntimeStore(dbPath),
        /runtime_recovery_authority@1 is unavailable/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects reserved recovery facts through every generic append path', async () => {
    await withStore(async (store) => {
      await assert.rejects(
        store.appendRuntimeEvent('session-1', 'run-1', reconcileEvent()),
        /atomic recovery bundle writer/,
      );
      await assert.rejects(
        store.importRuntimeEventsBatch({
          sessionId: 'session-1',
          runId: 'run-1',
          events: [reconcileEvent()],
        }),
        /atomic recovery bundle writer/,
      );
      await assert.rejects(
        store.appendRuntimeEvent('session-1', 'run-1', dispatchEvent()),
        /atomic tool boundary writer/,
      );
      await assert.rejects(
        store.appendRuntimeEvent('session-1', 'run-1', outcomeEvent()),
        /atomic tool boundary writer/,
      );
    });
  });

  it('recomputes T1 identity from the persisted function-call arguments', async () => {
    await withStore(async (store) => {
      const dispatch = dispatchEvent();
      dispatch.actions!.toolDispatch!.canonicalArgsHash = 'sha256:wrong';
      await assert.rejects(
        store.commitToolPrepared({
          operationId: 'operation-1',
          journalEventId: 'journal-prepared-1',
          runtimeEvent: callEvent(),
          dispatchRuntimeEvent: dispatch,
          providerToolCallId: 'provider-call-1',
          toolName: 'Write',
          canonicalArgsHash: 'sha256:wrong',
          recoveryMode: 'reconcile',
          committedAt: 10,
        }),
        /canonical function call/,
      );
      assert.deepEqual(await store.readImmutableRuntimeEvents('session-1', 'run-1'), []);
    });
  });

  it('rejects a T2 row that also claims another authoritative semantic lane', async () => {
    await withStore(async (store) => {
      await prepare(store);
      const outcome = outcomeEvent();
      outcome.actions = { endInvocation: true };
      await assert.rejects(
        store.commitToolOutcome({
          operationId: 'operation-1',
          journalEventId: 'operation-1_outcome',
          runtimeEvent: outcome,
          committedAt: 20,
        }),
        /semantic lane/,
      );
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
      assert.deepEqual(
        (await store.readImmutableRuntimeEvents('session-1', 'run-1')).map(({ id }) => id),
        ['call-event-1', 'dispatch-event-1'],
      );
    });
  });

  it('atomically settles completed recovery and rebuilds the same projection after reopen', async () => {
    await withStore(async (store, dbPath) => {
      assert.equal(store.recoveryBundleCapability, TOOL_RECOVERY_BUNDLE_CAPABILITY_V1);
      await prepare(store);
      await store.commitToolRecoveryBundle({
        operationId: 'operation-1',
        reconcileRuntimeEvent: reconcileEvent(),
        outcomeRuntimeEvent: outcomeEvent(),
        decisionRuntimeEvent: decisionEvent(),
      });

      const onlineOperation = await store.readToolOperation('operation-1');
      const onlineJournal = await store.readToolJournal('operation-1');
      assert.equal(onlineOperation?.currentState, 'recovery_completed');
      assert.equal(onlineOperation?.resultEventId, 'outcome-event-1');
      assert.deepEqual(
        onlineJournal.map(({ state }) => state),
        ['prepared', 'reconcile_observed', 'outcome_committed', 'recovery_completed'],
      );

      store.close();
      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        assert.deepEqual(await reopened.readToolOperation('operation-1'), onlineOperation);
        assert.deepEqual(await reopened.readToolJournal('operation-1'), onlineJournal);
        assert.deepEqual(await reopened.rebuildToolProjectionsFromRuntimeEvents(), {
          operations: 1,
          journalEvents: 4,
        });
        assert.deepEqual(await reopened.readToolOperation('operation-1'), onlineOperation);
        assert.deepEqual(await reopened.readToolJournal('operation-1'), onlineJournal);
      } finally {
        reopened.close();
      }
    });
  });

  it('rolls the whole recovery bundle back at every internal crash boundary', async () => {
    for (const failpoint of [
      'after_recovery_reconcile',
      'after_recovery_outcome',
      'after_recovery_decision',
    ] as const satisfies readonly SqliteRuntimeStoreFailpoint[]) {
      const root = await mkdtemp(join(tmpdir(), 'maka-recovery-failpoint-'));
      const dbPath = join(root, 'runtime.sqlite');
      let active: SqliteRuntimeStoreFailpoint | undefined;
      const store = createSqliteRuntimeStore(dbPath, {
        failpoint: (point) => {
          if (point === active) throw new Error(`recovery failpoint: ${point}`);
        },
      });
      try {
        await prepare(store);
        active = failpoint;
        await assert.rejects(
          store.commitToolRecoveryBundle({
            operationId: 'operation-1',
            reconcileRuntimeEvent: reconcileEvent(),
            outcomeRuntimeEvent: outcomeEvent(),
            decisionRuntimeEvent: decisionEvent(),
          }),
          new RegExp(failpoint),
        );
        active = undefined;
        assert.deepEqual(
          (await store.readImmutableRuntimeEvents('session-1', 'run-1')).map(({ id }) => id),
          ['call-event-1', 'dispatch-event-1'],
        );
        assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
        assert.deepEqual(
          (await store.readToolJournal('operation-1')).map(({ state }) => state),
          ['prepared'],
        );
      } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it('makes one parked bundle terminal and only permits its exact retry', async () => {
    await withStore(async (store) => {
      await prepare(store);
      const parked = {
        operationId: 'operation-1',
        reconcileRuntimeEvent: reconcileEvent('diverged'),
        decisionRuntimeEvent: decisionEvent('parked'),
      } as const;
      await store.commitToolRecoveryBundle(parked);
      await store.commitToolRecoveryBundle(parked);

      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'recovery_parked');
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map(({ state }) => state),
        ['prepared', 'reconcile_observed', 'recovery_parked'],
      );
      await assert.rejects(
        store.commitToolRecoveryBundle({
          operationId: 'operation-1',
          reconcileRuntimeEvent: reconcileEvent(),
          outcomeRuntimeEvent: outcomeEvent(),
          decisionRuntimeEvent: decisionEvent(),
        }),
        /already settled/,
      );
    });
  });

  it('fails immutable row/payload identity mismatches closed', async () => {
    await withStore(async (store, dbPath) => {
      await store.appendRuntimeEvent('session-1', 'run-1', userEvent());
      store.close();

      const db = new DatabaseSync(dbPath);
      const payload = { ...userEvent(), runId: 'run-other' };
      db.prepare('UPDATE runtime_events SET payload_json = ? WHERE event_id = ?').run(
        JSON.stringify(payload),
        'user-event-1',
      );
      db.close();

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        await assert.rejects(
          reopened.readImmutableRuntimeEvents('session-1', 'run-1'),
          /row\/payload identity mismatch/,
        );
      } finally {
        reopened.close();
      }
    });
  });

  it('rejects row/payload identity corruption through the online bundle writer', async () => {
    await withStore(async (store, dbPath) => {
      await prepare(store);
      store.close();

      const db = new DatabaseSync(dbPath);
      db.prepare(`UPDATE runtime_events SET run_id = 'run-other' WHERE event_id = ?`).run(
        'call-event-1',
      );
      db.close();

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        await assert.rejects(
          reopened.commitToolRecoveryBundle({
            operationId: 'operation-1',
            reconcileRuntimeEvent: reconcileEvent(),
            outcomeRuntimeEvent: outcomeEvent(),
            decisionRuntimeEvent: decisionEvent(),
          }),
          /row\/payload identity mismatch/,
        );
        assert.equal((await reopened.readToolOperation('operation-1'))?.currentState, 'prepared');
      } finally {
        reopened.close();
      }
    });
  });

  it('rejects duplicate call identity while rebuilding canonical projections', async () => {
    await withStore(async (store, dbPath) => {
      await prepare(store);
      store.close();

      const db = new DatabaseSync(dbPath);
      const row = db
        .prepare(`
          SELECT session_id, invocation_id, run_id, turn_id, event_kind,
            payload_json, committed_at
          FROM runtime_events
          WHERE event_id = 'call-event-1'
        `)
        .get() as {
        session_id: string;
        invocation_id: string;
        run_id: string;
        turn_id: string;
        event_kind: string;
        payload_json: string;
        committed_at: number;
      };
      const payload = JSON.parse(row.payload_json) as RuntimeEvent;
      payload.id = 'call-event-duplicate';
      db.prepare(`
        INSERT INTO runtime_events(
          event_id, session_id, invocation_id, run_id, turn_id,
          event_seq, event_kind, payload_json, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        payload.id,
        row.session_id,
        row.invocation_id,
        row.run_id,
        row.turn_id,
        3,
        row.event_kind,
        JSON.stringify(payload),
        row.committed_at,
      );
      db.close();

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        await assert.rejects(reopened.rebuildToolProjectionsFromRuntimeEvents(), /duplicate_call/);
      } finally {
        reopened.close();
      }
    });
  });

  it('rejects dispatch-before-call physical order while rebuilding projections', async () => {
    await withStore(async (store, dbPath) => {
      await prepare(store);
      store.close();

      const db = new DatabaseSync(dbPath);
      db.prepare(`UPDATE runtime_events SET event_seq = 100 WHERE event_id = 'call-event-1'`).run();
      db.prepare(
        `UPDATE runtime_events SET event_seq = 1 WHERE event_id = 'dispatch-event-1'`,
      ).run();
      db.prepare(`UPDATE runtime_events SET event_seq = 2 WHERE event_id = 'call-event-1'`).run();
      db.close();

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        await assert.rejects(
          reopened.rebuildToolProjectionsFromRuntimeEvents(),
          /event_order_conflict/,
        );
      } finally {
        reopened.close();
      }
    });
  });

  it('skips a corrupt mutable partial snapshot without hiding immutable history', async () => {
    await withStore(async (store, dbPath) => {
      await store.appendRuntimeEvent('session-1', 'run-1', userEvent());
      await store.appendRuntimeEvent('session-1', 'run-1', partialTextEvent());
      store.close();

      const db = new DatabaseSync(dbPath);
      db.prepare('UPDATE runtime_partial_snapshots SET payload_json = ?').run('{broken json');
      db.close();

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        assert.deepEqual(await reopened.readRuntimeEvents('session-1', 'run-1'), [userEvent()]);
      } finally {
        reopened.close();
      }
    });
  });

  it('skips a mutable partial whose SQL identity disagrees with its payload', async () => {
    await withStore(async (store, dbPath) => {
      await store.appendRuntimeEvent('session-1', 'run-1', userEvent());
      await store.appendRuntimeEvent('session-1', 'run-1', partialTextEvent());
      store.close();

      const db = new DatabaseSync(dbPath);
      db.prepare(`UPDATE runtime_partial_snapshots SET invocation_id = 'invocation-other'`).run();
      db.close();

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        assert.deepEqual(await reopened.readRuntimeEvents('session-1', 'run-1'), [userEvent()]);
      } finally {
        reopened.close();
      }
    });
  });
});

type Store = ReturnType<typeof createSqliteRuntimeStore>;

async function withStore(run: (store: Store, dbPath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-recovery-authority-'));
  const dbPath = join(root, 'runtime.sqlite');
  const store = createSqliteRuntimeStore(dbPath);
  try {
    await run(store, dbPath);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function prepare(store: Store): Promise<void> {
  await store.commitToolPrepared({
    operationId: 'operation-1',
    journalEventId: 'operation-1_prepared',
    runtimeEvent: callEvent(),
    dispatchRuntimeEvent: dispatchEvent(),
    providerToolCallId: 'provider-call-1',
    toolName: 'Write',
    canonicalArgsHash: ARGS_HASH,
    recoveryMode: 'reconcile',
    committedAt: 10,
  });
}

function baseEvent(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

function userEvent(): RuntimeEvent {
  return baseEvent({
    id: 'user-event-1',
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'write it' },
  });
}

function partialTextEvent(): RuntimeEvent {
  return baseEvent({
    id: 'partial-event-1',
    ts: 2,
    partial: true,
    role: 'model',
    author: 'agent',
    content: { kind: 'text', text: 'in progress' },
    refs: { providerEventId: 'provider-text-1' },
  });
}

function callEvent(): RuntimeEvent {
  return baseEvent({
    id: 'call-event-1',
    role: 'model',
    author: 'agent',
    content: {
      kind: 'function_call',
      id: 'provider-call-1',
      name: 'Write',
      args: { path: 'notes.txt', content: 'after' },
    },
  });
}

function dispatchEvent(): RuntimeEvent {
  return baseEvent({
    id: 'dispatch-event-1',
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: 'operation-1',
        providerToolCallId: 'provider-call-1',
        toolName: 'Write',
        canonicalArgsHash: ARGS_HASH,
        recoveryMode: 'reconcile',
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  });
}

function reconcileEvent(
  observation:
    | 'matches_expected_state'
    | 'matches_prior_state'
    | 'diverged'
    | 'unreadable' = 'matches_expected_state',
): RuntimeEvent {
  return baseEvent({
    id: 'reconcile-event-1',
    ts: 2,
    actions: {
      toolRecovery: {
        kind: 'maka.tool.reconcile_result',
        version: 1,
        payload: {
          protocol: 'tool_reconcile_v1',
          operationId: 'operation-1',
          observation,
          observationSchema: 'state_identity_v1',
          observationDigest: OBSERVATION_DIGEST,
        },
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  });
}

function outcomeEvent(): RuntimeEvent {
  return baseEvent({
    id: 'outcome-event-1',
    ts: 3,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'provider-call-1',
      name: 'Write',
      result: 'ok',
      isError: false,
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  });
}

function decisionEvent(disposition: 'completed' | 'parked' = 'completed'): RuntimeEvent {
  return baseEvent({
    id: 'decision-event-1',
    ts: 4,
    actions: {
      toolRecovery:
        disposition === 'completed'
          ? {
              kind: 'maka.tool.recovery_decision',
              version: 1,
              payload: {
                protocol: 'tool_recovery_v1',
                operationId: 'operation-1',
                disposition: 'completed',
                reasonCode: 'reconcile_matches_expected_state',
                outcomeEventId: 'outcome-event-1',
                evidenceEventIds: [
                  'call-event-1',
                  'dispatch-event-1',
                  'reconcile-event-1',
                  'outcome-event-1',
                ],
              },
            }
          : {
              kind: 'maka.tool.recovery_decision',
              version: 1,
              payload: {
                protocol: 'tool_recovery_v1',
                operationId: 'operation-1',
                disposition: 'parked',
                reasonCode: 'reconcile_diverged',
                evidenceEventIds: ['call-event-1', 'dispatch-event-1', 'reconcile-event-1'],
              },
            },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  });
}
