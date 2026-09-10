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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
