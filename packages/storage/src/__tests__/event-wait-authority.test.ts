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
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { eventWaitDeliveryKey, type EventWaitRecord } from '@maka/core/event-wait';
import { type ExecutionPersistenceProvider } from '../execution-persistence-provider.js';
import { openInteractiveExecutionStoresForWrite } from '../execution-stores.js';
import { localExecutionPersistenceProvider } from '../local-execution-persistence.js';
import { createMemoryExecutionPersistenceProvider } from '../test-only/memory-execution-persistence.js';
import {
  authenticateInteractiveEventWaitAuthorityWriter,
  EVENT_WAIT_OBSERVATION_HINT_LIMIT,
  openInteractiveEventWaitAuthorityForWrite,
  type EventWaitAuthorityRepository,
  type InteractiveEventWaitAuthorityWriter,
  type ListEventWaitsForObservationInput,
} from '../event-wait-authority.js';
import { createSqliteEventWaitAuthority } from '../sqlite-event-wait-authority.js';
import { SQLITE_WORKFLOW_SCHEMA_VERSION } from '../sqlite-workflow-schema.js';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '../root-authority.js';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import {
  createOperationalStateBackup,
  restoreOperationalStateBackup,
} from '../operational-state-backup.js';
import {
  trackControlDirectory,
  removeTrackedControlDirectories,
} from './fixtures/control-directory-hygiene.js';

