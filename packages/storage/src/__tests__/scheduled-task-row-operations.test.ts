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
import { after, test, type TestContext } from 'node:test';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from '../operational-state-store.js';
import {
  openInteractiveScheduledTaskStoreForWrite,
  ScheduledTaskStoreError,
  type InteractiveScheduledTaskStoreWriter,
} from '../scheduled-task-store.js';
import {
  resolveStorageRoot,
  runWithStorageRootLease,
  tryAcquireInteractiveRootOwner,
} from '../root-authority.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

after(removeTrackedControlDirectories);

const NOW = 1_000_000;
const EXECUTION = {
  sessionId: 'session-target',
  turnId: 'turn-target',
  runId: 'run-target',
  userMessageId: 'message-target',
};

test('ScheduledTask point operations do not materialize or rewrite unrelated rows', async (t) => {
  for (const unrelatedCount of [0, 32, 256]) {
    await t.test(`${unrelatedCount} unrelated tasks and pending fires`, async (t) => {
      await withStore(t, async ({ store, probe }) => {
        // Setup goes through the actual owner and public store, outside measurement.
        // Each unrelated task has a pending claim, so scanning either table fails.
        for (let index = 0; index < unrelatedCount; index += 1) {
          const other = await store.create(notifyInput(`Unrelated ${index}`), NOW);
          await store.claimNow(other.id, NOW);
        }
        const target = await store.create(agentInput(), NOW);
        const unchanged = probe.snapshotExcluding(target.id);

        const read = await probe.measure(() => store.get(target.id));
        assert.equal(read.value?.id, target.id);
        assertPointCost(read.cost, { rows: 1, payloadRows: 1, changes: 0 });
        assert.ok(
          read.cost.reads.every((read) => !read.sql.includes('workflow_scheduled_task_fires')),
        );

        const snoozed = await probe.measure(() => store.snooze(target.id, 1_000, NOW));
        assert.equal(snoozed.value.nextFireAt, target.nextFireAt! + 1_000);
        assertPointCost(snoozed.cost, { rows: 2, payloadRows: 1, changes: 1 });

        const paused = await probe.measure(() => store.pause(target.id, NOW + 1));
        assert.equal(paused.value.status, 'paused');
        assertPointCost(paused.cost, { rows: 2, payloadRows: 1, changes: 1 });
        await store.resume(target.id, NOW + 2);

        const claimed = await probe.measure(() => store.claimNow(target.id, NOW + 3));
        assert.equal(claimed.value.taskId, target.id);
        assertPointCost(claimed.cost, { rows: 2, payloadRows: 1, changes: 1 });

        const bound = await probe.measure(() =>
          store.bindFireExecution(claimed.value.id, EXECUTION),
        );
        assert.deepEqual(bound.value.execution, EXECUTION);
        assertPointCost(bound.cost, { rows: 1, payloadRows: 1, changes: 1 });

        const settled = await probe.measure(() =>
          store.settleFire(claimed.value.id, {
            id: 'run-receipt-target',
            at: NOW + 4,
            outcome: 'ok',
            message: 'done',
            sessionId: EXECUTION.sessionId,
            runId: EXECUTION.runId,
          }),
        );
        assert.equal(settled.value.fireCount, 1);
        assertPointCost(settled.cost, { rows: 2, payloadRows: 2, changes: 2 });
        assert.deepEqual(probe.snapshotExcluding(target.id), unchanged);
      });
    });
  }
});

test('ScheduledTask polls without new due or expired tasks perform no DML', async (t) => {
  await withStore(t, async ({ store, probe }) => {
    for (let index = 0; index < 32; index += 1) {
      await store.create(notifyInput(`Future ${index}`), NOW);
    }
    const due = await store.create(
      { ...notifyInput('Already claimed'), schedule: { kind: 'once', runAt: NOW + 1 } },
      NOW,
    );
    await store.claimNow(due.id, NOW);
    const before = probe.snapshotExcluding();

    for (let index = 0; index < 3; index += 1) {
      const poll = await probe.measure(() => store.claimNextDue(NOW + 2));
      assert.deepEqual(poll.value, { claim: null, expired: [] });
      assert.equal(poll.cost.writes.length, 0, 'an unchanged poll must issue no DML');
      assert.equal(poll.cost.totalChanges, 0);
    }
    assert.deepEqual(probe.snapshotExcluding(), before);
  });
});

