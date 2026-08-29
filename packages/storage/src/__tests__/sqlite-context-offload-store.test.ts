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
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import type { ContextOffloadLimits } from '@maka/core/context-offload';
import {
  CONTEXT_OFFLOAD_DATABASE_NAME,
  CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME,
  SqliteContextOffloadStore,
} from '../sqlite-context-offload-store.js';

const execFileAsync = promisify(execFile);
const managedPublicationCrashChild = fileURLToPath(
  new URL('./fixtures/context-offload-managed-publication-crash-child.js', import.meta.url),
);

test('creates the dedicated WAL schema with incremental auto-vacuum', async (t) => {
  const fixture = await createFixture(t);
  fixture.store.close();
  const database = new DatabaseSync(fixture.path);
  t.after(() => database.close());

  assert.equal(pragmaNumber(database, 'user_version'), 3);
  assert.equal(pragmaNumber(database, 'auto_vacuum'), 2);
  assert.equal(pragmaText(database, 'journal_mode'), 'wal');
  assert.deepEqual(
    database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name LIKE 'context_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name),
    [
      'context_blobs',
      'context_file_deletions',
      'context_gc_candidates',
      'context_refs',
      'context_session_usage',
      'context_store_usage',
    ],
  );
});

test('atomically persists one idempotent owner identity and verifies reads', async (t) => {
  const fixture = await createFixture(t, {
    ownerMaxBytes: TEST_OWNER_MAX_BYTES,
    sessionLogicalBytes: 64,
    workspacePhysicalBytes: 64,
  });
  const bytes = new TextEncoder().encode('snapshot');
  const expectedSha256 = sha256(bytes);
  const input = {
    sessionId: 'session-1',
    owner: { kind: 'read_image_snapshot' as const, ownerId: 'read-call-1' },
    bytes,
    mediaType: 'image/png',
    expectedSha256,
  };

  const first = await fixture.store.put(input);
  const retried = await fixture.store.put(input);
  assert.equal(first.ok, true);
  assert.deepEqual(retried, first);
  if (!first.ok) return;
  assert.equal(first.record.blobId, expectedSha256);
  assert.deepEqual(
    await fixture.store.read({
      sessionId: input.sessionId,
      refId: first.record.refId,
      maxBytes: bytes.byteLength,
    }),
    {
      ok: true,
      record: first.record,
      bytes,
    },
  );
  assert.deepEqual(await fixture.store.usage('session-1'), {
    references: 1,
    logicalBytes: bytes.byteLength,
    physicalBytes: bytes.byteLength,
  });

  assert.deepEqual(
    await fixture.store.put({ ...input, bytes: new TextEncoder().encode('changed') }),
    {
      ok: false,
      reason: 'identity_conflict',
    },
  );
  assert.deepEqual(await fixture.store.put({ ...input, expectedSha256: '0'.repeat(64) }), {
    ok: false,
    reason: 'identity_conflict',
  });
  assert.deepEqual(await fixture.store.put({ ...input, mediaType: 'image/jpeg' }), {
    ok: false,
    reason: 'identity_conflict',
  });
});

