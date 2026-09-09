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
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  OPERATIONAL_STATE_DATABASE_NAME,
  OPERATIONAL_STATE_SCHEMA_VERSION,
} from '@maka/storage/operational-state-store';
import { createSessionBundleFileService } from '@maka/storage/session-bundle-file-service';
import type { SessionBundleHydration } from '@maka/storage/session-bundle-contract';
import { SQLITE_RUNTIME_SCHEMA_VERSION } from '@maka/storage/sqlite-runtime-store';
import { SQLITE_SESSION_METADATA_SCHEMA_VERSION } from '@maka/storage/sqlite-session-metadata-store';
import { createSessionStore } from '@maka/storage/session-store';
import {
  exportSessionBundle,
  SESSION_EXPORT_BUNDLE_LIMITS,
  type ExportSessionBundleResult,
} from '../session-export.js';

const CONNECTION_SLUG = 'test-connection';
const MODEL = 'test-model';

async function makeWorkspace(name: string): Promise<string> {
  const root = await mkdtempRoot(name);
  await mkdir(join(root, 'workspace'), { recursive: true });
  return root;
}

async function mkdtempRoot(name: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), `${name}-`));
}

function withRoot(
  name: string,
  run: (root: string, workspaceRoot: string) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const root = await makeWorkspace(name);
    try {
      await run(root, join(root, 'workspace'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function createSession(
  workspaceRoot: string,
  overrides?: {
    name?: string;
  },
): Promise<string> {
  const store = createSessionStore(workspaceRoot);
  try {
    const header = await store.create({
      cwd: workspaceRoot,
      llmConnectionSlug: CONNECTION_SLUG,
      model: MODEL,
      permissionMode: 'ask',
      name: overrides?.name ?? 'Exported',
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

/**
 * A real artifact row.
 *
 * The metadata codec is strict, and deliberately so: the record carries an
 * exact key set, and `relativePath` must equal `<sessionId>/<id>-<name>`. That
 * equality is what keeps a record from naming a file outside its own Session,
 * and it is why the export can trust these paths. A fixture that hand-rolls a
 * looser shape decodes to nothing, and then an artifact test proves only that
 * the export copied no artifacts.
 */
async function addArtifactRecord(
  workspaceRoot: string,
  sessionId: string,
  artifactId: string,
  options: { bytes?: string; name?: string } = {},
): Promise<string> {
  const name = options.name ?? 'artifact.txt';
  const relativePath = `${sessionId}/${artifactId}-${name}`;
  const record = {
    id: artifactId,
    sessionId,
    turnId: 'turn-1',
    createdAt: 0,
    name,
    kind: 'file',
    relativePath,
    sizeBytes: options.bytes?.length ?? 0,
    source: 'tool_result',
  };
  const db = openDatabase(workspaceRoot);
  try {
    if (options.bytes !== undefined) {
      await mkdir(join(workspaceRoot, 'artifacts', sessionId), { recursive: true });
      await writeFile(join(workspaceRoot, 'artifacts', relativePath), options.bytes);
    }
    db.prepare(`
      INSERT INTO artifact_records(artifact_id, session_id, created_at, relative_path, record_json)
      VALUES (?, ?, 0, ?, ?)
    `).run(artifactId, sessionId, relativePath, JSON.stringify(record));
  } finally {
    db.close();
  }
  return relativePath;
}

function addOpenInvocation(workspaceRoot: string, sessionId: string): void {
  const db = openDatabase(workspaceRoot);
  try {
    db.exec(`
      INSERT INTO runtime_events(
        session_id, run_id, invocation_id, turn_id, event_id, event_seq,
        event_kind, committed_at, payload_json
      )
      VALUES ('${sessionId}', 'run-1', 'invocation-1', 'turn-1', 'event-open', 1,
        'invocation_opened', 1, '{}')
    `);
  } finally {
    db.close();
  }
}

/** Query the database the bundle actually carries. */
function openExported(hydration: SessionBundleHydration): DatabaseSync {
  return new DatabaseSync(join(hydration.stateRoot, OPERATIONAL_STATE_DATABASE_NAME), {
    readOnly: true,
  });
}

function exportedArtifactPath(hydration: SessionBundleHydration, relativePath: string): string {
  return join(hydration.stateRoot, 'artifacts', relativePath);
}

async function hydrateExport(
  destination: string,
  sessionId: string,
  destinationRoot: string,
): Promise<SessionBundleHydration> {
  return createSessionBundleFileService().hydrate({
    source: { path: destination },
    limits: SESSION_EXPORT_BUNDLE_LIMITS,
    expectedSessionId: sessionId,
    destinationRoot,
  });
}

async function exportOk(
  workspaceRoot: string,
  sessionId: string,
  destination: string,
): Promise<Extract<ExportSessionBundleResult, { ok: true }>> {
  const result = await exportSessionBundle({ workspaceRoot, sessionId, destination });
  if (!result.ok) {
    assert.fail(`expected export to succeed, got ${JSON.stringify(result.reason)}`);
  }
  return result;
}

test(
  'exports session state, artifacts, and inspectable identity',
  withRoot('maka-session-export', async (root, workspaceRoot) => {
    const sessionId = await createSession(workspaceRoot);
    const livePath = await addArtifactRecord(workspaceRoot, sessionId, 'live', { bytes: 'LIVE' });
    const destination = join(root, 'bundle.maka-session');

    const result = await exportOk(workspaceRoot, sessionId, destination);
    assert.equal(result.export.rootSessionId, sessionId);
    // Read from the source database's own registry, not this build's constants.
    // A fixture workspace is current, so they agree here — the point is where
    // the number came from, which the schema_unsupported test pins down.
    assert.equal(result.export.schema.runtime, SQLITE_RUNTIME_SCHEMA_VERSION);
    assert.equal(result.export.schema.session_metadata, SQLITE_SESSION_METADATA_SCHEMA_VERSION);
    assert.equal(result.export.schema.operational, OPERATIONAL_STATE_SCHEMA_VERSION);
    assert.deepEqual(result.export.sessionIds, [sessionId]);
    assert.equal(result.export.connection?.llmConnectionSlug, CONNECTION_SLUG);
    assert.equal(result.export.connection?.model, MODEL);
    assert.equal((await stat(destination)).isFile(), true);

    const inspection = await createSessionBundleFileService().inspect({
      source: { path: destination },
      limits: SESSION_EXPORT_BUNDLE_LIMITS,
    });
    const exportManifest = JSON.parse(
      Buffer.from(inspection.stateIdentity.bytes).toString('utf8'),
    ) as { rootSessionId?: string };
    assert.equal(exportManifest.rootSessionId, sessionId);

    const hydration = await hydrateExport(destination, sessionId, join(root, 'hydrated'));
    assert.equal(await readFile(exportedArtifactPath(hydration, livePath), 'utf8'), 'LIVE');
    // The bundle carries the database itself, filtered — not a re-encoding of
    // it — so the Session is queryable straight out of the archive.
    const exported = openExported(hydration);
    try {
      const row = exported.prepare('SELECT COUNT(*) AS count FROM session_metadata').get() as {
        count?: unknown;
      };
      assert.equal(Number(row.count), 1);
    } finally {
      exported.close();
    }
  }),
);

test('omits diagnostics and keeps event types this build has never seen', async () => {
  const root = await makeWorkspace('maka-session-export-content');
  try {
    const workspaceRoot = join(root, 'workspace');
    const sessionId = await createSession(workspaceRoot);
    const db = openDatabase(workspaceRoot);
    try {
      db.exec(`
        INSERT INTO core_agent_runs(session_id, run_id, created_at)
        VALUES ('${sessionId}', 'run-1', 0);
        INSERT INTO core_agent_run_events(
          session_id, run_id, sequence, event_id, event_type, event_ts, record_json
        )
        VALUES
          ('${sessionId}', 'run-1', 0, 'capture', 'provider_request_captured', 1, '{"diagnostic":true}'),
          ('${sessionId}', 'run-1', 1, 'future', 'zz_unknown_future', 2, '{"kept":true}');
      `);
    } finally {
      db.close();
    }

    const destination = join(root, 'bundle.maka-session');
    const result = await exportOk(workspaceRoot, sessionId, destination);
    assert.deepEqual(result.export.omittedEventTypes, [
      'provider_request_attempt_recorded',
      'provider_request_captured',
      'model_call_attempt_recorded',
      'model_stream_started',
      'model_stream_completed',
      'model_stream_failed',
      'send_diagnostics_recorded',
      'plan_context_resolved',
      'skill_catalog_built',
      'skill_searched',
      'skill_loaded',
      'skill_load_failed',
      'tool_searched',
      'request_composition_resolved',
      'trace_write_failed',
    ]);
    assert.equal(result.export.diagnosticsOmitted, true);

    const hydration = await hydrateExport(destination, sessionId, join(root, 'hydrated'));
    const exported = openExported(hydration);
    try {
      const kept = (
        exported
          .prepare('SELECT event_type FROM core_agent_run_events ORDER BY sequence')
          .all() as Array<{ event_type?: unknown }>
      ).map((row) => String(row.event_type));
      // The diagnostic row is gone; the type this build has never seen is kept,
      // because an export moves rows rather than interpreting them.
      assert.deepEqual(kept, ['zz_unknown_future']);
    } finally {
      exported.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exports the complete subagent subtree with per-session artifacts', async () => {
  const root = await makeWorkspace('maka-session-export-subtree');
  try {
    const workspaceRoot = join(root, 'workspace');
    const store = createSessionStore(workspaceRoot);
    try {
      const parent = await store.create({
        cwd: workspaceRoot,
        llmConnectionSlug: CONNECTION_SLUG,
        model: MODEL,
        permissionMode: 'ask',
      });
      const firstChild = await store.createSubagent({
        cwd: workspaceRoot,
        llmConnectionSlug: CONNECTION_SLUG,
        model: MODEL,
        permissionMode: 'ask',
        subagentParent: {
          kind: 'subagent' as const,
          parentSessionId: parent.id,
          spawnedBy: {
            parentRunId: 'parent-run',
            parentTurnId: 'parent-turn',
            toolCallId: 'call-1',
          },
          lifecycle: 'foreground',
        },
        subagentRuntime: {
          schemaVersion: 1,
          definitionVersion: 1,
          agentId: 'local-read',
          agentName: 'Local Read',
          profile: 'local_read',
          systemPrompt: 'Read the assigned workspace task.',
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
      const secondChild = await store.createSubagent({
        cwd: workspaceRoot,
        llmConnectionSlug: CONNECTION_SLUG,
        model: MODEL,
        permissionMode: 'ask',
        subagentParent: {
          kind: 'subagent' as const,
          parentSessionId: parent.id,
          spawnedBy: {
            parentRunId: 'parent-run',
            parentTurnId: 'parent-turn',
            toolCallId: 'call-2',
          },
          lifecycle: 'foreground',
        },
        subagentRuntime: {
          schemaVersion: 1,
          definitionVersion: 1,
          agentId: 'local-read',
          agentName: 'Local Read',
          profile: 'local_read',
          systemPrompt: 'Read the assigned workspace task.',
          toolNames: ['Read'],
          categoryPolicy: { read: 'allow' },
        },
        subagentSpawn: {
          schemaVersion: 1,
          requestFingerprint: 'b'.repeat(64),
          initialTurnId: 'child-turn',
          initialRunId: 'child-run',
        },
      } as Parameters<typeof store.createSubagent>[0]);
      const grandchild = await store.createSubagent({
        cwd: workspaceRoot,
        llmConnectionSlug: CONNECTION_SLUG,
        model: MODEL,
        permissionMode: 'ask',
        subagentParent: {
          kind: 'subagent' as const,
          parentSessionId: firstChild.header.id,
          spawnedBy: { parentRunId: 'child-run', parentTurnId: 'child-turn', toolCallId: 'call-3' },
          lifecycle: 'foreground',
        },
        subagentRuntime: {
          schemaVersion: 1,
          definitionVersion: 1,
          agentId: 'local-read',
          agentName: 'Local Read',
          profile: 'local_read',
          systemPrompt: 'Read the assigned workspace task.',
          toolNames: ['Read'],
          categoryPolicy: { read: 'allow' },
        },
        subagentSpawn: {
          schemaVersion: 1,
          requestFingerprint: 'c'.repeat(64),
          initialTurnId: 'child-turn',
          initialRunId: 'child-run',
        },
      } as Parameters<typeof store.createSubagent>[0]);

      const childArtifactPath = await addArtifactRecord(
        workspaceRoot,
        firstChild.header.id,
        'child',
        { bytes: 'CHILD' },
      );
      const destination = join(root, 'bundle.maka-session');
      const result = await exportOk(workspaceRoot, parent.id, destination);
      assert.equal(result.export.sessionIds.length, 4);
      assert.equal(result.export.rootSessionId, parent.id);
      // Membership is what the export promises; the order is the traversal's,
      // and sibling order comes from the id sort rather than creation time.
      // Asserting creation order here passes or fails on which random UUID
      // happens to sort first.
      assert.deepEqual(
        [...result.export.sessionIds].sort(),
        [parent.id, firstChild.header.id, secondChild.header.id, grandchild.header.id].sort(),
      );
      // The root leads, and each level's siblings are sorted, so the same tree
      // exports byte-identically on every run.
      assert.equal(result.export.sessionIds[0], parent.id);
      const siblings = [firstChild.header.id, secondChild.header.id].sort();
      assert.deepEqual(result.export.sessionIds.slice(1, 3), siblings);
      assert.equal(result.export.sessionIds[3], grandchild.header.id);

      const hydration = await hydrateExport(destination, parent.id, join(root, 'hydrated'));
      const exported = openExported(hydration);
      try {
        const carried = (
          exported
            .prepare('SELECT session_id FROM session_metadata ORDER BY session_id')
            .all() as Array<{ session_id?: unknown }>
        ).map((row) => String(row.session_id));
        assert.deepEqual(carried, [...result.export.sessionIds].sort());
      } finally {
        exported.close();
      }
      // The link is not the child Session: `subagent_spawns` records WHICH
      // tool call spawned it. A filter that does not recognise this table's
      // ownership columns empties it, and the bundle then holds two Sessions
      // with nothing joining them.
      const links = openExported(hydration);
      try {
        const rows = links
          .prepare('SELECT parent_session_id, child_session_id FROM subagent_spawns')
          .all() as Array<{ parent_session_id?: unknown; child_session_id?: unknown }>;
        assert.deepEqual(
          rows.map((row) => String(row.child_session_id)).sort(),
          [firstChild.header.id, secondChild.header.id, grandchild.header.id].sort(),
        );
      } finally {
        links.close();
      }
      // A child's artifact bytes travel with it, under the child's own id.
      assert.equal(
        await readFile(exportedArtifactPath(hydration, childArtifactPath), 'utf8'),
        'CHILD',
      );
    } finally {
      await store.close?.();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'rejects an active session before export',
  withRoot('maka-session-export-active', async (root, workspaceRoot) => {
    const sessionId = await createSession(workspaceRoot);
    addOpenInvocation(workspaceRoot, sessionId);
    const destination = join(root, 'bundle.maka-session');
    const result = await exportSessionBundle({ workspaceRoot, sessionId, destination });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason.kind, 'session_active');
    await assert.rejects(stat(destination));
  }),
);

test(
  'reports a missing live artifact without creating the destination',
  withRoot('maka-session-export-artifact-missing', async (root, workspaceRoot) => {
    const sessionId = await createSession(workspaceRoot);
    // A record with no bytes behind it. The export refuses rather than shipping
    // a bundle whose own metadata names a file it does not contain.
    await addArtifactRecord(workspaceRoot, sessionId, 'missing');
    const destination = join(root, 'bundle.maka-session');
    const result = await exportSessionBundle({ workspaceRoot, sessionId, destination });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason.kind, 'artifact_missing');
    await assert.rejects(stat(destination));
  }),
);

test(
  'refuses to overwrite an existing destination',
  withRoot('maka-session-export-destination', async (root, workspaceRoot) => {
    const sessionId = await createSession(workspaceRoot);
    const destination = join(root, 'bundle.maka-session');
    await writeFile(destination, 'original');
    const result = await exportSessionBundle({ workspaceRoot, sessionId, destination });
    assert.deepEqual(result, { ok: false, reason: { kind: 'destination_exists' } });
    assert.equal(await readFile(destination, 'utf8'), 'original');
  }),
);

test(
  'separates a directory that is not a workspace from a Session that is not there',
  withRoot('maka-session-export-not-found', async (root, workspaceRoot) => {
    const destination = join(root, 'bundle.maka-session');

    // No state database yet: the directory was never a workspace. Reporting a
    // missing Session here would read a mistyped path as an empty catalog.
    const beforeAnyStore = await exportSessionBundle({
      workspaceRoot,
      sessionId: 'missing-session',
      destination,
    });
    assert.deepEqual(beforeAnyStore, {
      ok: false,
      reason: { kind: 'workspace_not_found', workspaceRoot },
    });

    // A real workspace holding no such Session is the other answer. Creating
    // one Session is what makes the database exist.
    const store = createSessionStore(workspaceRoot);
    try {
      await store.create({
        cwd: workspaceRoot,
        llmConnectionSlug: CONNECTION_SLUG,
        model: MODEL,
        permissionMode: 'ask',
      });
    } finally {
      store.close?.();
    }
    const withStore = await exportSessionBundle({
      workspaceRoot,
      sessionId: 'missing-session',
      destination,
    });
    assert.deepEqual(withStore, { ok: false, reason: { kind: 'session_not_found' } });

    await assert.rejects(stat(destination));
  }),
);

test(
  'carries JSON columns as bytes rather than re-encoding them',
  withRoot('maka-session-export-bytes', async (root, workspaceRoot) => {
    const sessionId = await createSession(workspaceRoot);
    // Values chosen because a JSON.parse/stringify round trip changes them:
    // the integer exceeds Number.MAX_SAFE_INTEGER and the spacing is not what
    // a serializer emits. The bundle carries the database itself, so these
    // must come back as the same bytes rather than as an equivalent encoding.
    const payloadJson = '{ "big": 9007199254740993, "spaced" : true }';
    const recordJson = '{ "big": 9007199254740993, "note":"kept" }';
    const db = openDatabase(workspaceRoot);
    try {
      db.exec(`
        INSERT INTO runtime_events(
          session_id, run_id, invocation_id, turn_id, event_id, event_seq,
          event_kind, committed_at, payload_json
        )
        VALUES ('${sessionId}', 'run-1', 'invocation-1', 'turn-1', 'event-bytes', 1,
          'text', 1, '${payloadJson}');
        INSERT INTO runtime_events(
          session_id, run_id, invocation_id, turn_id, event_id, event_seq,
          event_kind, committed_at, payload_json
        )
        VALUES ('${sessionId}', 'run-1', 'invocation-1', 'turn-1', 'event-done', 2,
          'completed', 2, '{"status":"completed"}');
        INSERT INTO core_agent_runs(session_id, run_id, created_at)
        VALUES ('${sessionId}', 'run-1', 0);
        INSERT INTO core_agent_run_events(
          session_id, run_id, sequence, event_id, event_type, event_ts, record_json
        )
        VALUES ('${sessionId}', 'run-1', 0, 'bytes', 'turn_started', 1, '${recordJson}');
      `);
    } finally {
      db.close();
    }

    const destination = join(root, 'bundle.maka-session');
    await exportOk(workspaceRoot, sessionId, destination);
    const hydration = await hydrateExport(destination, sessionId, join(root, 'hydrated'));
    const exported = openExported(hydration);
    try {
      const carriedPayload = (
        exported
          .prepare("SELECT payload_json FROM runtime_events WHERE event_id = 'event-bytes'")
          .get() as { payload_json?: unknown }
      ).payload_json;
      const carriedRecord = (
        exported
          .prepare("SELECT record_json FROM core_agent_run_events WHERE event_id = 'bytes'")
          .get() as { record_json?: unknown }
      ).record_json;
      // Strict equality on the stored string, not JSON equivalence.
      assert.equal(carriedPayload, payloadJson);
      assert.equal(carriedRecord, recordJson);
    } finally {
      exported.close();
    }
  }),
);

async function bundleFileContents(hydration: SessionBundleHydration): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const parts: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else parts.push(path, await readFile(path, 'utf8'));
    }
  };
  await walk(hydration.stateRoot);
  await walk(hydration.workspaceRoot);
  return parts.join('\n');
}

test(
  'names the connection without carrying any credential into the bundle',
  withRoot('maka-session-export-credentials', async (root, workspaceRoot) => {
    const secret = 'sk-EXPORT-MUST-NEVER-CARRY-THIS-TOKEN';
    // A vault beside the state the export reads. Nothing selects it, and this
    // asserts that: a bundle is shared, so a credential reaching it is the one
    // failure here that cannot be walked back.
    await writeFile(
      join(workspaceRoot, 'credential-vault.json'),
      JSON.stringify({ connections: { [CONNECTION_SLUG]: { apiKey: secret } } }),
    );
    const sessionId = await createSession(workspaceRoot);
    const destination = join(root, 'bundle.maka-session');

    const result = await exportOk(workspaceRoot, sessionId, destination);
    assert.equal(result.export.connection?.llmConnectionSlug, CONNECTION_SLUG);

    const hydration = await hydrateExport(destination, sessionId, join(root, 'hydrated'));
    const contents = await bundleFileContents(hydration);
    // The slug is how the importing side finds a connection, so it must be here.
    assert.ok(contents.includes(CONNECTION_SLUG));
    assert.ok(contents.includes(MODEL));
    // The key must not, under any name.
    assert.equal(contents.includes(secret), false);
    assert.equal(contents.includes('credential-vault'), false);
    assert.equal(contents.includes('apiKey'), false);
  }),
);

test(
  'refuses the whole tree when only a child session is still active',
  withRoot('maka-session-export-child-active', async (root, workspaceRoot) => {
    const store = createSessionStore(workspaceRoot);
    let parentId: string;
    let childId: string;
    try {
      const parent = await store.create({
        cwd: workspaceRoot,
        llmConnectionSlug: CONNECTION_SLUG,
        model: MODEL,
        permissionMode: 'ask',
      });
      parentId = parent.id;
      const child = await store.createSubagent({
        cwd: workspaceRoot,
        llmConnectionSlug: CONNECTION_SLUG,
        model: MODEL,
        permissionMode: 'ask',
        subagentParent: {
          kind: 'subagent' as const,
          parentSessionId: parent.id,
          spawnedBy: {
            parentRunId: 'parent-run',
            parentTurnId: 'parent-turn',
            toolCallId: 'call-1',
          },
          lifecycle: 'foreground',
        },
        subagentRuntime: {
          schemaVersion: 1,
          definitionVersion: 1,
          agentId: 'local-read',
          agentName: 'Local Read',
          profile: 'local_read',
          systemPrompt: 'Read the assigned workspace task.',
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

    // The parent is quiescent; only the child holds an unfinished invocation.
    // A bundle that skipped it would be a subtree with a hole, so the refusal
    // covers the tree rather than the session that happens to be named.
    addOpenInvocation(workspaceRoot, childId);

    const destination = join(root, 'bundle.maka-session');
    const result = await exportSessionBundle({
      workspaceRoot,
      sessionId: parentId,
      destination,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason.kind, 'session_active');
    await assert.rejects(stat(destination));
  }),
);

test(
  'terminates on a subagent parent link that points back into the tree',
  withRoot('maka-session-export-cycle', async (root, workspaceRoot) => {
    const sessionId = await createSession(workspaceRoot);
    // `subagent_parent_session_id` is a plain column; nothing stops a row from
    // naming itself. The walk must end and must not list the Session twice.
    const db = openDatabase(workspaceRoot);
    try {
      db.exec(
        `UPDATE session_metadata SET subagent_parent_session_id = '${sessionId}' WHERE session_id = '${sessionId}'`,
      );
    } finally {
      db.close();
    }

    const destination = join(root, 'bundle.maka-session');
    const result = await exportOk(workspaceRoot, sessionId, destination);
    assert.deepEqual(result.export.sessionIds, [sessionId]);
  }),
);
