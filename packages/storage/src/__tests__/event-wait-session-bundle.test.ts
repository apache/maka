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
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { eventWaitDeliveryKey, type EventWaitRecord } from '@maka/core/event-wait';
import type { GoalAuthorityRecord } from '@maka/core/goal';
import type { ConsumerEventWaitRecord } from '@maka/core/event-wait';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import { openInteractiveExecutionStoresForWrite } from '../execution-stores.js';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '../root-authority.js';
import { exportSessionBundleState, importSessionBundleState } from '../session-bundle-policy.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

after(removeTrackedControlDirectories);

type Stores = Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>;
type OpenRoot = { root: string; owner: InteractiveRootOwner; stores: Stores };

for (const mode of ['portable', 'snapshot'] as const) {
  for (const status of ['waiting', 'resolved'] as const) {
    test(`${mode} Session Bundle ${status} wait never transfers subscription authority`, async () => {
      await withRoots(async ({ source, target, configRoot, bundleRoot }) => {
        const selected = await source.stores.sessionStore.create(
          sessionInput(source.root, 'Selected'),
        );
        const message = {
          type: 'user',
          id: 'message-1',
          turnId: 'turn-1',
          ts: 10,
          text: 'Preserve the conversation without its source subscription.',
        } as const;
        await source.stores.sessionStore.appendMessage(selected.id, message);
        const record = waiting(selected.id, 'shared-wait');
        const sourceKey = {
          providerId: record.resource.providerId,
          connectionId: record.resource.connectionId,
        };
        await source.stores.eventWaitStore.reserveSourceDispatch({
          ...sourceKey,
          token: 'source-dispatch',
          observedAt: 10,
          until: 50,
        });
        await source.stores.eventWaitStore.extendSourceCooldown({
          ...sourceKey,
          observedAt: 11,
          until: 90,
        });
        let result = await source.stores.eventWaitStore.commit(commit(record));
        if (status === 'resolved') {
          result = await source.stores.eventWaitStore.commit(
            commit(
              {
                ...record,
                status: 'resolved',
                updatedAt: 30,
                resolvedAt: 30,
                resolution: {
                  outcome: 'satisfied',
                  receiptKey: 'receipt-1',
                  observedAt: 25,
                  evidenceRefs: ['source-evidence-1'],
                },
              },
              0,
            ),
          );
        }
        assert.equal(result.kind, 'committed');
        if (result.kind !== 'committed') throw new Error('Expected source wait');
        const sourceSnapshot = result.snapshot;
        const sourceRows = readWaitRows(source.root);

        // A wait ID is global within a State Root. Reusing it in the target's
        // unrelated Session also proves that import skips incoming wait rows
        // before any identity or active-slot conflict can abort the transfer.
        const existing = await target.stores.sessionStore.create(
          sessionInput(target.root, 'Existing target Session'),
        );
        const targetRecord = waiting(existing.id, record.waitId);
        const targetCommit = await target.stores.eventWaitStore.commit(commit(targetRecord));
        assert.equal(targetCommit.kind, 'committed');
        if (targetCommit.kind !== 'committed') throw new Error('Expected target wait');

        const exported = await exportSessionBundleState({
          stateRoot: source.root,
          configRoot,
          destinationRoot: bundleRoot,
          sessionId: selected.id,
          lease: source.owner.lease,
          ...(mode === 'portable'
            ? {
                requireQuiescent: true,
                includeSubtree: true,
                omitDiagnostics: true,
                omitEventWaits: true,
              }
            : {}),
        });
        assert.deepEqual(exported.sessionIds, [selected.id]);
        const bundleRows = readWaitRows(bundleRoot);
        assert.deepEqual(bundleRows, mode === 'portable' ? [] : sourceRows);
        assert.deepEqual(
          readSourceRows(bundleRoot),
          mode === 'portable' ? [] : readSourceRows(source.root),
        );
        assert.deepEqual(readWaitRows(source.root), sourceRows);
        assert.deepEqual(await source.stores.eventWaitStore.read(identity(record)), sourceSnapshot);

        const imported = await importSessionBundleState({
          stateRoot: target.root,
          bundleStateRoot: bundleRoot,
          lease: target.owner.lease,
        });
        assert.deepEqual(imported.sessionIds, [selected.id]);
        assert.equal((await target.stores.sessionStore.readHeader(selected.id)).name, 'Selected');
        assert.deepEqual(await target.stores.sessionStore.readMessages(selected.id), [message]);
        assert.deepEqual(
          await target.stores.eventWaitStore.listSession({ sessionId: selected.id, limit: 200 }),
          { items: [], nextCursor: null },
        );
        assert.equal(await target.stores.eventWaitStore.read(identity(record)), null);
        assert.equal(await target.stores.eventWaitStore.readSourceCooldown(sourceKey), null);
        assert.deepEqual(
          readSourceRows(target.root),
          [],
          'import must not activate source dispatch reservations',
        );
        assert.deepEqual(
          await target.stores.eventWaitStore.listByStatus({ status: 'waiting', limit: 200 }),
          {
            items: [targetCommit.snapshot],
            nextCursor: null,
          },
        );
        assert.deepEqual(
          await target.stores.eventWaitStore.read(identity(targetRecord)),
          targetCommit.snapshot,
        );

        const fresh = waiting(selected.id, 'fresh-wait');
        assert.deepEqual(await target.stores.eventWaitStore.commit(commit(fresh)), {
          kind: 'committed',
          snapshot: { authorityRevision: 0, record: fresh },
        });
        assert.deepEqual(readWaitRows(source.root), sourceRows);
        // Import ignores snapshot waits without editing the snapshot itself.
        assert.deepEqual(readWaitRows(bundleRoot), bundleRows);
      });
    });
  }
}

