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
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import {
  messageContentDigest,
  normalizeMessageContent,
  type MessageContent,
} from '@maka/core/events';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
} from '@maka/core/session';
import { createSessionStore, type SessionAuthorityStore } from '@maka/storage/session-store';
import { OPERATIONAL_STATE_DATABASE_NAME } from '@maka/storage/operational-state-store';
import {
  WORKHUB_COORDINATION_SUMMARY_MAX_BYTES,
  WORKHUB_COORDINATION_TEXT_MAX_BYTES,
} from '../protocol/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import type { RootTurnCoordinator } from '../server/root-turn-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { SessionOperationFailure } from '../server/session-catalog-coordinator.js';
import type { WorkHubActionGateEffects } from '../server/workhub-coordination-action-gate.js';
import {
  HostWorkHubCoordinationCoordinator,
  type CoordinationCreateTarget,
} from '../server/workhub-coordination-coordinator.js';

const CONTEXT: ConnectionContext = {
  hostEpoch: 'workhub-test-epoch',
  connectionId: 'workhub-test-client',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

describe('Host WorkHub Coordination coordinator', () => {
  test('concurrently creates once and reuses the durable Session after Host restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-resolve-'));
    let store = createSessionStore(root);
    try {
      const firstCoordinator = coordinator(root, store);
      const outcomes = await Promise.all(
        Array.from({ length: 16 }, () =>
          firstCoordinator.handlers['workhub.coordination.resolve']({}, CONTEXT),
        ),
      );
      assert.equal(
        outcomes.every((outcome) => outcome.ok),
        true,
      );
      assert.deepEqual(
        new Set(outcomes.flatMap((outcome) => (outcome.ok ? [outcome.result.sessionId] : []))),
        new Set([WORKHUB_COORDINATION_SESSION_ID]),
      );
      const header = await store.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      assert.equal(header.role, WORKHUB_COORDINATION_SESSION_ROLE);
      assert.equal(header.toolProfile, 'workhub-coordination-v1');
      assert.equal(header.projectId, null);
      assert.equal(header.cwd, join(root, 'workhub-coordination'));
      assert.equal((await store.listHeaders()).length, 1);
    } finally {
      await store.close?.();
    }

    const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
    try {
      database
        .prepare(
          `UPDATE session_metadata
           SET payload_json = json_set(
             json_remove(payload_json, '$.toolProfile'),
             '$.permissionMode', 'ask',
             '$.collaborationMode', 'plan',
             '$.orchestrationMode', 'graph'
           )
           WHERE session_id = ?`,
        )
        .run(WORKHUB_COORDINATION_SESSION_ID);
    } finally {
      database.close();
    }

    store = createSessionStore(root);
    try {
      const restarted = await coordinator(root, store).handlers['workhub.coordination.resolve'](
        {},
        CONTEXT,
      );
      assert.deepEqual(restarted, {
        ok: true,
        result: { sessionId: WORKHUB_COORDINATION_SESSION_ID },
      });
      assert.equal(
        (await store.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID)).toolProfile,
        'workhub-coordination-v1',
      );
      const migrated = await store.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      assert.equal(migrated.permissionMode, 'explore');
      assert.equal(migrated.collaborationMode, 'agent');
      assert.equal(migrated.orchestrationMode, 'default');
      assert.equal((await store.listHeaders()).length, 1);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed on reserved-id collision without changing ordinary Sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-collision-'));
    const store = createSessionStore(root);
    try {
      await store.createStableSession({
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
        requestFingerprint: `sha256:${'c'.repeat(64)}`,
        input: {
          cwd: root,
          projectId: null,
          name: 'Ordinary collision',
          llmConnectionSlug: 'test-connection',
          model: 'test-model',
          permissionMode: 'ask',
          role: WORKHUB_COORDINATION_SESSION_ROLE,
        },
      });
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database
          .prepare(
            `UPDATE session_metadata
             SET payload_json = json_remove(payload_json, '$.role')
             WHERE session_id = ?`,
          )
          .run(WORKHUB_COORDINATION_SESSION_ID);
      } finally {
        database.close();
      }

      const outcome = await coordinator(root, store).handlers['workhub.coordination.resolve'](
        {},
        CONTEXT,
      );

      assert.deepEqual(outcome, {
        ok: false,
        error: {
          code: 'operation_conflict',
          message: 'WorkHub Coordination Session identity is unavailable',
        },
      });
      assert.deepEqual(await store.list(), []);
      const collision = await store.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      assert.equal(collision.name, 'Ordinary collision');
      assert.equal(collision.role, undefined);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reports corrupt durable state without replacing or losing ordinary Sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-corrupt-'));
    const store = createSessionStore(root);
    let drains = 0;
    try {
      const ordinary = await store.create({
        cwd: root,
        name: 'Keep me',
        llmConnectionSlug: 'test-connection',
        model: 'test-model',
        permissionMode: 'ask',
      });
      const initial = await coordinator(root, store).handlers['workhub.coordination.resolve'](
        {},
        CONTEXT,
      );
      assert.equal(initial.ok, true);

      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database
          .prepare(
            `UPDATE session_metadata
             SET payload_json = json_set(payload_json, '$.role', 'corrupt_role')
             WHERE session_id = ?`,
          )
          .run(WORKHUB_COORDINATION_SESSION_ID);
      } finally {
        database.close();
      }

      const outcome = await coordinator(root, store, () => {
        drains += 1;
      }).handlers['workhub.coordination.resolve']({}, CONTEXT);

      assert.deepEqual(outcome, {
        ok: false,
        error: {
          code: 'persistence_failed',
          message: 'WorkHub Coordination Session state is unavailable',
        },
      });
      assert.equal(drains, 1);
      assert.equal((await store.readHeaderSnapshot(ordinary.id)).name, 'Keep me');
      assert.deepEqual(
        (await store.list()).map((session) => session.id),
        [ordinary.id],
      );
      assert.deepEqual(
        (await store.listForRecovery()).map((session) => session.id),
        [ordinary.id],
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed and quarantines a Coordination Session whose role is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-missing-role-'));
    const store = createSessionStore(root);
    try {
      const ordinary = await store.create({
        cwd: root,
        name: 'Keep me',
        llmConnectionSlug: 'test-connection',
        model: 'test-model',
        permissionMode: 'ask',
      });
      assert.equal(
        (await coordinator(root, store).handlers['workhub.coordination.resolve']({}, CONTEXT)).ok,
        true,
      );

      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database
          .prepare(
            `UPDATE session_metadata
             SET payload_json = json_remove(payload_json, '$.role')
             WHERE session_id = ?`,
          )
          .run(WORKHUB_COORDINATION_SESSION_ID);
      } finally {
        database.close();
      }

      assert.deepEqual(
        await coordinator(root, store).handlers['workhub.coordination.resolve']({}, CONTEXT),
        {
          ok: false,
          error: {
            code: 'operation_conflict',
            message: 'WorkHub Coordination Session identity is unavailable',
          },
        },
      );
      assert.deepEqual(
        (await store.list()).map((session) => session.id),
        [ordinary.id],
      );
      assert.deepEqual(
        (await store.listForRecovery()).map((session) => session.id),
        [ordinary.id],
      );
      assert.equal(
        (await store.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID)).name,
        'WorkHub',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('relocates the durable workspace when the Host state root moves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-relocate-'));
    const movedRoot = await mkdtemp(join(tmpdir(), 'maka-workhub-relocated-'));
    const store = createSessionStore(root);
    try {
      assert.equal(
        (await coordinator(root, store).handlers['workhub.coordination.resolve']({}, CONTEXT)).ok,
        true,
      );

      // Same durable Session, same database, new absolute state-root path:
      // restoring the state directory elsewhere must not strand the identity
      // that no ordinary lifecycle operation is allowed to relocate.
      assert.deepEqual(
        await coordinator(movedRoot, store).handlers['workhub.coordination.resolve']({}, CONTEXT),
        { ok: true, result: { sessionId: WORKHUB_COORDINATION_SESSION_ID } },
      );
      const header = await store.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      assert.equal(header.cwd, join(movedRoot, 'workhub-coordination'));
      assert.equal(header.role, WORKHUB_COORDINATION_SESSION_ROLE);
      assert.equal((await store.listHeaders()).length, 1);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
      await rm(movedRoot, { recursive: true, force: true });
    }
  });

  test('restores a Coordination workspace that was pruned after provisioning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-workspace-'));
    const store = createSessionStore(root);
    try {
      assert.equal(
        (await coordinator(root, store).handlers['workhub.coordination.resolve']({}, CONTEXT)).ok,
        true,
      );
      const coordinationCwd = join(root, 'workhub-coordination');
      await rm(coordinationCwd, { recursive: true, force: true });

      assert.deepEqual(
        await coordinator(root, store).handlers['workhub.coordination.resolve']({}, CONTEXT),
        { ok: true, result: { sessionId: WORKHUB_COORDINATION_SESSION_ID } },
      );
      assert.equal((await stat(coordinationCwd)).isDirectory(), true);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('separates an unreadable model authority from a missing default model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-model-authority-'));
    const store = createSessionStore(root);
    try {
      assert.deepEqual(
        await coordinator(
          root,
          store,
          () => undefined,
          async () => {
            throw new SessionOperationFailure(
              'persistence_failed',
              'Runtime policy is unavailable',
            );
          },
        ).handlers['workhub.coordination.resolve']({}, CONTEXT),
        {
          ok: false,
          error: { code: 'persistence_failed', message: 'Runtime policy is unavailable' },
        },
      );
      assert.deepEqual(
        await coordinator(
          root,
          store,
          () => undefined,
          async () => {
            throw new SessionOperationFailure(
              'operation_unavailable',
              'No default Session model is configured',
            );
          },
        ).handlers['workhub.coordination.resolve']({}, CONTEXT),
        {
          ok: false,
          error: {
            code: 'operation_conflict',
            message: 'WorkHub Coordination Session requires an available default model',
          },
        },
      );
      assert.deepEqual(await store.listHeaders(), []);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('answers through the dedicated Coordination root without creating an ordinary Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-answer-'));
    const store = createSessionStore(root);
    const admission = new SessionAdmissionGate();
    const { executions, starts, prepared } = coordinationExecutions(admission);
    try {
      const workhub = coordinator(root, store, () => undefined, undefined, executions, admission);
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);
      assert.deepEqual(
        await workhub.handlers['workhub.coordination.answer'](
          { turnId: 'answer-turn', text: 'What should we do next?' },
          CONTEXT,
        ),
        { ok: true, result: { turnId: 'answer-turn' } },
      );
      assert.equal(starts.length, 1);
      assert.equal(starts[0]?.sessionId, WORKHUB_COORDINATION_SESSION_ID);
      assert.equal(starts[0]?.execution.kind, 'workhub_coordination');
      assert.deepEqual(prepared, [{ text: 'What should we do next?' }]);
      assert.deepEqual(
        (await store.listHeaders()).map(({ id, role }) => ({ id, role })),
        [{ id: WORKHUB_COORDINATION_SESSION_ID, role: WORKHUB_COORDINATION_SESSION_ROLE }],
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('records synthetic coordination summaries durably and retries idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-record-'));
    const store = createSessionStore(root);
    try {
      const workhub = coordinator(root, store);
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);
      const input = {
        turnId: 'summary-turn',
        userText: 'Continue payment work',
        assistantText: 'Submitted to Payment',
      };
      assert.deepEqual(await workhub.handlers['workhub.coordination.record'](input, CONTEXT), {
        ok: true,
        result: { turnId: 'summary-turn' },
      });
      assert.deepEqual(await workhub.handlers['workhub.coordination.record'](input, CONTEXT), {
        ok: true,
        result: { turnId: 'summary-turn' },
      });
      const maximumInput = {
        turnId: 'maximum-summary-turn',
        // Each NUL is one UTF-8 input byte but six bytes once JSON-escaped in
        // the durable transcript record. Retry lookup must budget for that
        // worst case, not only the decoded text sizes.
        userText: '\0'.repeat(WORKHUB_COORDINATION_TEXT_MAX_BYTES),
        assistantText: '\0'.repeat(WORKHUB_COORDINATION_SUMMARY_MAX_BYTES),
      };
      assert.deepEqual(
        await workhub.handlers['workhub.coordination.record'](maximumInput, CONTEXT),
        { ok: true, result: { turnId: 'maximum-summary-turn' } },
      );
      assert.deepEqual(
        await workhub.handlers['workhub.coordination.record'](maximumInput, CONTEXT),
        { ok: true, result: { turnId: 'maximum-summary-turn' } },
      );
      const messages = await store.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      assert.equal(messages.length, 6);
      assert.deepEqual(
        messages.slice(0, 3).map(({ type, turnId }) => ({ type, turnId })),
        [
          { type: 'user', turnId: 'summary-turn' },
          { type: 'assistant', turnId: 'summary-turn' },
          { type: 'turn_state', turnId: 'summary-turn' },
        ],
      );
      const conflict = await workhub.handlers['workhub.coordination.record'](
        { ...input, assistantText: 'Different summary' },
        CONTEXT,
      );
      assert.equal(conflict.ok, false);
      if (!conflict.ok) assert.equal(conflict.error.code, 'operation_conflict');
      assert.equal((await store.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID)).length, 6);
      const empty = await workhub.handlers['workhub.coordination.record'](
        { ...input, turnId: 'empty-summary', assistantText: '   ' },
        CONTEXT,
      );
      assert.equal(empty.ok, false);
      if (!empty.ok) assert.equal(empty.error.code, 'operation_conflict');
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persists delegated action ownership and replays it after Host restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-delegation-'));
    const userText = 'Continue payment work. '.repeat(900);
    let store = createSessionStore(root);
    try {
      await store.create({
        cwd: root,
        name: 'Payments',
        llmConnectionSlug: 'test-connection',
        model: 'test-model',
        permissionMode: 'ask',
      });
      const assignments: string[] = [];
      const first = coordinator(root, store, () => undefined, undefined, undefined, undefined, {
        assign: async (input) => {
          assignments.push(input.actionId);
          return persistTestAssignment(store, input, 'payments-turn');
        },
      });
      assert.equal((await first.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);
      const candidates = await first.handlers['workhub.coordination.candidates']({}, CONTEXT);
      assert.equal(candidates.ok, true);
      if (!candidates.ok) return;
      const input = {
        actionId: 'payments-action',
        userText,
        candidateSetId: candidates.result.candidateSetId,
        proposal: {
          disposition: 'delegate_existing' as const,
          candidateRef: candidates.result.candidates[0]!.candidateRef,
        },
      };
      const admitted = await first.handlers['workhub.coordination.act'](input, CONTEXT);
      assert.deepEqual(admitted, {
        ok: true,
        result: {
          disposition: 'delegate_existing',
          targetSessionId: candidates.result.candidates[0]!.sessionId,
          targetTurnId: 'payments-turn',
        },
      });
      assert.deepEqual(
        (await store.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID))
          .filter(
            (message) =>
              message.type === 'workhub_coordination' && message.kind === 'delegation_assigned',
          )
          .map(({ kind, actionId, targetSessionId }) => ({ kind, actionId, targetSessionId })),
        [
          {
            kind: 'delegation_assigned',
            actionId: 'payments-action',
            targetSessionId: candidates.result.candidates[0]!.sessionId,
          },
        ],
      );
      assert.equal(assignments.length, 1);
    } finally {
      await store.close?.();
    }

    store = createSessionStore(root);
    try {
      const restarted = coordinator(root, store, () => undefined, undefined, undefined, undefined, {
        assign: (input) => persistTestAssignment(store, input, 'payments-turn'),
      });
      const candidates = await restarted.handlers['workhub.coordination.candidates']({}, CONTEXT);
      assert.equal(candidates.ok, true);
      if (!candidates.ok) return;
      const replayed = await restarted.handlers['workhub.coordination.act'](
        {
          actionId: 'payments-action',
          userText,
          candidateSetId: candidates.result.candidateSetId,
          proposal: {
            disposition: 'delegate_existing',
            candidateRef: candidates.result.candidates[0]!.candidateRef,
          },
        },
        CONTEXT,
      );
      assert.equal(replayed.ok, true);
      if (replayed.ok) {
        assert.equal(replayed.result.disposition, 'delegate_existing');
        if (replayed.result.disposition === 'delegate_existing') {
          assert.equal(replayed.result.targetTurnId, 'payments-turn');
        }
      }
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses to merge a Turn identity shared across answer and record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-turn-identity-'));
    const store = createSessionStore(root);
    const admission = new SessionAdmissionGate();
    const { executions } = coordinationExecutions(admission);
    try {
      const workhub = coordinator(root, store, () => undefined, undefined, executions, admission);
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);

      // An answered Turn is owned by the root admission ledger.
      assert.equal(
        (
          await workhub.handlers['workhub.coordination.answer'](
            { turnId: 'shared-turn', text: 'What is left on payments?' },
            CONTEXT,
          )
        ).ok,
        true,
      );
      const recordAfterAnswer = await workhub.handlers['workhub.coordination.record'](
        { turnId: 'shared-turn', userText: 'Continue payments', assistantText: 'Sent to Payments' },
        CONTEXT,
      );
      assert.deepEqual(recordAfterAnswer, {
        ok: false,
        error: {
          code: 'operation_conflict',
          message: 'WorkHub Coordination Turn identity belongs to a different operation',
        },
      });
      assert.deepEqual(await store.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID), []);

      // A recorded Turn is owned by the durable summary triplet.
      assert.equal(
        (
          await workhub.handlers['workhub.coordination.record'](
            {
              turnId: 'recorded-turn',
              userText: 'Continue payments',
              assistantText: 'Sent to Payments',
            },
            CONTEXT,
          )
        ).ok,
        true,
      );
      const answerAfterRecord = await workhub.handlers['workhub.coordination.answer'](
        { turnId: 'recorded-turn', text: 'What is left on payments?' },
        CONTEXT,
      );
      assert.deepEqual(answerAfterRecord, {
        ok: false,
        error: {
          code: 'operation_conflict',
          message: 'WorkHub Coordination Turn identity belongs to a different operation',
        },
      });
      assert.deepEqual(
        (await store.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID)).map(
          ({ type, turnId }) => ({ type, turnId }),
        ),
        [
          { type: 'user', turnId: 'recorded-turn' },
          { type: 'assistant', turnId: 'recorded-turn' },
          { type: 'turn_state', turnId: 'recorded-turn' },
        ],
      );
      assert.deepEqual(
        (await store.listTurnsSnapshot(WORKHUB_COORDINATION_SESSION_ID)).map(
          ({ turnId }) => turnId,
        ),
        ['recorded-turn'],
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });
});

