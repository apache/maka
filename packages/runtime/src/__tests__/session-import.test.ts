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
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { OPERATIONAL_STATE_DATABASE_NAME } from '@maka/storage/operational-state-store';
import { createSessionStore } from '@maka/storage/session-store';
import { exportSessionBundle } from '../session-export.js';
import { importSessionBundle } from '../session-import.js';

const CONNECTION_SLUG = 'test-connection';
const MODEL = 'test-model';

async function makeWorkspace(name: string): Promise<{ root: string; workspaceRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  return { root, workspaceRoot };
}

async function createSession(workspaceRoot: string, name = 'Exported'): Promise<string> {
  const store = createSessionStore(workspaceRoot);
  try {
    const header = await store.create({
      cwd: workspaceRoot,
      llmConnectionSlug: CONNECTION_SLUG,
      model: MODEL,
      permissionMode: 'ask',
      name,
    });
    return header.id;
  } finally {
    await store.close?.();
  }
}

function openDatabase(workspaceRoot: string, readOnly = false): DatabaseSync {
  return new DatabaseSync(join(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME), {
    ...(readOnly ? { readOnly: true } : {}),
  });
}

/** Seed a Session with the history an import has to reproduce exactly. */
async function seedHistory(workspaceRoot: string, sessionId: string): Promise<void> {
  const db = openDatabase(workspaceRoot);
  try {
    db.exec(`
      INSERT INTO runtime_events(
        session_id, run_id, invocation_id, turn_id, event_id, event_seq,
        event_kind, committed_at, payload_json
      )
      VALUES
        ('${sessionId}', 'run-1', 'invocation-1', 'turn-1', 'evt-user', 1, 'text', 1,
          '{ "role": "user", "big": 9007199254740993 }'),
        ('${sessionId}', 'run-1', 'invocation-1', 'turn-1', 'evt-model', 2, 'text', 2,
          '{"role":"model","text":"ok"}'),
        ('${sessionId}', 'run-1', 'invocation-1', 'turn-1', 'evt-done', 3, 'completed', 3,
          '{"status":"completed"}');
      INSERT INTO core_agent_runs(session_id, run_id, created_at)
      VALUES ('${sessionId}', 'run-1', 0);
      INSERT INTO core_agent_run_events(
        session_id, run_id, sequence, event_id, event_type, event_ts, record_json
      )
      VALUES ('${sessionId}', 'run-1', 0, 'ckpt', 'history_compact_checkpoint_recorded', 1,
        '{ "checkpoint": {"kept":true} }');
    `);
  } finally {
    db.close();
  }
}

function readSessionRows(
  workspaceRoot: string,
  sessionId: string,
): { events: unknown[]; runEvents: unknown[]; metadata: unknown } {
  const db = openDatabase(workspaceRoot, true);
  try {
    return {
      events: db
        .prepare('SELECT * FROM runtime_events WHERE session_id = ? ORDER BY event_seq')
        .all(sessionId),
      runEvents: db
        .prepare('SELECT * FROM core_agent_run_events WHERE session_id = ? ORDER BY sequence')
        .all(sessionId),
      metadata: db.prepare('SELECT * FROM session_metadata WHERE session_id = ?').get(sessionId),
    };
  } finally {
    db.close();
  }
}

