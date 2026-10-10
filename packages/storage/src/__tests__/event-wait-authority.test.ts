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
  openInteractiveEventWaitAuthorityForWrite,
  type EventWaitAuthorityRepository,
  type InteractiveEventWaitAuthorityWriter,
} from '../event-wait-authority.js';
import { createSqliteEventWaitAuthority } from '../sqlite-event-wait-authority.js';
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
  for (const method of ['read', 'listSession', 'listPending', 'commit'] as const) {
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
          13,
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
        .prepare("UPDATE operational_schema_migrations SET version = 14 WHERE scope = 'workflow'")
        .run();
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
        14,
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
      () => s.eventWaitStore.commit(commit(r)),
    ])
      await assert.rejects(operation());
  });
});
