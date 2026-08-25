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
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
} from '@maka/core/session';
import { createSessionStore, type SessionAuthorityStore } from '@maka/storage/session-store';
import { OPERATIONAL_STATE_DATABASE_NAME } from '@maka/storage/operational-state-store';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { SessionOperationFailure } from '../server/session-catalog-coordinator.js';
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
      assert.equal(header.projectId, null);
      assert.equal(header.cwd, join(root, 'workhub-coordination'));
      assert.equal((await store.listHeaders()).length, 1);
    } finally {
      await store.close?.();
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
});

function coordinator(
  root: string,
  store: SessionAuthorityStore,
  requestDrain: () => void = () => undefined,
  resolveCreateTarget: () => Promise<CoordinationCreateTarget> = async () => ({
    llmConnectionSlug: 'test-connection',
    model: 'test-model',
    permissionMode: 'explore',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  }),
) {
  return new HostWorkHubCoordinationCoordinator({
    stateRoot: root,
    stores: store,
    admission: new SessionAdmissionGate(),
    continuity: { refreshCanonical: async () => undefined },
    resolveCreateTarget,
    requestDrain,
  });
}