test('stores managed binary values as durable file locators instead of SQLite payloads', async (t) => {
  const fixture = await createFixture(t);
  const bytes = new Uint8Array(1_024).fill(0x5a);
  const blobId = sha256(bytes);
  const stored = await fixture.store.put({
    sessionId: 'session-1',
    owner: { kind: 'read_image_snapshot', ownerId: 'read-call-1' },
    bytes,
    mediaType: 'image/png',
  });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;

  const database = new DatabaseSync(fixture.path);
  const row = database
    .prepare('SELECT storage_kind, payload, size_bytes FROM context_blobs WHERE blob_id = ?')
    .get(Buffer.from(blobId, 'hex')) as {
    storage_kind: string;
    payload: Uint8Array;
    size_bytes: number;
  };
  assert.equal(
    (
      database.prepare('SELECT COUNT(*) AS count FROM context_file_deletions').get() as {
        count: number;
      }
    ).count,
    0,
  );
  database.close();
  const locator = Buffer.from(row.payload).toString('utf8');
  assert.equal(row.storage_kind, 'managed_file');
  assert.equal(row.size_bytes, bytes.byteLength);
  assert.equal(locator, `sha256/${blobId.slice(0, 2)}/${blobId}`);
  assert.ok(row.payload.byteLength < bytes.byteLength);

  const valuePath = join(fixture.root, CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME, locator);
  assert.deepEqual(new Uint8Array(await readFile(valuePath)), bytes);
  assert.equal((await stat(valuePath)).isFile(), true);
  assert.deepEqual(
    await fixture.store.read({
      sessionId: 'session-1',
      refId: stored.record.refId,
      maxBytes: bytes.byteLength,
    }),
    { ok: true, record: stored.record, bytes },
  );

  await writeFile(valuePath, new Uint8Array(bytes.byteLength));
  assert.deepEqual(
    await fixture.store.read({
      sessionId: 'session-1',
      refId: stored.record.refId,
      maxBytes: bytes.byteLength,
    }),
    { ok: false, reason: 'corrupt' },
  );

  await fixture.store.releaseReference({
    sessionId: 'session-1',
    refId: stored.record.refId,
  });
  assert.deepEqual(
    await fixture.store.collectGarbage({
      olderThan: 1_001,
      maxBlobs: 1,
      maxBytes: bytes.byteLength,
    }),
    { deletedBlobs: 1, deletedBytes: bytes.byteLength, hasMore: false },
  );
  await assert.rejects(stat(valuePath), (error) => isNodeError(error, 'ENOENT'));
  const afterGc = new DatabaseSync(fixture.path);
  assert.equal(
    (
      afterGc.prepare('SELECT COUNT(*) AS count FROM context_file_deletions').get() as {
        count: number;
      }
    ).count,
    0,
  );
  afterGc.close();
});

test('repairs a missing managed blob when an inline owner retries identical bytes', async (t) => {
  const fixture = await createFixture(t);
  const bytes = new TextEncoder().encode('shared-value');
  const tool = await fixture.store.put({
    sessionId: 'session-1',
    owner: { kind: 'tool_result_archive', ownerId: 'tool-1' },
    bytes,
    mediaType: 'application/octet-stream',
  });
  const image = await fixture.store.put({
    sessionId: 'session-1',
    owner: { kind: 'read_image_snapshot', ownerId: 'read-1' },
    bytes,
    mediaType: 'image/png',
  });
  assert.equal(tool.ok, true);
  assert.equal(image.ok, true);
  if (!tool.ok || !image.ok) return;

  const blobId = sha256(bytes);
  const valuePath = join(
    fixture.root,
    CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME,
    `sha256/${blobId.slice(0, 2)}/${blobId}`,
  );
  await unlink(valuePath);

  assert.deepEqual(
    await fixture.store.put({
      sessionId: 'session-1',
      owner: { kind: 'tool_result_archive', ownerId: 'tool-1' },
      bytes,
      mediaType: 'application/octet-stream',
    }),
    tool,
  );
  assert.deepEqual(
    await fixture.store.read({
      sessionId: 'session-1',
      refId: tool.record.refId,
      maxBytes: bytes.byteLength,
    }),
    { ok: true, record: tool.record, bytes },
  );
});

test('removes managed publication state when quota admission fails', async (t) => {
  const fixture = await createFixture(t, {
    ownerMaxBytes: TEST_OWNER_MAX_BYTES,
    sessionLogicalBytes: 64,
    workspacePhysicalBytes: 0,
  });
  const bytes = new TextEncoder().encode('over-quota');
  const blobId = sha256(bytes);
  assert.deepEqual(
    await fixture.store.put({
      sessionId: 'session-1',
      owner: { kind: 'read_image_snapshot', ownerId: 'read-call-1' },
      bytes,
      mediaType: 'image/png',
    }),
    { ok: false, reason: 'workspace_quota_exceeded' },
  );
  await assert.rejects(
    stat(
      join(
        fixture.root,
        CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME,
        `sha256/${blobId.slice(0, 2)}/${blobId}`,
      ),
    ),
    (error) => isNodeError(error, 'ENOENT'),
  );
  const database = new DatabaseSync(fixture.path);
  assert.equal(
    (
      database.prepare('SELECT COUNT(*) AS count FROM context_file_deletions').get() as {
        count: number;
      }
    ).count,
    0,
  );
  database.close();
});

