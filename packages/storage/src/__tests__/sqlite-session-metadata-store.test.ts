import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { SessionHeader } from '@maka/core';
import {
  createSqliteSessionMetadataStore,
  SessionMetadataConflictError,
  type SqliteSessionMetadataStoreFailpoint,
} from '../sqlite-session-metadata-store.js';
import {
  createSqliteRuntimeStore,
  SQLITE_RUNTIME_SCHEMA_VERSION,
} from '../sqlite-runtime-store.js';

describe('SqliteSessionMetadataStore', () => {
  test('round-trips every SessionHeader field and reopens the same schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-metadata-'));
    const path = join(root, 'state.sqlite');
    try {
      const store = createSqliteSessionMetadataStore(path, { now: () => 100 });
      const header = fullHeader();
      assert.equal(store.schemaVersion(), 7);
      assert.equal(store.journalMode(), 'wal');
      assert.deepEqual(await store.create(header), {
        header,
        metadataVersion: 1,
        committedAt: 100,
      });
      store.close();

      const reopened = createSqliteSessionMetadataStore(path, { now: () => 200 });
      try {
        assert.equal(reopened.schemaVersion(), 7);
        assert.deepEqual(await reopened.read(header.id), {
          header,
          metadataVersion: 1,
          committedAt: 100,
        });
      } finally {
        reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('coexists with the RuntimeEvent schema in one workspace database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-runtime-database-'));
    const path = join(root, 'runtime.sqlite');
    const runtime = createSqliteRuntimeStore(path);
    const metadata = createSqliteSessionMetadataStore(path);
    try {
      assert.equal(runtime.schemaVersion(), SQLITE_RUNTIME_SCHEMA_VERSION);
      assert.equal(metadata.schemaVersion(), 7);
      await metadata.create(fullHeader());
      await runtime.appendRuntimeEvent('session-1', 'run-1', {
        id: 'event-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        ts: 1,
        partial: false,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'hello' },
      });
      assert.equal((await metadata.read('session-1')).header.name, 'Session');
      assert.equal((await runtime.readRuntimeEvents('session-1', 'run-1')).length, 1);
    } finally {
      metadata.close();
      runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('backfills the relation index when upgrading a populated v2 database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-metadata-v2-'));
    const path = join(root, 'sessions.sqlite');
    const parentSessionId = 'parent-session';
    const header = fullHeader({
      id: 'child-session',
      parentSessionId: undefined,
      branchOfTurnId: undefined,
      revisionRootSessionId: undefined,
      revisionParentSessionId: undefined,
      revisionOfTurnId: undefined,
      revisionIndex: undefined,
      revisionState: undefined,
      subagentParent: {
        kind: 'subagent',
        parentSessionId,
        spawnedBy: {
          parentRunId: 'parent-run',
          parentTurnId: 'parent-turn',
          toolCallId: 'tool-call',
        },
        lifecycle: 'foreground',
      },
    });
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE session_metadata_schema (
        scope TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      );
      INSERT INTO session_metadata_schema(scope, version) VALUES ('session_metadata', 2);
      CREATE TABLE session_metadata (
        session_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        last_message_at INTEGER,
        name TEXT NOT NULL,
        is_flagged INTEGER NOT NULL,
        is_archived INTEGER NOT NULL,
        status TEXT NOT NULL,
        status_updated_at INTEGER,
        parent_session_id TEXT,
        revision_root_session_id TEXT,
        revision_index INTEGER,
        has_unread INTEGER NOT NULL,
        backend TEXT NOT NULL,
        llm_connection_slug TEXT NOT NULL,
        model TEXT NOT NULL,
        metadata_version INTEGER NOT NULL,
        committed_at INTEGER NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO session_metadata(
        session_id, payload_json, created_at, last_used_at, last_message_at,
        name, is_flagged, is_archived, status, status_updated_at,
        parent_session_id, revision_root_session_id, revision_index, has_unread,
        backend, llm_connection_slug, model, metadata_version, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      header.id,
      JSON.stringify(header),
      header.createdAt,
      header.lastUsedAt,
      header.lastMessageAt ?? null,
      header.name,
      0,
      0,
      header.status,
      header.statusUpdatedAt ?? null,
      null,
      null,
      null,
      1,
      header.backend,
      header.llmConnectionSlug,
      header.model,
      1,
      100,
    );
    db.close();

    const store = createSqliteSessionMetadataStore(path);
    try {
      assert.equal(store.schemaVersion(), 7);
      assert.deepEqual(
        (
          await store.list({
            subagentParentSessionId: parentSessionId,
          })
        ).map((record) => record.header.id),
        [header.id],
      );
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('filters indexed flags, archive state, and normalized labels in recency order', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    try {
      await store.create(
        fullHeader({
          id: 'older',
          name: 'Older',
          lastUsedAt: 10,
          lastMessageAt: 20,
          labels: ['alpha', 'shared'],
          isFlagged: true,
        }),
      );
      await store.create(
        fullHeader({
          id: 'newer',
          name: 'Newer',
          lastUsedAt: 30,
          lastMessageAt: 40,
          labels: ['shared'],
          isFlagged: true,
        }),
      );
      await store.create(
        fullHeader({
          id: 'archived',
          name: 'Archived',
          isArchived: true,
          archivedAt: 50,
          status: 'archived',
          blockedReason: undefined,
          lastMessageAt: 50,
          labels: ['shared'],
        }),
      );

      assert.deepEqual(
        (await store.list({ isArchived: false })).map((record) => record.header.id),
        ['newer', 'older'],
      );
      assert.deepEqual(
        (await store.list({ isArchived: false, isFlagged: true, labelSlug: 'shared' })).map(
          (record) => record.header.id,
        ),
        ['newer', 'older'],
      );
      assert.deepEqual(
        (await store.list({ labelSlug: 'alpha' })).map((record) => record.header.id),
        ['older'],
      );
    } finally {
      store.close();
    }
  });

  test('queries typed subagent relations through the dedicated parent index', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    const subagentParent = {
      kind: 'subagent' as const,
      parentSessionId: 'parent-session',
      spawnedBy: {
        parentRunId: 'parent-run',
        parentTurnId: 'parent-turn',
        toolCallId: 'tool-call',
      },
      lifecycle: 'foreground' as const,
    };
    const subagentRuntime = {
      schemaVersion: 1 as const,
      definitionVersion: 1,
      agentId: 'local-read',
      agentName: 'Local Read',
      profile: 'local_read',
      systemPrompt: 'Read the assigned workspace task.',
      toolNames: ['Read', 'Glob', 'Grep'],
      categoryPolicy: { read: 'allow' as const },
      permissionCeiling: 'ask' as const,
    };
    const subagentSpawn = {
      schemaVersion: 1 as const,
      requestFingerprint: 'a'.repeat(64),
      initialTurnId: 'child-turn',
      initialRunId: 'child-run',
    };
    try {
      const created = await store.createSubagent(
        fullHeader({
          id: 'child-session',
          parentSessionId: undefined,
          branchOfTurnId: undefined,
          revisionRootSessionId: undefined,
          revisionParentSessionId: undefined,
          revisionOfTurnId: undefined,
          revisionIndex: undefined,
          revisionState: undefined,
          subagentParent,
          subagentRuntime,
          subagentSpawn,
        }),
      );
      assert.equal(created.created, true);
      await store.create(
        fullHeader({
          id: 'ordinary-branch',
          parentSessionId: 'parent-session',
          branchOfTurnId: 'parent-turn',
          revisionRootSessionId: undefined,
          revisionParentSessionId: undefined,
          revisionOfTurnId: undefined,
          revisionIndex: undefined,
          revisionState: undefined,
        }),
      );
      await store.create(
        fullHeader({
          id: 'other-child',
          parentSessionId: undefined,
          branchOfTurnId: undefined,
          revisionRootSessionId: undefined,
          revisionParentSessionId: undefined,
          revisionOfTurnId: undefined,
          revisionIndex: undefined,
          revisionState: undefined,
          subagentParent: { ...subagentParent, parentSessionId: 'other-parent' },
        }),
      );

      const children = await store.list({
        subagentParentSessionId: subagentParent.parentSessionId,
      });
      assert.deepEqual(
        children.map((record) => record.header.id),
        ['child-session'],
      );
      assert.deepEqual(children[0]?.header.subagentParent, subagentParent);
      assert.deepEqual(children[0]?.header.subagentRuntime, subagentRuntime);
      assert.deepEqual(children[0]?.header.subagentSpawn, subagentSpawn);
      await assert.rejects(
        () => store.update('child-session', { subagentParent: undefined }),
        /parent relation is immutable/,
      );
      await assert.rejects(
        () => store.update('child-session', { subagentRuntime: undefined }),
        /runtime snapshot is immutable/,
      );
      await assert.rejects(
        () => store.update('child-session', { subagentSpawn: undefined }),
        /spawn identity is immutable/,
      );
    } finally {
      store.close();
    }
  });

  test('atomically reuses one child per durable spawn identity and rejects request drift', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    const parent = {
      kind: 'subagent' as const,
      parentSessionId: 'parent-session',
      spawnedBy: {
        parentRunId: 'parent-run',
        parentTurnId: 'parent-turn',
        toolCallId: 'tool-call',
      },
      lifecycle: 'foreground' as const,
    };
    const runtime = {
      schemaVersion: 1 as const,
      definitionVersion: 1,
      agentId: 'local-read',
      agentName: 'Local Read',
      profile: 'local_read',
      systemPrompt: 'Original durable prompt.',
      toolNames: ['Read'],
      categoryPolicy: { read: 'allow' as const },
      permissionCeiling: 'ask' as const,
    };
    const childHeader = (overrides: Partial<SessionHeader>): SessionHeader =>
      fullHeader({
        parentSessionId: undefined,
        branchOfTurnId: undefined,
        revisionRootSessionId: undefined,
        revisionParentSessionId: undefined,
        revisionOfTurnId: undefined,
        revisionIndex: undefined,
        revisionState: undefined,
        subagentParent: parent,
        subagentRuntime: runtime,
        subagentSpawn: {
          schemaVersion: 1,
          requestFingerprint: 'a'.repeat(64),
          initialTurnId: 'child-turn',
          initialRunId: 'child-run',
        },
        ...overrides,
      });
    try {
      const first = await store.createSubagent(childHeader({ id: 'child-original' }));
      assert.equal(first.created, true);

      const retry = await store.createSubagent(
        childHeader({
          id: 'child-retry-candidate',
          subagentRuntime: { ...runtime, systemPrompt: 'A changed catalog prompt.' },
          subagentSpawn: {
            schemaVersion: 1,
            requestFingerprint: 'a'.repeat(64),
            initialTurnId: 'different-proposed-turn',
            initialRunId: 'different-proposed-run',
          },
        }),
      );
      assert.equal(retry.created, false);
      assert.equal(retry.record.header.id, 'child-original');
      assert.equal(retry.record.header.subagentRuntime?.systemPrompt, 'Original durable prompt.');
      assert.equal(retry.record.header.subagentSpawn?.initialRunId, 'child-run');

      await assert.rejects(
        () =>
          store.createSubagent(
            childHeader({
              id: 'drifted-child',
              subagentSpawn: {
                schemaVersion: 1,
                requestFingerprint: 'b'.repeat(64),
                initialTurnId: 'drifted-turn',
                initialRunId: 'drifted-run',
              },
            }),
          ),
        /reused for different work/,
      );

      const swarmItem = await store.createSubagent(
        childHeader({
          id: 'swarm-child',
          subagentParent: {
            ...parent,
            swarm: { swarmId: 'swarm-1', itemId: 'item-1' },
          },
          subagentSpawn: {
            schemaVersion: 1,
            requestFingerprint: 'c'.repeat(64),
            initialTurnId: 'swarm-turn',
            initialRunId: 'swarm-run',
          },
        }),
      );
      assert.equal(swarmItem.created, true);

      assert.equal(await store.remove('child-original'), true);
      await assert.rejects(
        () =>
          store.createSubagent(
            childHeader({
              id: 'child-after-delete',
              subagentSpawn: {
                schemaVersion: 1,
                requestFingerprint: 'a'.repeat(64),
                initialTurnId: 'retry-after-delete-turn',
                initialRunId: 'retry-after-delete-run',
              },
            }),
          ),
        /belongs to deleted session: child-original/,
      );
    } finally {
      store.close();
    }
  });

  test('migrates v4 spawn identities into claims that survive child deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-subagent-spawn-v4-'));
    const path = join(root, 'sessions.sqlite');
    const child = fullHeader({
      id: 'migrated-child',
      parentSessionId: undefined,
      branchOfTurnId: undefined,
      revisionRootSessionId: undefined,
      revisionParentSessionId: undefined,
      revisionOfTurnId: undefined,
      revisionIndex: undefined,
      revisionState: undefined,
      subagentParent: {
        kind: 'subagent',
        parentSessionId: 'parent-session',
        spawnedBy: {
          parentRunId: 'parent-run',
          parentTurnId: 'parent-turn',
          toolCallId: 'tool-call',
        },
        lifecycle: 'foreground',
      },
      subagentRuntime: {
        schemaVersion: 1,
        definitionVersion: 1,
        agentId: 'local-read',
        agentName: 'Local Read',
        profile: 'local_read',
        systemPrompt: 'Original durable prompt.',
        toolNames: ['Read'],
        categoryPolicy: { read: 'allow' },
        permissionCeiling: 'ask',
      },
      subagentSpawn: {
        schemaVersion: 1,
        requestFingerprint: 'd'.repeat(64),
        initialTurnId: 'child-turn',
        initialRunId: 'child-run',
      },
    });
    try {
      const initial = createSqliteSessionMetadataStore(path);
      await initial.createSubagent(child);
      initial.close();

      const v4 = new DatabaseSync(path);
      v4.exec(`
        DROP TABLE agent_graph_schedule_updates;
        DROP TABLE agent_graph_intent_claims;
        DROP TABLE subagent_spawns;
        CREATE UNIQUE INDEX session_metadata_by_subagent_spawn
          ON session_metadata(
            subagent_parent_session_id,
            subagent_parent_run_id,
            subagent_tool_call_id,
            COALESCE(subagent_swarm_id, ''),
            COALESCE(subagent_item_id, '')
          )
          WHERE
            subagent_parent_session_id IS NOT NULL
            AND subagent_parent_run_id IS NOT NULL
            AND subagent_tool_call_id IS NOT NULL
            AND subagent_request_fingerprint IS NOT NULL;
        UPDATE session_metadata_schema SET version = 4 WHERE scope = 'session_metadata';
      `);
      v4.close();

      const migrated = createSqliteSessionMetadataStore(path);
      try {
        assert.equal(migrated.schemaVersion(), 7);
        assert.equal(await migrated.remove(child.id), true);
        await assert.rejects(
          () => migrated.createSubagent({ ...child, id: 'retry-after-migration' }),
          /belongs to deleted session: migrated-child/,
        );
      } finally {
        migrated.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('updates metadata and labels with a compare-and-set version', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(10) });
    try {
      await store.create(fullHeader());
      const updated = await store.update(
        'session-1',
        {
          name: 'Renamed',
          labels: ['replacement'],
          hasUnread: false,
          lastReadMessageId: 'message-2',
        },
        { expectedVersion: 1 },
      );
      assert.equal(updated.metadataVersion, 2);
      assert.equal(updated.header.name, 'Renamed');
      assert.deepEqual(updated.header.labels, ['replacement']);
      assert.equal(updated.header.lastReadMessageId, 'message-2');
      assert.deepEqual(
        (await store.list({ labelSlug: 'replacement' })).map((record) => record.header.id),
        ['session-1'],
      );
      assert.deepEqual(await store.list({ labelSlug: 'alpha' }), []);

      await assert.rejects(
        () => store.update('session-1', { name: 'Stale' }, { expectedVersion: 1 }),
        SessionMetadataConflictError,
      );
      assert.equal((await store.read('session-1')).header.name, 'Renamed');
    } finally {
      store.close();
    }
  });

  test('rolls back row and label changes at every injected transaction failure', async () => {
    for (const failpoint of [
      'after_session_row_write',
      'after_session_labels_write',
    ] satisfies SqliteSessionMetadataStoreFailpoint[]) {
      let armed = true;
      const store = createSqliteSessionMetadataStore(':memory:', {
        failpoint: (point) => {
          if (armed && point === failpoint) throw new Error(`failpoint: ${point}`);
        },
      });
      try {
        await assert.rejects(() => store.create(fullHeader()), /failpoint/);
        await assert.rejects(() => store.read('session-1'), /not found/);

        armed = false;
        await store.create(fullHeader());
        armed = true;
        await assert.rejects(
          () => store.update('session-1', { name: 'Not committed', labels: ['lost'] }),
          /failpoint/,
        );
        const current = await store.read('session-1');
        assert.equal(current.metadataVersion, 1);
        assert.equal(current.header.name, 'Session');
        assert.deepEqual(current.header.labels, ['alpha', 'beta']);
        assert.deepEqual(await store.list({ labelSlug: 'lost' }), []);
      } finally {
        store.close();
      }
    }
  });

  test('imports source-marked metadata idempotently and rejects identity drift', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    const entry = {
      header: fullHeader(),
      source: { path: '/workspace/sessions/session-1/session.jsonl', fingerprint: '1:1' },
    };
    try {
      assert.deepEqual(await store.importEntries([entry]), {
        created: [true],
        sourcesAlreadyImported: 0,
        sourcesTombstoned: 0,
      });
      assert.deepEqual(await store.importEntries([entry]), {
        created: [],
        sourcesAlreadyImported: 1,
        sourcesTombstoned: 0,
      });
      await assert.rejects(
        () =>
          store.importEntries([
            {
              ...entry,
              header: fullHeader({ name: 'Changed outside SQLite' }),
              source: { ...entry.source, fingerprint: '2:2' },
            },
          ]),
        SessionMetadataConflictError,
      );
      assert.equal((await store.read('session-1')).header.name, 'Session');
    } finally {
      store.close();
    }
  });

  test('rolls back the whole import batch when a later source marker fails', async () => {
    let markers = 0;
    const store = createSqliteSessionMetadataStore(':memory:', {
      failpoint: (point) => {
        if (point === 'after_session_import_marker_write' && ++markers === 2) {
          throw new Error('second marker failed');
        }
      },
    });
    try {
      await assert.rejects(
        () =>
          store.importEntries([
            {
              header: fullHeader({ id: 'session-1' }),
              source: { path: '/session-1.jsonl', fingerprint: '1:1' },
            },
            {
              header: fullHeader({ id: 'session-2' }),
              source: { path: '/session-2.jsonl', fingerprint: '2:2' },
            },
          ]),
        /second marker failed/,
      );
      assert.deepEqual(await store.list(), []);
    } finally {
      store.close();
    }
  });

  test('deletes metadata and its label projection atomically', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    try {
      await store.create(fullHeader());
      assert.equal(await store.remove('session-1'), true);
      assert.equal(await store.remove('session-1'), false);
      assert.equal(await store.has('session-1'), false);
      assert.equal(await store.isTombstoned('session-1'), true);
      assert.deepEqual(await store.list({ labelSlug: 'alpha' }), []);
      assert.deepEqual(
        await store.importEntries([
          {
            header: fullHeader(),
            source: { path: '/session-1.jsonl', fingerprint: '1:1' },
          },
        ]),
        { created: [], sourcesAlreadyImported: 0, sourcesTombstoned: 1 },
      );
      await assert.rejects(() => store.create(fullHeader()), /tombstoned/);
    } finally {
      store.close();
    }
  });
});

function fullHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace',
    cwd: '/workspace/repo',
    createdAt: 1,
    lastUsedAt: 2,
    lastMessageAt: 3,
    name: 'Session',
    titleIsManual: true,
    isFlagged: false,
    labels: ['alpha', 'beta'],
    isArchived: false,
    status: 'blocked',
    blockedReason: 'permission_required',
    statusUpdatedAt: 4,
    parentSessionId: 'parent-session',
    branchOfTurnId: 'branch-turn',
    revisionRootSessionId: 'root-session',
    revisionParentSessionId: 'previous-session',
    revisionOfTurnId: 'revised-turn',
    revisionIndex: 2,
    revisionState: 'committed',
    lastReadMessageId: 'message-1',
    hasUnread: true,
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai',
    connectionLocked: true,
    model: 'gpt-5',
    thinkingLevel: 'high',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'swarm',
    schemaVersion: 1,
    ...overrides,
  };
}

function nextNow(start: number): () => number {
  let current = start;
  return () => current++;
}