test('ScheduledTask expiry updates only newly expired tasks, including a pending task', async (t) => {
  await withStore(t, async ({ store, probe }) => {
    const expiringInput = {
      ...notifyInput('Expired with pending fire'),
      schedule: { kind: 'interval', everySeconds: 60, startAt: NOW + 1_000 },
      expiresAt: NOW + 2_000,
    };
    const pending = await store.create(expiringInput, NOW);
    const pendingClaim = await store.claimNow(pending.id, NOW);
    const otherExpired = await store.create({ ...expiringInput, title: 'Other expired task' }, NOW);
    const due = await store.create(
      { ...notifyInput('Due'), schedule: { kind: 'once', runAt: NOW + 1_500 } },
      NOW,
    );
    for (let index = 0; index < 32; index += 1) {
      await store.create(notifyInput(`Unchanged ${index}`), NOW);
    }

    const first = await probe.measure(() => store.claimNextDue(NOW + 2_000));
    assert.deepEqual(
      first.value.expired.map((task) => task.id).sort(),
      [pending.id, otherExpired.id].sort(),
    );
    assert.equal(first.value.claim?.taskId, due.id);
    assert.equal(first.cost.totalChanges, 3, 'two task updates and one new claim');
    assert.equal(
      first.cost.writes.reduce((count, write) => count + write.changes, 0),
      3,
    );
    assert.ok((await store.listPendingFires()).some((claim) => claim.id === pendingClaim.id));

    const second = await probe.measure(() => store.claimNextDue(NOW + 2_000));
    assert.deepEqual(second.value, { claim: null, expired: [] });
    assert.equal(second.cost.writes.length, 0);
    assert.equal(second.cost.totalChanges, 0);

    // Even though pause(expired) otherwise does nothing, a pending fire still
    // takes precedence and must reject the mutation.
    const rejectedPause = await probe.measure(() =>
      assert.rejects(() => store.pause(pending.id, NOW + 3_000), isOperationConflict),
    );
    assertNoDml(rejectedPause.cost);
  });
});

test('ScheduledTask native delivery allows waiting cancellation but cannot undo admission', async (t) => {
  await withStore(t, async ({ store, probe }) => {
    const task = await store.create(notifyInput('Native notification'), NOW);
    const waiting = await store.claimNow(task.id, NOW);
    await store.setFireNativeState(waiting.id, 'waiting_for_provider');
    const cancelled = await probe.measure(() => store.cancelWaitingNativeFire(task.id));
    assert.equal(cancelled.value, true);
    assert.equal(cancelled.cost.totalChanges, 1);
    assert.deepEqual(await store.listPendingFires(), []);
    assert.equal((await store.get(task.id))?.fireCount, 0);

    const invoking = await store.claimNow(task.id, NOW + 1);
    await store.setFireNativeState(invoking.id, 'waiting_for_provider');
    await store.setFireNativeState(invoking.id, 'invoking');
    const admitted = probe.snapshotExcluding();
    const rejections = await probe.measure(async () => {
      await assert.rejects(() => store.cancelWaitingNativeFire(task.id), isOperationConflict);
      await assert.rejects(
        () => store.setFireNativeState(invoking.id, 'waiting_for_provider'),
        isOperationConflict,
      );
      await store.setFireNativeState(invoking.id, 'invoking');
    });
    assertNoDml(rejections.cost);
    assert.deepEqual(probe.snapshotExcluding(), admitted);

    // The same writer queue must remain usable after both rejected operations.
    const settled = await store.settleFire(invoking.id, {
      at: NOW + 2,
      outcome: 'failed',
      message: 'Delivery outcome was not observed.',
    });
    assert.equal(settled.fireCount, 1);
    assert.deepEqual(await store.listPendingFires(), []);
  });
});

test('ScheduledTask execution binding is idempotent and does not retain caller-owned objects', async (t) => {
  await withStore(t, async ({ store, probe }) => {
    const task = await store.create(agentInput(), NOW);
    const claim = await store.claimNow(task.id, NOW);
    const input = { ...EXECUTION };
    const bound = await store.bindFireExecution(claim.id, input);
    const persisted = probe.snapshotExcluding();
    input.runId = 'mutated-input-run';
    assert.ok(bound.execution);
    bound.execution.userMessageId = 'mutated-return-message';
    bound.task.title = 'Mutated returned task';
    assert.deepEqual(probe.snapshotExcluding(), persisted);

    const repeated = await probe.measure(() => store.bindFireExecution(claim.id, EXECUTION));
    assert.deepEqual(repeated.value.execution, EXECUTION);
    assert.equal(repeated.value.task.title, task.title);
    assertNoDml(repeated.cost);
    const conflict = await probe.measure(() =>
      assert.rejects(
        () => store.bindFireExecution(claim.id, { ...EXECUTION, runId: 'another-run' }),
        isOperationConflict,
      ),
    );
    assertNoDml(conflict.cost);
    assert.deepEqual(probe.snapshotExcluding(), persisted);
  });
});

