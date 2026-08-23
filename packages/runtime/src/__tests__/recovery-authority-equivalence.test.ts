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
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { createSqliteRuntimeStore } from '@maka/storage';
import { resolveRuntimeRecovery } from '../recovery-resolver.js';
import { buildResumePlanFromRuntimeEvents } from '../runtime-resume.js';

const ARGS_HASH = canonicalToolArgsHash('Write', {
  path: 'notes.txt',
  content: 'after',
});
const OBSERVATION_DIGEST =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

describe('recovery authority equivalence', () => {
  it('gives online projection, reopen, rebuild, and Resolver one terminal interpretation', async () => {
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
      await store.commitToolRecoveryBundle({
        operationId: 'operation-1',
        reconcileRuntimeEvent: reconcileEvent(),
        outcomeRuntimeEvent: outcomeEvent(),
        decisionRuntimeEvent: decisionEvent(),
      });

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
      assert.equal(resolution.requiresReconciliation, false);

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
          await store.commitToolRecoveryBundle({
            operationId: 'operation-1',
            reconcileRuntimeEvent: reconcileEvent('diverged'),
            decisionRuntimeEvent: parkedDecisionEvent(),
          });
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
    assert.equal(resolution.requiresReconciliation, false);
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
    assert.equal(resolution.requiresReconciliation, false);

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