after(removeTrackedControlDirectories);
type Stores = Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>;
const input = (root: string) => ({
  cwd: root,
  name: 'Event wait',
  llmConnectionSlug: 'test',
  model: 'test',
  permissionMode: 'ask' as const,
});
function waiting(
  sessionId: string,
  waitId = 'wait-1',
): Extract<EventWaitRecord, { status: 'waiting' }> {
  return {
    schemaVersion: 1,
    waitId,
    sessionId,
    goalControlLease: { goalId: 'goal-1', generation: 0 },
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'call-1',
    resource: {
      providerId: 'test',
      connectionId: null,
      resourceType: 'task',
      resourceId: 'opaque/task',
    },
    condition: { typeId: 'terminal', version: 1, parameters: { flags: [true], zero: -0 } },
    deliveryKey: eventWaitDeliveryKey(waitId),
    createdAt: 10,
    updatedAt: 10,
    deadlineAt: 100,
    status: 'waiting',
  };
}
const commit = (record: EventWaitRecord, expectedAuthorityRevision: number | null = null) => ({
  sessionId: record.sessionId,
  waitId: record.waitId,
  record,
  expectedAuthorityRevision,
});
const identity = (record: EventWaitRecord) => ({
  sessionId: record.sessionId,
  waitId: record.waitId,
});
const resolve = (r: EventWaitRecord): Extract<EventWaitRecord, { status: 'resolved' }> => ({
  ...r,
  status: 'resolved',
  updatedAt: 30,
  resolvedAt: 30,
  resolution: {
    outcome: 'satisfied',
    receiptKey: 'receipt-1',
    observedAt: 25,
    evidenceRefs: ['ref-1'],
  },
});
function cancel(r: EventWaitRecord): Extract<EventWaitRecord, { status: 'cancelled' }> {
  return {
    ...waiting(r.sessionId, r.waitId),
    status: 'cancelled',
    updatedAt: 40,
    cancelledAt: 40,
    reason: 'revoked',
    ...(r.status === 'resolved'
      ? { priorResolution: { resolvedAt: r.resolvedAt, resolution: r.resolution } }
      : {}),
  };
}
function observing(
  record: Extract<EventWaitRecord, { status: 'waiting' }>,
  lastAttemptAt: number,
  nextObserveAt = lastAttemptAt,
  nextPollAt = nextObserveAt,
): Extract<EventWaitRecord, { status: 'waiting' }> {
  return {
    ...record,
    updatedAt: lastAttemptAt,
    observation: {
      schemaVersion: 1,
      attempts: 1,
      lastAttemptAt,
      lastObservedAt: null,
      nextObserveAt,
      nextPollAt,
      consecutiveErrors: 0,
      outcome: 'checking',
      cursor: null,
      eventKey: null,
      reason: null,
    },
  };
}
async function withProvider(
  provider: ExecutionPersistenceProvider,
  action: (s: Stores, root: string, owner: InteractiveRootOwner) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'maka-event-wait-'));
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  let stores: Stores | undefined;
  try {
    stores = await openInteractiveExecutionStoresForWrite(owner.lease, provider);
    await action(stores, root, owner);
  } finally {
    try {
      await stores?.sessionStore.close?.();
    } finally {
      await owner.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}
for (const backend of ['Local', 'Memory'] as const) {
  const make = () =>
    backend === 'Local'
      ? localExecutionPersistenceProvider
      : createMemoryExecutionPersistenceProvider();
  test(`${backend}: observation selection orders durable attempts and reorders committed reservations`, async () => {
    await withProvider(make(), async (s, root) => {
      const store = s.eventWaitStore;
      const records = new Map<string, Extract<EventWaitRecord, { status: 'waiting' }>>();
      for (const waitId of ['z', 'b', 'y', 'a']) {
        const session = await s.sessionStore.create(input(root));
        const r = waiting(session.id, waitId);
        records.set(waitId, r);
        await store.commit(commit(r));
      }
      await store.commit(commit(observing(records.get('y')!, 15), 0));
      await store.commit(commit(observing(records.get('z')!, 20), 0));
      const ids = async (query: ListEventWaitsForObservationInput) =>
        (await store.listForObservation(query)).map((v) => v.record.waitId);
      assert.deepEqual(await ids({ now: 30, limit: 200 }), ['a', 'b', 'y', 'z']);
      assert.deepEqual(await ids({ now: 30, limit: 1 }), ['a']);
      // Legacy records without an observation remain first until their first reservation commits.
      await store.commit(commit(observing(records.get('a')!, 31, 32), 0));
      assert.deepEqual(await ids({ now: 31, limit: 200 }), ['b', 'y', 'z']);
      assert.deepEqual(await ids({ now: 32, limit: 200 }), ['b', 'y', 'z', 'a']);
      assert.deepEqual(await ids({ now: 32, limit: 2, excludedWaitIds: ['b'] }), ['y', 'z']);
      // Recovery can pass an unchanged failed reservation without retaining every failed ID.
      assert.deepEqual(await ids({ now: 32, limit: 200, scan: {} }), ['a', 'b', 'y', 'z']);
      assert.deepEqual(await ids({ now: 32, limit: 1, scan: { afterWaitId: 'a' } }), ['b']);
      assert.deepEqual(await ids({ now: 32, limit: 1, scan: { afterWaitId: 'b' } }), ['y']);
      assert.deepEqual(await ids({ now: 32, limit: 200, scan: { afterWaitId: 'x' } }), ['y', 'z']);
      assert.deepEqual(await ids({ now: 32, limit: 200, scan: { afterWaitId: 'z' } }), []);
      // Finishing a recovery traversal does not change ordinary durable-age priority.
      assert.deepEqual(await ids({ now: 32, limit: 1 }), ['b']);
      const scan = { afterWaitId: 'a' };
      const capturedScan = store.listForObservation({ now: 32, limit: 1, scan });
      scan.afterWaitId = 'z';
      assert.deepEqual(
        (await capturedScan).map((v) => v.record.waitId),
        ['b'],
      );
      const selected = await store.listForObservation({ now: 32, limit: 1 });
      (selected[0]!.record.resource as { resourceId: string }).resourceId = 'caller-mutation';
      assert.equal(
        (await store.read(identity(records.get('b')!)))!.record.resource.resourceId,
        'opaque/task',
      );
    });
  });
  test(`${backend}: observation eligibility respects dirty hints, deadlines, source cooldowns and dispatch reservations`, async () => {
    await withProvider(make(), async (s, root) => {
      const store = s.eventWaitStore;
      for (const waitId of [
        'plain',
        'future',
        'poll',
        'due',
        'deadline',
        'terminal',
        'cooldown',
        'dispatch',
        'connected',
      ]) {
        const session = await s.sessionStore.create(input(root));
        const r = {
          ...waiting(session.id, waitId),
          ...(waitId === 'future' ? { createdAt: 60, updatedAt: 60 } : {}),
          ...(waitId === 'deadline' ? { deadlineAt: 50 } : {}),
          resource: {
            ...waiting(session.id).resource,
            providerId: ['cooldown', 'dispatch'].includes(waitId) ? waitId : 'test',
            connectionId: waitId === 'connected' ? 'connection-1' : null,
          },
        };
        await store.commit(commit(r));
        if (waitId === 'poll') await store.commit(commit(observing(r, 30, 40, 60), 0));
        if (waitId === 'due') await store.commit(commit(observing(r, 25, 40, 50), 0));
        if (waitId === 'terminal') await store.commit(commit(resolve(r), 0));
      }
      await store.extendSourceCooldown({
        providerId: 'cooldown',
        connectionId: null,
        observedAt: 10,
        until: 51,
      });
      await store.reserveSourceDispatch({
        providerId: 'dispatch',
        connectionId: null,
        token: 'reserved',
        observedAt: 10,
        until: 52,
      });
      const ids = async (query: ListEventWaitsForObservationInput) => {
        const selected = (await store.listForObservation(query)).map((v) => v.record.waitId);
        const scanned = (await store.listForObservation({ ...query, scan: {} })).map(
          (v) => v.record.waitId,
        );
        // Recovery changes ordering only; cooldown, deadlines and all hints still apply.
        assert.deepEqual(scanned, [...selected].sort());
        return selected;
      };
      assert.deepEqual(await ids({ now: 50, limit: 200 }), ['connected', 'plain', 'due']);
      assert.deepEqual(
        (
          await store.listForObservation({
            now: 50,
            limit: 1,
            scan: { afterWaitId: 'connected' },
            excludedWaitIds: ['due'],
          })
        ).map((v) => v.record.waitId),
        ['plain'],
      );
      assert.deepEqual(await ids({ now: 39, limit: 200, dirtyWaitIds: ['poll'] }), [
        'connected',
        'deadline',
        'plain',
      ]);
      assert.deepEqual(await ids({ now: 50, limit: 200, dirtyWaitIds: ['poll'] }), [
        'connected',
        'plain',
        'due',
        'poll',
      ]);
      assert.deepEqual(
        await ids({
          now: 50,
          limit: 200,
          dirtyWaitIds: ['poll'],
          excludedSources: [{ providerId: 'test', connectionId: null }],
        }),
        ['connected'],
      );
      assert.deepEqual(await ids({ now: 51, limit: 200 }), [
        'connected',
        'cooldown',
        'plain',
        'due',
      ]);
      assert.deepEqual(
        await ids({ now: 52, limit: 200, excludedWaitIds: ['connected', 'plain', 'due'] }),
        ['cooldown', 'dispatch'],
      );
      assert.deepEqual(await ids({ now: 60, limit: 200 }), [
        'connected',
        'cooldown',
        'dispatch',
        'future',
        'plain',
        'due',
        'poll',
      ]);
      // Caller-owned nested hints must be captured before the asynchronous lease check.
      const query = {
        now: 50,
        limit: 200,
        dirtyWaitIds: ['poll'],
        excludedWaitIds: ['connected'],
        excludedSources: [{ providerId: 'unused', connectionId: null as string | null }],
      };
      const queued = store.listForObservation(query);
      query.dirtyWaitIds.length = 0;
      query.excludedWaitIds.push('plain');
      query.excludedSources[0]!.providerId = 'test';
      assert.deepEqual(
        (await queued).map((v) => v.record.waitId),
        ['plain', 'due', 'poll'],
      );
    });
  });
  test(`${backend}: observation selection rejects malformed or unbounded hints at both boundaries`, async () => {
    await withProvider(make(), async (s, root, owner) => {
      const raw = await make().open({
        rootId: owner.lease.rootId,
        canonicalPath: owner.lease.canonicalPath,
      });
      try {
        const accessor = ['wait-1'];
        Object.defineProperty(accessor, '0', {
          enumerable: true,
          get: () => {
            throw new Error('must not invoke');
          },
        });
        for (const bad of [
          { now: -1, limit: 1 },
          { now: NaN, limit: 1 },
          { now: 10.5, limit: 1 },
          { now: 10, limit: 0 },
          { now: 10, limit: 201 },
          { now: 10, limit: 1, extra: true },
          { now: 10, limit: 1, scan: undefined },
          { now: 10, limit: 1, scan: null },
          { now: 10, limit: 1, scan: [] },
          { now: 10, limit: 1, scan: { extra: true } },
          { now: 10, limit: 1, scan: { afterWaitId: undefined } },
          { now: 10, limit: 1, scan: { afterWaitId: '' } },
          { now: 10, limit: 1, scan: { afterWaitId: '../bad' } },
          { now: 10, limit: 1, scan: { afterWaitId: 'bad\n' } },
          { now: 10, limit: 1, scan: { afterWaitId: 'x'.repeat(129) } },
          {
            now: 10,
            limit: 1,
            scan: Object.defineProperty({}, 'afterWaitId', {
              enumerable: true,
              get: () => {
                throw new Error('must not invoke');
              },
            }),
          },
          { now: 10, limit: 1, dirtyWaitIds: undefined },
          { now: 10, limit: 1, excludedWaitIds: ['../bad'] },
          { now: 10, limit: 1, dirtyWaitIds: new Array(1) },
          { now: 10, limit: 1, dirtyWaitIds: accessor },
          { now: 10, limit: 1, excludedSources: [{ providerId: 'test', connectionId: undefined }] },
          ...['dirtyWaitIds', 'excludedWaitIds', 'excludedSources'].map((key) => ({
            now: 10,
            limit: 1,
            [key]: Array(EVENT_WAIT_OBSERVATION_HINT_LIMIT + 1).fill(
              key === 'excludedSources' ? { providerId: 'test', connectionId: null } : 'wait-1',
            ),
          })),
        ]) {
          await assert.rejects(
            s.eventWaitStore.listForObservation(bad as ListEventWaitsForObservationInput),
            TypeError,
          );
          await assert.rejects(
            async () =>
              raw.eventWaitStore.listForObservation(bad as ListEventWaitsForObservationInput),
            TypeError,
          );
        }
        assert.deepEqual(
          await s.eventWaitStore.listForObservation({
            now: 10,
            limit: 1,
            dirtyWaitIds: Array(EVENT_WAIT_OBSERVATION_HINT_LIMIT).fill('wait-1'),
          }),
          [],
        );
        await s.eventWaitStore.close();
        await assert.rejects(s.eventWaitStore.listForObservation({ now: 10, limit: 1 }));
      } finally {
        await raw.close();
      }
    });
  });
  test(`${backend}: CAS, active slots and immutable terminal results (not external-truth or Goal authorization checks)`, async () => {
    await withProvider(make(), async (s, root) => {
      const session = await s.sessionStore.create(input(root));
      const r = waiting(session.id),
        store = s.eventWaitStore;
      const created = await store.commit(commit(r));
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') throw new Error('Expected commit');
      assert.equal(created.snapshot.authorityRevision, 0);
      assert.deepEqual(await store.commit(commit(r)), {
        kind: 'revision_conflict',
        actualAuthorityRevision: 0,
      });
      assert.deepEqual(await store.commit(commit(waiting(session.id, 'wait-2'))), {
        kind: 'active_wait_conflict',
        waitId: r.waitId,
      });
      const results = await Promise.all([
        store.commit(commit(resolve(r), 0)),
        store.commit(commit(cancel(r), 0)),
      ]);
      assert.deepEqual(results.map((v) => v.kind).sort(), ['committed', 'revision_conflict']);
      const current = await store.read(identity(r));
      assert.ok(current);
      assert.equal(current.authorityRevision, 1);
      assert.deepEqual(await store.commit(commit(current.record, 1)), {
        kind: 'committed',
        snapshot: current,
      });
      assert.equal((await store.commit(commit(current.record, 0))).kind, 'revision_conflict');
      await assert.rejects(store.commit(commit(r, 1)), /transition|time regression/);
      if (current.record.status === 'resolved') {
        assert.equal(
          (await store.commit(commit(waiting(session.id, 'wait-2')))).kind,
          'active_wait_conflict',
        );
        await assert.rejects(
          store.commit(
            commit(
              { ...resolve(r), resolution: { ...resolve(r).resolution, receiptKey: 'other' } },
              1,
            ),
          ),
          /transition|time regression/,
        );
        await store.commit(commit(cancel(current.record), 1));
      }
      assert.equal((await store.commit(commit(waiting(session.id, 'wait-2')))).kind, 'committed');
      assert.equal(await store.read({ sessionId: 'other-session', waitId: r.waitId }), null);
      const other = await s.sessionStore.create(input(root));
      await assert.rejects(store.commit(commit(waiting(other.id, r.waitId))), /ownership/);
      await assert.rejects(store.commit({ ...commit(r), sessionId: other.id }), /identity/);
      assert.equal((await store.commit(commit(waiting(other.id, 'wait-other')))).kind, 'committed');
      const racing = await s.sessionStore.create(input(root));
      const creations = await Promise.all(
        ['race-a', 'race-b'].map((waitId) => store.commit(commit(waiting(racing.id, waitId)))),
      );
      assert.deepEqual(creations.map((v) => v.kind).sort(), ['active_wait_conflict', 'committed']);
      assert.equal((await store.listSession({ sessionId: racing.id, limit: 200 })).items.length, 1);
      // These dormant records do not create Goal authority or any successor.
      assert.equal(await s.goalStore.read(session.id), null);
    });
  });
  test(`${backend}: isolated inputs/results, bounded ASCII keyset pages, expiry and reopen`, async () => {
    const provider = make();
    await withProvider(provider, async (s, root, owner) => {
      const store = s.eventWaitStore;
      const ids = ['z', 'a', 'Z', '_', 'A', '0', '-'];
      for (const waitId of ids) {
        const session = await s.sessionStore.create(input(root));
        const r = waiting(session.id, waitId);
        const pending = store.commit(commit(r));
        (r.condition.parameters.flags as boolean[])[0] = false;
        const result = await pending;
        assert.equal(result.kind, 'committed');
        if (result.kind !== 'committed') throw new Error('Expected commit');
        assert.equal(result.snapshot.record.condition.parameters.zero, 0);
        (result.snapshot.record.condition.parameters.flags as boolean[])[0] = false;
        const read = await store.read(identity(r));
        assert.ok(read);
        assert.deepEqual(read.record.condition.parameters.flags, [true]);
        if (waitId === 'Z') await store.commit(commit(resolve(read.record), 0));
        if (waitId === 'z')
          await store.commit(
            commit({ ...read.record, status: 'expired', updatedAt: 100, expiredAt: 100 }, 0),
          );
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.listPending({
          limit: 2,
          ...(cursor ? { afterWaitId: cursor } : {}),
        });
        seen.push(...page.items.map((v) => v.record.waitId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.deepEqual(seen, ids.filter((v) => v !== 'z').sort());
      for (const limit of [0, -1, 201, Infinity, 1.5])
        await assert.rejects(store.listPending({ limit }));
      await assert.rejects(store.listPending({ limit: 1, afterWaitId: '../unsafe' }));
      for (const suffix of ['\n', '\r', '\u2028', '\u2029']) {
        await assert.rejects(store.listPending({ limit: 1, afterWaitId: `wait${suffix}` }));
        await assert.rejects(store.read({ sessionId: `session${suffix}`, waitId: 'wait' }));
        await assert.rejects(store.read({ sessionId: 'session', waitId: `wait${suffix}` }));
        await assert.rejects(store.listSession({ sessionId: `session${suffix}`, limit: 1 }));
      }
      const first = (await store.listPending({ limit: 1 })).items[0]!;
      const list = await store.listSession({ sessionId: first.record.sessionId, limit: 200 });
      assert.equal(list.items.length, 1);
      (list.items[0]!.record.condition.parameters.flags as boolean[])[0] = false;
      assert.deepEqual(
        (await store.read(identity(first.record)))!.record.condition.parameters.flags,
        [true],
      );
      await s.sessionStore.close?.();
      await assert.rejects(store.listPending({ limit: 1 }), /closed|invalid|Expected/);
      const reopened = await openInteractiveExecutionStoresForWrite(owner.lease, provider);
      try {
        assert.deepEqual(await reopened.eventWaitStore.read(identity(first.record)), first);
        assert.deepEqual(
          (await reopened.eventWaitStore.listPending({ limit: 200 })).items.map(
            (v) => v.record.waitId,
          ),
          seen,
        );
      } finally {
        await reopened.sessionStore.close?.();
      }
      if (backend === 'Memory') await assert.rejects(access(join(root, 'runtime.sqlite')));
    });
  });
  test(`${backend}: archive, unarchive, removal, mixed batch retirement and purge are scoped`, async () => {
    await withProvider(make(), async (s, root) => {
      const records: EventWaitRecord[] = [];
      for (let i = 0; i < 5; i++) {
        const session = await s.sessionStore.create(input(root));
        const r = waiting(session.id, `wait-${i}`);
        await s.eventWaitStore.commit(commit(r));
        records.push(r);
      }
      const versioned = async (r: EventWaitRecord) => ({
        sessionId: r.sessionId,
        expectedVersion: (await s.sessionStore.readHeaderRecordSnapshot(r.sessionId)).revision,
      });
      await s.sessionStore.setSessionsArchivedVersioned([await versioned(records[0]!)], true);
      assert.equal(await s.eventWaitStore.read(identity(records[0]!)), null);
      assert.equal(
        (await s.eventWaitStore.commit(commit(records[0]!))).kind,
        'session_unavailable',
      );
      await s.sessionStore.setSessionsArchivedVersioned([await versioned(records[0]!)], false);
      assert.equal(await s.eventWaitStore.read(identity(records[0]!)), null);
      await s.sessionStore.removeSessionsVersioned(
        [await versioned(records[1]!), await versioned(records[2]!)],
        [await versioned(records[3]!)],
      );
      for (const r of records.slice(1, 4)) {
        assert.equal(await s.eventWaitStore.read(identity(r)), null);
        assert.equal((await s.eventWaitStore.commit(commit(r))).kind, 'session_unavailable');
      }
      assert.ok(await s.eventWaitStore.read(identity(records[4]!)));
      await s.purgeConversationOperationalState(records[4]!.sessionId);
      assert.equal(await s.eventWaitStore.read(identity(records[4]!)), null);
      assert.ok(await s.sessionStore.readHeader(records[4]!.sessionId));
      assert.equal(
        (await s.eventWaitStore.commit(commit(waiting('missing-session')))).kind,
        'session_unavailable',
      );
    });
  });
  test(`${backend}: no-op slot release and terminal creation validation`, async () => {
    await withProvider(make(), async (s, root) => {
      const session = await s.sessionStore.create(input(root));
      const r = waiting(session.id);
      await assert.rejects(s.eventWaitStore.commit(commit(resolve(r))), /created waiting/);
      await s.eventWaitStore.commit(commit(r));
      const expired: EventWaitRecord = { ...r, status: 'expired', expiredAt: 100, updatedAt: 100 };
      await s.eventWaitStore.commit(commit(expired, 0));
      await assert.rejects(s.eventWaitStore.commit(commit(r, 1)), /transition|time regression/);
      await s.eventWaitStore.commit(commit(waiting(session.id, 'second')));
      const page = await s.eventWaitStore.listSession({ sessionId: session.id, limit: 1 });
      assert.equal(page.items.length, 1);
      assert.ok(page.nextCursor);
      const next = await s.eventWaitStore.listSession({
        sessionId: session.id,
        afterWaitId: page.nextCursor,
        limit: 1,
      });
      assert.equal(next.items.length, 1);
      assert.equal(next.nextCursor, null);
    });
  });
  test(`${backend}: a closed backend cannot reuse authority retained by another execution group`, async () => {
    const provider = make();
    await withProvider(provider, async (s, root, owner) => {
      const session = await s.sessionStore.create(input(root));
      const r = waiting(session.id);
      await s.eventWaitStore.commit(commit(r));
      const other = await provider.open({
        rootId: owner.lease.rootId,
        canonicalPath: owner.lease.canonicalPath,
      });
      try {
        await other.eventWaitStore.close();
        for (const operation of [
          () => other.eventWaitStore.read(identity(r)),
          () => other.eventWaitStore.listSession({ sessionId: r.sessionId, limit: 1 }),
          () => other.eventWaitStore.listPending({ limit: 1 }),
          () => other.eventWaitStore.listForObservation({ limit: 1, now: 10 }),
          () => other.eventWaitStore.commit(commit(resolve(r), 0)),
        ]) {
          await assert.rejects(async () => operation(), /closed/);
        }
        assert.equal((await s.eventWaitStore.read(identity(r)))?.authorityRevision, 0);
      } finally {
        await other.close();
      }
    });
  });
}

test('Local: two backend handles share CAS authority; corrupt JSON and indexed columns fail closed', async () => {
  await withProvider(localExecutionPersistenceProvider, async (s, root) => {
    const session = await s.sessionStore.create(input(root));
    const r = waiting(session.id);
    const a = createSqliteEventWaitAuthority(root),
      b = createSqliteEventWaitAuthority(root);
    try {
      await a.commit(commit(r));
      await b.commit(commit(resolve(r), 0));
      assert.deepEqual(await a.commit(commit(cancel(r), 0)), {
        kind: 'revision_conflict',
        actualAuthorityRevision: 1,
      });
      const db = acquireOperationalStateDatabase(root);
      try {
        for (const [column, value] of [
          ['status', 'waiting'],
          ['delivery_key', 'tampered'],
          ['deadline_at', 101],
          ['record_json', '{bad-json'],
          ['authority_revision', 0.5],
        ] as const) {
          const before = db.database
            .prepare(`SELECT ${column} AS value FROM workflow_event_waits WHERE wait_id = ?`)
            .get(r.waitId)!.value;
          db.transaction('write', () =>
            db.database
              .prepare(`UPDATE workflow_event_waits SET ${column} = ? WHERE wait_id = ?`)
              .run(value, r.waitId),
          );
          assert.throws(() => a.read(identity(r)));
          db.transaction('write', () =>
            db.database
              .prepare(`UPDATE workflow_event_waits SET ${column} = ? WHERE wait_id = ?`)
              .run(before!, r.waitId),
          );
        }
      } finally {
        db.close();
      }
    } finally {
      await a.close();
      await b.close();
    }
  });
});

test('Memory: beforeCommit rolls back and afterCommit loses only the acknowledgement', async () => {
  let mode: 'before' | 'after' | undefined;
  const provider = createMemoryExecutionPersistenceProvider({
    beforeCommit: (op) => {
      if (op === 'eventWait.commit' && mode === 'before') throw new Error('before fault');
    },
    afterCommit: (op) => {
      if (op === 'eventWait.commit' && mode === 'after') throw new Error('after fault');
    },
  });
  await withProvider(provider, async (s, root) => {
    const session = await s.sessionStore.create(input(root));
    const r = waiting(session.id);
    mode = 'before';
    await assert.rejects(s.eventWaitStore.commit(commit(r)), /before fault/);
    mode = undefined;
    assert.equal(await s.eventWaitStore.read(identity(r)), null);
    mode = 'after';
    await assert.rejects(s.eventWaitStore.commit(commit(r)), /after fault/);
    mode = undefined;
    assert.equal((await s.eventWaitStore.read(identity(r)))?.authorityRevision, 0);
    assert.deepEqual(await s.eventWaitStore.commit(commit(r)), {
      kind: 'revision_conflict',
      actualAuthorityRevision: 0,
    });
  });
});

test('facade authentication, explicit provider port, lease revocation and backend close ownership', async () => {
  let backendCloses = 0;
  const inner = createMemoryExecutionPersistenceProvider();
  const provider: ExecutionPersistenceProvider = {
    async open(i) {
      const raw = await inner.open(i);
      const store = raw.eventWaitStore;
      return {
        ...raw,
        eventWaitStore: {
          ...store,
          close() {
            backendCloses++;
          },
        },
        async close() {
          backendCloses++;
          await raw.close();
        },
      };
    },
  };
  await withProvider(provider, async (s, _root, owner) => {
    assert.equal(
      authenticateInteractiveEventWaitAuthorityWriter(s.eventWaitStore),
      s.eventWaitStore,
    );
    assert.throws(() =>
      authenticateInteractiveEventWaitAuthorityWriter({} as InteractiveEventWaitAuthorityWriter),
    );
    await assert.rejects(
      openInteractiveEventWaitAuthorityForWrite(
        {} as typeof owner.lease,
        {} as EventWaitAuthorityRepository,
      ),
    );
    await s.eventWaitStore.close();
    assert.equal(backendCloses, 0);
    assert.throws(() => authenticateInteractiveEventWaitAuthorityWriter(s.eventWaitStore));
    await assert.rejects(s.eventWaitStore.listPending({ limit: 1 }));
    await s.sessionStore.close?.();
    assert.equal(backendCloses, 1);
    await owner.close();
    await assert.rejects(openInteractiveExecutionStoresForWrite(owner.lease, provider));
  });
});

test('group close waits for pending event-wait reads, lists and writes', async () => {
  for (const method of [
    'read',
    'listSession',
    'listPending',
    'listByStatus',
    'listForObservation',
    'readSourceCooldown',
    'extendSourceCooldown',
    'reserveSourceDispatch',
    'completeSourceDispatch',
    'commit',
  ] as const) {
    let release!: () => void,
      entered!: () => void,
      closed = false;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const inner = createMemoryExecutionPersistenceProvider();
    const provider: ExecutionPersistenceProvider = {
      async open(i) {
        const raw = await inner.open(i);
        const store = new Proxy(raw.eventWaitStore, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (property !== method)
              return typeof value === 'function' ? value.bind(target) : value;
            return async (...args: unknown[]) => {
              entered();
              await gate;
              return Reflect.apply(value, target, args);
            };
          },
        });
        return {
          ...raw,
          eventWaitStore: store,
          async close() {
            closed = true;
            await raw.close();
          },
        };
      },
    };
    await withProvider(provider, async (s, root) => {
      const session = await s.sessionStore.create(input(root));
      const r = waiting(session.id);
      const task =
        method === 'read'
          ? s.eventWaitStore.read(identity(r))
          : method === 'listSession'
            ? s.eventWaitStore.listSession({ sessionId: session.id, limit: 1 })
            : method === 'listPending'
              ? s.eventWaitStore.listPending({ limit: 1 })
              : method === 'listByStatus'
                ? s.eventWaitStore.listByStatus({ status: 'waiting', limit: 1 })
                : method === 'listForObservation'
                  ? s.eventWaitStore.listForObservation({ limit: 1, now: 10 })
                  : method === 'readSourceCooldown'
                    ? s.eventWaitStore.readSourceCooldown({
                        providerId: 'fake',
                        connectionId: null,
                      })
                    : method === 'extendSourceCooldown'
                      ? s.eventWaitStore.extendSourceCooldown({
                          providerId: 'fake',
                          connectionId: null,
                          observedAt: 10,
                          until: 20,
                        })
                      : method === 'reserveSourceDispatch' || method === 'completeSourceDispatch'
                        ? s.eventWaitStore[method]({
                            providerId: 'fake',
                            connectionId: null,
                            token: 'dispatch-1',
                            observedAt: 10,
                            until: 20,
                          })
                        : s.eventWaitStore.commit(commit(r));
      await started;
      const closing = s.sessionStore.close?.();
      assert.equal(closed, false);
      release();
      await task;
      await closing;
      assert.equal(closed, true);
      await assert.rejects(s.eventWaitStore.read(identity(r)));
    });
  }
});

test('workflow-12 migration adds only dormant schema, retains Session/Goal data, backup retains waits', async () => {
  await withProvider(localExecutionPersistenceProvider, async (s, root, owner) => {
    const session = await s.sessionStore.create(input(root));
    const r = waiting(session.id);
    await s.sessionStore.close?.();
    // Reconstruct the released workflow-12 structure: the new table and indexes are absent.
    const old = new DatabaseSync(join(root, 'runtime.sqlite'));
    try {
      old.exec('DROP TABLE workflow_event_waits');
      old
        .prepare("UPDATE operational_schema_migrations SET version = 12 WHERE scope = 'workflow'")
        .run();
      old
        .prepare('INSERT INTO workflow_goal_authority VALUES (?, 0, ?, 0, ?, ?)')
        .run(session.id, 'goal-1', 'active', '{"preserve":"unchanged"}');
      assert.equal(
        old.prepare("SELECT name FROM sqlite_schema WHERE name = 'workflow_event_waits'").get(),
        undefined,
      );
    } finally {
      old.close();
    }
    const reopened = await openInteractiveExecutionStoresForWrite(owner.lease);
    try {
      assert.equal((await reopened.sessionStore.readHeader(session.id)).id, session.id);
      assert.deepEqual(await reopened.eventWaitStore.listPending({ limit: 1 }), {
        items: [],
        nextCursor: null,
      });
      await reopened.eventWaitStore.commit(commit(r));
      await reopened.eventWaitStore.commit(commit(resolve(r), 0));
      const db = acquireOperationalStateDatabase(root);
      try {
        assert.equal(
          db.database
            .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'workflow'")
            .get()!.version,
          SQLITE_WORKFLOW_SCHEMA_VERSION,
        );
        assert.equal(
          db.database
            .prepare('SELECT record_json FROM workflow_goal_authority WHERE session_id = ?')
            .get(session.id)!.record_json,
          '{"preserve":"unchanged"}',
        );
        db.transaction('write', () =>
          db.database
            .prepare('DELETE FROM workflow_goal_authority WHERE session_id = ?')
            .run(session.id),
        );
      } finally {
        db.close();
      }
    } finally {
      await reopened.sessionStore.close?.();
    }
    const backup = await mkdtemp(join(tmpdir(), 'maka-wait-backup-'));
    const restored = join(backup, 'restored');
    try {
      await createOperationalStateBackup({
        stateRoot: root,
        destinationRoot: join(backup, 'backup'),
        now: () => 200,
      });
      await restoreOperationalStateBackup({
        backupRoot: join(backup, 'backup'),
        destinationRoot: restored,
      });
      const store = createSqliteEventWaitAuthority(restored);
      try {
        assert.deepEqual(await store.read(identity(r)), {
          authorityRevision: 1,
          record: {
            ...resolve(r),
            condition: { ...r.condition, parameters: { flags: [true], zero: 0 } },
          },
        });
      } finally {
        await store.close();
      }
    } finally {
      await rm(backup, { recursive: true, force: true });
    }
    const future = new DatabaseSync(join(root, 'runtime.sqlite'));
    try {
      future
        .prepare("UPDATE operational_schema_migrations SET version = ? WHERE scope = 'workflow'")
        .run(SQLITE_WORKFLOW_SCHEMA_VERSION + 1);
    } finally {
      future.close();
    }
    assert.throws(() => createSqliteEventWaitAuthority(root));
    const check = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
    try {
      assert.equal(
        check
          .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'workflow'")
          .get()!.version,
        SQLITE_WORKFLOW_SCHEMA_VERSION + 1,
      );
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM workflow_event_waits').get()!.n, 1);
    } finally {
      check.close();
    }
  });
});

for (const backend of ['Local', 'Memory'] as const) {
  test(`${backend}: archive/removal/purge faults roll back wait cleanup and Session lifecycle together`, async () => {
    let armed: string | undefined;
    const provider =
      backend === 'Local'
        ? localExecutionPersistenceProvider
        : createMemoryExecutionPersistenceProvider({
            beforeCommit: (op) => {
              if (op === armed) throw new Error('cleanup fault');
            },
          });
    await withProvider(provider, async (s, root) => {
      for (const operation of ['session.archive', 'session.remove', 'execution.purgeOperational']) {
        const session = await s.sessionStore.create(input(root));
        const r = waiting(session.id, operation.replaceAll('.', '-'));
        await s.eventWaitStore.commit(commit(r));
        const db = backend === 'Local' ? acquireOperationalStateDatabase(root) : undefined;
        const before = await s.sessionStore.readHeaderRecordSnapshot(session.id);
        try {
          db?.database.exec(
            "CREATE TRIGGER event_wait_cleanup_fault BEFORE DELETE ON workflow_event_waits BEGIN SELECT RAISE(ABORT, 'cleanup fault'); END",
          );
          armed = operation;
          await assert.rejects(
            operation === 'session.archive'
              ? s.sessionStore.setSessionsArchivedVersioned(
                  [{ sessionId: session.id, expectedVersion: before.revision }],
                  true,
                )
              : operation === 'session.remove'
                ? s.sessionStore.remove(session.id)
                : s.purgeConversationOperationalState(session.id),
            /cleanup fault/,
          );
        } finally {
          armed = undefined;
          db?.database.exec('DROP TRIGGER IF EXISTS event_wait_cleanup_fault');
          db?.close();
        }
        assert.deepEqual(await s.sessionStore.readHeaderRecordSnapshot(session.id), before);
        assert.equal((await s.eventWaitStore.read(identity(r)))?.authorityRevision, 0);
        await s.sessionStore.remove(session.id);
        assert.equal(await s.eventWaitStore.read(identity(r)), null);
        assert.equal((await s.eventWaitStore.commit(commit(r))).kind, 'session_unavailable');
      }
    });
  });
  test(`${backend}: Session branch/import copy declared data without active subscriptions`, async () => {
    await withProvider(
      backend === 'Local'
        ? localExecutionPersistenceProvider
        : createMemoryExecutionPersistenceProvider(),
      async (s, root) => {
        const source = await s.sessionStore.create(input(root));
        const r = waiting(source.id);
        await s.eventWaitStore.commit(commit(r));
        const requestFingerprint = `sha256:${'d'.repeat(64)}` as const;
        const branch = await s.sessionStore.createStableSession({
          sessionId: 'branch-target',
          requestFingerprint,
          input: {
            ...input(root),
            parentSessionId: source.id,
            conversationCopy: {
              kind: 'branch',
              sourceSessionId: source.id,
              requestFingerprint,
              state: 'preparing',
              intent: 'side_conversation',
            },
          },
        });
        assert.equal(branch.kind, 'created');
        const imported = await s.sessionStore.createImportedSession(input(root), [], {
          adapterId: 'test-import',
          sourceSessionId: source.id,
        });
        for (const sessionId of ['branch-target', imported.id]) {
          assert.deepEqual(await s.eventWaitStore.listSession({ sessionId, limit: 200 }), {
            items: [],
            nextCursor: null,
          });
          assert.equal(await s.eventWaitStore.read({ sessionId, waitId: r.waitId }), null);
        }
        assert.equal((await s.eventWaitStore.listPending({ limit: 200 })).items.length, 1);
      },
    );
  });
}

test('missing event-wait provider port cleans partial composition; uncertain close blocks Local fallback', async () => {
  for (const failClose of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'maka-wait-open-fault-'));
    const capability = trackControlDirectory(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    const inner = createMemoryExecutionPersistenceProvider();
    let closes = 0;
    const provider: ExecutionPersistenceProvider = {
      async open(i) {
        const raw = await inner.open(i);
        return {
          ...raw,
          eventWaitStore: undefined as unknown as EventWaitAuthorityRepository,
          async close() {
            closes++;
            await raw.close();
            if (failClose) throw new Error('uncertain close');
          },
        };
      },
    };
    try {
      await assert.rejects(
        openInteractiveExecutionStoresForWrite(owner.lease, provider),
        failClose ? /compose/ : /eventWaitStore/,
      );
      assert.equal(closes, 1);
      if (failClose)
        await assert.rejects(openInteractiveExecutionStoresForWrite(owner.lease), /fresh owner/);
      await assert.rejects(access(join(root, 'runtime.sqlite')));
    } finally {
      await owner.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('revoked root lease rejects every event-wait operation before a still-live facade reaches its backend', async () => {
  await withProvider(createMemoryExecutionPersistenceProvider(), async (s, _root, owner) => {
    await owner.close();
    const r = waiting('session');
    for (const operation of [
      () => s.eventWaitStore.read(identity(r)),
      () => s.eventWaitStore.listSession({ sessionId: r.sessionId, limit: 1 }),
      () => s.eventWaitStore.listPending({ limit: 1 }),
      () => s.eventWaitStore.listForObservation({ limit: 1, now: 10 }),
      () => s.eventWaitStore.commit(commit(r)),
    ])
      await assert.rejects(operation());
  });
});

for (const backend of ['Local', 'Memory'] as const) {
  test(`${backend}: observation CAS, status pagination, expiry discovery and cleanup`, async () => {
    const provider =
      backend === 'Local'
        ? localExecutionPersistenceProvider
        : createMemoryExecutionPersistenceProvider();
    await withProvider(provider, async (s, root) => {
      for (const n of [1, 2, 3]) {
        const session = await s.sessionStore.create(input(root));
        const r = waiting(session.id, `observe-${n}`);
        await s.eventWaitStore.commit(commit(r));
        const observation = {
          schemaVersion: 1 as const,
          attempts: 1,
          lastAttemptAt: 15,
          lastObservedAt: null,
          nextObserveAt: 25,
          nextPollAt: 25,
          consecutiveErrors: 0,
          outcome: 'checking' as const,
          cursor: null,
          eventKey: null,
          reason: null,
        };
        const next = { ...r, updatedAt: 15, observation };
        const raced = await Promise.all([
          s.eventWaitStore.commit(commit(next, 0)),
          s.eventWaitStore.commit(commit(next, 0)),
        ]);
        assert.deepEqual(raced.map((v) => v.kind).sort(), ['committed', 'revision_conflict']);
        const snapshot = (await s.eventWaitStore.read(identity(r)))!;
        assert.deepEqual(snapshot.record.observation, observation);
        if (n < 3)
          await s.eventWaitStore.commit(
            commit({ ...next, status: 'expired', updatedAt: 100, expiredAt: 100 }, 1),
          );
      }
      const first = await s.eventWaitStore.listByStatus({ status: 'expired', limit: 1 });
      assert.equal(first.items[0].record.waitId, 'observe-1');
      assert.equal(first.nextCursor, 'observe-1');
      const second = await s.eventWaitStore.listByStatus({
        status: 'expired',
        limit: 1,
        afterWaitId: first.nextCursor,
      });
      assert.equal(second.items[0].record.waitId, 'observe-2');
      assert.equal(second.nextCursor, null);
      assert.deepEqual(
        (await s.eventWaitStore.listPending({ limit: 10 })).items.map((v) => v.record.waitId),
        ['observe-3'],
      );
      for (const bad of [
        { status: 'delivered', limit: 1 },
        { status: 'waiting', limit: 201 },
        { status: 'waiting', limit: 1, extra: true },
        { status: 'waiting', limit: 1, afterWaitId: undefined },
      ])
        await assert.rejects(
          s.eventWaitStore.listByStatus(bad as Parameters<typeof s.eventWaitStore.listByStatus>[0]),
        );
      await s.eventWaitStore.close();
      await assert.rejects(s.eventWaitStore.listByStatus({ status: 'expired', limit: 1 }));
    });
  });
}

for (const [backend, make] of [
  ['Local', () => localExecutionPersistenceProvider],
  ['Memory', createMemoryExecutionPersistenceProvider],
] as const) {
  test(`${backend}: source cooldowns are monotonic, scoped and independent of wait cleanup`, async () => {
    const provider = make();
    await withProvider(provider, async (s, root, owner) => {
      const source = { providerId: 'fake', connectionId: null };
      const session = await s.sessionStore.create(input(root));
      await s.eventWaitStore.commit(commit(waiting(session.id)));
      assert.equal(await s.eventWaitStore.readSourceCooldown(source), null);
      assert.equal(
        await s.eventWaitStore.extendSourceCooldown({ ...source, observedAt: 10, until: 500 }),
        500,
      );
      assert.equal(
        await s.eventWaitStore.extendSourceCooldown({ ...source, observedAt: 20, until: 100 }),
        500,
      );
      await s.eventWaitStore.extendSourceCooldown({
        ...source,
        connectionId: 'other',
        observedAt: 10,
        until: 200,
      });
      assert.equal(
        await s.eventWaitStore.readSourceCooldown({ ...source, providerId: 'another' }),
        null,
      );
      assert.equal(
        await s.eventWaitStore.readSourceCooldown({ ...source, connectionId: 'other' }),
        200,
      );
      await s.purgeConversationOperationalState(session.id);
      assert.equal(await s.eventWaitStore.read(identity(waiting(session.id))), null);
      await s.sessionStore.close?.();
      const reopened = await openInteractiveExecutionStoresForWrite(owner.lease, provider);
      try {
        assert.equal(await reopened.eventWaitStore.readSourceCooldown(source), 500);
        // Expired rows are reclaimed in bounded batches when new limits arrive.
        await reopened.eventWaitStore.extendSourceCooldown({
          ...source,
          connectionId: 'new',
          observedAt: 300,
          until: 400,
        });
        assert.equal(
          await reopened.eventWaitStore.readSourceCooldown({ ...source, connectionId: 'other' }),
          null,
        );
        assert.equal(await reopened.eventWaitStore.readSourceCooldown(source), 500);
        for (const bad of [
          { ...source, providerId: 'fake\n' },
          { ...source, connectionId: '' },
          { ...source, extra: true },
        ])
          await assert.rejects(reopened.eventWaitStore.readSourceCooldown(bad));
        for (const bad of [
          { ...source, observedAt: 10, until: 10 },
          { ...source, observedAt: -1, until: 10 },
          { ...source, observedAt: 10, until: Number.POSITIVE_INFINITY },
        ])
          await assert.rejects(reopened.eventWaitStore.extendSourceCooldown(bad));
        await reopened.eventWaitStore.close();
        await assert.rejects(reopened.eventWaitStore.readSourceCooldown(source));
        await assert.rejects(
          reopened.eventWaitStore.extendSourceCooldown({ ...source, observedAt: 10, until: 20 }),
        );
      } finally {
        await reopened.sessionStore.close?.();
      }
    });
  });
}

for (const [backend, make] of [
  ['Local', () => localExecutionPersistenceProvider],
  ['Memory', createMemoryExecutionPersistenceProvider],
] as const) {
  test(`${backend}: dispatch reservations preserve independent cooldown facts and token ownership`, async () => {
    const provider = make();
    await withProvider(provider, async (s, _root, owner) => {
      const source = { providerId: 'fake', connectionId: null };
      const reservation = { ...source, token: 'dispatch-1', observedAt: 10, until: 500 };
      assert.equal(await s.eventWaitStore.reserveSourceDispatch(reservation), true);
      assert.equal(
        await s.eventWaitStore.reserveSourceDispatch({ ...reservation, until: 400 }),
        true,
      );
      assert.equal(await s.eventWaitStore.readSourceCooldown(source), 500);
      assert.equal(
        await s.eventWaitStore.reserveSourceDispatch({
          ...reservation,
          token: 'dispatch-2',
          observedAt: 20,
          until: 600,
        }),
        false,
      );
      // A shorter Retry-After is still an independent fact, hidden by the reservation.
      assert.equal(
        await s.eventWaitStore.extendSourceCooldown({ ...source, observedAt: 30, until: 200 }),
        200,
      );
      assert.equal(await s.eventWaitStore.readSourceCooldown(source), 500);
      assert.equal(
        await s.eventWaitStore.completeSourceDispatch({
          ...source,
          token: 'foreign',
          observedAt: 40,
          until: 40,
        }),
        500,
      );
      assert.equal(
        await s.eventWaitStore.completeSourceDispatch({
          ...source,
          token: 'dispatch-1',
          observedAt: 50,
          until: 70,
        }),
        200,
      );
      assert.equal(
        await s.eventWaitStore.reserveSourceDispatch({
          ...source,
          token: 'dispatch-2',
          observedAt: 199,
          until: 600,
        }),
        false,
      );
      assert.equal(
        await s.eventWaitStore.reserveSourceDispatch({
          ...source,
          token: 'dispatch-2',
          observedAt: 200,
          until: 600,
        }),
        true,
      );
      await s.sessionStore.close?.();
      const reopened = await openInteractiveExecutionStoresForWrite(owner.lease, provider);
      try {
        assert.equal(await reopened.eventWaitStore.readSourceCooldown(source), 600);
        // Cleanup cannot discard a reservation just because its actual cooldown expired.
        await reopened.eventWaitStore.extendSourceCooldown({
          ...source,
          connectionId: 'other',
          observedAt: 250,
          until: 300,
        });
        assert.equal(await reopened.eventWaitStore.readSourceCooldown(source), 600);
        assert.equal(
          await reopened.eventWaitStore.completeSourceDispatch({
            ...source,
            token: 'dispatch-1',
            observedAt: 250,
            until: 999,
          }),
          600,
        );
        // A prepared request that was cancelled can release without adding an interval.
        assert.equal(
          await reopened.eventWaitStore.completeSourceDispatch({
            ...source,
            token: 'dispatch-2',
            observedAt: 251,
            until: 251,
          }),
          251,
        );
        for (const bad of [
          { ...reservation, token: '' },
          { ...reservation, token: 'bad\n' },
          { ...reservation, token: 'x'.repeat(129) },
          { ...reservation, observedAt: -1 },
          { ...reservation, until: 9 },
          { ...reservation, extra: true },
        ]) {
          await assert.rejects(reopened.eventWaitStore.reserveSourceDispatch(bad));
          await assert.rejects(reopened.eventWaitStore.completeSourceDispatch(bad));
        }
        await assert.rejects(
          reopened.eventWaitStore.reserveSourceDispatch({ ...reservation, until: 10 }),
        );
        await reopened.eventWaitStore.close();
        await assert.rejects(reopened.eventWaitStore.reserveSourceDispatch(reservation));
        await assert.rejects(reopened.eventWaitStore.completeSourceDispatch(reservation));
      } finally {
        await reopened.sessionStore.close?.();
      }
    });
  });
}

test('workflow-15 upgrade indexes observation order without rewriting legacy wait records', async () => {
  await withProvider(localExecutionPersistenceProvider, async (s, root, owner) => {
    const session = await s.sessionStore.create(input(root));
    const record = waiting(session.id);
    await s.eventWaitStore.commit(commit(record));
    await s.sessionStore.close?.();
    const old = new DatabaseSync(join(root, 'runtime.sqlite'));
    const before = old.prepare('SELECT record_json FROM workflow_event_waits').get();
    try {
      old.exec('DROP INDEX workflow_event_waits_observation_order');
      old
        .prepare("UPDATE operational_schema_migrations SET version = 15 WHERE scope = 'workflow'")
        .run();
    } finally {
      old.close();
    }
    const reopened = await openInteractiveExecutionStoresForWrite(owner.lease);
    try {
      assert.equal(
        (await reopened.eventWaitStore.listForObservation({ now: 10, limit: 1 }))[0]!.record.waitId,
        record.waitId,
      );
      const db = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.deepEqual(db.prepare('SELECT record_json FROM workflow_event_waits').get(), before);
        assert.ok(
          db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE name = 'workflow_event_waits_observation_order'",
            )
            .get(),
        );
        assert.equal(
          db
            .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'workflow'")
            .get()?.version,
          SQLITE_WORKFLOW_SCHEMA_VERSION,
        );
        const plan = db
          .prepare(`EXPLAIN QUERY PLAN SELECT wait_id FROM workflow_event_waits
          INDEXED BY workflow_event_waits_observation_order
          WHERE status = 'waiting'
          ORDER BY COALESCE(json_extract(record_json, '$.observation.lastAttemptAt'), 0), wait_id
          LIMIT 1`)
          .all();
        assert.ok(
          plan.some((row) => String(row.detail).includes('workflow_event_waits_observation_order')),
        );
        assert.ok(plan.every((row) => !String(row.detail).includes('TEMP B-TREE')));
      } finally {
        db.close();
      }
    } finally {
      await reopened.sessionStore.close?.();
    }
  });
});

test('workflow-14 upgrade retains source cooldown facts and adds dispatch reservations', async () => {
  await withProvider(localExecutionPersistenceProvider, async (s, root, owner) => {
    await s.sessionStore.close?.();
    const old = new DatabaseSync(join(root, 'runtime.sqlite'));
    try {
      old.exec(`DROP TABLE workflow_event_wait_source_cooldowns;
        CREATE TABLE workflow_event_wait_source_cooldowns (
          source_key TEXT PRIMARY KEY, until_ms INTEGER NOT NULL CHECK (until_ms >= 0)
        );
        CREATE INDEX workflow_event_wait_source_cooldowns_expiry
          ON workflow_event_wait_source_cooldowns(until_ms, source_key);`);
      old
        .prepare('INSERT INTO workflow_event_wait_source_cooldowns VALUES (?, ?)')
        .run('["fake",null]', 500);
      old
        .prepare("UPDATE operational_schema_migrations SET version = 14 WHERE scope = 'workflow'")
        .run();
    } finally {
      old.close();
    }
    const reopened = await openInteractiveExecutionStoresForWrite(owner.lease);
    try {
      const source = { providerId: 'fake', connectionId: null };
      assert.equal(await reopened.eventWaitStore.readSourceCooldown(source), 500);
      assert.equal(
        await reopened.eventWaitStore.reserveSourceDispatch({
          ...source,
          token: 'dispatch-1',
          observedAt: 100,
          until: 600,
        }),
        false,
      );
      assert.equal(
        await reopened.eventWaitStore.reserveSourceDispatch({
          ...source,
          token: 'dispatch-1',
          observedAt: 500,
          until: 600,
        }),
        true,
      );
      assert.equal(
        await reopened.eventWaitStore.completeSourceDispatch({
          ...source,
          token: 'dispatch-1',
          observedAt: 510,
          until: 530,
        }),
        530,
      );
    } finally {
      await reopened.sessionStore.close?.();
    }
  });
});

test('workflow-13 upgrade retains wait bytes and adds status access and source cooldowns', async () => {
  await withProvider(localExecutionPersistenceProvider, async (s, root, owner) => {
    const session = await s.sessionStore.create(input(root));
    const record = waiting(session.id);
    await s.eventWaitStore.commit(commit(record));
    await s.sessionStore.close?.();
    const old = new DatabaseSync(join(root, 'runtime.sqlite'));
    const before = old.prepare('SELECT record_json FROM workflow_event_waits').get();
    try {
      old.exec('DROP INDEX workflow_event_waits_by_status');
      old.exec('DROP TABLE workflow_event_wait_source_cooldowns');
      old
        .prepare("UPDATE operational_schema_migrations SET version = 13 WHERE scope = 'workflow'")
        .run();
    } finally {
      old.close();
    }
    const reopened = await openInteractiveExecutionStoresForWrite(owner.lease);
    try {
      assert.deepEqual(
        (await reopened.eventWaitStore.listByStatus({ status: 'waiting', limit: 1 })).items[0],
        {
          authorityRevision: 0,
          record: {
            ...record,
            condition: { ...record.condition, parameters: { flags: [true], zero: 0 } },
          },
        },
      );
      const source = { providerId: 'fake', connectionId: null };
      assert.equal(await reopened.eventWaitStore.readSourceCooldown(source), null);
      await reopened.eventWaitStore.extendSourceCooldown({ ...source, observedAt: 10, until: 500 });
      assert.equal(await reopened.eventWaitStore.readSourceCooldown(source), 500);
      const db = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.deepEqual(db.prepare('SELECT record_json FROM workflow_event_waits').get(), before);
        assert.equal(
          db
            .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'workflow'")
            .get()?.version,
          SQLITE_WORKFLOW_SCHEMA_VERSION,
        );
      } finally {
        db.close();
      }
    } finally {
      await reopened.sessionStore.close?.();
    }
  });
});
