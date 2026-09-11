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
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test, type TestContext } from 'node:test';
import {
  authenticateInteractiveArtifactStoreWriter,
  openInteractiveArtifactStoreForWrite,
  type InteractiveArtifactStoreWriter,
} from '../artifact-stores.js';
import { ARTIFACT_WRITER_LOCK_FILE } from '../artifact-writer-lock.js';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  type StorageRootLease,
} from '../root-authority.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

// The control directory of each resolved root lives outside that root, so a
// temporary root's removal leaves it behind; reclaim the recorded rootIds here.
after(removeTrackedControlDirectories);

describe('interactive artifact store authority', () => {
  for (const unrelated of [0, 1_000, 12_000]) {
    test(`upgrade cleanup addresses one page without decoding ${unrelated} unrelated records`, async (t) => {
      await withInteractiveOwner(async (owner, root, track) => {
        const store = track(await openInteractiveArtifactStoreForWrite(owner.lease));
        const db = new DatabaseSync(join(root, 'runtime.sqlite'));
        try {
          db.prepare(`WITH RECURSIVE numbers(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < ?
          ) INSERT INTO artifact_records
            SELECT 'other-' || n, 'other', 0, 'other/' || n, '{}' FROM numbers WHERE n <= ?`).run(
            unrelated,
            unrelated,
          );
          db.exec(`WITH RECURSIVE numbers(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 12000
          ) INSERT INTO artifact_upgrade_orphan_paths
            SELECT printf('removed/%05d', n) FROM numbers`);
          const queries: string[] = [];
          const prepare = DatabaseSync.prototype.prepare;
          const spy = t.mock.method(
            DatabaseSync.prototype,
            'prepare',
            function (this: DatabaseSync, sql: string) {
              queries.push(sql);
              assert.doesNotMatch(sql, /SELECT record_json\s+FROM artifact_records/);
              return prepare.call(this, sql);
            },
          );
          const result = await store.reclaimUpgradeResidue({ maxPaths: 3 });
          spy.mock.restore();
          assert.deepEqual(result, {
            nextAfter: 'removed/00003',
            processedPaths: 3,
            failedPaths: 0,
          });
          assert.equal(
            queries.filter((sql) => sql.includes('SELECT 1 FROM artifact_records')).length,
            3,
          );
          assert.equal(
            db.prepare('SELECT count(*) AS n FROM artifact_upgrade_orphan_paths').get()?.n,
            11997,
          );
          const plan = db
            .prepare(`EXPLAIN QUERY PLAN SELECT relative_path FROM artifact_upgrade_orphan_paths
            WHERE relative_path > ? ORDER BY relative_path LIMIT ?`)
            .all('', 4);
          assert.match(JSON.stringify(plan), /SEARCH.*INDEX/);
          const claimedPlan = db
            .prepare('EXPLAIN QUERY PLAN SELECT 1 FROM artifact_records WHERE relative_path = ?')
            .all('other/1');
          assert.match(JSON.stringify(claimedPlan), /artifact_records_relative_path/);
        } finally {
          db.close();
        }
      });
    });
  }

  test('reads retained v1 payloads after upgrade without reviving retired rows', async () => {
    await withInteractiveOwner(async (owner, root, track) => {
      const initial = await openInteractiveArtifactStoreForWrite(owner.lease);
      initial.close();
      const db = new DatabaseSync(join(root, 'runtime.sqlite'));
      db.exec(`
        DROP TABLE artifact_records;
        CREATE TABLE artifact_records (
          storage_key TEXT PRIMARY KEY, artifact_id TEXT NOT NULL,
          session_id TEXT NOT NULL, created_at INTEGER NOT NULL CHECK(created_at >= 0),
          status TEXT NOT NULL CHECK(status IN ('live', 'deleted')),
          relative_path TEXT NOT NULL, record_json TEXT NOT NULL
        );
        CREATE INDEX artifact_records_session_order ON artifact_records(session_id, created_at, storage_key);
        CREATE UNIQUE INDEX artifact_records_relative_path ON artifact_records(relative_path);
        UPDATE operational_schema_migrations SET version = 1 WHERE scope = 'artifact';
      `);
      const retained = [
        'tool_result',
        'tool_result_projection',
        'tool_result_archive',
        'subagent_writeback',
        'deep_research',
        'user_upload',
        'session_effect',
      ];
      const image = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=',
        'base64',
      );
      await mkdir(join(root, 'artifacts', 'session-1'), { recursive: true });
      for (const source of [...retained, 'fixture', 'deleted', 'malformed']) {
        const path = `session-1/${source}-result.txt`;
        const content =
          source === 'tool_result_projection' || source === 'user_upload'
            ? image
            : `original ${source}`;
        const record = {
          id: source,
          sessionId: 'session-1',
          turnId: 'turn-1',
          createdAt: 1,
          name: 'result.txt',
          kind: 'file',
          sizeBytes: Buffer.byteLength(content),
          relativePath: path,
          source: source === 'deleted' ? 'tool_result' : source,
          status: source === 'deleted' ? 'deleted' : 'live',
        };
        await writeFile(join(root, 'artifacts', path), content);
        db.prepare('INSERT INTO artifact_records VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          source,
          source,
          'session-1',
          1,
          record.status,
          path,
          source === 'malformed' ? '{' : JSON.stringify(record),
        );
      }
      db.close();
      for (let reopen = 0; reopen < 2; reopen += 1) {
        const store = track(await openInteractiveArtifactStoreForWrite(owner.lease));
        assert.deepEqual(
          (await store.listTurnArtifacts('session-1', 'turn-1')).map((r) => r.id).sort(),
          [...retained].sort(),
        );
        for (const source of retained) {
          if (source === 'tool_result_projection' || source === 'user_upload') {
            assert.deepEqual(
              await store.readDurableAttachmentBinary({
                sessionId: 'session-1',
                artifactId: source,
              }),
              { ok: true, base64: image.toString('base64'), mimeType: 'image/png' },
            );
            continue;
          }
          const result = await store.readTextInSession('session-1', source);
          assert.equal(result.ok, true);
          if (result.ok) assert.equal(result.text, `original ${source}`);
        }
        for (const id of ['fixture', 'deleted', 'malformed']) {
          assert.equal((await store.getInSession('session-1', id)).record, null);
        }
        store.close();
      }
    });
  });

  test('reclaims the bytes the v1 upgrade orphaned, including a user-deleted upload', async () => {
    await withInteractiveOwner(async (owner, root, track) => {
      const initial = await openInteractiveArtifactStoreForWrite(owner.lease);
      initial.close();
      const db = new DatabaseSync(join(root, 'runtime.sqlite'));
      db.exec(`
        DROP TABLE artifact_records;
        CREATE TABLE artifact_records (
          storage_key TEXT PRIMARY KEY, artifact_id TEXT NOT NULL,
          session_id TEXT NOT NULL, created_at INTEGER NOT NULL CHECK(created_at >= 0),
          status TEXT NOT NULL CHECK(status IN ('live', 'deleted')),
          relative_path TEXT NOT NULL, record_json TEXT NOT NULL
        );
        CREATE UNIQUE INDEX artifact_records_relative_path ON artifact_records(relative_path);
        UPDATE operational_schema_migrations SET version = 1 WHERE scope = 'artifact';
      `);
      // One row per reason the upgrade drops one, each with bytes on disk.
      const rows = [
        { id: 'live', name: 'quarterly numbers.csv', status: 'live', source: 'user_upload' },
        { id: 'erased', name: 'passport scan.pdf', status: 'deleted', source: 'user_upload' },
        {
          id: 'retired',
          name: 'provider-request-step-4-cap.json',
          status: 'live',
          source: 'provider_request_capture',
        },
        { id: 'sourceless', name: 'recap-request.json', status: 'live', source: undefined },
        { id: 'broken', name: 'unreadable.txt', status: 'live', source: 'tool_result' },
        { id: 'mismatched', name: 'inconsistent.txt', status: 'live', source: 'tool_result' },
        // Sorts first, and a directory cannot be unlinked, so it stands in for
        // any leftover the store cannot remove.
        { id: 'aborted', name: 'stuck', status: 'live', source: 'provider_request_capture' },
      ];
      await mkdir(join(root, 'artifacts', 'session-1'), { recursive: true });
      for (const row of rows) {
        const relativePath = `session-1/${row.id}-${row.name}`;
        if (row.id === 'aborted') await mkdir(join(root, 'artifacts', relativePath));
        else await writeFile(join(root, 'artifacts', relativePath), `bytes of ${row.id}`);
        db.prepare('INSERT INTO artifact_records VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          row.id,
          row.id,
          'session-1',
          1,
          row.status,
          relativePath,
          row.id === 'broken'
            ? '{'
            : JSON.stringify({
                id: row.id === 'mismatched' ? 'other-id' : row.id,
                sessionId: 'session-1',
                turnId: 'turn-1',
                createdAt: 1,
                name: row.name,
                kind: 'file',
                sizeBytes: `bytes of ${row.id}`.length,
                relativePath,
                ...(row.source ? { source: row.source } : {}),
                status: row.status,
              }),
        );
      }
      db.close();

      const store = track(await openInteractiveArtifactStoreForWrite(owner.lease));
      // Re-creating a dropped record's exact path before the reclamation runs
      // must keep the new bytes, not honour the note.
      await store.create({
        id: 'erased',
        sessionId: 'session-1',
        turnId: 'turn-2',
        name: 'passport scan.pdf',
        kind: 'file',
        content: 'uploaded again',
        source: 'user_upload',
      });
      let after: string | undefined;
      do {
        const batch = await store.reclaimUpgradeResidue({ after, maxPaths: 2 });
        assert.ok(batch.processedPaths <= 2);
        after = batch.nextAfter ?? undefined;
      } while (after);
      const retry = await store.reclaimUpgradeResidue({ maxPaths: 2 });
      assert.equal(retry.failedPaths, 1);
      assert.equal(retry.nextAfter, null);

      const path = (id: string) =>
        join(root, 'artifacts', `session-1/${id}-${rows.find((row) => row.id === id)!.name}`);
      for (const id of ['retired', 'sourceless', 'broken', 'mismatched']) {
        await assert.rejects(() => stat(path(id)), { code: 'ENOENT' });
      }
      assert.deepEqual(await store.readTextInSession('session-1', 'live'), {
        ok: true,
        text: 'bytes of live',
      });
      assert.deepEqual(await store.readTextInSession('session-1', 'erased'), {
        ok: true,
        text: 'uploaded again',
      });
      assert.equal((await stat(path('aborted'))).isDirectory(), true);
      store.close();

      // Everything behind the one that would not go was still reclaimed, and
      // only its own note survives for a later attempt.
      const remaining = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      assert.deepEqual(
        remaining
          .prepare('SELECT relative_path FROM artifact_upgrade_orphan_paths')
          .all()
          .map((row) => (row as { relative_path: string }).relative_path),
        ['session-1/aborted-stuck'],
      );
      remaining.close();
    });
  });

  test('does not follow a replaced parent directory while reclaiming upgrade residue', async (t) => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-artifact-upgrade-outside-'));
    try {
      await withInteractiveOwner(async (owner, root, track) => {
        const initial = await openInteractiveArtifactStoreForWrite(owner.lease);
        initial.close();
        const relativePath = 'session-1/retired-payload.txt';
        const db = new DatabaseSync(join(root, 'runtime.sqlite'));
        db.exec(`
          DROP TABLE artifact_records;
          CREATE TABLE artifact_records (
            storage_key TEXT PRIMARY KEY, artifact_id TEXT NOT NULL,
            session_id TEXT NOT NULL, created_at INTEGER NOT NULL CHECK(created_at >= 0),
            status TEXT NOT NULL CHECK(status IN ('live', 'deleted')),
            relative_path TEXT NOT NULL, record_json TEXT NOT NULL
          );
          CREATE UNIQUE INDEX artifact_records_relative_path ON artifact_records(relative_path);
          UPDATE operational_schema_migrations SET version = 1 WHERE scope = 'artifact';
        `);
        db.prepare('INSERT INTO artifact_records VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          'retired',
          'retired',
          'session-1',
          1,
          'live',
          relativePath,
          JSON.stringify({
            id: 'retired',
            sessionId: 'session-1',
            turnId: 'turn-1',
            createdAt: 1,
            name: 'payload.txt',
            kind: 'file',
            sizeBytes: 8,
            relativePath,
            source: 'provider_request_capture',
            status: 'live',
          }),
        );
        db.close();

        const artifactRoot = join(root, 'artifacts');
        const sessionRoot = join(artifactRoot, 'session-1');
        await mkdir(sessionRoot, { recursive: true });
        await writeFile(join(artifactRoot, relativePath), 'original', 'utf8');
        const store = track(await openInteractiveArtifactStoreForWrite(owner.lease));
        const displacedSessionRoot = join(artifactRoot, 'displaced-session-1');
        await rename(sessionRoot, displacedSessionRoot);
        const outsidePath = join(outsideRoot, 'retired-payload.txt');
        await writeFile(outsidePath, 'external', 'utf8');
        if (!(await createSymlinkOrSkip(t, outsideRoot, sessionRoot))) return;

        assert.deepEqual(await store.reclaimUpgradeResidue({ maxPaths: 64 }), {
          nextAfter: null,
          processedPaths: 1,
          failedPaths: 1,
        });

        assert.equal(await readFile(outsidePath, 'utf8'), 'external');
        assert.equal(
          await readFile(join(displacedSessionRoot, 'retired-payload.txt'), 'utf8'),
          'original',
        );
        assert.deepEqual(readUpgradeOrphanPaths(root), [relativePath]);
      });
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test('does not reclaim an upgrade orphan path that aliases a live artifact', async (t) => {
    await withInteractiveOwner(async (owner, root, track) => {
      if (!(await isCaseInsensitiveFilesystem(root))) {
        t.skip('requires a case-insensitive filesystem');
        return;
      }

      const initial = await openInteractiveArtifactStoreForWrite(owner.lease);
      initial.close();
      const liveRelativePath = 'session-1/SHARED-Payload.txt';
      const orphanRelativePath = 'session-1/shared-payload.txt';
      const db = new DatabaseSync(join(root, 'runtime.sqlite'));
      db.exec(`
        DROP TABLE artifact_records;
        CREATE TABLE artifact_records (
          storage_key TEXT PRIMARY KEY, artifact_id TEXT NOT NULL,
          session_id TEXT NOT NULL, created_at INTEGER NOT NULL CHECK(created_at >= 0),
          status TEXT NOT NULL CHECK(status IN ('live', 'deleted')),
          relative_path TEXT NOT NULL, record_json TEXT NOT NULL
        );
        CREATE UNIQUE INDEX artifact_records_relative_path ON artifact_records(relative_path);
        UPDATE operational_schema_migrations SET version = 1 WHERE scope = 'artifact';
      `);
      for (const [storageKey, artifactId, status, relativePath, name] of [
        ['live', 'SHARED', 'live', liveRelativePath, 'Payload.txt'],
        ['retired', 'shared', 'deleted', orphanRelativePath, 'payload.txt'],
      ] as const) {
        db.prepare('INSERT INTO artifact_records VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          storageKey,
          artifactId,
          'session-1',
          1,
          status,
          relativePath,
          JSON.stringify({
            id: artifactId,
            sessionId: 'session-1',
            turnId: 'turn-1',
            createdAt: 1,
            name,
            kind: 'file',
            sizeBytes: 10,
            relativePath,
            source: 'user_upload',
            status,
          }),
        );
      }
      db.close();

      await mkdir(join(root, 'artifacts', 'session-1'), { recursive: true });
      await writeFile(join(root, 'artifacts', liveRelativePath), 'live bytes', 'utf8');
      const store = track(await openInteractiveArtifactStoreForWrite(owner.lease));
      assert.deepEqual(readUpgradeOrphanPaths(root), [orphanRelativePath]);

      assert.deepEqual(await store.reclaimUpgradeResidue({ maxPaths: 64 }), {
        nextAfter: null,
        processedPaths: 1,
        failedPaths: 0,
      });

      assert.deepEqual(await store.readTextInSession('session-1', 'SHARED'), {
        ok: true,
        text: 'live bytes',
      });
      assert.deepEqual(readUpgradeOrphanPaths(root), []);
    });
  });

  test('requires authentic leases and writer facades', async () => {
    await assert.rejects(
      () =>
        openInteractiveArtifactStoreForWrite(
          {} as unknown as StorageRootLease<'interactive', 'write'>,
        ),
      invalidLease,
    );

    assert.throws(
      () =>
        authenticateInteractiveArtifactStoreWriter({} as unknown as InteractiveArtifactStoreWriter),
      invalidLease,
    );
  });

  test('returns one authenticated writer per lease and preserves mutation operations', async () => {
    await withInteractiveOwner(async (owner, root, track) => {
      const [first, second] = await Promise.all([
        openInteractiveArtifactStoreForWrite(owner.lease),
        openInteractiveArtifactStoreForWrite(owner.lease),
      ]);
      track(first);
      track(second);

      assert.strictEqual(first, second);
      assert.strictEqual(authenticateInteractiveArtifactStoreWriter(first), first);
      await first.create(artifactInput('deleted', 'delete me'));
      const deleted = await first.deleteUserArtifactInSession('session-1', 'deleted');

      assert.strictEqual(await openInteractiveArtifactStoreForWrite(owner.lease), first);
      assert.equal(deleted.kind, 'deleted');
      const page = await first.listPage('session-1', { offset: 0, limit: 1 });
      assert.equal(page.total, 0);
      assert.deepEqual(await first.getInSession('session-1', 'deleted'), {
        revision: page.revision,
        record: null,
      });
      assert.deepEqual(await first.readTextInSession('session-1', 'deleted'), {
        ok: false,
        reason: 'not_found',
      });
      assert.deepEqual(await first.readTextInSession('other-session', 'deleted'), {
        ok: false,
        reason: 'not_found',
      });
      await assert.rejects(() => stat(join(root, ARTIFACT_WRITER_LOCK_FILE)), { code: 'ENOENT' });

      first.close();
      const reopened = track(await openInteractiveArtifactStoreForWrite(owner.lease));
      assert.notStrictEqual(reopened, first);
      assert.equal((await reopened.getInSession('session-1', 'deleted')).record, null);
    });
  });

  test('root close revokes new facade operations after draining an in-flight write', async () => {
    await withTemporaryRoot('interactive', async (root, track) => {
      const capability = trackControlDirectory(
        await resolveStorageRoot({ path: root, kind: 'interactive' }),
      );
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      const writer = track(await openInteractiveArtifactStoreForWrite(owner.lease));
      const accepted = writer.create(
        artifactInput('accepted', new Uint8Array(8 * 1024 * 1024).fill(0x62)),
      );

      await owner.close();
      assert.equal((await accepted).id, 'accepted');
      await assert.rejects(
        () => writer.listPage('session-1', { offset: 0, limit: 1 }),
        invalidLease,
      );
    });
  });

  test('snapshots create inputs and makes user deletion idempotent', async () => {
    await withInteractiveOwner(async (owner, _root, track) => {
      const writer = track(await openInteractiveArtifactStoreForWrite(owner.lease));
      const bytes = Uint8Array.from([0x73, 0x61, 0x66, 0x65]);
      const createInput = artifactInput('accepted', bytes);
      const created = writer.create(createInput);
      createInput.id = 'mutated';
      createInput.sessionId = 'mutated-session';
      createInput.content = 'mutated';
      bytes.fill(0x78);

      const record = await created;
      assert.equal(record.id, 'accepted');
      assert.deepEqual(await writer.readTextInSession('session-1', 'accepted'), {
        ok: true,
        text: 'safe',
      });

      const deleted = writer.deleteUserArtifactInSession('session-1', record.id);
      assert.equal((await deleted).kind, 'deleted');
      assert.equal(
        (await writer.deleteUserArtifactInSession('session-1', record.id)).kind,
        'not_found',
      );
      assert.equal((await writer.getInSession('session-1', 'accepted')).record, null);
    });
  });
});

function artifactInput(id: string, content: string | Uint8Array) {
  return {
    id,
    sessionId: 'session-1',
    turnId: 'turn-1',
    name: `${id}.txt`,
    kind: 'file' as const,
    content,
    source: 'tool_result' as const,
    now: 1,
  };
}

function invalidLease(error: unknown): boolean {
  return error instanceof StorageRootAuthorityError && error.code === 'invalid_lease';
}

async function withInteractiveOwner(
  run: (
    owner: NonNullable<Awaited<ReturnType<typeof tryAcquireInteractiveRootOwner>>>,
    root: string,
    track: TrackArtifactWriter,
  ) => Promise<void>,
): Promise<void> {
  await withTemporaryRoot('interactive', async (root, track) => {
    const capability = trackControlDirectory(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    try {
      await run(owner, root, track);
    } finally {
      await owner.close();
    }
  });
}

async function withTemporaryRoot(
  kind: 'interactive',
  run: (root: string, track: TrackArtifactWriter) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `maka-artifact-${kind}-`));
  const writers = new Set<{ close(): void }>();
  const track: TrackArtifactWriter = (writer) => {
    writers.add(writer);
    return writer;
  };
  try {
    await run(root, track);
  } finally {
    for (const writer of [...writers].reverse()) writer.close();
    await rm(root, { recursive: true, force: true });
  }
}

type TrackArtifactWriter = <T extends { close(): void }>(writer: T) => T;

async function createSymlinkOrSkip(t: TestContext, target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
      t.skip('Windows symlink creation requires elevated privileges or Developer Mode');
      return false;
    }
    throw error;
  }
}

function readUpgradeOrphanPaths(root: string): string[] {
  const database = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
  try {
    return database
      .prepare('SELECT relative_path FROM artifact_upgrade_orphan_paths ORDER BY relative_path')
      .all()
      .map((row) => (row as { relative_path: string }).relative_path);
  } finally {
    database.close();
  }
}

async function isCaseInsensitiveFilesystem(directory: string): Promise<boolean> {
  const probe = join(directory, '.maka-case-sensitivity-probe');
  const alias = join(directory, '.MAKA-CASE-SENSITIVITY-PROBE');
  await writeFile(probe, 'probe', { flag: 'wx' });
  try {
    return await stat(alias).then(
      () => true,
      (error: unknown) => {
        if ((error as { code?: unknown }).code === 'ENOENT') return false;
        throw error;
      },
    );
  } finally {
    await rm(probe, { force: true });
  }
}
