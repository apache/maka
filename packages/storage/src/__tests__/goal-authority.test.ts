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
import { test } from 'node:test';
import type { GoalAuthorityRecord } from '@maka/core/goal';
import { openInteractiveExecutionStoresForWrite } from '../execution-stores.js';
import { openInteractiveGoalAuthorityForWrite } from '../goal-authority.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';

test('Goal authority commits one revisioned record and preserves its execution reference', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-goal-authority-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'interactive'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const writer = await openInteractiveGoalAuthorityForWrite(owner.lease);
  try {
    const initial = goalRecord(0, null);
    const created = await writer.commit({
      sessionId: initial.goal.sessionId,
      expectedAuthorityRevision: null,
      record: initial,
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    assert.equal(created.snapshot?.authorityRevision, 0);

    const running = goalRecord(0, {
      execution: {
        sessionId: initial.goal.sessionId,
        turnId: 'turn_goal_1',
        runId: 'run_goal_1',
      },
      checkpoint: { goalId: initial.goal.id, revision: 0 },
      controlLease: initial.controlLease,
    });
    const updated = await writer.commit({
      sessionId: running.goal.sessionId,
      expectedAuthorityRevision: 0,
      record: running,
    });
    assert.equal(updated.kind, 'committed');
    assert.deepEqual((await writer.read(running.goal.sessionId))?.record, running);

    const stale = await writer.commit({
      sessionId: running.goal.sessionId,
      expectedAuthorityRevision: 0,
      record: { ...running, goal: { ...running.goal, revision: 1 } },
    });
    assert.deepEqual(stale, {
      kind: 'revision_conflict',
      actualAuthorityRevision: 1,
    });
    assert.equal((await writer.list()).length, 1);
  } finally {
    await writer.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('Goal authority close lets an admitted commit finish before releasing storage', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-goal-authority-close-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'interactive'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  try {
    const writer = await openInteractiveGoalAuthorityForWrite(owner.lease);
    const record = goalRecord(0, null);
    const committing = writer.commit({
      sessionId: record.goal.sessionId,
      expectedAuthorityRevision: null,
      record,
    });
    const closing = writer.close();

    assert.equal((await committing).kind, 'committed');
    await closing;
    await owner.close();
    const successor = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(successor);
    if (!successor) return;
    try {
      const reopened = await openInteractiveGoalAuthorityForWrite(successor.lease);
      assert.equal((await reopened.read(record.goal.sessionId))?.record.goal.id, record.goal.id);
      await reopened.close();
    } finally {
      await successor.close();
    }
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('Session retirement atomically removes its Goal authority', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-goal-authority-retirement-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'interactive'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const goals = await openInteractiveGoalAuthorityForWrite(owner.lease);
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  try {
    const sessions = await Promise.all(
      ['archive', 'remove'].map((name) =>
        stores.sessionStore.create({
          cwd: capability.canonicalPath,
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          permissionMode: 'ask',
          name,
        }),
      ),
    );
    for (const session of sessions) {
      const record = goalRecord(0, null, session.id);
      assert.equal(
        (
          await goals.commit({
            sessionId: session.id,
            expectedAuthorityRevision: null,
            record,
          })
        ).kind,
        'committed',
      );
    }

    const [archived, removed] = await Promise.all(
      sessions.map((session) => stores.sessionStore.readHeaderRecordSnapshot(session.id)),
    );
    await stores.sessionStore.setSessionsArchivedVersioned(
      [{ sessionId: archived.header.id, expectedVersion: archived.revision }],
      true,
    );
    await stores.sessionStore.removeSessionsVersioned([
      { sessionId: removed.header.id, expectedVersion: removed.revision },
    ]);

    assert.equal(await goals.read(archived.header.id), null);
    assert.equal(await goals.read(removed.header.id), null);
  } finally {
    await goals.close();
    await stores.sessionStore.close?.();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

function goalRecord(
  revision: number,
  currentExecution: GoalAuthorityRecord['currentExecution'],
  sessionId = 'session_goal_1',
): GoalAuthorityRecord {
  return {
    schemaVersion: 1,
    goal: {
      id: 'goal_1',
      revision,
      sessionId,
      condition: 'Finish the durable Goal refactor.',
      status: 'active',
      setAt: 1,
      iterations: 0,
      maxIterations: 50,
      consecutiveNoProgress: 0,
      blockCap: 8,
      tokensAtStart: 0,
      tokensNow: 0,
      tokensBaselinePending: true,
    },
    controlLease: { goalId: 'goal_1', generation: 0 },
    currentExecution,
  };
}