type CoordinationExecutions = Pick<
  RootTurnCoordinator,
  'startWorkHubCoordinationMessage' | 'hasRootTurnAdmission'
>;

/**
 * Stands in for the root admission ledger: answers claim their Turn identity
 * under the same Session admission the coordinator uses, so the fake can
 * reproduce the ordering the real ledger enforces.
 */
function coordinationExecutions(admission: SessionAdmissionGate) {
  const admitted = new Set<string>();
  const starts: Parameters<RootTurnCoordinator['startWorkHubCoordinationMessage']>[0][] = [];
  const prepared: MessageContent[] = [];
  const executions: CoordinationExecutions = {
    startWorkHubCoordinationMessage: async (request) => {
      starts.push(request);
      return admission.run(WORKHUB_COORDINATION_SESSION_ID, async (lease) => {
        const content = await request.prepareFreshContent(lease);
        if (content.kind === 'rejected') return content.outcome;
        prepared.push(content.content);
        admitted.add(request.turnId);
        return {
          ok: true,
          result: {
            sessionId: request.sessionId,
            turnId: request.turnId,
            runId: `workhub-run-${request.turnId}`,
            status: 'running',
          },
        };
      });
    },
    hasRootTurnAdmission: async (_sessionId, turnId) => admitted.has(turnId),
  };
  return { executions, starts, prepared };
}

