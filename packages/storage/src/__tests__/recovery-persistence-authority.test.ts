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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { TOOL_RECOVERY_BUNDLE_CAPABILITY_V1 } from '@maka/core/runtime-event-store';
import { type RuntimeEvent } from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';
import type { SqliteRuntimeStoreFailpoint } from '../sqlite-runtime-store.js';

const ARGS_HASH = canonicalToolArgsHash('Write', {
  path: 'notes.txt',
  content: 'after',
});
// Mainline schema 4 persisted stableHash({ toolName, args }) for this exact
// provider call. Keep the literal independent from the current hash helper so
// an accidental identity-epoch change remains observable during migration.
const MAINLINE_SCHEMA_4_SPECIAL_ARGS_HASH =
  'sha256:0002fcd132216e3442d4ab7579d9659019019c6b7000456fbef198b7ae53ee43';
const OBSERVATION_DIGEST =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

describe('SQLite recovery persistence authority', () => {
  it('rebuilds a real schema 4 T1 dispatch written with the mainline args identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-recovery-mainline-t1-upgrade-'));
    const dbPath = join(root, 'runtime.sqlite');
    const store = createSqliteRuntimeStore(dbPath);
    store.close();

    const call = baseEvent({
      id: 'schema-4-call',
      role: 'model',
      author: 'agent',
      content: {
        kind: 'function_call',
        id: 'schema-4-provider-call',
        name: 'X',
        args: { required: ['b', 'a'] },
      },
    });
    const dispatch = baseEvent({
      id: 'schema-4-dispatch',
      ts: 2,
      actions: {
        toolDispatch: {
          protocol: 't1_after_preflight_v1',
          operationId: 'schema-4-operation',
          providerToolCallId: 'schema-4-provider-call',
          toolName: 'X',
          canonicalArgsHash: MAINLINE_SCHEMA_4_SPECIAL_ARGS_HASH,
          recoveryMode: 'replay_safe',
        },
      },
      refs: {
        operationId: 'schema-4-operation',
        toolCallId: 'schema-4-provider-call',
      },
    });

    const db = new DatabaseSync(dbPath);
    const insertEvent = db.prepare(`
      INSERT INTO runtime_events(
        event_id, session_id, invocation_id, run_id, turn_id,
        event_seq, event_kind, payload_json, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertEvent.run(
      call.id,
      call.sessionId,
      call.invocationId,
      call.runId,
      call.turnId,
      1,
      'function_call',
      JSON.stringify(call),
      call.ts,
    );
    insertEvent.run(
      dispatch.id,
      dispatch.sessionId,
      dispatch.invocationId,
      dispatch.runId,
      dispatch.turnId,
      2,
      'tool_dispatch',
      JSON.stringify(dispatch),
      dispatch.ts,
    );
    db.exec(
      'DROP TABLE runtime_session_event_ordinals; DROP TABLE runtime_partial_segments; DROP TABLE runtime_storage_root_binding; DROP TABLE runtime_workspace_heads; DROP TABLE runtime_workspace_versions; DROP TABLE runtime_workspace_epochs; DROP TABLE runtime_continuation_claims; DROP TABLE runtime_capabilities; PRAGMA user_version = 4;',
    );
    db.close();

    try {
      const upgraded = createSqliteRuntimeStore(dbPath);
      try {
        assert.deepEqual(await upgraded.rebuildToolProjectionsFromRuntimeEvents(), {
          operations: 1,
          journalEvents: 1,
        });
        assert.deepEqual(await upgraded.readToolOperation('schema-4-operation'), {
          operationId: 'schema-4-operation',
          invocationId: 'invocation-1',
          runId: 'run-1',
          turnId: 'turn-1',
          providerToolCallId: 'schema-4-provider-call',
          toolName: 'X',
          canonicalArgsHash: MAINLINE_SCHEMA_4_SPECIAL_ARGS_HASH,
          recoveryMode: 'replay_safe',
          currentState: 'prepared',
          callEventId: 'schema-4-call',
          dispatchEventId: 'schema-4-dispatch',
          version: 1,
        });
      } finally {
        upgraded.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('upgrades and quarantines populated mainline schema 4 tool projections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-recovery-mainline-upgrade-'));
    const dbPath = join(root, 'runtime.sqlite');
    const store = createSqliteRuntimeStore(dbPath);
    const preparedCall = callEvent();
    preparedCall.id = 'legacy-prepared-call';
    preparedCall.content = {
      kind: 'function_call',
      id: 'legacy-prepared-provider-call',
      name: 'Read',
      args: { path: 'prepared.txt' },
    };
    const completedCall = callEvent();
    completedCall.id = 'legacy-completed-call';
    completedCall.content = {
      kind: 'function_call',
      id: 'legacy-completed-provider-call',
      name: 'Read',
      args: { path: 'completed.txt' },
    };
    const completedResponse = outcomeEvent();
    completedResponse.id = 'legacy-completed-response';
    completedResponse.content = {
      kind: 'function_response',
      id: 'legacy-completed-provider-call',
      name: 'Read',
      result: 'contents',
    };
    completedResponse.refs = { toolCallId: 'legacy-completed-provider-call' };
    await store.importRuntimeEventsBatch({
      sessionId: 'session-1',
      runId: 'run-1',
      events: [preparedCall, completedCall, completedResponse],
    });
    store.close();

    const db = new DatabaseSync(dbPath);
    const insertOperation = db.prepare(`
      INSERT INTO tool_operations(
        operation_id, invocation_id, run_id, turn_id, provider_tool_call_id,
        tool_name, canonical_args_hash, recovery_mode, current_state,
        call_event_id, dispatch_event_id, result_event_id, version
      ) VALUES (?, 'invocation-1', 'run-1', 'turn-1', ?, 'Read', ?, 'replay_safe', ?, ?, NULL, ?, ?)
    `);
    insertOperation.run(
      'legacy-prepared-operation',
      'legacy-prepared-provider-call',
      canonicalToolArgsHash('Read', { path: 'prepared.txt' }),
      'prepared',
      'legacy-prepared-call',
      null,
      1,
    );
    insertOperation.run(
      'legacy-completed-operation',
      'legacy-completed-provider-call',
      canonicalToolArgsHash('Read', { path: 'completed.txt' }),
      'outcome_committed',
      'legacy-completed-call',
      'legacy-completed-response',
      2,
    );
    db.exec(
      'DROP TABLE runtime_session_event_ordinals; DROP TABLE runtime_partial_segments; DROP TABLE runtime_storage_root_binding; DROP TABLE runtime_workspace_heads; DROP TABLE runtime_workspace_versions; DROP TABLE runtime_workspace_epochs; DROP TABLE runtime_continuation_claims; DROP TABLE runtime_capabilities; PRAGMA user_version = 4;',
    );
    db.close();

    try {
      const upgraded = createSqliteRuntimeStore(dbPath);
      try {
        assert.equal(
          (await upgraded.readToolOperation('legacy-prepared-operation'))?.currentState,
          'prepared',
        );
        assert.equal(
          (await upgraded.readToolOperation('legacy-completed-operation'))?.currentState,
          'outcome_committed',
        );
        assert.deepEqual(await upgraded.listUnsettledToolOperations(), []);
        assert.deepEqual(await upgraded.rebuildToolProjectionsFromRuntimeEvents(), {
          operations: 0,
          journalEvents: 0,
        });
        assert.equal(
          (await upgraded.readToolOperation('legacy-prepared-operation'))?.currentState,
          'prepared',
        );
        assert.equal(
          (await upgraded.readToolOperation('legacy-completed-operation'))?.currentState,
          'outcome_committed',
        );
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
          journalEventId: 'operation-1_prepared',
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

  it('derives projection-local journal identities instead of trusting callers', async () => {
    await withStore(async (store) => {
      await assert.rejects(
        store.commitToolPrepared({
          operationId: 'operation-1',
          journalEventId: 'caller-selected-id',
          runtimeEvent: callEvent(),
          dispatchRuntimeEvent: dispatchEvent(),
          providerToolCallId: 'provider-call-1',
          toolName: 'Write',
          canonicalArgsHash: ARGS_HASH,
          recoveryMode: 'reconcile',
          committedAt: 10,
        }),
        /journal identity/,
      );
      assert.deepEqual(await store.readImmutableRuntimeEvents('session-1', 'run-1'), []);
    });
  });

  it('rejects duplicate call identities through the generic writer', async () => {
    await withStore(async (store) => {
      await store.appendRuntimeEvent('session-1', 'run-1', callEvent());
      await assert.rejects(
        store.appendRuntimeEvent('session-1', 'run-1', {
          ...callEvent(),
          id: 'call-event-duplicate',
        }),
        /duplicate_call/,
      );
      assert.deepEqual(
        (await store.readImmutableRuntimeEvents('session-1', 'run-1')).map(({ id }) => id),
        ['call-event-1'],
      );
    });
  });

  it('rejects one invocation identity crossing run, turn, or session boundaries', async () => {
    await withStore(async (store) => {
      await store.appendRuntimeEvent('session-1', 'run-1', userEvent());

      for (const event of [
        baseEvent({
          id: 'other-run-event',
          runId: 'run-2',
          content: { kind: 'text', text: 'other run' },
        }),
        baseEvent({
          id: 'other-turn-event',
          turnId: 'turn-2',
          content: { kind: 'text', text: 'other turn' },
        }),
        baseEvent({
          id: 'other-session-event',
          sessionId: 'session-2',
          content: { kind: 'text', text: 'other session' },
        }),
      ]) {
        await assert.rejects(
          store.appendRuntimeEvent(event.sessionId, event.runId, event),
          /invocation identity conflict/,
        );
      }
      assert.deepEqual(
        (await store.readImmutableRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
        ['user-event-1'],
      );
    });
  });

  it('rejects an unbound generic response after T1', async () => {
    await withStore(async (store) => {
      await prepare(store);
      const unboundResponse = outcomeEvent();
      unboundResponse.refs = { toolCallId: 'provider-call-1' };

      await assert.rejects(
        store.appendRuntimeEvent('session-1', 'run-1', unboundResponse),
        /identity_conflict/,
      );
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
    });
  });

  it('rejects a T1 dispatch after a pre-T1 synthetic response settled the call', async () => {
    await withStore(async (store) => {
      const unboundResponse = outcomeEvent();
      unboundResponse.refs = { toolCallId: 'provider-call-1' };
      await store.importRuntimeEventsBatch({
        sessionId: 'session-1',
        runId: 'run-1',
        events: [callEvent(), unboundResponse],
      });

      await assert.rejects(
        store.commitToolPrepared({
          operationId: 'operation-1',
          journalEventId: 'operation-1_prepared',
          runtimeEvent: callEvent(),
          dispatchRuntimeEvent: dispatchEvent(),
          providerToolCallId: 'provider-call-1',
          toolName: 'Write',
          canonicalArgsHash: ARGS_HASH,
          recoveryMode: 'reconcile',
          committedAt: 10,
        }),
        /event_order_conflict/,
      );
      assert.equal(await store.readToolOperation('operation-1'), undefined);
    });
  });

  it('rejects an out-of-order tool-bearing batch import atomically', async () => {
    await withStore(async (store) => {
      const unboundResponse = outcomeEvent();
      unboundResponse.refs = { toolCallId: 'provider-call-1' };
      await assert.rejects(
        store.importRuntimeEventsBatch({
          sessionId: 'session-1',
          runId: 'run-1',
          events: [unboundResponse, callEvent()],
        }),
        /orphan_response/,
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

  it('rebuilds interleaved operations to the same projections and journal identities', async () => {
    await withStore(async (store) => {
      await prepare(store);
      const secondHash = canonicalToolArgsHash('Write', {
        path: 'other.txt',
        content: 'after',
      });
      const secondCall = callEvent();
      secondCall.id = 'call-event-2';
      secondCall.content = {
        kind: 'function_call',
        id: 'provider-call-2',
        name: 'Write',
        args: { path: 'other.txt', content: 'after' },
      };
      const secondDispatch = dispatchEvent();
      secondDispatch.id = 'dispatch-event-2';
      secondDispatch.actions!.toolDispatch = {
        protocol: 't1_after_preflight_v1',
        operationId: 'operation-2',
        providerToolCallId: 'provider-call-2',
        toolName: 'Write',
        canonicalArgsHash: secondHash,
        recoveryMode: 'reconcile',
      };
      secondDispatch.refs = { operationId: 'operation-2', toolCallId: 'provider-call-2' };
      await store.commitToolPrepared({
        operationId: 'operation-2',
        journalEventId: 'operation-2_prepared',
        runtimeEvent: secondCall,
        dispatchRuntimeEvent: secondDispatch,
        providerToolCallId: 'provider-call-2',
        toolName: 'Write',
        canonicalArgsHash: secondHash,
        recoveryMode: 'reconcile',
        committedAt: 11,
      });
      const secondOutcome = outcomeEvent();
      secondOutcome.id = 'outcome-event-2';
      secondOutcome.content = {
        kind: 'function_response',
        id: 'provider-call-2',
        name: 'Write',
        result: 'ok',
      };
      secondOutcome.refs = { operationId: 'operation-2', toolCallId: 'provider-call-2' };
      await store.commitToolOutcome({
        operationId: 'operation-2',
        journalEventId: 'operation-2_outcome',
        runtimeEvent: secondOutcome,
        committedAt: 20,
      });
      await store.commitToolOutcome({
        operationId: 'operation-1',
        journalEventId: 'operation-1_outcome',
        runtimeEvent: outcomeEvent(),
        committedAt: 21,
      });

      const onlineOperations = await Promise.all([
        store.readToolOperation('operation-1'),
        store.readToolOperation('operation-2'),
      ]);
      const onlineJournals = await Promise.all([
        store.readToolJournal('operation-1'),
        store.readToolJournal('operation-2'),
      ]);
      await store.rebuildToolProjectionsFromRuntimeEvents();
      assert.deepEqual(
        await Promise.all([
          store.readToolOperation('operation-1'),
          store.readToolOperation('operation-2'),
        ]),
        onlineOperations,
      );
      assert.deepEqual(
        await Promise.all([
          store.readToolJournal('operation-1'),
          store.readToolJournal('operation-2'),
        ]),
        onlineJournals,
      );
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
        /duplicate_event_id/,
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

  it('persists the decoder canonical RuntimeEvent and makes raw retries idempotent', async () => {
    await withStore(async (store) => {
      const raw = userEvent();
      raw.content = {
        kind: 'text',
        text: 'write it',
        displayText: 'write it',
        attachments: [],
        quotes: [],
      };

      await store.appendRuntimeEvent('session-1', 'run-1', raw);
      await store.appendRuntimeEvent('session-1', 'run-1', raw);

      assert.deepEqual(await store.readImmutableRuntimeEvents('session-1', 'run-1'), [userEvent()]);
    });
  });

  it('rejects RuntimeEvents that lose required fields during JSON serialization', async () => {
    await withStore(async (store) => {
      const lossy = callEvent();
      if (lossy.content?.kind !== 'function_call') throw new Error('invalid fixture');
      lossy.content.args = undefined;

      await assert.rejects(
        store.appendRuntimeEvent('session-1', 'run-1', lossy),
        /RuntimeEvent schema|losslessly serializable/,
      );
      assert.deepEqual(await store.readImmutableRuntimeEvents('session-1', 'run-1'), []);
    });
  });

  it('rejects nested JSON loss in a function response before persistence', async () => {
    await withStore(async (store) => {
      await store.appendRuntimeEvent('session-1', 'run-1', callEvent());
      const lossy = outcomeEvent();
      if (lossy.content?.kind !== 'function_response') throw new Error('invalid fixture');
      lossy.content.result = { value: undefined };
      lossy.refs = { toolCallId: 'provider-call-1' };

      await assert.rejects(
        store.appendRuntimeEvent('session-1', 'run-1', lossy),
        /losslessly serializable/,
      );
      assert.deepEqual(
        (await store.readImmutableRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
        ['call-event-1'],
      );
    });
  });

  it('rejects provider metadata that rewrites itself through toJSON', async () => {
    await withStore(async (store) => {
      const lossy = callEvent();
      if (lossy.content?.kind !== 'function_call') throw new Error('invalid fixture');
      lossy.content.providerOptions = {
        value: 1,
        toJSON() {
          return { value: 2 };
        },
      };

      await assert.rejects(
        store.appendRuntimeEvent('session-1', 'run-1', lossy),
        /losslessly serializable/,
      );
      assert.deepEqual(await store.readImmutableRuntimeEvents('session-1', 'run-1'), []);
    });
  });

  it('rejects recovery evidence whose JSON bytes can rewrite validated event ids', async () => {
    await withStore(async (store) => {
      await prepare(store);
      const decision = decisionEvent();
      const fact = decision.actions?.toolRecovery;
      if (fact?.kind !== 'maka.tool.recovery_decision') throw new Error('invalid fixture');
      Object.defineProperty(fact.payload.evidenceEventIds, 'toJSON', {
        value: () => ['call-event-1', 'dispatch-event-1', 'reconcile-event-1', 'forged-outcome'],
      });

      await assert.rejects(
        store.commitToolRecoveryBundle({
          operationId: 'operation-1',
          reconcileRuntimeEvent: reconcileEvent(),
          outcomeRuntimeEvent: outcomeEvent(),
          decisionRuntimeEvent: decision,
        }),
        /losslessly serializable/,
      );
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
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

  it('fails an exact T1 retry closed when the immutable ledger is already corrupt', async () => {
    await withStore(async (store, dbPath) => {
      await prepare(store);
      store.close();
      injectDuplicateCall(dbPath, 3);

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        await assert.rejects(prepare(reopened), /duplicate_call/);
      } finally {
        reopened.close();
      }
    });
  });

  it('fails an exact T2 retry closed when the immutable ledger is already corrupt', async () => {
    await withStore(async (store, dbPath) => {
      await prepare(store);
      await store.commitToolOutcome({
        operationId: 'operation-1',
        journalEventId: 'operation-1_outcome',
        runtimeEvent: outcomeEvent(),
        committedAt: 20,
      });
      store.close();
      injectDuplicateCall(dbPath, 4);

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        await assert.rejects(
          reopened.commitToolOutcome({
            operationId: 'operation-1',
            journalEventId: 'operation-1_outcome',
            runtimeEvent: outcomeEvent(),
            committedAt: 20,
          }),
          /duplicate_call/,
        );
      } finally {
        reopened.close();
      }
    });
  });

  it('fails an exact recovery retry closed when the immutable ledger is already corrupt', async () => {
    await withStore(async (store, dbPath) => {
      await prepare(store);
      const bundle = {
        operationId: 'operation-1',
        reconcileRuntimeEvent: reconcileEvent(),
        outcomeRuntimeEvent: outcomeEvent(),
        decisionRuntimeEvent: decisionEvent(),
      } as const;
      await store.commitToolRecoveryBundle(bundle);
      store.close();
      injectDuplicateCall(dbPath, 6);

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        await assert.rejects(reopened.commitToolRecoveryBundle(bundle), /duplicate_call/);
      } finally {
        reopened.close();
      }
    });
  });

  it('fail-stops a new session tool boundary when another session ledger is corrupt', async () => {
    await withStore(async (store, dbPath) => {
      await prepare(store);
      injectDuplicateCall(dbPath, 3);

      const unrelatedCall = callEvent();
      unrelatedCall.id = 'unrelated-call-event';
      unrelatedCall.sessionId = 'session-2';
      unrelatedCall.invocationId = 'invocation-2';
      unrelatedCall.runId = 'run-2';
      unrelatedCall.turnId = 'turn-2';
      if (unrelatedCall.content?.kind !== 'function_call') {
        throw new Error('invalid unrelated call fixture');
      }
      unrelatedCall.content.id = 'provider-call-2';
      unrelatedCall.refs = { toolCallId: 'provider-call-2' };
      await assert.rejects(
        store.appendRuntimeEvent('session-2', 'run-2', unrelatedCall),
        /duplicate_call/,
      );
      assert.deepEqual(await store.readImmutableRuntimeEvents('session-2', 'run-2'), []);
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

function injectDuplicateCall(dbPath: string, eventSeq: number): void {
  const db = new DatabaseSync(dbPath);
  try {
    const duplicate = callEvent();
    duplicate.id = `call-event-duplicate-${eventSeq}`;
    db.prepare(`
      INSERT INTO runtime_events (
        event_id, session_id, invocation_id, run_id, turn_id,
        event_seq, event_kind, payload_json, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      duplicate.id,
      duplicate.sessionId,
      duplicate.invocationId,
      duplicate.runId,
      duplicate.turnId,
      eventSeq,
      'function_call',
      JSON.stringify(duplicate),
      duplicate.ts,
    );
  } finally {
    db.close();
  }
}

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