test('recovers a durable managed-file publication intent after process exit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-offload-publication-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    execFileAsync(process.execPath, [managedPublicationCrashChild], {
      env: { ...process.env, MAKA_CONTEXT_OFFLOAD_CRASH_ROOT: root, NODE_NO_WARNINGS: '1' },
      windowsHide: true,
    }),
    (error: unknown) => error instanceof Error && 'code' in error && Number(error.code) === 73,
  );

  const bytes = new TextEncoder().encode('crash-safe-managed-value');
  const blobId = sha256(bytes);
  const locator = `sha256/${blobId.slice(0, 2)}/${blobId}`;
  const valuePath = join(root, CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME, locator);
  assert.deepEqual(new Uint8Array(await readFile(valuePath)), bytes);
  const path = join(root, CONTEXT_OFFLOAD_DATABASE_NAME);
  const crashed = new DatabaseSync(path);
  assert.equal(
    (
      crashed
        .prepare('SELECT COUNT(*) AS count FROM context_file_deletions WHERE locator = ?')
        .get(Buffer.from(locator, 'utf8')) as { count: number }
    ).count,
    1,
  );
  assert.equal(
    (crashed.prepare('SELECT COUNT(*) AS count FROM context_blobs').get() as { count: number })
      .count,
    0,
  );
  crashed.close();

  const recovered = new SqliteContextOffloadStore(path, { limits: defaultLimits() });
  t.after(() => recovered.close());
  assert.deepEqual(
    await recovered.collectGarbage({ olderThan: 1, maxBlobs: 1, maxBytes: bytes.byteLength }),
    { deletedBlobs: 0, deletedBytes: 0, hasMore: false },
  );
  await assert.rejects(stat(valuePath), (error) => isNodeError(error, 'ENOENT'));
  const afterRecovery = new DatabaseSync(path);
  assert.equal(
    (
      afterRecovery.prepare('SELECT COUNT(*) AS count FROM context_file_deletions').get() as {
        count: number;
      }
    ).count,
    0,
  );
  afterRecovery.close();
});

test('recovers deterministic managed-file staging after process exit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-offload-staging-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    execFileAsync(process.execPath, [managedPublicationCrashChild], {
      env: {
        ...process.env,
        MAKA_CONTEXT_OFFLOAD_CRASH_ROOT: root,
        MAKA_CONTEXT_OFFLOAD_CRASH_POINT: 'after_managed_file_staging',
        NODE_NO_WARNINGS: '1',
      },
      windowsHide: true,
    }),
    (error: unknown) => error instanceof Error && 'code' in error && Number(error.code) === 73,
  );

  const bytes = new TextEncoder().encode('crash-safe-managed-value');
  const blobId = sha256(bytes);
  const directory = join(
    root,
    CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME,
    `sha256/${blobId.slice(0, 2)}`,
  );
  const stagingPath = join(directory, `.${blobId}.publish.tmp`);
  assert.deepEqual(new Uint8Array(await readFile(stagingPath)), bytes);

  const path = join(root, CONTEXT_OFFLOAD_DATABASE_NAME);
  const recovered = new SqliteContextOffloadStore(path, { limits: defaultLimits() });
  t.after(() => recovered.close());
  assert.deepEqual(await recovered.usage(), {
    references: 0,
    logicalBytes: 0,
    physicalBytes: bytes.byteLength,
  });
  assert.deepEqual(
    await recovered.collectGarbage({ olderThan: 1, maxBlobs: 1, maxBytes: bytes.byteLength }),
    { deletedBlobs: 0, deletedBytes: 0, hasMore: false },
  );
  await assert.rejects(stat(stagingPath), (error) => isNodeError(error, 'ENOENT'));
  assert.equal((await recovered.usage()).physicalBytes, 0);
});

