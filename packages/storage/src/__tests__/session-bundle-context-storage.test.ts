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
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { runWithContextValueMutation } from '../context-value-mutation-gate.js';
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

async function seedImage(
  root: string,
  kind: 'inline' | 'managed_file',
  refId: string,
  bytes: Buffer = BYTES,
) {
  trackControlDirectory(await resolveStorageRoot({ path: root, kind: 'interactive' }));
  const sessions = createSessionStore(root);
  const store = new SqliteContextOffloadStore(join(root, CONTEXT_OFFLOAD_DATABASE_NAME), {
    limits: {
      ...LIMITS,
      ownerMaxBytes: {
        ...LIMITS.ownerMaxBytes,
        read_image_snapshot: Math.max(LIMITS.ownerMaxBytes.read_image_snapshot, bytes.length),
      },
    },
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
      bytes,
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
          .run(bytes, Buffer.from(blobId, 'hex'));
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
    return { sessionId: session.id, refId, valuePath, blobId };
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

test('a refused context import does not leave its declared payload files in the target', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-context-import-orphan-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourceRoot = join(base, 'source');
  const targetRoot = join(base, 'target');
  const bundleBytes = Buffer.alloc(32 * 1024, 0xa5);
  const source = await seedImage(sourceRoot, 'managed_file', 'source-ref', bundleBytes);
  trackControlDirectory(await resolveStorageRoot({ path: targetRoot, kind: 'interactive' }));
  const store = new SqliteContextOffloadStore(join(targetRoot, CONTEXT_OFFLOAD_DATABASE_NAME), {
    limits: LIMITS,
    idFactory: () => source.refId,
    now: () => 1_000,
  });
  try {
    // A residual reference for the same identity naming different bytes makes
    // the import a conflict -- after the bundle's declared payload was copied.
    assert.equal(
      (
        await store.put({
          sessionId: source.sessionId,
          owner: { kind: 'read_image_snapshot', ownerId: 'image' },
          bytes: Buffer.alloc(16 * 1024, 0x3c),
          mediaType: 'image/png',
        })
      ).ok,
      true,
    );
    const orphanPath = join(
      targetRoot,
      CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME,
      'sha256',
      source.blobId.slice(0, 2),
      source.blobId,
    );
    const context = new DatabaseSync(join(targetRoot, CONTEXT_OFFLOAD_DATABASE_NAME));
    try {
      const before = context.prepare('SELECT * FROM context_refs').all();
      await assert.rejects(
        importSessionBundleState({ stateRoot: targetRoot, bundleStateRoot: sourceRoot }),
        { code: 'conflict' },
      );
      assert.deepEqual(context.prepare('SELECT * FROM context_refs').all(), before);
    } finally {
      context.close();
    }
    // The rollback removes the blob row that would have named the copy, and
    // collection only starts from committed rows, so a file left behind here is
    // unreachable by every reader and by cleanup alike.
    await assert.rejects(stat(orphanPath), { code: 'ENOENT' });
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

test('the rollback cleanup waits for its turn in the context mutation queue', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-context-import-cleanup-queue-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourceRoot = join(base, 'source');
  const targetRoot = join(base, 'target');
  const bundleBytes = Buffer.alloc(32 * 1024, 0xa5);
  const source = await seedImage(sourceRoot, 'managed_file', 'source-ref', bundleBytes);
  trackControlDirectory(await resolveStorageRoot({ path: targetRoot, kind: 'interactive' }));
  let refCounter = 0;
  const refIds = [source.refId, 'reimported-ref'];
  const store = new SqliteContextOffloadStore(join(targetRoot, CONTEXT_OFFLOAD_DATABASE_NAME), {
    limits: LIMITS,
    idFactory: () => refIds[refCounter++] ?? 'extra-ref',
    now: () => 1_000,
  });
  try {
    // A residual reference for the same identity naming different bytes makes
    // the import a conflict -- after the bundle's declared payload was copied.
    const residual = await store.put({
      sessionId: source.sessionId,
      owner: { kind: 'read_image_snapshot', ownerId: 'image' },
      bytes: Buffer.alloc(16 * 1024, 0x3c),
      mediaType: 'image/png',
    });
    assert.equal(residual.ok, true);
    if (!residual.ok) throw new Error('Unable to seed residual reference');
    const residualPath = join(
      targetRoot,
      CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME,
      'sha256',
      residual.record.blobId.slice(0, 2),
      residual.record.blobId,
    );
    const orphanPath = join(
      targetRoot,
      CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME,
      'sha256',
      source.blobId.slice(0, 2),
      source.blobId,
    );

    // The conflict is decided by this query, after the bundle's payload was
    // copied and before its rows roll back: the moment the copy is on disk.
    const canonicalTarget = await realpath(targetRoot);
    const prepare = DatabaseSync.prototype.prepare;
    let conflictImminent!: () => void;
    const conflictSignal = new Promise<void>((resolve) => {
      conflictImminent = resolve;
    });
    t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (sql.includes('SELECT b.ref_id FROM bundle.context_refs b')) conflictImminent();
      return statement;
    });

    const importing = importSessionBundleState({
      stateRoot: targetRoot,
      bundleStateRoot: sourceRoot,
    });
    await conflictSignal;

    // Holding the turn stands in for a Store put in flight: the cleanup reads
    // the committed locators and then unlinks, and a put of these same bytes
    // that commits in that window adopts the file and must not lose it. The
    // turn is registered with no await in between, so it joins the queue before
    // the import's own rejection can reach the cleanup. With the cleanup outside
    // the queue the refused import completes -- snapshot and unlink included --
    // while this turn is still held.
    let settle!: () => void;
    const held = new Promise<void>((resolve) => {
      settle = resolve;
    });
    t.after(() => settle());
    const holding = runWithContextValueMutation(canonicalTarget, () => held);
    const outcome = await Promise.race([
      importing.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    assert.equal(outcome, false, 'the rollback cleanup must wait for the mutation queue');

    settle();
    await holding;
    await assert.rejects(importing, { code: 'conflict' });
    // The intended cleanup still ran once its turn came: the uncommitted copy
    // is gone, the residual committed payload stays.
    await assert.rejects(stat(orphanPath), { code: 'ENOENT' });
    await assert.doesNotReject(stat(residualPath));

    // A put of the same bytes after the failed import publishes cleanly.
    const reimported = await store.put({
      sessionId: source.sessionId,
      owner: { kind: 'read_image_snapshot', ownerId: 'reimported' },
      bytes: bundleBytes,
      mediaType: 'image/png',
    });
    assert.equal(reimported.ok, true);
    if (!reimported.ok) throw new Error('Unable to reimport payload');
    const read = await store.read({
      sessionId: source.sessionId,
      refId: reimported.record.refId,
      maxBytes: bundleBytes.length,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.deepEqual(Buffer.from(read.bytes), bundleBytes);
  } finally {
    store.close();
  }
});

test('a directory-sync failure after the final payload link leaves no orphan', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-context-import-sync-eio-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourceRoot = join(base, 'source');
  const targetRoot = join(base, 'target');
  const bundleBytes = Buffer.alloc(32 * 1024, 0xa5);
  const source = await seedImage(sourceRoot, 'managed_file', 'source-ref', bundleBytes);
  trackControlDirectory(await resolveStorageRoot({ path: targetRoot, kind: 'interactive' }));
  const payloadPath = join(
    targetRoot,
    CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME,
    'sha256',
    source.blobId.slice(0, 2),
    source.blobId,
  );

  // The final hard link publishes the payload; the directory sync naming it
  // follows. The link is what makes the file this import's own, so failing the
  // sync after it must still hand the file to the rollback cleanup. Failing the
  // staging sync instead would be a different, pre-link failure: the probe only
  // injects once the final path exists and the handle is a directory.
  const probe = await open(targetRoot, 'r');
  const fileHandlePrototype = Object.getPrototypeOf(probe) as { sync: FileHandle['sync'] };
  const originalSync = fileHandlePrototype.sync;
  await probe.close();
  let injected = 0;
  const syncMock = t.mock.method(fileHandlePrototype, 'sync', async function (this: FileHandle) {
    if (injected === 0 && existsSync(payloadPath) && (await this.stat()).isDirectory()) {
      injected += 1;
      throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' });
    }
    return originalSync.call(this);
  });

  try {
    await assert.rejects(
      importSessionBundleState({ stateRoot: targetRoot, bundleStateRoot: sourceRoot }),
      /injected directory sync failure/,
    );
    assert.equal(injected, 1);
    // The file was linked, so nothing committed names it and nothing else will
    // reclaim it: the cleanup must, or it stays on disk forever.
    await assert.rejects(stat(payloadPath), { code: 'ENOENT' });
    await assert.rejects(stat(join(targetRoot, CONTEXT_OFFLOAD_DATABASE_NAME)), {
      code: 'ENOENT',
    });
  } finally {
    syncMock.mock.restore();
  }
});

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