test('ScheduledTask metadata updates keep schedule and expired-trigger semantics', async (t) => {
  await withStore(t, async ({ store, probe }) => {
    const task = await store.create(notifyInput('Original title'), NOW);
    assert.equal(task.nextFireAt, NOW + 60_000);
    const updated = await store.update(task.id, { title: 'New title' }, NOW + 61_000);
    assert.equal(updated.title, 'New title');
    assert.equal(updated.nextFireAt, NOW + 120_000);

    const paused = await store.pause(task.id, NOW + 61_001);
    const repeatedPause = await probe.measure(() => store.pause(task.id, NOW + 61_002));
    assert.deepEqual(repeatedPause.value, paused);
    assertNoDml(repeatedPause.cost);

    const expiring = await store.create(
      {
        ...notifyInput('Expired trigger'),
        schedule: { kind: 'interval', everySeconds: 60, startAt: NOW + 1_000 },
        expiresAt: NOW + 2_000,
      },
      NOW,
    );
    const before = probe.snapshotExcluding();
    const rejected = await probe.measure(() =>
      assert.rejects(() => store.claimNow(expiring.id, NOW + 2_000), isOperationConflict),
    );
    assertNoDml(rejected.cost);
    assert.deepEqual(probe.snapshotExcluding(), before);
    assert.equal((await store.get(expiring.id))?.status, 'active');
  });
});

test('ScheduledTask due discovery rejects a damaged task identity before changing another task', async (t) => {
  await withStore(t, async ({ store, probe }) => {
    const expiring = await store.create(
      {
        ...notifyInput('Expiring task'),
        schedule: { kind: 'interval', everySeconds: 60, startAt: NOW + 1_000 },
        expiresAt: NOW + 2_000,
      },
      NOW,
    );
    const future = await store.create(notifyInput('Unrelated future task'), NOW);
    // Both records came from the public API. This single-field corruption is a
    // fault injection: the expiry write must not follow a damaged JSON identity.
    probe.damageTaskIdentity(expiring.id, future.id);
    const damaged = probe.snapshotExcluding();
    const rejected = await probe.measure(() =>
      assert.rejects(() => store.claimNextDue(NOW + 2_000), /Invalid scheduled task identity/),
    );
    assertNoDml(rejected.cost);
    assert.deepEqual(probe.snapshotExcluding(), damaged);
    assert.equal((await store.get(future.id))?.status, 'active');
  });
});

test('ScheduledTask settlement rolls back both rows and the queue accepts a retry', async (t) => {
  await withStore(t, async ({ store, probe }) => {
    const task = await store.create(agentInput(), NOW);
    const claim = await store.claimNow(task.id, NOW);
    await store.bindFireExecution(claim.id, EXECUTION);
    const before = probe.snapshotExcluding();
    const run = {
      id: 'rollback-receipt',
      at: NOW + 1,
      outcome: 'ok' as const,
      message: 'durable settlement',
    };

    // Execute the task mutation normally, then fail before deleting the claim.
    // This exercises SQLite rollback, not an early rejection in the store facade.
    probe.failNextClaimDelete();
    await assert.rejects(() => store.settleFire(claim.id, run), /injected claim-delete failure/);
    assert.equal(probe.failedAfterTaskWrite, true);
    assert.deepEqual(probe.snapshotExcluding(), before);

    const retried = await store.settleFire(claim.id, run);
    assert.equal(retried.fireCount, 1);
    assert.equal(retried.runs.filter((item) => item.id === run.id).length, 1);
    assert.equal((await store.listPendingFires()).length, 0);
  });
});