function coordinator(
  root: string,
  store: SessionAuthorityStore,
  requestDrain: () => void = () => undefined,
  resolveCreateTarget: (() => Promise<CoordinationCreateTarget>) | undefined = undefined,
  executions: CoordinationExecutions = {
    startWorkHubCoordinationMessage: async () => ({
      ok: false,
      error: {
        code: 'operation_unavailable',
        message: 'WorkHub test execution is not configured',
      },
    }),
    hasRootTurnAdmission: async () => false,
  },
  admission: SessionAdmissionGate = new SessionAdmissionGate(),
  sessionActions: Partial<
    Pick<WorkHubActionGateEffects, 'assign' | 'readDelegationRetirement' | 'retireDelegation'>
  > = {},
) {
  return new HostWorkHubCoordinationCoordinator({
    stateRoot: root,
    stores: store,
    admission,
    continuity: { refreshCanonical: async () => undefined },
    executions,
    sessionActions: {
      assign: async ({ targetSessionId }) => ({ turnId: `turn-${targetSessionId}` }),
      readDelegationRetirement: async () => 'not_retired',
      retireDelegation: async () => undefined,
      ...sessionActions,
    },
    resolveCreateTarget:
      resolveCreateTarget ??
      (async () => ({
        llmConnectionSlug: 'test-connection',
        model: 'test-model',
        permissionMode: 'explore',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
      })),
    requestDrain,
  });
}