function sessionInput(root: string, name: string): CreateSessionInput {
  return {
    cwd: root,
    name,
    llmConnectionSlug: 'test',
    model: 'test-model',
    permissionMode: 'ask',
  };
}

function waiting(
  sessionId: string,
  waitId: string,
): Extract<EventWaitRecord, { status: 'waiting' }> {
  return {
    schemaVersion: 1,
    waitId,
    sessionId,

    sourceTurnId: 'turn-1',
    sourceToolCallId: 'call-1',
    resource: {
      providerId: 'test',
      connectionId: 'source-connection',
      resourceType: 'task',
      resourceId: 'opaque/task',
    },
    condition: { typeId: 'terminal', version: 1, parameters: {} },
    deliveryKey: eventWaitDeliveryKey(waitId),
    createdAt: 10,
    updatedAt: 10,
    deadlineAt: 100,
    status: 'waiting',
  };
}

function commit(record: EventWaitRecord, expectedAuthorityRevision: number | null = null) {
  return { ...identity(record), expectedAuthorityRevision, record };
}

function identity(record: EventWaitRecord) {
  return { sessionId: record.sessionId, waitId: record.waitId };
}

function readWaitRows(root: string) {
  const database = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
  try {
    assert.ok(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'workflow_event_waits'",
        )
        .get(),
      'bundle retains the event-wait schema even when it omits all wait rows',
    );
    return database
      .prepare('SELECT * FROM workflow_event_waits ORDER BY wait_id')
      .all()
      .map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

function readSourceRows(root: string) {
  const database = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
  try {
    return database
      .prepare('SELECT * FROM workflow_event_wait_source_cooldowns ORDER BY source_key')
      .all()
      .map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

async function openRoot(root: string): Promise<OpenRoot> {
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    return { root, owner, stores: await openInteractiveExecutionStoresForWrite(owner.lease) };
  } catch (error) {
    await owner.close();
    throw error;
  }
}

async function withRoots(
  action: (roots: {
    source: OpenRoot;
    target: OpenRoot;
    configRoot: string;
    bundleRoot: string;
  }) => Promise<void>,
) {
  const base = await mkdtemp(join(tmpdir(), 'maka-event-wait-session-bundle-'));
  const roots: OpenRoot[] = [];
  try {
    const source = await openRoot(join(base, 'source'));
    roots.push(source);
    const target = await openRoot(join(base, 'target'));
    roots.push(target);
    const configRoot = join(base, 'config');
    await mkdir(configRoot);
    await action({ source, target, configRoot, bundleRoot: join(base, 'bundle') });
  } finally {
    try {
      for (const root of roots.reverse()) {
        try {
          await root.stores.sessionStore.close?.();
        } finally {
          await root.owner.close();
        }
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }
}

for (const mode of ['portable', 'snapshot'] as const) {
  test(`${mode} Session Bundle removes natural Goal observation linkage as well as consumer rows`, async () => {
    await withRoots(async ({ source, target, configRoot, bundleRoot }) => {
      const session = await source.stores.sessionStore.create(
        sessionInput(source.root, 'Natural waiting'),
      );
      const original = waiting(session.id, 'natural-wait');
      const goalControlLease = { goalId: 'goal', generation: 0 };
      const {
        sourceToolCallId: _tool,
        observation: _observation,
        delivery: _delivery,
        ...base
      } = original;
      const record: ConsumerEventWaitRecord = {
        ...base,
        schemaVersion: 2,
        deadlineAt: null,
        consumer: {
          kind: 'goal_waiting',
          sourceRunId: 'source-run',
          completionEventId: 'completed',
          goalControlLease,
          goalRevision: 1,
        },
      };
      const goal: GoalAuthorityRecord = {
        schemaVersion: 1,
        controlLease: goalControlLease,
        currentExecution: null,
        goal: {
          id: goalControlLease.goalId,
          revision: 1,
          sessionId: session.id,
          condition: 'Observe external completion',
          status: 'waiting',
          setAt: 1,
          iterations: 1,
          maxIterations: 50,
          consecutiveNoProgress: 0,
          blockCap: 8,
          tokensAtStart: 0,
          tokensNow: 0,
          tokensBaselinePending: true,
        },
        pendingContinuation: {
          checkpoint: { goalId: goalControlLease.goalId, revision: 1 },
          controlLease: goalControlLease,
          triggeringTurnId: record.sourceTurnId,
          prompt: 'Continue after external completion',
          observation: {
            waitId: record.waitId,
            resource: record.resource,
            condition: record.condition,
            deadlineAt: null,
            sourceRunId: 'source-run',
            completionEventId: 'completed',
          },
        },
      };
      await source.stores.runtimeEventStore.appendRuntimeEvent(session.id, 'source-run', {
        id: 'completed',
        sessionId: session.id,
        runId: 'source-run',
        turnId: record.sourceTurnId,
        invocationId: 'source-invocation',
        partial: false,
        ts: 10,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
      });
      assert.equal(
        (
          await source.stores.goalStore.commit({
            sessionId: session.id,
            expectedAuthorityRevision: null,
            record: goal,
          })
        ).kind,
        'committed',
      );
      await source.stores.eventWaitStore.registerGoalWaitingWait({ record });
      await exportSessionBundleState({
        stateRoot: source.root,
        configRoot,
        destinationRoot: bundleRoot,
        sessionId: session.id,
        lease: source.owner.lease,
        ...(mode === 'portable'
          ? {
              requireQuiescent: true,
              includeSubtree: true,
              omitDiagnostics: true,
              omitEventWaits: true,
            }
          : {}),
      });
      await importSessionBundleState({
        stateRoot: target.root,
        bundleStateRoot: bundleRoot,
        lease: target.owner.lease,
      });
      const imported = (await target.stores.goalStore.read(session.id))!.record;
      assert.equal(imported.goal.status, 'paused');
      assert.equal(imported.pendingContinuation, null);
      assert.equal(imported.controlLease.generation, goalControlLease.generation + 1);
      assert.deepEqual(
        (await target.stores.eventWaitStore.listAny({ sessionId: session.id, limit: 10 })).items,
        [],
      );
      assert.deepEqual((await source.stores.goalStore.read(session.id))!.record, goal);
      assert.equal(
        (
          await source.stores.eventWaitStore.readAny({
            sessionId: session.id,
            waitId: record.waitId,
          })
        )?.record.status,
        'waiting',
      );
    });
  });
}