test('reports continuation while pending managed-file deletions remain', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-offload-pending-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const values = ['pending-one', 'pending-two', 'pending-three'];
  for (const [index, value] of values.entries()) {
    await assert.rejects(
      execFileAsync(process.execPath, [managedPublicationCrashChild], {
        env: {
          ...process.env,
          MAKA_CONTEXT_OFFLOAD_CRASH_ROOT: root,
          MAKA_CONTEXT_OFFLOAD_CRASH_POINT: 'after_managed_file_staging',
          MAKA_CONTEXT_OFFLOAD_OWNER_ID: `read-${index}`,
          MAKA_CONTEXT_OFFLOAD_VALUE: value,
          NODE_NO_WARNINGS: '1',
        },
        windowsHide: true,
      }),
      (error: unknown) => error instanceof Error && 'code' in error && Number(error.code) === 73,
    );
  }

  const path = join(root, CONTEXT_OFFLOAD_DATABASE_NAME);
  const recovered = new SqliteContextOffloadStore(path, { limits: defaultLimits() });
  t.after(() => recovered.close());
  const totalBytes = values.reduce((total, value) => total + Buffer.byteLength(value), 0);
  assert.equal((await recovered.usage()).physicalBytes, totalBytes);
  for (const hasMore of [true, true, false]) {
    assert.deepEqual(
      await recovered.collectGarbage({ olderThan: 1, maxBlobs: 1, maxBytes: totalBytes }),
      { deletedBlobs: 0, deletedBytes: 0, hasMore },
    );
  }
  assert.equal((await recovered.usage()).physicalBytes, 0);
});

test('rejects a managed-value directory that resolves outside the Storage Root', async (t) => {
  const fixture = await createFixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'maka-context-offload-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(
    outside,
    join(fixture.root, CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  assert.deepEqual(
    await fixture.store.put({
      sessionId: 'session-1',
      owner: { kind: 'read_image_snapshot', ownerId: 'read-call-1' },
      bytes: new TextEncoder().encode('image'),
      mediaType: 'image/png',
    }),
    { ok: false, reason: 'unavailable' },
  );
  assert.deepEqual(await readdir(outside), []);
});

test('reopens durable records and preserves owner idempotency', async (t) => {
  const fixture = await createFixture(t);
  const bytes = new TextEncoder().encode('durable');
  const first = await fixture.store.put(putInput('session-1', 'archive-1', bytes));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  fixture.store.close();

  const reopened = new SqliteContextOffloadStore(fixture.path, {
    limits: fixture.limits,
    now: () => 2_000,
    idFactory: () => 'unexpected-new-reference',
  });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.put(putInput('session-1', 'archive-1', bytes)), first);
  assert.deepEqual(
    await reopened.read({
      sessionId: 'session-1',
      refId: first.record.refId,
      maxBytes: bytes.byteLength,
    }),
    { ok: true, record: first.record, bytes },
  );
});

test('rejects a database schema newer than this authority understands', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-offload-newer-'));
  const path = join(root, CONTEXT_OFFLOAD_DATABASE_NAME);
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = new DatabaseSync(path);
  database.exec('PRAGMA user_version = 4');
  database.close();

  assert.throws(
    () =>
      new SqliteContextOffloadStore(path, {
        limits: {
          ownerMaxBytes: TEST_OWNER_MAX_BYTES,
          sessionLogicalBytes: 1,
          workspacePhysicalBytes: 1,
        },
      }),
    /schema 4 is newer than supported version 3/u,
  );
});

test('rejects a current schema missing a query-required index', async (t) => {
  const fixture = await createFixture(t);
  fixture.store.close();
  const database = new DatabaseSync(fixture.path);
  database.exec('DROP INDEX context_refs_session');
  database.close();

  assert.throws(
    () => new SqliteContextOffloadStore(fixture.path, { limits: fixture.limits }),
    /missing index context_refs_session/u,
  );
});

test('deduplicates physical bytes while quotas count each Session reference logically', async (t) => {
  const fixture = await createFixture(t, {
    ownerMaxBytes: TEST_OWNER_MAX_BYTES,
    sessionLogicalBytes: 8,
    workspacePhysicalBytes: 4,
  });
  const bytes = new TextEncoder().encode('same');

  const first = await fixture.store.put(putInput('session-1', 'owner-1', bytes));
  const crossSession = await fixture.store.put(putInput('session-2', 'owner-2', bytes));
  const secondReference = await fixture.store.put(putInput('session-1', 'owner-3', bytes));
  assert.equal(first.ok, true);
  assert.equal(crossSession.ok, true);
  assert.equal(secondReference.ok, true);
  assert.deepEqual(await fixture.store.usage('session-1'), {
    references: 2,
    logicalBytes: 8,
    physicalBytes: 4,
  });
  assert.deepEqual(await fixture.store.usage('session-2'), {
    references: 1,
    logicalBytes: 4,
    physicalBytes: 4,
  });

  assert.deepEqual(await fixture.store.put(putInput('session-1', 'owner-4', bytes)), {
    ok: false,
    reason: 'session_quota_exceeded',
  });
  assert.deepEqual(
    await fixture.store.put(putInput('session-2', 'owner-5', new TextEncoder().encode('else'))),
    { ok: false, reason: 'workspace_quota_exceeded' },
  );
});

