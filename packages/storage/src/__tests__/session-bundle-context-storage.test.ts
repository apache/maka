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
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { resolveStorageRoot } from '../root-authority.js';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import { exportSessionBundleState, importSessionBundleState } from '../session-bundle-policy.js';
import { createSessionStore } from '../session-store.js';
import {
  CONTEXT_OFFLOAD_DATABASE_NAME,
  CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME,
  SqliteContextOffloadStore,
} from '../sqlite-context-offload-store.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

after(removeTrackedControlDirectories);

const BYTES = Buffer.alloc(64 * 1024, 0x5a);
const LIMITS = {
  ownerMaxBytes: { read_image_snapshot: BYTES.length, tool_result_archive: 0 },
  sessionLogicalBytes: BYTES.length,
  workspacePhysicalBytes: BYTES.length,
};

async function seedImage(root: string, kind: 'inline' | 'managed_file', refId: string) {
  trackControlDirectory(await resolveStorageRoot({ path: root, kind: 'interactive' }));
  const sessions = createSessionStore(root);
  const store = new SqliteContextOffloadStore(join(root, CONTEXT_OFFLOAD_DATABASE_NAME), {
    limits: LIMITS,
    idFactory: () => refId,
    now: () => 1_000,
  });
  try {
    const session = await sessions.create({
      cwd: root,
      llmConnectionSlug: 'fake',
      model: 'fake',
      permissionMode: 'ask',
    });
    const put = await store.put({
      sessionId: session.id,
      owner: { kind: 'read_image_snapshot', ownerId: 'image' },
      bytes: BYTES,
      mediaType: 'image/png',
    });
    assert.equal(put.ok, true);
    if (!put.ok) throw new Error('Unable to seed image');
    const blobId = put.record.blobId;
    const valuePath = join(
      root,
      CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME,
      'sha256',
      blobId.slice(0, 2),
      blobId,
    );
    if (kind === 'inline') {
      // The v2 -> v3 migration retains historical images as inline blobs.
      const database = new DatabaseSync(join(root, CONTEXT_OFFLOAD_DATABASE_NAME));
      try {
        database
          .prepare(
            "UPDATE context_blobs SET storage_kind = 'inline', payload = ? WHERE blob_id = ?",
          )
          .run(BYTES, Buffer.from(blobId, 'hex'));
      } finally {
        database.close();
      }
      await rm(valuePath);
    }
    await sessions.appendMessage(session.id, {
      type: 'tool_result',
      id: `result-${refId}`,
      turnId: 'turn',
      ts: 1_000,
      toolUseId: 'read-image',
      isError: false,
      content: {
        kind: 'image',
        mimeType: 'image/png',
        ref: { kind: 'session_context', sessionId: session.id, refId },
      },
    });
    return { sessionId: session.id, refId, valuePath };
  } finally {
    store.close();
    await sessions.close?.();
  }
}

for (const sourceKind of ['inline', 'managed_file'] as const) {
  for (const targetKind of ['inline', 'managed_file'] as const) {
    test(`imported ${sourceKind} images deduplicated against ${targetKind} images remain readable and reclaimable`, async (t) => {
      const base = await mkdtemp(join(tmpdir(), 'maka-context-import-storage-'));
      t.after(() => rm(base, { recursive: true, force: true }));
      const sourceRoot = join(base, 'source');
      const targetRoot = join(base, 'target');
      const source = await seedImage(sourceRoot, sourceKind, 'source-ref');
      const target = await seedImage(targetRoot, targetKind, 'target-ref');
      const bundleRoot = join(base, 'bundle');
      await exportSessionBundleState({
        stateRoot: sourceRoot,
        configRoot: join(base, 'config'),
        destinationRoot: bundleRoot,
        sessionId: source.sessionId,
      });
      const imported = await importSessionBundleState({
        stateRoot: targetRoot,
        bundleStateRoot: bundleRoot,
      });
      assert.deepEqual(imported.sessionIds, [source.sessionId]);
      assert.equal(imported.contextRefs, 1);

      const store = new SqliteContextOffloadStore(join(targetRoot, CONTEXT_OFFLOAD_DATABASE_NAME), {
        limits: LIMITS,
        now: () => 2_000,
      });
      try {
        for (const image of [source, target]) {
          const read = await store.read({ ...image, maxBytes: BYTES.length });
          assert.equal(read.ok, true);
          if (read.ok) assert.deepEqual(Buffer.from(read.bytes), BYTES);
        }
        assert.deepEqual(await store.usage(), {
          references: 2,
          logicalBytes: 2 * BYTES.length,
          physicalBytes: BYTES.length,
        });
        await store.retireSession(source.sessionId);
        const collection = { olderThan: 2_001, maxBlobs: 1, maxBytes: BYTES.length };
        assert.equal((await store.collectGarbage(collection)).deletedBlobs, 0);
        assert.equal((await store.read({ ...target, maxBytes: BYTES.length })).ok, true);

        await store.retireSession(target.sessionId);
        assert.deepEqual(await store.collectGarbage(collection), {
          deletedBlobs: 1,
          deletedBytes: BYTES.length,
          hasMore: false,
        });
        assert.deepEqual(await store.usage(), { references: 0, logicalBytes: 0, physicalBytes: 0 });
        await assert.rejects(stat(target.valuePath), { code: 'ENOENT' });
      } finally {
        store.close();
      }
    });
  }
}

