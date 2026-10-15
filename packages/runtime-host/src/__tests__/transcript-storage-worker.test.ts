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
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { seedInvocation } from '@maka/runtime/test-only/invocation-fixture';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { TranscriptStorageWorker } from '../server/transcript-storage-worker-client.js';
import { ColdRuntimeStorage, COLD_STORAGE_AGE_MS } from '@maka/storage/cold-runtime-storage';
import { createSessionTranscriptReader } from '../server/session-transcript-reader.js';

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'maka-transcript-worker-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const workers: TranscriptStorageWorker[] = [];
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const session = await stores.sessionStore.create({
    cwd: capability.canonicalPath,
    llmConnectionSlug: 'fake',
    model: 'fake',
    permissionMode: 'ask',
  });
  await seedInvocation(stores.runtimeEventStore, {
    sessionId: session.id,
    runId: 'run',
    turnId: 'turn',
    openedAt: 1,
  });
  const request = {
    direction: 'newer' as const,
    position: 0,
    throughOrdinal: (await stores.runtimeEventStore.readTranscriptHighWater(session.id))!,
  };
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    await owner.close();
    await rm(base, { recursive: true, force: true });
  });
  return {
    databasePath: join(capability.canonicalPath, 'runtime.sqlite'),
    sessionId: session.id,
    request,
    stores,
    lease: owner.lease,
    ownWorker: (worker: TranscriptStorageWorker) => {
      workers.push(worker);
      return worker;
    },
  };
}

test('worker releases its SQLite snapshot before permission I/O and prioritizes queued foreground reads', async (t) => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let reads = 0;
  const worker = f.ownWorker(
    new TranscriptStorageWorker({
      databasePath: f.databasePath,
      permissions: async () => {
        if (++reads === 1) {
          entered();
          await gate;
        }
        return new Map();
      },
    }),
  );
  const order: string[] = [];
  const first = worker.readRun(f.sessionId, f.request).then((value) => {
    order.push('first');
    return value;
  });
  await ready;
  assert.equal(worker.isProtected(f.sessionId), true);
  const db = new DatabaseSync(f.databasePath);
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.prepare('UPDATE runtime_storage_policy SET epoch = epoch + 1').run();
    assert.equal(
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy,
      0,
      'permission I/O must not pin a WAL snapshot',
    );
  } finally {
    db.close();
  }
  const background = worker
    .codec('encode', [
      JSON.stringify({ partial: false, content: { kind: 'text', text: 'x'.repeat(8192) } }),
    ])
    .then(() => {
      order.push('codec');
    });
  const second = worker.readRun(f.sessionId, f.request).then(() => {
    order.push('second');
  });
  release();
  await Promise.all([first, second, background]);
  assert.deepEqual(order, ['first', 'second', 'codec']);
  assert.equal(worker.reading, false);
});

test('closing cancels in-flight and queued reads, removes pins and rejects subsequent work', async (t) => {
  const f = await fixture(t);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const worker = f.ownWorker(
    new TranscriptStorageWorker({
      databasePath: f.databasePath,
      permissions: async () => {
        entered();
        return new Promise(() => {});
      },
    }),
  );
  const first = worker.readRun(f.sessionId, f.request);
  const firstRejected = assert.rejects(first, /closing/);
  await ready;
  const secondRejected = assert.rejects(worker.readRun(f.sessionId, f.request), /closing/);
  await worker.close();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(worker.reading, false);
  await assert.rejects(worker.readRun(f.sessionId, f.request), /closed/);
});