test('fails closed before returning bytes for Session mismatch and size limits', async (t) => {
  const fixture = await createFixture(t);
  const stored = await fixture.store.put(
    putInput('session-1', 'archive-1', new TextEncoder().encode('archive')),
  );
  assert.equal(stored.ok, true);
  if (!stored.ok) return;

  assert.deepEqual(
    await fixture.store.read({
      sessionId: 'session-2',
      refId: stored.record.refId,
      maxBytes: 100,
    }),
    { ok: false, reason: 'session_mismatch' },
  );
  assert.deepEqual(
    await fixture.store.read({
      sessionId: 'session-1',
      refId: stored.record.refId,
      maxBytes: 3,
    }),
    { ok: false, reason: 'too_large' },
  );
  assert.deepEqual(
    await fixture.store.read({
      sessionId: 'session-1',
      refId: 'missing',
      maxBytes: 100,
    }),
    { ok: false, reason: 'not_found' },
  );
});

test('enforces configured owner hard caps before commit and return', async (t) => {
  const ownerMaxBytes = {
    read_image_snapshot: 5,
    tool_result_archive: 7,
  } as const;
  const fixture = await createFixture(t, {
    ownerMaxBytes,
    sessionLogicalBytes: 32,
    workspacePhysicalBytes: 32,
  });

  assert.deepEqual(
    await fixture.store.put({
      ...putInput(
        'session-1',
        'large-image',
        new Uint8Array(ownerMaxBytes.read_image_snapshot + 1),
      ),
      owner: { kind: 'read_image_snapshot', ownerId: 'large-image' },
    }),
    { ok: false, reason: 'too_large' },
  );
  assert.deepEqual(
    await fixture.store.put({
      ...putInput(
        'session-1',
        'large-archive',
        new Uint8Array(ownerMaxBytes.tool_result_archive + 1),
      ),
      owner: { kind: 'tool_result_archive', ownerId: 'large-archive' },
    }),
    { ok: false, reason: 'too_large' },
  );
  assert.deepEqual(await fixture.store.usage(), {
    references: 0,
    logicalBytes: 0,
    physicalBytes: 0,
  });

  const accepted = await fixture.store.put(
    putInput('session-1', 'accepted-archive', new Uint8Array(ownerMaxBytes.tool_result_archive)),
  );
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  fixture.store.close();

  const lowerReadLimit = new SqliteContextOffloadStore(fixture.path, {
    limits: {
      ...fixture.limits,
      ownerMaxBytes: { ...ownerMaxBytes, tool_result_archive: 6 },
    },
  });
  t.after(() => lowerReadLimit.close());
  assert.deepEqual(
    await lowerReadLimit.read({
      sessionId: 'session-1',
      refId: accepted.record.refId,
      maxBytes: ownerMaxBytes.tool_result_archive,
    }),
    { ok: false, reason: 'too_large' },
  );
});

test('detects payload corruption instead of returning unverified bytes', async (t) => {
  const fixture = await createFixture(t);
  const stored = await fixture.store.put(
    putInput('session-1', 'archive-1', new TextEncoder().encode('original')),
  );
  assert.equal(stored.ok, true);
  if (!stored.ok) return;

  const database = new DatabaseSync(fixture.path);
  database
    .prepare('UPDATE context_blobs SET payload = ?')
    .run(new TextEncoder().encode('tampered'));
  database.close();

  assert.deepEqual(
    await fixture.store.read({
      sessionId: 'session-1',
      refId: stored.record.refId,
      maxBytes: 100,
    }),
    { ok: false, reason: 'corrupt' },
  );
});