for (const [column, value] of [
  ['ref_id', 'leftover-ref'],
  ['owner_kind', 'tool_result_archive'],
  ['owner_id', 'another-image'],
  ['media_type', 'image/jpeg'],
  ['created_at', 999],
] as const) {
  test(`import refuses a residual context reference with different ${column}`, async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'maka-context-import-conflict-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const sourceRoot = join(base, 'source');
    const targetRoot = join(base, 'target');
    const source = await seedImage(sourceRoot, 'managed_file', 'source-ref');
    trackControlDirectory(await resolveStorageRoot({ path: targetRoot, kind: 'interactive' }));
    const store = new SqliteContextOffloadStore(join(targetRoot, CONTEXT_OFFLOAD_DATABASE_NAME), {
      limits: LIMITS,
      idFactory: () => source.refId,
      now: () => 1_000,
    });
    try {
      // Context can outlive a failed import whose runtime transaction rolled
      // back. Only an identical reference is a safe retry of that import.
      assert.equal(
        (
          await store.put({
            sessionId: source.sessionId,
            owner: { kind: 'read_image_snapshot', ownerId: 'image' },
            bytes: BYTES,
            mediaType: 'image/png',
          })
        ).ok,
        true,
      );
      const context = new DatabaseSync(join(targetRoot, CONTEXT_OFFLOAD_DATABASE_NAME));
      try {
        context.prepare(`UPDATE context_refs SET ${column} = ?`).run(value);
        const before = context.prepare('SELECT * FROM context_refs').all();
        await assert.rejects(
          importSessionBundleState({ stateRoot: targetRoot, bundleStateRoot: sourceRoot }),
          { code: 'conflict' },
        );
        assert.deepEqual(context.prepare('SELECT * FROM context_refs').all(), before);
      } finally {
        context.close();
      }
      const runtime = new DatabaseSync(join(targetRoot, 'runtime.sqlite'));
      try {
        assert.equal(runtime.prepare('SELECT count(*) AS n FROM session_metadata').get()?.n, 0);
      } finally {
        runtime.close();
      }
    } finally {
      store.close();
    }
  });
}

for (const shared of [false, true]) {
  test(`a failed runtime import releases context references with shared image = ${shared}`, async (t) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'maka-context-import-rollback-')));
    t.after(() => rm(base, { recursive: true, force: true }));
    const sourceRoot = join(base, 'source');
    const targetRoot = join(base, 'target');
    const source = await seedImage(sourceRoot, 'managed_file', 'source-ref');
    const existing = shared ? await seedImage(targetRoot, 'managed_file', 'target-ref') : undefined;
    trackControlDirectory(await resolveStorageRoot({ path: targetRoot, kind: 'interactive' }));
    const lease = acquireOperationalStateDatabase(targetRoot);
    try {
      lease.database.exec(`
        CREATE TRIGGER fail_import BEFORE INSERT ON session_metadata
        BEGIN SELECT RAISE(ABORT, 'injected runtime import failure'); END
      `);
      await assert.rejects(
        importSessionBundleState({ stateRoot: targetRoot, bundleStateRoot: sourceRoot }),
        /injected runtime import failure/,
      );
      lease.database.exec('DROP TRIGGER fail_import');
      assert.equal(
        lease.database
          .prepare('SELECT 1 FROM session_metadata WHERE session_id = ?')
          .get(source.sessionId),
        undefined,
      );

      const store = new SqliteContextOffloadStore(join(targetRoot, CONTEXT_OFFLOAD_DATABASE_NAME), {
        limits: LIMITS,
      });
      try {
        await store.collectGarbage({
          olderThan: Date.now() + 1,
          maxBlobs: 1,
          maxBytes: BYTES.length,
        });
        assert.deepEqual(await store.usage(), {
          references: shared ? 1 : 0,
          logicalBytes: shared ? BYTES.length : 0,
          physicalBytes: shared ? BYTES.length : 0,
        });
        if (existing) {
          const read = await store.read({ ...existing, maxBytes: BYTES.length });
          assert.equal(read.ok, true);
          if (read.ok) assert.deepEqual(Buffer.from(read.bytes), BYTES);
        }
        // Cleanup must leave the same bundle retryable after the failure clears.
        const retried = await importSessionBundleState({
          stateRoot: targetRoot,
          bundleStateRoot: sourceRoot,
        });
        assert.deepEqual(retried.sessionIds, [source.sessionId]);
        const read = await store.read({ ...source, maxBytes: BYTES.length });
        assert.equal(read.ok, true);
        if (read.ok) assert.deepEqual(Buffer.from(read.bytes), BYTES);
      } finally {
        store.close();
      }
    } finally {
      lease.database.exec('DROP TRIGGER IF EXISTS fail_import');
      lease.close();
    }
  });
}