test('recall scans original compressed text in the worker and keeps the candidate set unchanged', async (t) => {
  const f = await fixture(t);
  for (const [id, text] of [
    ['ascii', 'needle '.repeat(2000)],
    ['unicode', '上下文 '.repeat(2000)],
  ]) {
    await f.stores.runtimeEventStore.appendRuntimeEvent(f.sessionId, 'run', {
      id,
      sessionId: f.sessionId,
      runId: 'run',
      invocationId: 'run',
      turnId: 'turn',
      ts: 2,
      partial: false,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: text! },
    });
  }
  const worker = f.ownWorker(
    new TranscriptStorageWorker({
      databasePath: f.databasePath,
      permissions: async () => new Map(),
    }),
  );
  const terms = [['needle'], ['上下文'], ['not-in-history'], ['not-in-history', 'needle']];
  const before = await Promise.all(
    terms.map((value) => worker.readRecallCandidates([f.sessionId], value)),
  );
  const codec = f.ownWorker(
    new TranscriptStorageWorker({
      databasePath: f.databasePath,
      permissions: async () => new Map(),
    }),
  );
  const cold = await ColdRuntimeStorage.open({
    lease: f.lease,
    codec: codec.codec,
    canRun: () => !worker.reading,
    isProtected: (id) => worker.isProtected(id),
  });
  try {
    const db = new DatabaseSync(f.databasePath);
    try {
      db.prepare('UPDATE session_content_activity SET last_content_write_at = ?').run(
        Date.now() - COLD_STORAGE_AGE_MS - 1,
      );
    } finally {
      db.close();
    }
    assert.equal((await cold.compressBatch()).changed, 2);
    assert.deepEqual(
      await Promise.all(terms.map((value) => worker.readRecallCandidates([f.sessionId], value))),
      before,
    );
    assert.deepEqual(before, [[f.sessionId], [f.sessionId], [], [f.sessionId]]);
    assert.equal(worker.reading, false);
  } finally {
    cold.close();
  }
});

test('large Unicode prompt landmarks keep the existing wire bound before and after compression', async (t) => {
  const f = await fixture(t);
  await f.stores.runtimeEventStore.appendRuntimeEvent(f.sessionId, 'run', {
    id: 'large-prompt',
    invocationId: 'run',
    runId: 'run',
    turnId: 'turn',
    sessionId: f.sessionId,
    ts: 2,
    partial: false,
    author: 'user',
    role: 'user',
    content: { kind: 'text', text: '😀'.repeat(2 * 1024 * 1024) },
  });
  const worker = f.ownWorker(
    new TranscriptStorageWorker({
      databasePath: f.databasePath,
      permissions: async () => new Map(),
    }),
  );
  const request = {
    throughOrdinal: (await f.stores.runtimeEventStore.readTranscriptHighWater(f.sessionId))!,
    maxLandmarks: 3,
    turnId: null,
  };
  const baseline = await worker.readLandmarks(f.sessionId, request);
  assert.equal(baseline.length, 1);
  assert.equal(Buffer.byteLength(baseline[0]!.label), 96);
  const cold = await ColdRuntimeStorage.open({
    lease: f.lease,
    codec: worker.codec,
    canRun: () => !worker.reading,
    isProtected: (id) => worker.isProtected(id),
  });
  try {
    const db = new DatabaseSync(f.databasePath);
    try {
      db.prepare('UPDATE session_content_activity SET last_content_write_at = ?').run(
        Date.now() - COLD_STORAGE_AGE_MS - 1,
      );
    } finally {
      db.close();
    }
    await cold.setEnabled(true);
    let changed = 0;
    for (;;) {
      const result = await cold.compressBatch();
      changed += result.changed;
      if (!result.hasMore) break;
    }
    assert.equal(changed, 1);
    assert.deepEqual(await worker.readLandmarks(f.sessionId, request), baseline);
  } finally {
    cold.close();
  }
});

test('the complete frontend read stays protected while Host-side ledger preparation waits', async (t) => {
  const f = await fixture(t);
  const worker = f.ownWorker(
    new TranscriptStorageWorker({
      databasePath: f.databasePath,
      permissions: async () => new Map(),
    }),
  );
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader = createSessionTranscriptReader({
    stores: f.stores,
    storageWorker: worker,
    canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
    ensureTranscriptLedger: async () => {
      entered!();
      await gate;
    },
  });
  const reading = reader.readDurableHighWater(f.sessionId);
  await ready;
  assert.equal(worker.isProtected(f.sessionId), true);
  release!();
  assert.notEqual(await reading, null);
  assert.equal(worker.isProtected(f.sessionId), false);
});