test('ScheduledTask execution identity survives closing and reacquiring the root owner', async (t) => {
  await withStore(t, async (fixture) => {
    const task = await fixture.store.create(agentInput(), NOW);
    const claim = await fixture.store.claimNow(task.id, NOW);
    await fixture.store.bindFireExecution(claim.id, EXECUTION);
    const oldWriter = fixture.store;

    await fixture.reopen();
    await assert.rejects(() => oldWriter.get(task.id), /writer is closed/);
    assert.notEqual(fixture.store, oldWriter);
    assert.deepEqual((await fixture.store.listPendingFires())[0]?.execution, EXECUTION);
    assert.equal((await fixture.store.listPendingFires())[0]?.id, claim.id);
    await fixture.store.settleFire(claim.id, {
      at: NOW + 1,
      outcome: 'ok',
      message: 'after reopening',
      sessionId: EXECUTION.sessionId,
      runId: EXECUTION.runId,
    });

    await fixture.reopen();
    assert.deepEqual(await fixture.store.listPendingFires(), []);
    const settled = await fixture.store.get(task.id);
    assert.equal(settled?.fireCount, 1);
    assert.equal(settled?.runs[0]?.runId, EXECUTION.runId);
  });
});

function notifyInput(title: string) {
  return {
    title,
    intentBody: '',
    schedule: { kind: 'interval', everySeconds: 60, startAt: NOW + 60_000 },
    effect: { kind: 'notify', channel: 'local' },
    createdBy: { kind: 'user' },
  };
}

function agentInput() {
  return {
    ...notifyInput('Target task'),
    intentBody: 'Perform the scheduled work.',
    effect: {
      kind: 'agent_run',
      execution: {
        cwd: '/workspace',
        llmConnectionId: 'connection-default',
        llmConnectionSlug: 'default',
        model: 'test-model',
        permissionMode: 'ask',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
      },
    },
  };
}

interface QueryRead {
  sql: string;
  parameters: SQLInputValue[];
  rows: number;
  payloadRows: number;
  payloadBytes: number;
  plan: string[];
}

interface OperationCost {
  reads: QueryRead[];
  writes: Array<{ sql: string; changes: number }>;
  totalChanges: number;
}

function isOperationConflict(error: unknown): boolean {
  return error instanceof ScheduledTaskStoreError && error.code === 'operation_conflict';
}

function assertNoDml(cost: OperationCost): void {
  assert.equal(cost.writes.length, 0);
  assert.equal(cost.totalChanges, 0);
}

function assertPointCost(
  cost: OperationCost,
  expected: { rows: number; payloadRows: number; changes: number },
): void {
  const returnedRows = cost.reads.reduce((count, read) => count + read.rows, 0);
  const payloadRows = cost.reads.reduce((count, read) => count + read.payloadRows, 0);
  const payloadBytes = cost.reads.reduce((count, read) => count + read.payloadBytes, 0);
  assert.ok(returnedRows <= expected.rows, JSON.stringify({ returnedRows, cost }));
  assert.ok(payloadRows <= expected.payloadRows, JSON.stringify({ payloadRows, cost }));
  assert.ok(payloadBytes < 8 * 1024, JSON.stringify({ payloadBytes, cost }));
  assert.equal(cost.totalChanges, expected.changes, JSON.stringify(cost));
  assert.equal(
    cost.writes.reduce((count, write) => count + write.changes, 0),
    expected.changes,
    JSON.stringify(cost),
  );
  assert.ok(cost.reads.length > 0, 'the probe must observe the actual point read');
  for (const read of cost.reads) {
    assert.ok(
      read.plan.some((line) => /SEARCH .*USING .*INDEX/u.test(line)),
      JSON.stringify(read),
    );
    assert.ok(
      read.plan.every((line) => !/\bSCAN\b/u.test(line)),
      JSON.stringify(read),
    );
  }
}

class SqlProbe {
  readonly #prepare: DatabaseSync['prepare'];
  #cost: OperationCost | undefined;
  #failDelete = false;
  #taskWritten = false;
  failedAfterTaskWrite = false;