test('an error after the runtime commit preserves the published context references', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'maka-context-import-committed-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourceRoot = join(base, 'source');
  const targetRoot = join(base, 'target');
  const source = await seedImage(sourceRoot, 'managed_file', 'source-ref');
  const artifactPath = join('artifacts', source.sessionId, 'payload.txt');
  await mkdir(join(sourceRoot, 'artifacts', source.sessionId), { recursive: true });
  await writeFile(join(sourceRoot, artifactPath), 'committed artifact');
  trackControlDirectory(await resolveStorageRoot({ path: targetRoot, kind: 'interactive' }));
  const lease = acquireOperationalStateDatabase(targetRoot);
  try {
    const exec = DatabaseSync.prototype.exec;
    let injected = false;
    t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
      const result = exec.call(this, sql);
      if (this === lease.database && sql === 'DETACH DATABASE bundle' && !injected) {
        injected = true;
        throw new Error('injected error after runtime commit');
      }
      return result;
    });
    await assert.rejects(
      importSessionBundleState({ stateRoot: targetRoot, bundleStateRoot: sourceRoot }),
      /injected error after runtime commit/,
    );
    assert.ok(
      lease.database
        .prepare('SELECT 1 FROM session_metadata WHERE session_id = ?')
        .get(source.sessionId),
    );
    const store = new SqliteContextOffloadStore(join(targetRoot, CONTEXT_OFFLOAD_DATABASE_NAME), {
      limits: LIMITS,
    });
    try {
      await store.collectGarbage({
        olderThan: Date.now() + 1,
        maxBlobs: 1,
        maxBytes: BYTES.length,
      });
      const read = await store.read({ ...source, maxBytes: BYTES.length });
      assert.equal(read.ok, true);
      if (read.ok) assert.deepEqual(Buffer.from(read.bytes), BYTES);
      assert.equal(await readFile(join(targetRoot, artifactPath), 'utf8'), 'committed artifact');
    } finally {
      store.close();
    }
  } finally {
    lease.close();
  }
});

for (const [name, sql, expected] of [
  ['NONE vacuum mode', 'PRAGMA auto_vacuum = NONE; VACUUM', /incremental auto-vacuum required/],
  ['missing index', 'DROP INDEX context_refs_blob', /missing index context_refs_blob/],
  [
    'incompatible index',
    'DROP INDEX context_refs_blob; CREATE INDEX context_refs_blob ON context_refs(session_id)',
    /index context_refs_blob has incompatible columns/,
  ],
] as const) {
  test(`import rejects a context snapshot with ${name} before publishing it`, async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'maka-context-import-schema-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const sourceRoot = join(base, 'source');
    const targetRoot = join(base, 'target');
    await seedImage(sourceRoot, 'managed_file', 'source-ref');
    trackControlDirectory(await resolveStorageRoot({ path: targetRoot, kind: 'interactive' }));
    const damaged = new DatabaseSync(join(sourceRoot, CONTEXT_OFFLOAD_DATABASE_NAME));
    try {
      damaged.exec(sql);
      assert.equal(damaged.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    } finally {
      damaged.close();
    }
    await assert.rejects(
      importSessionBundleState({ stateRoot: targetRoot, bundleStateRoot: sourceRoot }),
      expected,
    );
    await assert.rejects(stat(join(targetRoot, CONTEXT_OFFLOAD_DATABASE_NAME)), { code: 'ENOENT' });
    const runtime = new DatabaseSync(join(targetRoot, 'runtime.sqlite'));
    try {
      assert.equal(runtime.prepare('SELECT count(*) AS n FROM session_metadata').get()?.n, 0);
    } finally {
      runtime.close();
    }
  });
}
