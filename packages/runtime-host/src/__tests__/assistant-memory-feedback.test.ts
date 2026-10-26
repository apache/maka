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

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MemoryController } from '../assistant/memory-network/controller.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE memory_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const workers = new Map(
    ['a', 'b'].map((id) => [
      id,
      {
        ownerSessionId: 'owner',
        sessionId: 'worker',
        groupIndexIds: ['a', 'b'],
        maintenanceEnabled: true,
      } as any,
    ]),
  );
  const store: any = {
    db,
    worker: (id: string) => workers.get(id),
    saveWorker: (id: string, w: any) => workers.set(id, w),
    index: (id: string) => ({ id, name: id }),
    boundary: () => 'covered',
    work: () => ({ id: 'range', completed: true }),
    lease: () => true,
    list: () => [],
  };
  const seen: any[] = [];
  let available = false;
  const ctx: any = {
    bot: {
      post: (owner: string, input: any) => {
        if (!available) return false;
        seen.push({ owner, input });
        return true;
      },
    },
    agents: { withInvocation: (_: any, fn: any) => fn() },
  };
  const controller: any = new MemoryController(ctx, store);
  return {
    db,
    workers,
    store,
    ctx,
    controller,
    seen,
    enable: () => {
      available = true;
    },
  };
}

test('index feedback survives controller restart and retries with one immutable inbox ID', async () => {
  const f = setup();
  try {
    f.controller.reportRun(['a', 'b'], 'run-1');
    assert.equal(f.seen.length, 0);
    assert.equal(
      f.db.prepare('SELECT count(*) n FROM memory_notifications WHERE delivered=0').get()!.n,
      1,
    );
    f.enable();
    const next: any = new MemoryController(f.ctx, f.store);
    await next.tick();
    await next.tick();
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0].owner, 'owner');
    assert.equal(f.seen[0].input.content.indexes.length, 2);
    assert.equal(f.seen[0].input.content.indexes[0].coveredCursor, 'covered');
    f.workers.get('a')!.lastError = 'source unavailable';
    next.reportRun(['a'], 'run-2');
    assert.equal(f.seen[1].input.content.indexes[0].status, 'failed');
    f.workers.get('a')!.lastError = null;
    f.workers.get('a')!.continuationStopped = true;
    next.reportRun(['a'], 'manual-success');
    assert.equal(f.seen[2].input.content.indexes[0].status, 'completed');
    next.reportRun(['a'], 'user-stop', true);
    assert.equal(f.seen[3].input.content.indexes[0].status, 'stopped');
  } finally {
    f.db.close();
  }
});

test('stopping a shared index job cancels once, waits, and disables all members', async () => {
  const f = setup();
  try {
    let cancellations = 0;
    f.controller.runGroup = async (_: any, signal: AbortSignal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            cancellations++;
            resolve();
          },
          { once: true },
        ),
      );
    };
    assert.equal(f.controller.launch('a').status, 'started');
    assert.equal(f.controller.launch('b').status, 'reused');
    await Promise.resolve();
    await f.controller.control('b', 'stop');
    assert.equal(cancellations, 1);
    assert.ok(
      [...f.workers.keys()].every(
        (id) => f.controller.nextCheck(id) === null && f.workers.get(id)!.lastError === null,
      ),
    );
    assert.equal(f.controller.runs.size, 0);
    assert.ok(
      [...f.workers.values()].every((w) => w.maintenanceEnabled === false && w.continuationStopped),
    );
  } finally {
    f.db.close();
  }
});

test('stop from a paused member finds the running scheduled sibling', async () => {
  const f = setup();
  try {
    let cancelled = false;
    f.controller.enabled = (id: string) => id === 'b';
    f.controller.runGroup = async (_: string[], signal: AbortSignal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true;
            resolve();
          },
          { once: true },
        ),
      );
    };
    f.controller.launch('b', true);
    await Promise.resolve();
    await f.controller.control('a', 'stop');
    assert.equal(cancelled, true);
    assert.equal(f.controller.runs.size, 0);
  } finally {
    f.db.close();
  }
});

test('worker creation failure ends only its owner batch and reports failure without delaying other owners', async () => {
  const f = setup();
  try {
    f.enable();
    for (const [id, worker] of f.workers) {
      worker.protocol = 'cursor-v1';
      worker.ownerSessionId = id;
    }
    let schedule: any = { intervalMs: 43200000, nextCheckAt: 0 };
    f.controller.schedule = () => structuredClone(schedule);
    f.controller.saveSchedule = (value: any) => {
      schedule = value;
    };
    f.store.list = () => [{ id: 'a' }, { id: 'b' }];
    f.db.exec('CREATE TABLE memory_worker_sessions(id TEXT PRIMARY KEY)');
    let creates = 0;
    f.ctx.agents.create = async () => {
      if (++creates === 1) throw Error('Worker unavailable');
      return { sessionId: 'healthy-worker' };
    };
    const batches: string[][] = [];
    f.controller.runGroup = async (ids: string[]) => {
      batches.push(ids);
    };
    await f.controller.tick();
    assert.deepEqual(schedule.remainingIds, ['b']);
    assert.equal(schedule.retryAt, null);
    assert.equal(f.seen[0].input.content.indexes[0].status, 'failed');
    assert.match(f.seen[0].input.content.indexes[0].error, /Worker unavailable/);
    await f.controller.tick();
    await Promise.all([...f.controller.runs.values()]);
    assert.deepEqual(batches, [['b']]);
    assert.deepEqual(schedule.remainingIds, []);
    assert.equal(f.seen[1].input.content.indexes[0].status, 'completed');
    await f.controller.tick();
    assert.equal(creates, 2, 'wait for the next scheduled round');
  } finally {
    f.db.close();
  }
});

test('pet activity reads only owner-scoped worker metadata, without scanning or computing coverage', () => {
  const f = setup();
  try {
    f.store.list = () => [{ id: 'a' }, { id: 'b' }];
    f.workers.get('b')!.ownerSessionId = 'someone-else';
    f.workers.get('a')!.lastAttempt = 123;
    f.controller.runs.set('a', Promise.resolve());
    f.store.boundary = () => {
      throw Error('must not read coverage');
    };
    f.store.work = () => {
      throw Error('must not read content');
    };
    assert.deepEqual(f.controller.activity('owner'), [
      { id: 'a', running: true, attempt: 123, error: null },
    ]);
  } finally {
    f.db.close();
  }
});