async function persistTestAssignment(
  store: SessionAuthorityStore,
  input: Parameters<WorkHubActionGateEffects['assign']>[0],
  targetTurnId: string,
): Promise<{ turnId: string }> {
  const suffix = createHash('sha256').update(input.actionId, 'utf8').digest('hex').slice(0, 48);
  const content = normalizeMessageContent({ text: input.userText });
  const result = await store.assignWorkHubMessage({
    assignment: {
      type: 'workhub_coordination',
      id: `wha_${suffix}`,
      turnId: input.actionId,
      ts: Date.now(),
      schemaVersion: 1,
      kind: 'delegation_assigned',
      actionId: input.actionId,
      actionFingerprint: input.actionFingerprint,
      coordinationTurnId: input.actionId,
      targetSessionId: input.targetSessionId,
      targetSessionName: input.targetSessionName,
      targetTurnId,
      targetMessageId: `whm_${suffix}`,
      delegationId: `whd_${suffix}`,
      disposition: input.disposition,
      userText: input.userText,
      ...(input.create ? { create: input.create } : {}),
    },
    admission: {
      sessionId: input.targetSessionId,
      turnId: targetTurnId,
      runId: `whr_${suffix}`,
      messageId: `whm_${suffix}`,
      content,
      submittedContentDigest: messageContentDigest(content),
      submittedPlacement: 'current_turn',
      placement: 'current_turn',
      disposition: 'steering',
      skillInvocation: { loaded: [], failed: [], receipts: [] },
      admittedAt: Date.now(),
    },
  });
  return { turnId: result.assignment.targetTurnId };
}
