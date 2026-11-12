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
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { createSqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import { resolveRuntimeRecovery } from '../recovery-resolver.js';
import { buildResumePlanFromRuntimeEvents } from '../runtime-resume.js';
import { LEGACY_TOOL_RECOVERY_DATABASE_SQL } from './fixtures/legacy-tool-recovery-database.js';

const ARGS_HASH = canonicalToolArgsHash('Write', {
  path: 'notes.txt',
  content: 'after',
});
const OBSERVATION_DIGEST =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

describe('recovery authority equivalence', () => {
  for (const scenario of ['completed', 'parked', 'prepared'] as const) {
    it(`opens old-writer ${scenario} rows and plans resume without rebuilding`, async () => {
      const root = await mkdtemp(join(tmpdir(), `maka-old-writer-${scenario}-`));
      const dbPath = join(root, 'runtime.sqlite');
      try {
        // The schema is unchanged by writer removal. Restore captured old-writer
        // rows into an empty schema, including its already-materialized projections.
        createSqliteRuntimeStore(dbPath).close();
        const db = new DatabaseSync(dbPath);
        try {
          db.exec(LEGACY_TOOL_RECOVERY_DATABASE_SQL[scenario]);
        } finally {
          db.close();
        }

        const expectedStates =
          scenario === 'completed'
            ? ['prepared', 'reconcile_observed', 'outcome_committed', 'recovery_completed']
            : scenario === 'parked'
              ? ['prepared', 'reconcile_observed', 'recovery_parked']
              : ['prepared'];
        const store = createSqliteRuntimeStore(dbPath);
        try {
          const operation = await store.readToolOperation('operation-1');
          assert.deepEqual(operation, {
            operationId: 'operation-1',
            invocationId: 'invocation-1',
            runId: 'run-1',
            turnId: 'turn-1',
            providerToolCallId: 'provider-call-1',
            toolName: 'Write',
            canonicalArgsHash: ARGS_HASH,
            recoveryMode: 'reconcile',
            currentState: expectedStates.at(-1),
            callEventId: 'call-event-1',
            dispatchEventId: 'dispatch-event-1',
            ...(scenario === 'completed' ? { resultEventId: 'outcome-event-1' } : {}),
            version: expectedStates.length,
          });
          const journal = await store.readToolJournal('operation-1');
          assert.deepEqual(
            journal.map(({ state }) => state),
            expectedStates,
          );
          assert.deepEqual(
            journal.map(({ journalEventId }) => journalEventId),
            scenario === 'completed'
              ? [
                  'operation-1_prepared',
                  'reconcile-event-1_journal',
                  'operation-1_outcome',
                  'decision-event-1_journal',
                ]
              : scenario === 'parked'
                ? ['operation-1_prepared', 'reconcile-event-1_journal', 'decision-event-1_journal']
                : ['operation-1_prepared'],
          );
          assert.deepEqual(
            await store.listUnsettledToolOperations(),
            scenario === 'prepared' ? [{ sessionId: 'session-1', ...operation }] : [],
          );
          assert.deepEqual(
            await store.listUnsettledToolOperations('session-1'),
            scenario === 'prepared' ? [{ sessionId: 'session-1', ...operation }] : [],
          );

          const events = await store.readImmutableRuntimeEvents('session-1', 'run-1');
          assert.equal(events.length, scenario === 'completed' ? 5 : scenario === 'parked' ? 4 : 2);
          const resolution = resolveRuntimeRecovery(events);
          assert.equal(resolution.hasCorruption, false);
          assert.equal(resolution.decisions.length, 1);
          assert.equal(
            resolution.decisions[0]?.status,
            scenario === 'prepared' ? 'indeterminate' : scenario,
          );
          const plan = buildResumePlanFromRuntimeEvents(events);
          assert.equal(plan.disposition, scenario === 'completed' ? 'safe_replay' : 'blocked');
          assert.equal(plan.requiresVerification, scenario === 'prepared');
          assert.deepEqual(
            plan.rejectionReasons,
            scenario === 'completed' ? [] : ['dangling_tool_state'],
          );
          assert.equal(
            events.filter((event) => event.content?.kind === 'function_response').length,
            scenario === 'completed' ? 1 : 0,
          );
        } finally {
          store.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it('gives historical projection, reopen, rebuild, and Resolver one terminal interpretation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-recovery-equivalence-'));
    const dbPath = join(root, 'runtime.sqlite');
    const store = createSqliteRuntimeStore(dbPath);
    try {
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
      seedHistoricalRecoveryTail(dbPath, [reconcileEvent(), outcomeEvent(), decisionEvent()]);
      await store.rebuildToolProjectionsFromRuntimeEvents();

      const immutable = await store.readImmutableRuntimeEvents('session-1', 'run-1');
      const online = await store.readToolOperation('operation-1');
      const resolution = resolveRuntimeRecovery(immutable);
      assert.equal(online?.currentState, 'recovery_completed');
      assert.deepEqual(resolution.decisions, [
        {
          toolCallId: 'provider-call-1',
          toolName: 'Write',
          operationId: 'operation-1',
          status: 'completed',
          reason: 'recovery_bundle_completed',
          settlementOrigin: 'recovery_bundle',
          callRuntimeEventId: 'call-event-1',
          dispatchRuntimeEventId: 'dispatch-event-1',
          responseRuntimeEventId: 'outcome-event-1',
          responseIsError: false,
        },
      ]);

      store.close();
      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        assert.deepEqual(await reopened.readToolOperation('operation-1'), online);
        await reopened.rebuildToolProjectionsFromRuntimeEvents();
        assert.deepEqual(await reopened.readToolOperation('operation-1'), online);
        assert.deepEqual(
          resolveRuntimeRecovery(await reopened.readImmutableRuntimeEvents('session-1', 'run-1')),
          resolution,
        );
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps prepared, normal T2, and parked states equivalent across reopen and rebuild', async () => {
    const cases = [
      {
        name: 'prepared',
        expectedProjection: 'prepared',
        expectedDecision: 'indeterminate',
      },
      {
        name: 'normal-success',
        expectedProjection: 'outcome_committed',
        expectedDecision: 'completed',
        outcomeIsError: false,
      },
      {
        name: 'normal-error',
        expectedProjection: 'outcome_committed',
        expectedDecision: 'completed',
        outcomeIsError: true,
      },
      {
        name: 'parked',
        expectedProjection: 'recovery_parked',
        expectedDecision: 'parked',
        parked: true,
      },
    ] as const;

    for (const scenario of cases) {
      const root = await mkdtemp(join(tmpdir(), `maka-recovery-${scenario.name}-`));
      const dbPath = join(root, 'runtime.sqlite');
      const store = createSqliteRuntimeStore(dbPath);
      try {
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
        if ('outcomeIsError' in scenario) {
          await store.commitToolOutcome({
            operationId: 'operation-1',
            journalEventId: 'operation-1_outcome',
            runtimeEvent: outcomeEvent(scenario.outcomeIsError),
            committedAt: 20,
          });
        } else if ('parked' in scenario) {
          seedHistoricalRecoveryTail(dbPath, [reconcileEvent('diverged'), parkedDecisionEvent()]);
          await store.rebuildToolProjectionsFromRuntimeEvents();
        }

        const immutable = await store.readImmutableRuntimeEvents('session-1', 'run-1');
        const online = await store.readToolOperation('operation-1');
        const resolution = resolveRuntimeRecovery(immutable);
        assert.equal(online?.currentState, scenario.expectedProjection, scenario.name);
        assert.equal(resolution.decisions[0]?.status, scenario.expectedDecision, scenario.name);

        store.close();
        const reopened = createSqliteRuntimeStore(dbPath);
        try {
          assert.deepEqual(await reopened.readToolOperation('operation-1'), online, scenario.name);
          await reopened.rebuildToolProjectionsFromRuntimeEvents();
          assert.deepEqual(await reopened.readToolOperation('operation-1'), online, scenario.name);
          assert.deepEqual(
            resolveRuntimeRecovery(await reopened.readImmutableRuntimeEvents('session-1', 'run-1')),
            resolution,
            scenario.name,
          );
        } finally {
          reopened.close();
        }
      } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it('preserves duplicate event identity and semantic-lane diagnostics', () => {
    const duplicate = callEvent();
    const invalid = outcomeEvent();
    invalid.actions = dispatchEvent().actions;

    const resolution = resolveRuntimeRecovery([callEvent(), duplicate, invalid]);

    assert.deepEqual(
      resolution.issues.map(({ code }) => code),
      ['duplicate_event_id', 'semantic_lane_conflict'],
    );
    assert.equal(resolution.hasCorruption, true);
  });

  it('treats a valid parked recovery bundle as terminal', () => {
    const events = [
      callEvent(),
      dispatchEvent(),
      reconcileEvent('diverged'),
      parkedDecisionEvent(),
    ];
    const resolution = resolveRuntimeRecovery(events);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'provider-call-1',
        toolName: 'Write',
        operationId: 'operation-1',
        status: 'parked',
        reason: 'reconcile_diverged',
        settlementOrigin: 'recovery_bundle',
        callRuntimeEventId: 'call-event-1',
        dispatchRuntimeEventId: 'dispatch-event-1',
      },
    ]);
    assert.equal(resolution.hasCorruption, false);

    const plan = buildResumePlanFromRuntimeEvents(events);
    assert.equal(plan.disposition, 'blocked');
    assert.equal(plan.requiresVerification, false);
    assert.deepEqual(plan.rejectionReasons, ['dangling_tool_state']);
    assert.deepEqual(
      plan.diagnostics.map((diagnostic) => diagnostic.code),
      ['tool_recovery_parked'],
    );
  });

  it('blocks resume whenever the recovery ledger contains top-level corruption', () => {
    const orphanReconcile = reconcileEvent();
    orphanReconcile.id = 'orphan-reconcile-event';
    orphanReconcile.actions!.toolRecovery!.payload.operationId = 'unknown-operation';
    orphanReconcile.refs = {
      operationId: 'unknown-operation',
      toolCallId: 'unknown-provider-call',
    };
    const events = [callEvent(), outcomeEvent(), orphanReconcile];

    const resolution = resolveRuntimeRecovery(events);
    assert.equal(resolution.hasCorruption, true);
    assert.equal(resolution.decisions[0]?.status, 'completed');

    const plan = buildResumePlanFromRuntimeEvents(events);
    assert.equal(plan.disposition, 'blocked');
    assert.deepEqual(plan.rejectionReasons, ['dangling_tool_state']);
    assert.deepEqual(
      plan.diagnostics.map((diagnostic) => diagnostic.code),
      ['tool_ledger_corruption'],
    );
    assert.equal(plan.diagnostics[0]?.detail?.issueCode, 'event_order_conflict');
  });
});

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

function parkedDecisionEvent(): RuntimeEvent {
  return baseEvent({
    id: 'decision-event-1',
    ts: 4,
    actions: {
      toolRecovery: {
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

function outcomeEvent(isError = false): RuntimeEvent {
  return baseEvent({
    id: 'outcome-event-1',
    ts: 3,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'provider-call-1',
      name: 'Write',
      result: isError ? 'failed' : 'ok',
      isError,
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  });
}

function decisionEvent(): RuntimeEvent {
  return baseEvent({
    id: 'decision-event-1',
    ts: 4,
    actions: {
      toolRecovery: {
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
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  });
}

/** Read-compatibility fixture: these facts were persisted by the retired writer. */
function seedHistoricalRecoveryTail(dbPath: string, events: readonly RuntimeEvent[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    const insert = db.prepare(`
      INSERT INTO runtime_events (
        event_id, session_id, invocation_id, run_id, turn_id,
        event_seq, event_kind, payload_json, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [index, event] of events.entries()) {
      insert.run(
        event.id,
        event.sessionId,
        event.invocationId,
        event.runId,
        event.turnId,
        index + 3,
        event.content?.kind ?? 'runtime_fact',
        JSON.stringify(event),
        event.ts,
      );
    }
  } finally {
    db.close();
  }
}
