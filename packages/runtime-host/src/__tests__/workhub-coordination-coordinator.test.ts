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
  WORKHUB_COORDINATION_REPLACEMENT_SCHEMA_VERSION,
  type StoredMessage,
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

  test('persists direct-stop request and resolution before replaying after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-stop-'));
    let store = createSessionStore(root);
    let targetId = '';
    try {
      const target = await store.create({
        cwd: root,
        name: 'Payments',
        llmConnectionSlug: 'test-connection',
        model: 'test-model',
        permissionMode: 'ask',
      });
      targetId = target.id;
      let retireCalls = 0;
      const workhub = coordinator(root, store, () => undefined, undefined, undefined, undefined, {
        assign: (input) => persistTestAssignment(store, input, 'payments-turn'),
        retireDelegation: async () => {
          retireCalls += 1;
          return { outcome: 'stop_delivered', targetTurnId: 'payments-turn' };
        },
      });
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);
      const candidates = await workhub.handlers['workhub.coordination.candidates']({}, CONTEXT);
      assert.equal(candidates.ok, true);
      if (!candidates.ok) return;
      const candidate = candidates.result.candidates.find(
        ({ sessionId }) => sessionId === target.id,
      )!;
      assert.equal(
        (
          await workhub.handlers['workhub.coordination.act'](
            {
              actionId: 'source-action',
              userText: 'Fix payment retry',
              candidateSetId: candidates.result.candidateSetId,
              proposal: { disposition: 'delegate_existing', candidateRef: candidate.candidateRef },
            },
            CONTEXT,
          )
        ).ok,
        true,
      );
      const stopped = await workhub.handlers['workhub.coordination.act'](
        {
          actionId: 'stop-action',
          userText: 'Stop Payments',
          proposal: {
            disposition: 'stop_work',
            expects: { targetSessionId: target.id },
          },
          confirmation: { kind: 'user_stop' },
        },
        CONTEXT,
      );
      assert.deepEqual(stopped, {
        ok: true,
        result: {
          disposition: 'stop_work',
          outcome: 'stop_delivered',
          targetSessionId: target.id,
          targetTurnId: 'payments-turn',
        },
      });
      assert.equal(retireCalls, 1);
      const assignment = await store.readWorkHubAssignment('source-action');
      assert.ok(assignment);
      assert.equal(
        (await store.readWorkHubStopRequest(assignment.delegationId))?.actionId,
        'stop-action',
      );
      assert.equal(
        (await store.readWorkHubStopResolution(assignment.delegationId))?.outcome,
        'stop_delivered',
      );
    } finally {
      await store.close?.();
    }

    store = createSessionStore(root);
    try {
      const restarted = coordinator(root, store, () => undefined, undefined, undefined, undefined, {
        retireDelegation: async () => assert.fail('durable stop replay must not retire twice'),
      });
      const replay = await restarted.handlers['workhub.coordination.act'](
        {
          actionId: 'stop-action',
          userText: 'Stop Payments',
          proposal: {
            disposition: 'stop_work',
            expects: { targetSessionId: targetId },
          },
          confirmation: { kind: 'user_stop' },
        },
        CONTEXT,
      );
      assert.equal(replay.ok, true);
      if (replay.ok && replay.result.disposition === 'stop_work') {
        assert.equal(replay.result.outcome, 'stop_delivered');
      }
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rechecks sole-delegation stop preconditions after the advisory active-link read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-stop-race-'));
    const store = createSessionStore(root);
    try {
      const target = await store.create({
        cwd: root,
        name: 'Payments',
        llmConnectionSlug: 'test-connection',
        model: 'test-model',
        permissionMode: 'ask',
      });
      let injected = false;
      const stores = new Proxy(store, {
        get(authority, property, receiver) {
          if (property === 'readMessagesSnapshot') {
            return async (sessionId: string) => {
              const messages = await authority.readMessagesSnapshot(sessionId);
              if (
                !injected &&
                sessionId === WORKHUB_COORDINATION_SESSION_ID &&
                messages.some(
                  (message) =>
                    message.type === 'workhub_coordination' &&
                    message.kind === 'delegation_assigned' &&
                    message.actionId === 'source-action',
                )
              ) {
                injected = true;
                await persistTestAssignment(
                  authority,
                  {
                    actionId: 'racing-action',
                    actionFingerprint: `sha256:${'8'.repeat(64)}`,
                    targetSessionId: target.id,
                    targetSessionName: 'Payments',
                    disposition: 'delegate_existing',
                    userText: 'A second payment delegation',
                  },
                  'racing-turn',
                );
              }
              return messages;
            };
          }
          const value = Reflect.get(authority, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(authority) : value;
        },
      }) as SessionAuthorityStore;
      let retireCalls = 0;
      const workhub = coordinator(root, stores, () => undefined, undefined, undefined, undefined, {
        assign: (input) => persistTestAssignment(store, input, 'source-turn'),
        retireDelegation: async () => {
          retireCalls += 1;
          return { outcome: 'cancelled_pending' };
        },
      });
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);
      const candidates = await workhub.handlers['workhub.coordination.candidates']({}, CONTEXT);
      assert.equal(candidates.ok, true);
      if (!candidates.ok) return;
      const candidate = candidates.result.candidates.find(
        ({ sessionId }) => sessionId === target.id,
      )!;
      assert.equal(
        (
          await workhub.handlers['workhub.coordination.act'](
            {
              actionId: 'source-action',
              userText: 'Fix payment retry',
              candidateSetId: candidates.result.candidateSetId,
              proposal: { disposition: 'delegate_existing', candidateRef: candidate.candidateRef },
            },
            CONTEXT,
          )
        ).ok,
        true,
      );

      const stopped = await workhub.handlers['workhub.coordination.act'](
        {
          actionId: 'stop-racing-action',
          userText: 'Stop Payments',
          proposal: {
            disposition: 'stop_work',
            expects: { targetSessionId: target.id },
          },
          confirmation: { kind: 'user_stop' },
        },
        CONTEXT,
      );
      assert.equal(stopped.ok, false);
      if (!stopped.ok) assert.equal(stopped.error.code, 'operation_conflict');
      const source = await store.readWorkHubAssignment('source-action');
      assert.ok(source);
      assert.equal(
        source ? await store.readWorkHubStopRequest(source.delegationId) : undefined,
        undefined,
      );
      assert.equal(retireCalls, 0);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('converges a committed stop after the target Session is removed and the Host restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-stop-removed-'));
    let store = createSessionStore(root);
    let targetId: string;
    const stopInput = () => ({
      actionId: 'stop-action',
      userText: 'Stop Payments',
      proposal: {
        disposition: 'stop_work' as const,
        expects: { targetSessionId: targetId },
      },
      confirmation: { kind: 'user_stop' as const },
    });
    try {
      const target = await store.create({
        cwd: root,
        name: 'Payments',
        llmConnectionSlug: 'test-connection',
        model: 'test-model',
        permissionMode: 'ask',
      });
      targetId = target.id;
      // The exact crash seam: the pending cancellation succeeds and the durable
      // resolution never lands.
      const crashing = new Proxy(store, {
        get(authority, property, receiver) {
          if (property === 'appendMessages') {
            return async (sessionId: string, messages: readonly { kind?: unknown }[]) => {
              if (messages.some((message) => message.kind === 'delegation_stop_resolved')) {
                throw new Error('simulated process exit before the stop resolution');
              }
              return authority.appendMessages(sessionId, messages as never);
            };
          }
          const value = Reflect.get(authority, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(authority) : value;
        },
      }) as SessionAuthorityStore;
      const workhub = coordinator(
        root,
        crashing,
        () => undefined,
        undefined,
        undefined,
        undefined,
        {
          assign: (input) => persistTestAssignment(store, input, 'payments-turn'),
          retireDelegation: async () => ({ outcome: 'cancelled_pending' }),
        },
      );
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);
      const candidates = await workhub.handlers['workhub.coordination.candidates']({}, CONTEXT);
      assert.equal(candidates.ok, true);
      if (!candidates.ok) return;
      assert.equal(
        (
          await workhub.handlers['workhub.coordination.act'](
            {
              actionId: 'source-action',
              userText: 'Fix payment retry',
              candidateSetId: candidates.result.candidateSetId,
              proposal: {
                disposition: 'delegate_existing',
                candidateRef: candidates.result.candidates.find(
                  ({ sessionId }) => sessionId === target.id,
                )!.candidateRef,
              },
            },
            CONTEXT,
          )
        ).ok,
        true,
      );
      const crashed = await workhub.handlers['workhub.coordination.act'](stopInput(), CONTEXT);
      assert.equal(crashed.ok, false);
      const assignment = await store.readWorkHubAssignment('source-action');
      assert.ok(assignment);
      assert.ok(await store.readWorkHubStopRequest(assignment.delegationId));
      assert.equal(await store.readWorkHubStopResolution(assignment.delegationId), undefined);

      await store.remove(target.id);
    } finally {
      await store.close?.();
    }

    store = createSessionStore(root);
    try {
      let retireCalls = 0;
      const restarted = coordinator(root, store, () => undefined, undefined, undefined, undefined, {
        // The removed Session took every Message-ownership proof with it.
        retireDelegation: async () => {
          retireCalls += 1;
          return { outcome: 'recovering' };
        },
      });
      const resolved = await restarted.handlers['workhub.coordination.act'](stopInput(), CONTEXT);
      assert.deepEqual(resolved, {
        ok: true,
        result: {
          disposition: 'stop_work',
          outcome: 'already_terminal',
          targetSessionId: targetId,
        },
      });
      assert.equal(retireCalls, 1);
      assert.deepEqual(
        await restarted.handlers['workhub.coordination.act'](stopInput(), CONTEXT),
        resolved,
      );
      assert.equal(retireCalls, 1);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a claim written before its stop request resolves like a first attempt', async () => {
    // The claim is committed before the request, so a crash between them leaves
    // an action that owns a stop with nothing to converge on. Nothing
    // destructive happened either, so the delegation is still linked and the
    // retry must resolve from the active links rather than refuse.
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-claim-only-'));
    const store = createSessionStore(root);
    try {
      const target = await store.create({
        cwd: root,
        name: 'Payments',
        llmConnectionSlug: 'test-connection',
        model: 'test-model',
        permissionMode: 'ask',
      });
      let failStopRequest = true;
      const stores = new Proxy(store, {
        get(authority, property, receiver) {
          if (property === 'appendMessages') {
            return async (sessionId: string, messages: StoredMessage[]) => {
              if (
                failStopRequest &&
                messages.some(
                  (message) =>
                    message.type === 'workhub_coordination' &&
                    message.kind === 'delegation_stop_requested',
                )
              ) {
                failStopRequest = false;
                throw new Error('crash before the stop request is durable');
              }
              return authority.appendMessages(sessionId, messages);
            };
          }
          return Reflect.get(authority, property, receiver);
        },
      }) as SessionAuthorityStore;
      const workhub = coordinator(root, stores, () => undefined, undefined, undefined, undefined, {
        assign: (input) => persistTestAssignment(store, input, 'payments-turn'),
        retireDelegation: async () => ({
          outcome: 'stop_delivered' as const,
          targetTurnId: 'payments-turn',
        }),
      });
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);
      const candidates = await workhub.handlers['workhub.coordination.candidates']({}, CONTEXT);
      assert.equal(candidates.ok, true);
      if (!candidates.ok) return;
      assert.equal(
        (
          await workhub.handlers['workhub.coordination.act'](
            {
              actionId: 'source-action',
              userText: 'Fix payment retry',
              candidateSetId: candidates.result.candidateSetId,
              proposal: {
                disposition: 'delegate_existing',
                candidateRef: candidates.result.candidates.find(
                  ({ sessionId }) => sessionId === target.id,
                )!.candidateRef,
              },
            },
            CONTEXT,
          )
        ).ok,
        true,
      );
      const assignment = await store.readWorkHubAssignment('source-action');
      assert.ok(assignment);

      const stop = () =>
        workhub.handlers['workhub.coordination.act'](
          {
            actionId: 'stop-action',
            userText: 'Stop Payments',
            proposal: { disposition: 'stop_work', expects: { targetSessionId: target.id } },
            confirmation: { kind: 'user_stop' },
          },
          CONTEXT,
        );

      assert.equal((await stop()).ok, false);
      // Exactly the seam: the action owns a stop claim, and no request behind it.
      assert.equal((await store.readWorkHubActionClaim('stop-action'))?.operation, 'stop');
      assert.equal(await store.readWorkHubStopRequest(assignment.delegationId), undefined);

      const retried = await stop();
      assert.equal(retried.ok, true);
      if (retried.ok && retried.result.disposition === 'stop_work') {
        assert.equal(retried.result.outcome, 'stop_delivered');
      }
      assert.equal(
        (await store.readWorkHubStopResolution(assignment.delegationId))?.outcome,
        'stop_delivered',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a claimed stop refuses by name when its delegation was replaced', async () => {
    // The claim survived a crash before its request. By the retry the link it
    // bound itself to is gone and another has taken its place on the same
    // Session, so re-deriving would silently bind this action to a delegation
    // the user never named. The fingerprint would not match the claim either,
    // and claims are never deleted, so the refusal is permanent — it should at
    // least say which refusal it is.
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-claim-moved-'));
    const store = createSessionStore(root);
    try {
      const target = await store.create({
        cwd: root,
        name: 'Payments',
        llmConnectionSlug: 'test-connection',
        model: 'test-model',
        permissionMode: 'ask',
      });
      const workhub = coordinator(root, store, () => undefined, undefined, undefined, undefined, {
        assign: (input) => persistTestAssignment(store, input, `${input.actionId}-turn`),
        retireDelegation: async () => assert.fail('a spent stop identity must not retire work'),
      });
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);
      const candidates = await workhub.handlers['workhub.coordination.candidates']({}, CONTEXT);
      assert.equal(candidates.ok, true);
      if (!candidates.ok) return;
      assert.equal(
        (
          await workhub.handlers['workhub.coordination.act'](
            {
              actionId: 'source-action',
              userText: 'Fix payment retry',
              candidateSetId: candidates.result.candidateSetId,
              proposal: {
                disposition: 'delegate_existing',
                candidateRef: candidates.result.candidates.find(
                  ({ sessionId }) => sessionId === target.id,
                )!.candidateRef,
              },
            },
            CONTEXT,
          )
        ).ok,
        true,
      );
      const assignment = await store.readWorkHubAssignment('source-action');
      assert.ok(assignment);
      // The stop bound itself to that delegation, then crashed before its
      // request was durable.
      assert.equal(
        await store.claimWorkHubAction({
          actionId: 'stop-action',
          operation: 'stop',
          actionFingerprint: `sha256:${'d'.repeat(64)}`,
          subject: assignment.delegationId,
        }),
        'claimed',
      );
      // That delegation ends and a different one takes its place.
      await store.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [
        {
          type: 'workhub_coordination',
          id: 'whs_replaced_probe',
          turnId: 'replaced-probe-turn',
          ts: Date.now(),
          schemaVersion: WORKHUB_COORDINATION_REPLACEMENT_SCHEMA_VERSION,
          kind: 'delegation_superseded',
          actionId: 'supersede-probe-action',
          actionFingerprint: `sha256:${'e'.repeat(64)}`,
          coordinationTurnId: 'replaced-probe-turn',
          supersededActionId: 'source-action',
          supersededDelegationId: assignment.delegationId,
          replacementDelegationId: 'whd_replacement_probe',
        },
      ]);
      await persistTestAssignment(
        store,
        {
          actionId: 'successor-action',
          actionFingerprint: `sha256:${'f'.repeat(64)}`,
          targetSessionId: target.id,
          targetSessionName: 'Payments',
          disposition: 'delegate_existing',
          userText: 'Fix payment retry again',
        },
        'successor-turn',
      );

      const refused = await workhub.handlers['workhub.coordination.act'](
        {
          actionId: 'stop-action',
          userText: 'Stop Payments',
          proposal: { disposition: 'stop_work', expects: { targetSessionId: target.id } },
          confirmation: { kind: 'user_stop' },
        },
        CONTEXT,
      );

      assert.equal(refused.ok, false);
      if (!refused.ok) {
        assert.equal(refused.error.code, 'operation_conflict');
        assert.match(refused.error.message, /already bound to a different delegation/u);
      }
      const successor = await store.readWorkHubAssignment('successor-action');
      assert.ok(successor);
      assert.equal(await store.readWorkHubStopRequest(successor.delegationId), undefined);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a claimed stop whose delegation went terminal elsewhere conflicts', async () => {
    // Claim present, no request and no resolution to converge on, and the
    // delegation is gone from the active set because another path superseded
    // it. There is nothing left to resolve and nothing was destroyed, so this
    // refuses exactly as it did before the claim became the replay key.
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-claim-terminal-'));
    const store = createSessionStore(root);
    try {
      const target = await store.create({
        cwd: root,
        name: 'Payments',
        llmConnectionSlug: 'test-connection',
        model: 'test-model',
        permissionMode: 'ask',
      });
      const workhub = coordinator(root, store, () => undefined, undefined, undefined, undefined, {
        assign: (input) => persistTestAssignment(store, input, 'payments-turn'),
        retireDelegation: async () => assert.fail('a terminal delegation must not be retired'),
      });
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);
      const candidates = await workhub.handlers['workhub.coordination.candidates']({}, CONTEXT);
      assert.equal(candidates.ok, true);
      if (!candidates.ok) return;
      assert.equal(
        (
          await workhub.handlers['workhub.coordination.act'](
            {
              actionId: 'source-action',
              userText: 'Fix payment retry',
              candidateSetId: candidates.result.candidateSetId,
              proposal: {
                disposition: 'delegate_existing',
                candidateRef: candidates.result.candidates.find(
                  ({ sessionId }) => sessionId === target.id,
                )!.candidateRef,
              },
            },
            CONTEXT,
          )
        ).ok,
        true,
      );
      const assignment = await store.readWorkHubAssignment('source-action');
      assert.ok(assignment);
      assert.equal(
        await store.claimWorkHubAction({
          actionId: 'stop-action',
          operation: 'stop',
          actionFingerprint: `sha256:${'b'.repeat(64)}`,
          subject: assignment.delegationId,
        }),
        'claimed',
      );
      await store.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [
        {
          type: 'workhub_coordination',
          id: 'whs_terminal_probe',
          turnId: 'terminal-probe-turn',
          ts: Date.now(),
          schemaVersion: WORKHUB_COORDINATION_REPLACEMENT_SCHEMA_VERSION,
          kind: 'delegation_superseded',
          actionId: 'supersede-probe-action',
          actionFingerprint: `sha256:${'c'.repeat(64)}`,
          coordinationTurnId: 'terminal-probe-turn',
          supersededActionId: 'source-action',
          supersededDelegationId: assignment.delegationId,
          replacementDelegationId: 'whd_replacement_probe',
        },
      ]);

      const conflicted = await workhub.handlers['workhub.coordination.act'](
        {
          actionId: 'stop-action',
          userText: 'Stop Payments',
          proposal: { disposition: 'stop_work', expects: { targetSessionId: target.id } },
          confirmation: { kind: 'user_stop' },
        },
        CONTEXT,
      );
      assert.equal(conflicted.ok, false);
      if (!conflicted.ok) assert.equal(conflicted.error.code, 'operation_conflict');
      assert.equal(await store.readWorkHubStopResolution(assignment.delegationId), undefined);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a stop holds only its target Session lane and the Coordination lane', async () => {
    // Admission serializes per Session. A stop that held a lane for every
    // Session with an active delegation would put unrelated delegation traffic
    // behind it, and a delegation arriving elsewhere mid-admission would fail a
    // stop it cannot affect. The proof under the lease needs neither.
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-lanes-'));
    const store = createSessionStore(root);
    try {
      const targets: Array<{ id: string; name: string }> = [];
      for (const name of ['Payments', 'Login']) {
        targets.push(
          await store.create({
            cwd: root,
            name,
            llmConnectionSlug: 'test-connection',
            model: 'test-model',
            permissionMode: 'ask',
          }),
        );
      }
      const payments = targets.find((session) => session.name === 'Payments')!;
      const login = targets.find((session) => session.name === 'Login')!;
      const admission = new SessionAdmissionGate();
      const laneSets: string[][] = [];
      const observed = new Proxy(admission, {
        get(gate, property, receiver) {
          if (property === 'runMany') {
            return (sessionIds: readonly string[], operation: never) => {
              laneSets.push([...sessionIds]);
              return gate.runMany(sessionIds, operation);
            };
          }
          const value = Reflect.get(gate, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(gate) : value;
        },
      }) as SessionAdmissionGate;
      const workhub = coordinator(root, store, () => undefined, undefined, undefined, observed, {
        assign: (input) => persistTestAssignment(store, input, `${input.actionId}-turn`),
        retireDelegation: async () => ({
          outcome: 'stop_delivered' as const,
          targetTurnId: 'source-action-turn',
        }),
      });
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);
      for (const [actionId, target, userText] of [
        ['source-action', payments, 'Fix payment retry'],
        ['login-action', login, 'Fix the login redirect'],
      ] as const) {
        const candidates = await workhub.handlers['workhub.coordination.candidates']({}, CONTEXT);
        assert.equal(candidates.ok, true);
        if (!candidates.ok) return;
        assert.equal(
          (
            await workhub.handlers['workhub.coordination.act'](
              {
                actionId,
                userText,
                candidateSetId: candidates.result.candidateSetId,
                proposal: {
                  disposition: 'delegate_existing',
                  candidateRef: candidates.result.candidates.find(
                    ({ sessionId }) => sessionId === target.id,
                  )!.candidateRef,
                },
              },
              CONTEXT,
            )
          ).ok,
          true,
        );
      }

      laneSets.length = 0;
      const stopped = await workhub.handlers['workhub.coordination.act'](
        {
          actionId: 'stop-action',
          userText: 'Stop Payments',
          proposal: { disposition: 'stop_work', expects: { targetSessionId: payments.id } },
          confirmation: { kind: 'user_stop' },
        },
        CONTEXT,
      );

      assert.equal(stopped.ok, true);
      const stopLanes = laneSets.find((lanes) => lanes.includes(payments.id));
      assert.ok(stopLanes, 'the stop must take a lane on its own target');
      assert.deepEqual(
        [...stopLanes].sort(),
        [WORKHUB_COORDINATION_SESSION_ID, payments.id].sort(),
        'Login has an active delegation but this stop cannot change it',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('one stop reads the Coordination transcript twice, not once per proof', async () => {
    // The Gate derives the delegation from the active links, then admission
    // reproves it under the lease. Those are the two reads that decide. Any
    // further pass re-derives an answer the stop already holds, on a transcript
    // that only grows.
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-scan-count-'));
    const store = createSessionStore(root);
    try {
      const target = await store.create({
        cwd: root,
        name: 'Payments',
        llmConnectionSlug: 'test-connection',
        model: 'test-model',
        permissionMode: 'ask',
      });
      let coordinationReads = 0;
      let counting = false;
      const stores = new Proxy(store, {
        get(authority, property, receiver) {
          if (property === 'readMessagesSnapshot') {
            return async (sessionId: string) => {
              if (counting && sessionId === WORKHUB_COORDINATION_SESSION_ID) coordinationReads += 1;
              return authority.readMessagesSnapshot(sessionId);
            };
          }
          const value = Reflect.get(authority, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(authority) : value;
        },
      }) as SessionAuthorityStore;
      const workhub = coordinator(root, stores, () => undefined, undefined, undefined, undefined, {
        assign: (input) => persistTestAssignment(store, input, 'payments-turn'),
        retireDelegation: async () => ({
          outcome: 'stop_delivered' as const,
          targetTurnId: 'payments-turn',
        }),
      });
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);
      const candidates = await workhub.handlers['workhub.coordination.candidates']({}, CONTEXT);
      assert.equal(candidates.ok, true);
      if (!candidates.ok) return;
      assert.equal(
        (
          await workhub.handlers['workhub.coordination.act'](
            {
              actionId: 'source-action',
              userText: 'Fix payment retry',
              candidateSetId: candidates.result.candidateSetId,
              proposal: {
                disposition: 'delegate_existing',
                candidateRef: candidates.result.candidates.find(
                  ({ sessionId }) => sessionId === target.id,
                )!.candidateRef,
              },
            },
            CONTEXT,
          )
        ).ok,
        true,
      );

      counting = true;
      const stopped = await workhub.handlers['workhub.coordination.act'](
        {
          actionId: 'stop-action',
          userText: 'Stop Payments',
          proposal: { disposition: 'stop_work', expects: { targetSessionId: target.id } },
          confirmation: { kind: 'user_stop' },
        },
        CONTEXT,
      );

      assert.equal(stopped.ok, true);
      assert.equal(coordinationReads, 2, 'a stop derives once and reproves once');
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
      retireDelegation: async () => ({ outcome: 'cancelled_pending' }),
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