test('rolls back blob and reference together when publication fails', async (t) => {
  const fixture = await createFixture(t, undefined, (point) => {
    if (point === 'after_ref_insert') throw new Error('injected publication failure');
  });

  assert.deepEqual(
    await fixture.store.put(
      putInput('session-1', 'archive-1', new TextEncoder().encode('archive')),
    ),
    { ok: false, reason: 'unavailable' },
  );
  assert.deepEqual(await fixture.store.usage(), {
    references: 0,
    logicalBytes: 0,
    physicalBytes: 0,
  });
});

test('releases only the authorized Session reference without deleting shared bytes', async (t) => {
  const fixture = await createFixture(t);
  const bytes = new TextEncoder().encode('shared');
  const first = await fixture.store.put(putInput('session-1', 'owner-1', bytes));
  const second = await fixture.store.put(putInput('session-2', 'owner-2', bytes));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok) return;

  await fixture.store.releaseReference({ sessionId: 'session-2', refId: first.record.refId });
  assert.equal((await fixture.store.usage('session-1')).references, 1);
  await fixture.store.releaseReference({ sessionId: 'session-1', refId: first.record.refId });
  await fixture.store.releaseReference({ sessionId: 'session-1', refId: first.record.refId });
  assert.deepEqual(await fixture.store.usage('session-1'), {
    references: 0,
    logicalBytes: 0,
    physicalBytes: bytes.byteLength,
  });
});

