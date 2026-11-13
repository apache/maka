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
import { after, test } from 'node:test';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import { openRuntimePageReclamation } from '../runtime-page-reclamation.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

after(removeTrackedControlDirectories);

async function withRuntimeDatabase(
  existingNone: boolean,
  run: (input: {
    root: string;
    database: DatabaseSync;
    reclaim: ReturnType<typeof openRuntimePageReclamation>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-reclamation-'));
  if (existingNone) {
    acquireOperationalStateDatabase(root).close();
    const existing = new DatabaseSync(join(root, 'runtime.sqlite'));
    try {
      existing.exec('PRAGMA auto_vacuum = NONE; VACUUM');
    } finally {
      existing.close();
    }
  }
  try {
    const capability = trackControlDirectory(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    try {
      const lease = acquireOperationalStateDatabase(root);
      try {
        await run({
          root,
          database: lease.database,
          reclaim: openRuntimePageReclamation(owner.lease),
        });
      } finally {
        lease.close();
      }
    } finally {
      await owner.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function pragma(database: DatabaseSync, name: 'auto_vacuum' | 'freelist_count'): number {
  return (database.prepare(`PRAGMA ${name}`).get() as Record<typeof name, number>)[name];
}

function createFreePages(database: DatabaseSync): number {
  database.exec('CREATE TABLE reclaim_fixture (payload BLOB NOT NULL)');
  const insert = database.prepare('INSERT INTO reclaim_fixture VALUES (?)');
  database.exec('BEGIN');
  try {
    for (let index = 0; index < 120; index += 1) insert.run(Buffer.alloc(8192, index));
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  database.exec('DELETE FROM reclaim_fixture');
  return pragma(database, 'freelist_count');
}

test('runtime reclamation frees at most the page budget per tick and drains incremental databases', async () => {
  await withRuntimeDatabase(false, async ({ database, reclaim }) => {
    assert.equal(pragma(database, 'auto_vacuum'), 2);
    const initial = createFreePages(database);
    assert.ok(initial > 64);

    const first = await reclaim.reclaimFreePages({ maxPages: 64 });
    assert.ok(first.reclaimedPages > 0 && first.reclaimedPages <= 64);
    assert.equal(first.hasMore, true);
    assert.equal(pragma(database, 'freelist_count'), initial - first.reclaimedPages);

    let remaining = pragma(database, 'freelist_count');
    for (let tick = 0; tick < 100 && remaining > 0; tick += 1) {
      const result = await reclaim.reclaimFreePages({ maxPages: 64 });
      assert.ok(result.reclaimedPages > 0 && result.reclaimedPages <= 64);
      remaining = pragma(database, 'freelist_count');
      assert.equal(result.hasMore, remaining > 0);
    }
    assert.equal(remaining, 0);
    assert.deepEqual(await reclaim.reclaimFreePages({ maxPages: 64 }), {
      reclaimedPages: 0,
      hasMore: false,
    });
  });
});

test('runtime reclamation retries a checkpoint after a pinned reader releases its snapshot', async () => {
  await withRuntimeDatabase(false, async ({ root, database, reclaim }) => {
    database.exec('CREATE TABLE reclaim_fixture (payload BLOB NOT NULL)');
    const insert = database.prepare('INSERT INTO reclaim_fixture VALUES (?)');
    database.exec('BEGIN');
    try {
      for (let index = 0; index < 120; index += 1) insert.run(Buffer.alloc(8192, index));
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');

    const path = join(root, 'runtime.sqlite');
    const reader = new DatabaseSync(path);
    try {
      reader.exec('BEGIN');
      assert.equal(
        (reader.prepare('SELECT COUNT(*) AS count FROM reclaim_fixture').get() as { count: number })
          .count,
        120,
      );
      database.exec('DELETE FROM reclaim_fixture');
      assert.ok(pragma(database, 'freelist_count') > 64);

      for (let tick = 0; tick < 100 && pragma(database, 'freelist_count') > 0; tick += 1) {
        await reclaim.reclaimFreePages({ maxPages: 64 });
      }
      assert.equal(pragma(database, 'freelist_count'), 0);
      const pinnedSize = (await stat(path)).size;
      reader.exec('COMMIT');

      assert.deepEqual(await reclaim.reclaimFreePages({ maxPages: 64 }), {
        reclaimedPages: 0,
        hasMore: false,
      });
      assert.ok((await stat(path)).size < pinnedSize, 'the next idle tick checkpoints the shrink');
    } finally {
      reader.close();
    }
  });
});

test('runtime reclamation leaves an existing NONE database and its freelist untouched', async () => {
  await withRuntimeDatabase(true, async ({ database, reclaim }) => {
    assert.equal(pragma(database, 'auto_vacuum'), 0);
    const before = createFreePages(database);
    assert.ok(before > 0);
    assert.deepEqual(await reclaim.reclaimFreePages({ maxPages: 64 }), {
      reclaimedPages: 0,
      hasMore: false,
    });
    assert.equal(pragma(database, 'auto_vacuum'), 0);
    assert.equal(pragma(database, 'freelist_count'), before);
  });
});

test('runtime reclamation rejects unbounded page counts', async () => {
  await withRuntimeDatabase(false, async ({ reclaim }) => {
    assert.throws(() => reclaim.reclaimFreePages({ maxPages: 0 }), /positive safe integer/);
    assert.throws(
      () => reclaim.reclaimFreePages({ maxPages: Number.MAX_SAFE_INTEGER + 1 }),
      /positive safe integer/,
    );
  });
});