test('round-trips a Session into another workspace, row for row', async () => {
  const source = await makeWorkspace('maka-import-source');
  const target = await makeWorkspace('maka-import-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    // Somebody else's Session, so the target is not an empty database.
    await createSession(target.workspaceRoot, 'Unrelated');

    const bundle = join(source.root, 'bundle.maka-session');
    const exported = await exportSessionBundle({
      workspaceRoot: source.workspaceRoot,
      sessionId,
      destination: bundle,
    });
    assert.equal(exported.ok, true);

    const imported = await importSessionBundle({
      workspaceRoot: target.workspaceRoot,
      source: bundle,
    });
    if (!imported.ok) assert.fail(`import failed: ${JSON.stringify(imported.reason)}`);
    assert.deepEqual(imported.sessionIds, [sessionId]);

    // The acceptance criterion: the rows the model reads are the same rows,
    // as bytes. JSON equivalence would pass on a re-encoding that changed them.
    assert.deepEqual(
      readSessionRows(target.workspaceRoot, sessionId),
      readSessionRows(source.workspaceRoot, sessionId),
    );

    // And the workspace it landed in kept what it already had.
    const db = openDatabase(target.workspaceRoot, true);
    try {
      const count = db.prepare('SELECT COUNT(*) AS count FROM session_metadata').get() as {
        count?: unknown;
      };
      assert.equal(Number(count.count), 2);
    } finally {
      db.close();
    }
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('refuses a Session this workspace already has', async () => {
  const source = await makeWorkspace('maka-import-conflict');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    const bundle = join(source.root, 'bundle.maka-session');
    await exportSessionBundle({
      workspaceRoot: source.workspaceRoot,
      sessionId,
      destination: bundle,
    });

    // Importing back into the workspace it came from. Session ids are
    // generated, so one already present means this Session is already here.
    const result = await importSessionBundle({
      workspaceRoot: source.workspaceRoot,
      source: bundle,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason.kind, 'session_exists');

    const db = openDatabase(source.workspaceRoot, true);
    try {
      const count = db.prepare('SELECT COUNT(*) AS count FROM runtime_events').get() as {
        count?: unknown;
      };
      // A refusal writes nothing: the history is what it was.
      assert.equal(Number(count.count), 3);
    } finally {
      db.close();
    }
  } finally {
    await rm(source.root, { recursive: true, force: true });
  }
});

test('carries the subagent subtree and its artifact bytes across', async () => {
  const source = await makeWorkspace('maka-import-subtree-source');
  const target = await makeWorkspace('maka-import-subtree-target');
  try {
    const store = createSessionStore(source.workspaceRoot);
    let parentId: string;
    let childId: string;
    try {
      const parent = await store.create({
        cwd: source.workspaceRoot,
        llmConnectionSlug: CONNECTION_SLUG,
        model: MODEL,
        permissionMode: 'ask',
      });
      parentId = parent.id;
      const child = await store.createSubagent({
        cwd: source.workspaceRoot,
        llmConnectionSlug: CONNECTION_SLUG,
        model: MODEL,
        permissionMode: 'ask',
        subagentParent: {
          kind: 'subagent' as const,
          parentSessionId: parent.id,
          spawnedBy: { parentRunId: 'r', parentTurnId: 't', toolCallId: 'call-1' },
          lifecycle: 'foreground',
        },
        subagentRuntime: {
          schemaVersion: 1,
          definitionVersion: 1,
          agentId: 'local-read',
          agentName: 'Local Read',
          profile: 'local_read',
          systemPrompt: 'Read.',
          toolNames: ['Read'],
          categoryPolicy: { read: 'allow' },
        },
        subagentSpawn: {
          schemaVersion: 1,
          requestFingerprint: 'a'.repeat(64),
          initialTurnId: 'child-turn',
          initialRunId: 'child-run',
        },
      } as Parameters<typeof store.createSubagent>[0]);
      childId = child.header.id;
    } finally {
      await store.close?.();
    }

    const relativePath = `${childId}/child-file.txt`;
    await mkdir(join(source.workspaceRoot, 'artifacts', childId), { recursive: true });
    await writeFile(join(source.workspaceRoot, 'artifacts', relativePath), 'CHILD-BYTES');
    const db = openDatabase(source.workspaceRoot);
    try {
      db.prepare(`
        INSERT INTO artifact_records(artifact_id, session_id, created_at, relative_path, record_json)
        VALUES ('child', ?, 0, ?, ?)
      `).run(
        childId,
        relativePath,
        JSON.stringify({
          id: 'child',
          sessionId: childId,
          turnId: 'turn-1',
          createdAt: 0,
          name: 'file.txt',
          kind: 'file',
          relativePath,
          sizeBytes: 11,
          source: 'tool_result',
        }),
      );
    } finally {
      db.close();
    }

    const bundle = join(source.root, 'bundle.maka-session');
    await exportSessionBundle({
      workspaceRoot: source.workspaceRoot,
      sessionId: parentId,
      destination: bundle,
    });
    const imported = await importSessionBundle({
      workspaceRoot: target.workspaceRoot,
      source: bundle,
    });
    if (!imported.ok) assert.fail(`import failed: ${JSON.stringify(imported.reason)}`);

    assert.deepEqual([...imported.sessionIds].sort(), [parentId, childId].sort());
    assert.equal(imported.artifactFiles, 1);
    // The link is not the child Session: without `subagent_spawns` the target
    // holds two Sessions and nothing saying which tool call joined them.
    const targetDb = openDatabase(target.workspaceRoot, true);
    try {
      const link = targetDb
        .prepare('SELECT parent_session_id FROM subagent_spawns WHERE child_session_id = ?')
        .get(childId) as { parent_session_id?: unknown };
      assert.equal(String(link?.parent_session_id), parentId);
    } finally {
      targetDb.close();
    }
    const { readFile } = await import('node:fs/promises');
    assert.equal(
      await readFile(join(target.workspaceRoot, 'artifacts', relativePath), 'utf8'),
      'CHILD-BYTES',
    );
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('leaves the shared workspace connection as it found it', async () => {
  const source = await makeWorkspace('maka-import-pragma-source');
  const target = await makeWorkspace('maka-import-pragma-target');
  const { acquireOperationalStateDatabase } = await import('@maka/storage/operational-state-store');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    await createSession(target.workspaceRoot, 'Unrelated');
    const bundle = join(source.root, 'bundle.maka-session');
    await exportSessionBundle({
      workspaceRoot: source.workspaceRoot,
      sessionId,
      destination: bundle,
    });

    // Hold a lease across the import, the way a running Runtime Host does. The
    // operational store hands out one reference-counted connection per
    // workspace, and `PRAGMA foreign_keys` is per-connection: reading it on a
    // fresh handle would report the default no matter what the import did.
    // The import canonicalises the root before acquiring, so a lease taken on
    // the uncanonicalised path would be a different connection and this test
    // would observe nothing.
    const { realpath } = await import('node:fs/promises');
    const held = acquireOperationalStateDatabase(await realpath(target.workspaceRoot));
    try {
      const before = readForeignKeys(held.database);
      assert.equal(before, 1);

      const imported = await importSessionBundle({
        workspaceRoot: target.workspaceRoot,
        source: bundle,
      });
      assert.equal(imported.ok, true);

      // The merge must disable foreign keys to insert in table order. Leaving
      // the pragma off would silently disarm constraint checking for every
      // later user of this workspace -- a failure nothing would report.
      assert.equal(readForeignKeys(held.database), before);
    } finally {
      held.close();
    }
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

function readForeignKeys(database: DatabaseSync): number {
  const row = (database.prepare('PRAGMA foreign_keys').get() ?? {}) as Record<string, unknown>;
  return Number(Object.values(row)[0] ?? 0);
}

test('refuses a bundle written against a different schema', async () => {
  const source = await makeWorkspace('maka-import-schema-source');
  const target = await makeWorkspace('maka-import-schema-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    await createSession(target.workspaceRoot, 'Unrelated');
    const bundle = join(source.root, 'bundle.maka-session');
    await exportSessionBundle({
      workspaceRoot: source.workspaceRoot,
      sessionId,
      destination: bundle,
    });

    // Hydrate and tamper, which is the only way to hold a bundle from a build
    // that is not this one. The merge copies rows with `INSERT ... SELECT *`,
    // which maps by position: a bundle whose tables carry the same column count
    // in a different order would be inserted transposed -- rows that read as
    // data and are not.
    const { createSessionBundleFileService } = await import(
      '@maka/storage/session-bundle-file-service'
    );
    const { importSessionBundleState } = await import('@maka/storage/session-bundle-policy');
    const { SESSION_EXPORT_BUNDLE_LIMITS } = await import('../session-export.js');
    const hydration = await createSessionBundleFileService().hydrate({
      source: { path: bundle },
      limits: SESSION_EXPORT_BUNDLE_LIMITS,
      expectedSessionId: sessionId,
      destinationRoot: join(source.root, 'hydrated'),
    });
    const bundleDb = new DatabaseSync(join(hydration.stateRoot, OPERATIONAL_STATE_DATABASE_NAME));
    try {
      bundleDb.exec(
        "UPDATE operational_schema_migrations SET version = version + 1 WHERE scope = 'usage'",
      );
    } finally {
      bundleDb.close();
    }

    await assert.rejects(
      () =>
        importSessionBundleState({
          stateRoot: target.workspaceRoot,
          bundleStateRoot: hydration.stateRoot,
        }),
      (error: unknown) => (error as { code?: string }).code === 'schema_unsupported',
    );

    const after = openDatabase(target.workspaceRoot, true);
    try {
      const count = after.prepare('SELECT COUNT(*) AS count FROM session_metadata').get() as {
        count?: unknown;
      };
      assert.equal(Number(count.count), 1);
    } finally {
      after.close();
    }
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

/** Give a workspace a context store holding one managed-file payload. */
async function seedContext(
  workspaceRoot: string,
  sessionId: string,
  bytes: string,
): Promise<{ relativePath: string; blobId: Buffer }> {
  // The offline context authority only works on a marked Storage Root, so a
  // workspace holding context has to be one.
  const { resolveStorageRoot } = await import('@maka/storage/root-authority');
  await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(bytes).digest();
  const hex = digest.toString('hex');
  // The layout the context store uses: a payload is addressed by its content.
  const relativePath = `sha256/${hex.slice(0, 2)}/${hex}`;
  const values = join(workspaceRoot, 'context-offload-values');
  await mkdir(join(values, 'sha256', hex.slice(0, 2)), { recursive: true });
  await writeFile(join(values, relativePath), bytes);

  const db = new DatabaseSync(join(workspaceRoot, 'context-offload.sqlite'));
  try {
    // The real v3 shape, not an approximation: `reference_count`, an owner kind
    // the CHECK accepts, and the columns the store actually writes. A fixture
    // that only resembles it proves the SQL runs, not that the imported store
    // is usable by the store that has to read it.
    db.exec(`
      PRAGMA user_version = 3;
      CREATE TABLE context_blobs (
        blob_id BLOB PRIMARY KEY CHECK(length(blob_id) = 32),
        storage_kind TEXT NOT NULL CHECK(storage_kind IN ('inline', 'managed_file')),
        payload BLOB NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        CHECK(
          (storage_kind = 'inline' AND length(payload) = size_bytes) OR
          (storage_kind = 'managed_file' AND length(payload) BETWEEN 1 AND 512)
        )
      );
      CREATE TABLE context_refs (
        ref_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        owner_kind TEXT NOT NULL CHECK(
          owner_kind IN ('read_image_snapshot', 'tool_result_archive')
        ),
        owner_id TEXT NOT NULL,
        blob_id BLOB NOT NULL REFERENCES context_blobs(blob_id) ON DELETE RESTRICT,
        media_type TEXT NOT NULL,
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        UNIQUE(session_id, owner_kind, owner_id)
      );
      CREATE TABLE context_gc_candidates (
        blob_id BLOB PRIMARY KEY REFERENCES context_blobs(blob_id) ON DELETE CASCADE,
        unreferenced_at INTEGER NOT NULL CHECK(unreferenced_at >= 0)
      );
      CREATE TABLE context_file_deletions (
        locator BLOB PRIMARY KEY CHECK(length(locator) BETWEEN 1 AND 512),
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        enqueued_at INTEGER NOT NULL CHECK(enqueued_at >= 0)
      );
      CREATE TABLE context_session_usage (
        session_id TEXT PRIMARY KEY,
        reference_count INTEGER NOT NULL CHECK(reference_count >= 0),
        logical_bytes INTEGER NOT NULL CHECK(logical_bytes >= 0)
      );
      CREATE TABLE context_store_usage (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        blob_count INTEGER NOT NULL CHECK(blob_count >= 0),
        physical_bytes INTEGER NOT NULL CHECK(physical_bytes >= 0)
      );
      INSERT INTO context_store_usage VALUES (1, 0, 0);
    `);
    db.prepare('INSERT INTO context_blobs VALUES (?, ?, ?, ?, 0)').run(
      digest,
      'managed_file',
      Buffer.from(relativePath, 'utf8'),
      bytes.length,
    );
    db.prepare('INSERT INTO context_refs VALUES (?, ?, ?, ?, ?, ?, 0)').run(
      `ref-${sessionId}`,
      sessionId,
      'read_image_snapshot',
      `owner-${sessionId}`,
      digest,
      'image/png',
    );
    db.exec(`
      INSERT INTO context_session_usage
        SELECT r.session_id, count(*), sum(b.size_bytes)
        FROM context_refs r JOIN context_blobs b USING(blob_id) GROUP BY r.session_id;
      UPDATE context_store_usage SET
        blob_count = (SELECT count(*) FROM context_blobs),
        physical_bytes = (SELECT coalesce(sum(size_bytes), 0) FROM context_blobs)
      WHERE singleton = 1;
    `);
  } finally {
    db.close();
  }
  return { relativePath, blobId: digest };
}

function readContextUsage(workspaceRoot: string): {
  blobCount: number;
  physicalBytes: number;
  sessionRows: number;
} {
  const db = new DatabaseSync(join(workspaceRoot, 'context-offload.sqlite'), { readOnly: true });
  try {
    const store = db.prepare('SELECT blob_count, physical_bytes FROM context_store_usage').get() as
      | { blob_count?: unknown; physical_bytes?: unknown }
      | undefined;
    const sessions = db.prepare('SELECT COUNT(*) AS count FROM context_session_usage').get() as {
      count?: unknown;
    };
    return {
      blobCount: Number(store?.blob_count ?? -1),
      physicalBytes: Number(store?.physical_bytes ?? -1),
      sessionRows: Number(sessions.count ?? -1),
    };
  } finally {
    db.close();
  }
}

test('carries managed context payloads and keeps usage accounting true', async () => {
  const source = await makeWorkspace('maka-import-context-source');
  const target = await makeWorkspace('maka-import-context-target');
  try {
    // Build the bundle's state tree directly. The merge is what these findings
    // are about, and going through pack/hydrate to reach it only adds the
    // Storage Root machinery to the fixture.
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    const payload = 'IMG';
    const seeded = await seedContext(source.workspaceRoot, sessionId, payload);

    const targetSession = await createSession(target.workspaceRoot, 'Unrelated');
    await seedContext(target.workspaceRoot, targetSession, 'ZZ');

    const { importSessionBundleState } = await import('@maka/storage/session-bundle-policy');
    const merged = await importSessionBundleState({
      stateRoot: target.workspaceRoot,
      bundleStateRoot: source.workspaceRoot,
    });
    assert.equal(merged.contextRefs, 1);

    // Read the payload rather than count the reference: a reference whose bytes
    // never arrived counts exactly the same. Managed payloads live at
    // `sha256/<prefix>/<hash>`, so a copy that visited only immediate children
    // saw one directory, skipped it, and reported success.
    const { readFile } = await import('node:fs/promises');
    assert.equal(
      await readFile(
        join(target.workspaceRoot, 'context-offload-values', seeded.relativePath),
        'utf8',
      ),
      payload,
    );

    // These numbers drive quotas and the cleanup consistency checks, and no
    // trigger maintains them, so a stale count is not a display problem.
    const usage = readContextUsage(target.workspaceRoot);
    assert.equal(usage.blobCount, 2);
    assert.equal(usage.physicalBytes, 5);
    assert.equal(usage.sessionRows, 2);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

async function seedArtifact(
  workspaceRoot: string,
  sessionId: string,
  artifactId: string,
  bytes: string,
): Promise<string> {
  const relativePath = `${sessionId}/${artifactId}-file.txt`;
  await mkdir(join(workspaceRoot, 'artifacts', sessionId), { recursive: true });
  await writeFile(join(workspaceRoot, 'artifacts', relativePath), bytes);
  const db = openDatabase(workspaceRoot);
  try {
    db.prepare(`
      INSERT INTO artifact_records(artifact_id, session_id, created_at, relative_path, record_json)
      VALUES (?, ?, 0, ?, ?)
    `).run(
      artifactId,
      sessionId,
      relativePath,
      JSON.stringify({
        id: artifactId,
        sessionId,
        turnId: 'turn-1',
        createdAt: 0,
        name: 'file.txt',
        kind: 'file',
        relativePath,
        sizeBytes: bytes.length,
        source: 'tool_result',
      }),
    );
  } finally {
    db.close();
  }
  return relativePath;
}

async function importState(
  target: string,
  bundle: string,
): Promise<{ sessionIds: readonly string[]; artifactFiles: number; contextRefs: number }> {
  const { importSessionBundleState } = await import('@maka/storage/session-bundle-policy');
  return importSessionBundleState({ stateRoot: target, bundleStateRoot: bundle });
}

test('a failed context merge leaves nothing published and the retry then succeeds', async () => {
  const source = await makeWorkspace('maka-import-retry-source');
  const target = await makeWorkspace('maka-import-retry-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    const seeded = await seedContext(source.workspaceRoot, sessionId, 'ABC');
    const artifactPath = await seedArtifact(source.workspaceRoot, sessionId, 'a1', 'BYTES');

    const targetSession = await createSession(target.workspaceRoot, 'Unrelated');
    const kept = await seedContext(target.workspaceRoot, targetSession, 'ZZ');
    // Collide the reference ids so the context merge fails partway. Any context
    // failure would do; this one needs no injection point in the code.
    const collide = new DatabaseSync(join(target.workspaceRoot, 'context-offload.sqlite'));
    try {
      collide.prepare('UPDATE context_refs SET ref_id = ?').run(`ref-${sessionId}`);
    } finally {
      collide.close();
    }

    await assert.rejects(() => importState(target.workspaceRoot, source.workspaceRoot));

    // The Session rows are the last thing written, so a failure reaching them
    // leaves nothing published. Had they gone first, the ids would now be taken
    // and the retry would report `session_exists` forever.
    const after = openDatabase(target.workspaceRoot, true);
    try {
      const present = after
        .prepare('SELECT COUNT(*) AS count FROM session_metadata WHERE session_id = ?')
        .get(sessionId) as { count?: unknown };
      assert.equal(Number(present.count), 0);
    } finally {
      after.close();
    }

    // The artifact staged by the failed attempt is the part that used to make
    // the retry impossible: `COPYFILE_EXCL` refused its own leftover and the
    // import reported a conflict against itself, forever.
    const repair = new DatabaseSync(join(target.workspaceRoot, 'context-offload.sqlite'));
    try {
      repair.prepare('UPDATE context_refs SET ref_id = ?').run(`ref-${targetSession}`);
    } finally {
      repair.close();
    }
    const retried = await importState(target.workspaceRoot, source.workspaceRoot);
    assert.deepEqual([...retried.sessionIds], [sessionId]);
    assert.equal(retried.artifactFiles, 1);
    assert.equal(retried.contextRefs, 1);

    // Both payloads, not just the count: the retry must neither lose the bytes
    // it staged nor overwrite what was already in the target.
    const { readFile } = await import('node:fs/promises');
    const values = join(target.workspaceRoot, 'context-offload-values');
    assert.equal(
      await readFile(join(target.workspaceRoot, 'artifacts', artifactPath), 'utf8'),
      'BYTES',
    );
    assert.equal(await readFile(join(values, seeded.relativePath), 'utf8'), 'ABC');
    assert.equal(await readFile(join(values, kept.relativePath), 'utf8'), 'ZZ');
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('a failure after the context commit is still retryable', async () => {
  const source = await makeWorkspace('maka-import-late-source');
  const target = await makeWorkspace('maka-import-late-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    const seeded = await seedContext(source.workspaceRoot, sessionId, 'ABC');
    await seedArtifact(source.workspaceRoot, sessionId, 'shared', 'BYTES');

    const targetSession = await createSession(target.workspaceRoot, 'Unrelated');
    await seedContext(target.workspaceRoot, targetSession, 'ZZ');
    // An artifact id already taken by a Session the bundle knows nothing about.
    // The importability check reads Session ids, so this passes it and fails in
    // the operational merge -- after the context transaction has committed.
    await seedArtifact(target.workspaceRoot, targetSession, 'shared', 'OTHER');

    await assert.rejects(() => importState(target.workspaceRoot, source.workspaceRoot));

    const clear = openDatabase(target.workspaceRoot);
    try {
      clear.prepare('DELETE FROM artifact_records WHERE artifact_id = ?').run('shared');
    } finally {
      clear.close();
    }

    // Context rows survived the failure, so the retry re-inserts rows that are
    // already there. A plain INSERT makes that second attempt fail on its own
    // predecessor.
    const retried = await importState(target.workspaceRoot, source.workspaceRoot);
    assert.deepEqual([...retried.sessionIds], [sessionId]);
    const { readFile } = await import('node:fs/promises');
    assert.equal(
      await readFile(
        join(target.workspaceRoot, 'context-offload-values', seeded.relativePath),
        'utf8',
      ),
      'ABC',
    );
    assert.equal(readContextUsage(target.workspaceRoot).blobCount, 2);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('keeps bytes queued for deletion in the physical total', async () => {
  const source = await makeWorkspace('maka-import-pending-source');
  const target = await makeWorkspace('maka-import-pending-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    await seedContext(source.workspaceRoot, sessionId, 'ABC');

    const targetSession = await createSession(target.workspaceRoot, 'Unrelated');
    await seedContext(target.workspaceRoot, targetSession, 'ZZ');
    // A blob already dropped from the table whose file has not been drained
    // yet. Its bytes are on disk and still charged; the drain will subtract
    // them, so a total recomputed from live blobs alone underflows.
    const pending = new DatabaseSync(join(target.workspaceRoot, 'context-offload.sqlite'));
    try {
      pending
        .prepare('INSERT INTO context_file_deletions VALUES (?, 7, 0)')
        .run(Buffer.from('sha256/aa/pending', 'utf8'));
      pending.exec('UPDATE context_store_usage SET physical_bytes = physical_bytes + 7');
    } finally {
      pending.close();
    }

    await importState(target.workspaceRoot, source.workspaceRoot);

    // 3 imported + 2 already there + 7 queued.
    assert.equal(readContextUsage(target.workspaceRoot).physicalBytes, 12);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('imports context into a workspace that has never held a Session', async () => {
  const source = await makeWorkspace('maka-import-fresh-source');
  const target = await makeWorkspace('maka-import-fresh-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    const seeded = await seedContext(source.workspaceRoot, sessionId, 'ABC');

    // Nothing has run here: no Storage Root marker, no context database. The
    // snapshot lock used to only *discover* a marked root, so the first import
    // into a new workspace failed `root_unmarked` -- exactly the case a user
    // hits when they receive a bundle before starting any Session.
    const imported = await importState(target.workspaceRoot, source.workspaceRoot);
    assert.deepEqual([...imported.sessionIds], [sessionId]);
    assert.equal(imported.contextRefs, 1);

    const { readFile } = await import('node:fs/promises');
    assert.equal(
      await readFile(
        join(target.workspaceRoot, 'context-offload-values', seeded.relativePath),
        'utf8',
      ),
      'ABC',
    );
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('accepts an identical artifact left by a crashed attempt, and only an identical one', async () => {
  const source = await makeWorkspace('maka-import-leftover-source');
  const target = await makeWorkspace('maka-import-leftover-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    const relativePath = await seedArtifact(source.workspaceRoot, sessionId, 'a1', 'BYTES');

    // A crash between staging the artifact and the rollback leaves the file
    // behind with no row to explain it. `COPYFILE_EXCL` refuses it, so without
    // this the workspace can never import that bundle again.
    const staged = join(target.workspaceRoot, 'artifacts', relativePath);
    await mkdir(join(target.workspaceRoot, 'artifacts', sessionId), { recursive: true });
    await writeFile(staged, 'DIFFERENT');
    await assert.rejects(
      () => importState(target.workspaceRoot, source.workspaceRoot),
      /Artifact already present/,
      'a leftover naming different bytes is a real collision, not a retry',
    );

    await writeFile(staged, 'BYTES');
    const imported = await importState(target.workspaceRoot, source.workspaceRoot);
    assert.deepEqual([...imported.sessionIds], [sessionId]);
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(staged, 'utf8'), 'BYTES');
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('refuses a context payload whose path already holds different bytes', async () => {
  const source = await makeWorkspace('maka-import-payload-source');
  const target = await makeWorkspace('maka-import-payload-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    const seeded = await seedContext(source.workspaceRoot, sessionId, 'ABC');

    const targetSession = await createSession(target.workspaceRoot, 'Unrelated');
    await seedContext(target.workspaceRoot, targetSession, 'ZZ');

    // Payloads are addressed by the hash of their content, so the same path in
    // two workspaces is supposed to mean the same bytes. When it does not, the
    // target holds something this bundle cannot explain -- and the import used
    // to swallow `EEXIST` and report success over it.
    const occupied = join(target.workspaceRoot, 'context-offload-values', seeded.relativePath);
    await mkdir(dirname(occupied), { recursive: true });
    await writeFile(occupied, 'NOT-THE-SAME');

    await assert.rejects(
      () => importState(target.workspaceRoot, source.workspaceRoot),
      /Context payload already names different content/,
    );

    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(occupied, 'utf8'), 'NOT-THE-SAME', 'the other payload survives');
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('publishes a context payload past a staging file a crashed attempt left', async () => {
  const source = await makeWorkspace('maka-import-staging-source');
  const target = await makeWorkspace('maka-import-staging-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    const seeded = await seedContext(source.workspaceRoot, sessionId, 'ABC');

    const targetSession = await createSession(target.workspaceRoot, 'Unrelated');
    await seedContext(target.workspaceRoot, targetSession, 'ZZ');

    // A payload now becomes visible by `link`, so an interrupted copy leaves its
    // half-written bytes under the staging name rather than at the path other
    // Sessions read. The retry has to get past its own leftover.
    const values = join(target.workspaceRoot, 'context-offload-values');
    const destination = join(values, seeded.relativePath);
    const staging = join(dirname(destination), `.${basename(destination)}.import.tmp`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(staging, 'HALF');

    const imported = await importState(target.workspaceRoot, source.workspaceRoot);
    assert.equal(imported.contextRefs, 1);

    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(destination, 'utf8'), 'ABC', 'the leftover was not published');
    assert.deepEqual(
      (await readdir(dirname(destination))).filter((name) => name.endsWith('.import.tmp')),
      [],
      'staging files do not outlive the import',
    );
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('imports under authority the caller already holds', async () => {
  const source = await makeWorkspace('maka-import-lease-source');
  const target = await makeWorkspace('maka-import-lease-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    const seeded = await seedContext(source.workspaceRoot, sessionId, 'ABC');
    await createSession(target.workspaceRoot, 'Unrelated');

    const { resolveStorageRoot, tryAcquireInteractiveRootOwner } = await import(
      '@maka/storage/root-authority'
    );
    const { importSessionBundleState } = await import('@maka/storage/session-bundle-policy');

    // What a Runtime Host is: it took this authority at startup and holds it
    // for its lifetime.
    const capability = await resolveStorageRoot({
      path: target.workspaceRoot,
      kind: 'interactive',
    });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner, 'the probe must hold the authority for this test to mean anything');
    try {
      // The lock is an election, not a mutex: it refuses a second hold even
      // from the process already holding it, so electing here cannot work.
      await assert.rejects(
        () =>
          importSessionBundleState({
            stateRoot: target.workspaceRoot,
            bundleStateRoot: source.workspaceRoot,
          }),
        /offline Storage Root/,
      );

      const imported = await importSessionBundleState({
        stateRoot: target.workspaceRoot,
        bundleStateRoot: source.workspaceRoot,
        lease: owner.lease,
      });
      assert.deepEqual([...imported.sessionIds], [sessionId]);
      assert.equal(imported.contextRefs, 1);
      const { readFile } = await import('node:fs/promises');
      assert.equal(
        await readFile(
          join(target.workspaceRoot, 'context-offload-values', seeded.relativePath),
          'utf8',
        ),
        'ABC',
      );
    } finally {
      await owner?.close();
    }
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('refuses a lease that names a different Storage Root', async () => {
  const source = await makeWorkspace('maka-import-wrong-lease-source');
  const target = await makeWorkspace('maka-import-wrong-lease-target');
  const other = await makeWorkspace('maka-import-wrong-lease-other');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    await seedContext(source.workspaceRoot, sessionId, 'ABC');
    await createSession(target.workspaceRoot, 'Unrelated');
    await createSession(other.workspaceRoot, 'Elsewhere');

    const { resolveStorageRoot, tryAcquireInteractiveRootOwner } = await import(
      '@maka/storage/root-authority'
    );
    const { importSessionBundleState } = await import('@maka/storage/session-bundle-policy');

    // A valid lease is still only authority over the root it names. Accepting
    // one for a different root would write to a directory nobody holds.
    const capability = await resolveStorageRoot({ path: other.workspaceRoot, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    try {
      await assert.rejects(
        () =>
          importSessionBundleState({
            stateRoot: target.workspaceRoot,
            bundleStateRoot: source.workspaceRoot,
            lease: owner.lease,
          }),
        /does not name this Storage Root/,
      );
    } finally {
      await owner?.close();
    }
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
    await rm(other.root, { recursive: true, force: true });
  }
});

test('refuses a bundle whose payload does not hash to what its row claims', async () => {
  const source = await makeWorkspace('maka-import-tamper-source');
  const target = await makeWorkspace('maka-import-tamper-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    const seeded = await seedContext(source.workspaceRoot, sessionId, 'ABC');
    await createSession(target.workspaceRoot, 'Unrelated');

    // An archive digest authenticates the archive, not the state inside it: it
    // says the bytes arrived as sent, not that a row claiming a hash names a
    // file that hashes to it. Without validating the hydrated state, this
    // imports and publishes a reference to content nobody can read back.
    await writeFile(
      join(source.workspaceRoot, 'context-offload-values', seeded.relativePath),
      'XYZ',
    );

    await assert.rejects(() => importState(target.workspaceRoot, source.workspaceRoot));

    // Rejected before the target was touched, not midway through it.
    const after = openDatabase(target.workspaceRoot, true);
    try {
      const present = after
        .prepare('SELECT COUNT(*) AS count FROM session_metadata WHERE session_id = ?')
        .get(sessionId) as { count?: unknown };
      assert.equal(Number(present.count), 0);
    } finally {
      after.close();
    }
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('refuses to publish through a payload directory that leaves the Storage Root', async () => {
  const source = await makeWorkspace('maka-import-escape-source');
  const target = await makeWorkspace('maka-import-escape-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    await seedContext(source.workspaceRoot, sessionId, 'ABC');
    const targetSession = await createSession(target.workspaceRoot, 'Unrelated');
    await seedContext(target.workspaceRoot, targetSession, 'ZZ');

    // Containment by string comparison says nothing about what the path
    // resolves to. With the payload directory replaced by a symlink, a lexical
    // check passes and the payloads land outside the workspace entirely.
    const { symlink } = await import('node:fs/promises');
    const values = join(target.workspaceRoot, 'context-offload-values');
    const elsewhere = join(target.root, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await rm(values, { recursive: true, force: true });
    await symlink(elsewhere, values);

    await assert.rejects(
      () => importState(target.workspaceRoot, source.workspaceRoot),
      /escapes the Storage Root/,
    );
    assert.deepEqual(await readdir(elsewhere), [], 'nothing was written outside the root');
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('clears the collection candidate of a blob the import references again', async () => {
  const source = await makeWorkspace('maka-import-gc-source');
  const target = await makeWorkspace('maka-import-gc-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    const seeded = await seedContext(source.workspaceRoot, sessionId, 'ABC');
    const targetSession = await createSession(target.workspaceRoot, 'Unrelated');
    await seedContext(target.workspaceRoot, targetSession, 'ABC');

    // The target holds the same content -- payloads are content-addressed, so
    // this is the ordinary case -- and it was queued for collection while
    // nothing referenced it. The import references it again.
    const queue = new DatabaseSync(join(target.workspaceRoot, 'context-offload.sqlite'));
    try {
      queue.exec(`
        DELETE FROM context_refs;
        DELETE FROM context_session_usage;
        INSERT INTO context_gc_candidates SELECT blob_id, 0 FROM context_blobs;
      `);
    } finally {
      queue.close();
    }

    await importState(target.workspaceRoot, source.workspaceRoot);

    // Left behind, the next collection fails outright and keeps failing: the
    // candidate is referenced, which collection treats as corruption.
    const after = new DatabaseSync(join(target.workspaceRoot, 'context-offload.sqlite'), {
      readOnly: true,
    });
    try {
      const stranded = after
        .prepare(`
          SELECT COUNT(*) AS count FROM context_gc_candidates
          WHERE blob_id IN (SELECT blob_id FROM context_refs)
        `)
        .get() as { count?: unknown };
      assert.equal(Number(stranded.count), 0);
    } finally {
      after.close();
    }
    assert.ok(seeded.relativePath.length > 0);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('refuses a bundle whose context references a Session it does not carry', async () => {
  const source = await makeWorkspace('maka-import-foreign-ref-source');
  const target = await makeWorkspace('maka-import-foreign-ref-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    await seedContext(source.workspaceRoot, sessionId, 'ABC');
    await createSession(target.workspaceRoot, 'Unrelated');

    // An export only keeps refs for the Sessions it carries, but a bundle can
    // be assembled rather than exported, and its digest still checks out. A
    // reference owned by a Session that never arrives can never be released:
    // that happens when its Session is retired.
    const tamper = new DatabaseSync(join(source.workspaceRoot, 'context-offload.sqlite'));
    try {
      // Usage rows move with it. Left inconsistent, the snapshot validator
      // catches the tampering first and this guard is never reached -- the
      // test would pass while proving the wrong thing.
      tamper.prepare('UPDATE context_refs SET session_id = ?').run('a-session-not-in-this-bundle');
      tamper
        .prepare('UPDATE context_session_usage SET session_id = ?')
        .run('a-session-not-in-this-bundle');
    } finally {
      tamper.close();
    }

    await assert.rejects(
      () => importState(target.workspaceRoot, source.workspaceRoot),
      /references a Session it does not carry/,
    );
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('refuses a bundle carrying collection state from the workspace it left', async () => {
  const source = await makeWorkspace('maka-import-stale-gc-source');
  const target = await makeWorkspace('maka-import-stale-gc-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    await seedContext(source.workspaceRoot, sessionId, 'ABC');
    await createSession(target.workspaceRoot, 'Unrelated');

    // The export empties this queue on its private copy. One that survives is a
    // decision about a moment in another workspace, and a fresh target adopts
    // the bundle's database whole -- so the candidate names a blob the target
    // now references, which collection treats as corruption from then on.
    const tamper = new DatabaseSync(join(source.workspaceRoot, 'context-offload.sqlite'));
    try {
      tamper.exec('INSERT INTO context_gc_candidates SELECT blob_id, 0 FROM context_blobs');
    } finally {
      tamper.close();
    }

    await assert.rejects(
      () => importState(target.workspaceRoot, source.workspaceRoot),
      /collection state from the workspace it left/,
    );
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('refuses a payload path that is a symlink, even onto matching bytes', async () => {
  const source = await makeWorkspace('maka-import-payload-link-source');
  const target = await makeWorkspace('maka-import-payload-link-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    const seeded = await seedContext(source.workspaceRoot, sessionId, 'ABC');
    const targetSession = await createSession(target.workspaceRoot, 'Unrelated');
    await seedContext(target.workspaceRoot, targetSession, 'ZZ');

    // Matching content read through a link is not the same fact as matching
    // content at the path: the Context Store refuses to read through one and
    // reports the payload corrupt. Accepting it here imports a tree that the
    // Store cannot use.
    const { symlink } = await import('node:fs/promises');
    const destination = join(target.workspaceRoot, 'context-offload-values', seeded.relativePath);
    const decoy = join(target.root, 'decoy');
    await writeFile(decoy, 'ABC');
    await mkdir(dirname(destination), { recursive: true });
    await symlink(decoy, destination);

    await assert.rejects(
      () => importState(target.workspaceRoot, source.workspaceRoot),
      /Context payload already names different content/,
    );
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('reports a payload path occupied by a directory as a conflict', async () => {
  const source = await makeWorkspace('maka-import-payload-dir-source');
  const target = await makeWorkspace('maka-import-payload-dir-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    const seeded = await seedContext(source.workspaceRoot, sessionId, 'ABC');
    const targetSession = await createSession(target.workspaceRoot, 'Unrelated');
    await seedContext(target.workspaceRoot, targetSession, 'ZZ');

    // `O_NOFOLLOW` answers the symlink; it says nothing about the other things
    // a path can be. A directory opens fine and only fails at the read, which
    // surfaces a raw `EISDIR` instead of saying what is actually wrong.
    await mkdir(join(target.workspaceRoot, 'context-offload-values', seeded.relativePath), {
      recursive: true,
    });

    await assert.rejects(
      () => importState(target.workspaceRoot, source.workspaceRoot),
      /Context payload already names different content/,
    );
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('refuses a bundle carrying a payload nothing references', async () => {
  const source = await makeWorkspace('maka-import-orphan-blob-source');
  const target = await makeWorkspace('maka-import-orphan-blob-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    await seedContext(source.workspaceRoot, sessionId, 'ABC');
    await createSession(target.workspaceRoot, 'Unrelated');

    // An export drops blobs nothing references. One that survives is quota the
    // target can never reclaim: collection only ever considers a blob after a
    // reference releases it, and this one never had a reference to release.
    const tamper = new DatabaseSync(join(source.workspaceRoot, 'context-offload.sqlite'));
    try {
      tamper.exec(`
        DELETE FROM context_refs;
        DELETE FROM context_session_usage;
      `);
    } finally {
      tamper.close();
    }

    await assert.rejects(
      () => importState(target.workspaceRoot, source.workspaceRoot),
      /payload nothing references/,
    );
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('refuses a bundle carrying usage for a Session it does not hold', async () => {
  const source = await makeWorkspace('maka-import-surplus-usage-source');
  const target = await makeWorkspace('maka-import-surplus-usage-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    await seedContext(source.workspaceRoot, sessionId, 'ABC');
    await createSession(target.workspaceRoot, 'Unrelated');

    // Surplus in the direction the aggregate comparison cannot see: every real
    // Session's numbers still add up, and this row is simply extra. A fresh
    // target adopts it, and the next write for that Session fails against a
    // count that describes a store it never had.
    const tamper = new DatabaseSync(join(source.workspaceRoot, 'context-offload.sqlite'));
    try {
      tamper.prepare('INSERT INTO context_session_usage VALUES (?, 0, 0)').run('a-ghost-session');
    } finally {
      tamper.close();
    }

    await assert.rejects(
      () => importState(target.workspaceRoot, source.workspaceRoot),
      /usage for a Session it does not hold/,
    );
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('never replaces a context database that is already there', async () => {
  const source = await makeWorkspace('maka-import-no-replace-source');
  const target = await makeWorkspace('maka-import-no-replace-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    const seeded = await seedContext(source.workspaceRoot, sessionId, 'ABC');
    const targetSession = await createSession(target.workspaceRoot, 'Unrelated');
    const kept = await seedContext(target.workspaceRoot, targetSession, 'ZZ');

    // Publication creates; it never replaces. What it would replace is a
    // database a Context Store may hold open, and on POSIX that Store then
    // keeps writing to an unlinked inode -- writes that survive until the next
    // restart and are then simply gone.
    const imported = await importState(target.workspaceRoot, source.workspaceRoot);
    assert.equal(imported.contextRefs, 1);

    const after = new DatabaseSync(join(target.workspaceRoot, 'context-offload.sqlite'), {
      readOnly: true,
    });
    try {
      const rows = after
        .prepare('SELECT session_id FROM context_refs ORDER BY session_id')
        .all() as Array<{ session_id?: unknown }>;
      assert.deepEqual(
        rows.map((row) => String(row.session_id)).sort(),
        [sessionId, targetSession].sort(),
        'the Session that was already here keeps its reference',
      );
    } finally {
      after.close();
    }
    const values = join(target.workspaceRoot, 'context-offload-values');
    assert.equal(await readFile(join(values, seeded.relativePath), 'utf8'), 'ABC');
    assert.equal(await readFile(join(values, kept.relativePath), 'utf8'), 'ZZ');
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('publishes only the payloads the bundle declares', async () => {
  const source = await makeWorkspace('maka-import-undeclared-source');
  const target = await makeWorkspace('maka-import-undeclared-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    const seeded = await seedContext(source.workspaceRoot, sessionId, 'ABC');
    await createSession(target.workspaceRoot, 'Unrelated');

    // Bytes no row names. The validator only ever looks at rows, so a bundle
    // can be assembled with these and they arrive charged to nothing and
    // reachable by nothing: usage counts blobs, and collection starts from a
    // blob whose references were released.
    const stowaway = join(
      source.workspaceRoot,
      'context-offload-values',
      'sha256',
      'ff',
      'f'.repeat(64),
    );
    await mkdir(dirname(stowaway), { recursive: true });
    await writeFile(stowaway, 'NOT DECLARED');

    const imported = await importState(target.workspaceRoot, source.workspaceRoot);
    assert.equal(imported.contextRefs, 1);

    const values = join(target.workspaceRoot, 'context-offload-values');
    assert.equal(await readFile(join(values, seeded.relativePath), 'utf8'), 'ABC');
    assert.equal(
      await readFile(join(values, 'sha256', 'ff', 'f'.repeat(64)), 'utf8').catch(() => undefined),
      undefined,
      'the undeclared payload did not travel',
    );
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test('refuses a bundle that declares a payload it does not carry', async () => {
  const source = await makeWorkspace('maka-import-missing-payload-source');
  const target = await makeWorkspace('maka-import-missing-payload-target');
  try {
    const sessionId = await createSession(source.workspaceRoot);
    await seedHistory(source.workspaceRoot, sessionId);
    const seeded = await seedContext(source.workspaceRoot, sessionId, 'ABC');
    await createSession(target.workspaceRoot, 'Unrelated');

    // A row whose bytes are absent. Publishing the rest and committing the
    // Session would leave a reference to content nobody can read back.
    await rm(join(source.workspaceRoot, 'context-offload-values', seeded.relativePath));

    await assert.rejects(() => importState(target.workspaceRoot, source.workspaceRoot));
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});