test('copies references atomically without copying physical bytes', async (t) => {
  const fixture = await createFixture(t, {
    ownerMaxBytes: TEST_OWNER_MAX_BYTES,
    sessionLogicalBytes: 16,
    workspacePhysicalBytes: 16,
  });
  const first = await fixture.store.put(
    putInput('source', 'source-1', new TextEncoder().encode('first')),
  );
  const second = await fixture.store.put(
    putInput('source', 'source-2', new TextEncoder().encode('second')),
  );
  const third = await fixture.store.put({
    ...putInput('source', 'source-3', new TextEncoder().encode('first')),
    mediaType: 'text/plain',
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, true);
  if (!first.ok || !second.ok || !third.ok) return;

  const copyInput = {
    sourceSessionId: 'source',
    targetSessionId: 'target',
    references: [
      {
        sourceRefId: first.record.refId,
        targetOwner: { kind: 'tool_result_archive' as const, ownerId: 'target-1' },
      },
      {
        sourceRefId: second.record.refId,
        targetOwner: { kind: 'tool_result_archive' as const, ownerId: 'target-2' },
      },
    ],
  };
  const copied = await fixture.store.copyReferences(copyInput);
  assert.equal(copied.ok, true);
  if (!copied.ok) return;
  assert.deepEqual(await fixture.store.copyReferences(copyInput), copied);
  assert.deepEqual(await fixture.store.usage('target'), {
    references: 2,
    logicalBytes: 11,
    physicalBytes: 11,
  });
  assert.equal(
    (
      await fixture.store.read({
        sessionId: 'target',
        refId: copied.copied[0]?.targetRefId ?? '',
        maxBytes: 16,
      })
    ).ok,
    true,
  );

  assert.deepEqual(
    await fixture.store.copyReferences({
      sourceSessionId: 'source',
      targetSessionId: 'target',
      references: [
        {
          sourceRefId: second.record.refId,
          targetOwner: { kind: 'tool_result_archive', ownerId: 'target-over-quota' },
        },
      ],
    }),
    { ok: false, reason: 'session_quota_exceeded' },
  );

  assert.deepEqual(
    await fixture.store.copyReferences({
      sourceSessionId: 'source',
      targetSessionId: 'target',
      references: [
        {
          sourceRefId: second.record.refId,
          targetOwner: { kind: 'tool_result_archive', ownerId: 'new-before-conflict' },
        },
        {
          sourceRefId: second.record.refId,
          targetOwner: { kind: 'tool_result_archive', ownerId: 'target-1' },
        },
      ],
    }),
    { ok: false, reason: 'identity_conflict' },
  );
  assert.deepEqual(
    await fixture.store.copyReferences({
      sourceSessionId: 'source',
      targetSessionId: 'target',
      references: [
        {
          sourceRefId: third.record.refId,
          targetOwner: { kind: 'tool_result_archive', ownerId: 'target-1' },
        },
      ],
    }),
    { ok: false, reason: 'identity_conflict' },
  );
  assert.deepEqual(
    await fixture.store.copyReferences({
      sourceSessionId: 'source',
      targetSessionId: 'mime-conflict-target',
      references: [
        {
          sourceRefId: first.record.refId,
          targetOwner: { kind: 'tool_result_archive', ownerId: 'target-1' },
        },
        {
          sourceRefId: third.record.refId,
          targetOwner: { kind: 'tool_result_archive', ownerId: 'target-1' },
        },
      ],
    }),
    { ok: false, reason: 'identity_conflict' },
  );
  assert.equal((await fixture.store.usage('target')).references, 2);
  assert.equal((await fixture.store.usage('mime-conflict-target')).references, 0);
});

test('retires only one Session and collects shared blobs after the last reference', async (t) => {
  const fixture = await createFixture(t);
  const bytes = new TextEncoder().encode('shared');
  await fixture.store.put(putInput('session-1', 'owner-1', bytes));
  await fixture.store.put(putInput('session-2', 'owner-2', bytes));

  assert.deepEqual(await fixture.store.retireSession('session-1'), {
    releasedReferences: 1,
    releasedLogicalBytes: bytes.byteLength,
  });
  assert.deepEqual(
    await fixture.store.collectGarbage({ olderThan: 1_001, maxBlobs: 1, maxBytes: 16 }),
    { deletedBlobs: 0, deletedBytes: 0, hasMore: false },
  );
  assert.equal((await fixture.store.usage('session-2')).references, 1);

  assert.deepEqual(await fixture.store.retireSession('session-2'), {
    releasedReferences: 1,
    releasedLogicalBytes: bytes.byteLength,
  });
  assert.deepEqual(
    await fixture.store.collectGarbage({ olderThan: 1_000, maxBlobs: 1, maxBytes: 16 }),
    { deletedBlobs: 0, deletedBytes: 0, hasMore: false },
  );
  assert.deepEqual(
    await fixture.store.collectGarbage({ olderThan: 1_001, maxBlobs: 1, maxBytes: 16 }),
    { deletedBlobs: 1, deletedBytes: bytes.byteLength, hasMore: false },
  );
  assert.deepEqual(await fixture.store.usage(), {
    references: 0,
    logicalBytes: 0,
    physicalBytes: 0,
  });
});

test('garbage collection obeys both batch limits and rolls back failed deletion', async (t) => {
  let failGc = false;
  const fixture = await createFixture(t, undefined, (point) => {
    if (point === 'after_gc_blob_delete' && failGc) throw new Error('injected GC failure');
  });
  const bytes = new TextEncoder().encode('four');
  const first = await fixture.store.put(putInput('session-1', 'owner-1', bytes));
  const second = await fixture.store.put(
    putInput('session-1', 'owner-2', new TextEncoder().encode('fives')),
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  await fixture.store.releaseReference({ sessionId: 'session-1', refId: first.record.refId });
  await fixture.store.releaseReference({ sessionId: 'session-1', refId: second.record.refId });

  assert.deepEqual(
    await fixture.store.collectGarbage({ olderThan: 1_001, maxBlobs: 2, maxBytes: 4 }),
    { deletedBlobs: 1, deletedBytes: 4, hasMore: true },
  );
  await assert.rejects(
    fixture.store.collectGarbage({ olderThan: 1_001, maxBlobs: 1, maxBytes: 4 }),
    /byte limit 4 cannot fit eligible blob of 5 bytes/u,
  );
  assert.equal((await fixture.store.usage()).physicalBytes, 5);
  failGc = true;
  await assert.rejects(
    fixture.store.collectGarbage({ olderThan: 1_001, maxBlobs: 1, maxBytes: 8 }),
    /injected GC failure/u,
  );
  assert.equal((await fixture.store.usage()).physicalBytes, 5);
  failGc = false;
  assert.deepEqual(
    await fixture.store.collectGarbage({ olderThan: 1_001, maxBlobs: 1, maxBytes: 8 }),
    { deletedBlobs: 1, deletedBytes: 5, hasMore: false },
  );
});

test('migrates v1 orphan blobs into the indexed garbage candidate set', async (t) => {
  const fixture = await createFixture(t);
  const stored = await fixture.store.put(
    putInput('session-1', 'owner-1', new TextEncoder().encode('orphan')),
  );
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  await fixture.store.releaseReference({ sessionId: 'session-1', refId: stored.record.refId });
  fixture.store.close();

  const database = new DatabaseSync(fixture.path);
  database.exec(
    'DROP TABLE context_gc_candidates; DROP TABLE context_file_deletions; PRAGMA user_version = 1',
  );
  database.close();
  const migrated = new SqliteContextOffloadStore(fixture.path, { limits: fixture.limits });
  t.after(() => migrated.close());
  assert.deepEqual(await migrated.collectGarbage({ olderThan: 1_001, maxBlobs: 1, maxBytes: 16 }), {
    deletedBlobs: 1,
    deletedBytes: 6,
    hasMore: false,
  });
});

test('lifecycle queries use Session and garbage eligibility indexes', async (t) => {
  const fixture = await createFixture(t);
  fixture.store.close();
  const database = new DatabaseSync(fixture.path);
  t.after(() => database.close());

  const retirementPlan = database
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT r.blob_id, b.size_bytes
       FROM context_refs r INDEXED BY context_refs_session
       JOIN context_blobs b ON b.blob_id = r.blob_id
       WHERE r.session_id = ?`,
    )
    .all('session-1');
  assert.match(JSON.stringify(retirementPlan), /context_refs_session/u);

  const garbagePlan = database
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT c.blob_id, b.size_bytes
       FROM context_gc_candidates c INDEXED BY context_gc_candidates_eligible
       JOIN context_blobs b ON b.blob_id = c.blob_id
       WHERE c.unreferenced_at < ?
       ORDER BY c.unreferenced_at, c.blob_id
       LIMIT ?`,
    )
    .all(1_001, 2);
  assert.match(JSON.stringify(garbagePlan), /context_gc_candidates_eligible/u);
  assert.doesNotMatch(JSON.stringify(garbagePlan), /SCAN b(?:\W|$)/u);

  const fileDeletionPlan = database
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT locator FROM context_file_deletions
       ORDER BY enqueued_at, locator
       LIMIT ?`,
    )
    .all(2);
  assert.match(JSON.stringify(fileDeletionPlan), /context_file_deletions_pending/u);
});

function putInput(sessionId: string, ownerId: string, bytes: Uint8Array) {
  return {
    sessionId,
    owner: { kind: 'tool_result_archive' as const, ownerId },
    bytes,
    mediaType: 'application/json',
  };
}

async function createFixture(
  t: TestContext,
  limits: ContextOffloadLimits = {
    ownerMaxBytes: TEST_OWNER_MAX_BYTES,
    sessionLogicalBytes: 16 * 1024 * 1024,
    workspacePhysicalBytes: 32 * 1024 * 1024,
  },
  failpoint?: ConstructorParameters<typeof SqliteContextOffloadStore>[1]['failpoint'],
) {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-offload-'));
  const path = join(root, CONTEXT_OFFLOAD_DATABASE_NAME);
  let nextId = 1;
  const store = new SqliteContextOffloadStore(path, {
    limits,
    now: () => 1_000,
    idFactory: () => `ref-${nextId++}`,
    failpoint,
  });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { limits, path, root, store };
}

const TEST_OWNER_MAX_BYTES = Object.freeze({
  read_image_snapshot: 5 * 1024 * 1024,
  tool_result_archive: 8 * 1024 * 1024,
});

function defaultLimits(): ContextOffloadLimits {
  return {
    ownerMaxBytes: TEST_OWNER_MAX_BYTES,
    sessionLogicalBytes: 16 * 1024 * 1024,
    workspacePhysicalBytes: 32 * 1024 * 1024,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function pragmaNumber(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  const value = row[name];
  if (typeof value !== 'number') throw new Error(`Expected numeric PRAGMA ${name}`);
  return value;
}

function pragmaText(database: DatabaseSync, name: string): string {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  const value = row[name];
  if (typeof value !== 'string') throw new Error(`Expected text PRAGMA ${name}`);
  return value;
}