  constructor(t: TestContext, database: DatabaseSync) {
    this.#prepare = database.prepare.bind(database);
    t.mock.method(database, 'prepare', (sql: string) => {
      const statement = this.#prepare(sql);
      const relevant = /\bworkflow_scheduled_task(?:s|_fires)\b/u.test(sql);
      if (!relevant) return statement;
      return new Proxy(statement, {
        get: (target, key) => {
          const value: unknown = Reflect.get(target, key, target);
          if (typeof value !== 'function') return value;
          if (!['all', 'get', 'iterate', 'run'].includes(String(key))) return value.bind(target);
          return (...parameters: SQLInputValue[]) => {
            const isWrite = /^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql);
            if (
              this.#failDelete &&
              /^\s*DELETE\s+FROM\s+workflow_scheduled_task_fires\b/iu.test(sql)
            ) {
              this.#failDelete = false;
              this.failedAfterTaskWrite = this.#taskWritten;
              throw new Error('injected claim-delete failure');
            }
            const result: unknown = Reflect.apply(value, target, parameters);
            if (isWrite && key === 'run') {
              const changes = Number((result as { changes: number | bigint }).changes);
              if (/\bworkflow_scheduled_tasks\b/u.test(sql) && changes > 0) {
                this.#taskWritten = true;
              }
              this.#cost?.writes.push({ sql, changes });
            } else if (this.#cost && /^\s*SELECT\b/iu.test(sql)) {
              const read: QueryRead = {
                sql,
                parameters,
                rows: 0,
                payloadRows: 0,
                payloadBytes: 0,
                plan: [],
              };
              this.#cost.reads.push(read);
              const record = (row: unknown) => {
                if (row === undefined) return;
                read.rows += 1;
                const json = (row as { record_json?: unknown }).record_json;
                if (typeof json === 'string') {
                  read.payloadRows += 1;
                  read.payloadBytes += Buffer.byteLength(json, 'utf8');
                }
              };
              if (key === 'iterate') {
                return (function* () {
                  for (const row of result as Iterable<unknown>) {
                    record(row);
                    yield row;
                  }
                })();
              }
              if (key === 'all') {
                for (const row of result as unknown[]) record(row);
              } else if (key === 'get') record(result);
            }
            return result;
          };
        },
      });
    });
  }

  async measure<T>(operation: () => Promise<T>): Promise<{ value: T; cost: OperationCost }> {
    const before = this.#totalChanges();
    const cost: OperationCost = { reads: [], writes: [], totalChanges: 0 };
    this.#cost = cost;
    try {
      const value = await operation();
      cost.totalChanges = this.#totalChanges() - before;
      for (const read of cost.reads) {
        read.plan = this.#prepare(`EXPLAIN QUERY PLAN ${read.sql}`)
          .all(...read.parameters)
          .map((row) => String(row.detail));
      }
      return { value, cost };
    } finally {
      this.#cost = undefined;
    }
  }

  failNextClaimDelete(): void {
    this.#taskWritten = false;
    this.#failDelete = true;
    this.failedAfterTaskWrite = false;
  }

  damageTaskIdentity(taskId: string, replacementId: string): void {
    const result = this.#prepare(
      "UPDATE workflow_scheduled_tasks SET record_json = json_set(record_json, '$.id', ?) WHERE task_id = ?",
    ).run(replacementId, taskId);
    assert.equal(result.changes, 1);
  }

  snapshotExcluding(taskId = ''): unknown {
    return {
      tasks: this.#prepare(
        'SELECT * FROM workflow_scheduled_tasks WHERE task_id <> ? ORDER BY task_id',
      ).all(taskId),
      claims: this.#prepare(
        'SELECT * FROM workflow_scheduled_task_fires WHERE task_id <> ? ORDER BY claim_id',
      ).all(taskId),
    };
  }

  #totalChanges(): number {
    return Number(this.#prepare('SELECT total_changes() AS count').get()?.count);
  }
}

interface Fixture {
  store: InteractiveScheduledTaskStoreWriter;
  probe: SqlProbe;
  reopen(): Promise<void>;
}

async function withStore(t: TestContext, run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-scheduled-task-rows-'));
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  let owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  let lease: OperationalStateDatabaseLease = await runWithStorageRootLease(
    owner.lease,
    'interactive',
    'write',
    async (canonicalRoot) => acquireOperationalStateDatabase(canonicalRoot),
  );
  const probe = new SqlProbe(t, lease.database);
  let store = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
  const fixture: Fixture = {
    store,
    probe,
    async reopen() {
      store.close();
      lease.close();
      await owner!.close();
      owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      lease = await runWithStorageRootLease(
        owner.lease,
        'interactive',
        'write',
        async (canonicalRoot) => acquireOperationalStateDatabase(canonicalRoot),
      );
      fixture.probe = new SqlProbe(t, lease.database);
      store = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
      fixture.store = store;
    },
  };
  try {
    await run(fixture);
  } finally {
    store.close();
    lease.close();
    await owner?.close();
    await rm(root, { recursive: true, force: true });
  }
}
