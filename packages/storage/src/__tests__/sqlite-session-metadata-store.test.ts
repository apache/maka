import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { Worker } from 'node:worker_threads';
import {
  AgentGraphClientTerminalCursorError,
  canReadPath,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
  MAX_EXECUTION_BOUNDARY_SERIALIZED_BYTES,
  type SandboxBoundarySettlement,
  type SessionHeader,
} from '@maka/core';
import type { AgentGraphOperatorProvisionRequest } from '@maka/core/agent-graph-topology';
import {
  createSqliteSessionMetadataStore,
  SessionMetadataConflictError,
  SessionMetadataVersionConflictError,
  SQLITE_SESSION_METADATA_SCHEMA_VERSION,
  type SqliteSessionMetadataStoreFailpoint,
} from '../sqlite-session-metadata-store.js';
import {
  createSqliteRuntimeStore,
  SQLITE_RUNTIME_SCHEMA_VERSION,
} from '../sqlite-runtime-store.js';
import { SQLITE_AGENT_GRAPH_CONTROL_TABLES } from '../sqlite-session-metadata-schema.js';

describe('SqliteSessionMetadataStore', () => {
  test('migration locks only legacy sessions that already contain a user message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-lock-migration-'));
    const path = join(root, 'state.sqlite');
    try {
      const store = createSqliteSessionMetadataStore(path);
      await store.create(fullHeader({ id: 'with-user', connectionLocked: false }));
      await store.create(fullHeader({ id: 'assistant-only', connectionLocked: false }));
      store.close();

      const legacy = new DatabaseSync(path);
      legacy
        .prepare(`
        INSERT INTO session_messages(
          session_id, sequence, message_id, message_type, message_ts, record_json
        ) VALUES (?, 0, ?, ?, 1, ?)
      `)
        .run(
          'with-user',
          'user-1',
          'user',
          JSON.stringify({
            type: 'user',
            id: 'user-1',
            turnId: 'turn-1',
            ts: 1,
            text: 'hello',
          }),
        );
      legacy
        .prepare(`
        INSERT INTO session_messages(
          session_id, sequence, message_id, message_type, message_ts, record_json
        ) VALUES (?, 0, ?, ?, 1, ?)
      `)
        .run(
          'assistant-only',
          'assistant-1',
          'assistant',
          JSON.stringify({
            type: 'assistant',
            id: 'assistant-1',
            turnId: 'turn-1',
            ts: 1,
            text: 'preview',
            modelId: 'fake-model',
          }),
        );
      legacy
        .prepare(`
        UPDATE session_metadata_schema
        SET version = ?
        WHERE scope = 'session_metadata'
      `)
        .run(21);
      legacy.close();

      const migrated = createSqliteSessionMetadataStore(path);
      try {
        assert.equal((await migrated.read('with-user')).header.connectionLocked, true);
        assert.equal((await migrated.read('assistant-only')).header.connectionLocked, false);
      } finally {
        migrated.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('round-trips every SessionHeader field and reopens the same schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-metadata-'));
    const path = join(root, 'state.sqlite');
    try {
      const store = createSqliteSessionMetadataStore(path, { now: () => 100 });
      const header = fullHeader();
      assert.equal(store.schemaVersion(), SQLITE_SESSION_METADATA_SCHEMA_VERSION);
      assert.equal(store.journalMode(), 'wal');
      assert.deepEqual(await store.create(header), {
        header,
        metadataVersion: 1,
        committedAt: 100,
      });
      store.close();

      const reopened = createSqliteSessionMetadataStore(path, { now: () => 200 });
      try {
        assert.equal(reopened.schemaVersion(), SQLITE_SESSION_METADATA_SCHEMA_VERSION);
        assert.deepEqual(await reopened.read(header.id), {
          header,
          metadataVersion: 1,
          committedAt: 100,
        });
      } finally {
        reopened.close();
      }
      const schema = new DatabaseSync(path);
      try {
        const graphTables = schema
          .prepare(`
            SELECT name
            FROM sqlite_schema
            WHERE type = 'table' AND name GLOB 'agent_graph_*'
            ORDER BY name
          `)
          .all() as unknown as Array<{ readonly name: string }>;
        assert.deepEqual(
          graphTables.map(({ name }) => name),
          [...SQLITE_AGENT_GRAPH_CONTROL_TABLES].sort(),
        );
        assert.deepEqual(
          schema.prepare('PRAGMA foreign_key_list(agent_graph_client_operator_projections)').all(),
          [],
        );
        assert.deepEqual(
          schema.prepare('PRAGMA foreign_key_list(agent_graph_client_terminal_activity)').all(),
          [],
        );
      } finally {
        schema.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('atomically retires a revision family with CAS and tombstone retries', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: () => 100 });
    const root = fullHeader({
      id: 'family-root',
      parentSessionId: undefined,
      branchOfTurnId: undefined,
      revisionRootSessionId: undefined,
      revisionParentSessionId: undefined,
      revisionOfTurnId: undefined,
      revisionIndex: undefined,
      revisionState: undefined,
      isArchived: false,
      archivedAt: undefined,
      status: 'active',
      blockedReason: undefined,
    });
    const revision = fullHeader({
      id: 'family-revision',
      parentSessionId: undefined,
      branchOfTurnId: undefined,
      revisionRootSessionId: root.id,
      revisionParentSessionId: root.id,
      revisionOfTurnId: 'turn-1',
      revisionIndex: 2,
      revisionState: 'committed',
      isArchived: false,
      archivedAt: undefined,
      status: 'active',
      blockedReason: undefined,
    });
    try {
      await store.create(root);
      await store.create(revision);

      await assert.rejects(
        store.setLifecycleVersioned(
          [
            { sessionId: root.id, expectedVersion: 1 },
            { sessionId: revision.id, expectedVersion: 2 },
          ],
          'archived',
        ),
        SessionMetadataVersionConflictError,
      );
      for (const sessionId of [root.id, revision.id]) {
        const current = await store.read(sessionId);
        assert.equal(current.metadataVersion, 1);
        assert.equal(current.header.isArchived, false);
      }

      const archived = await store.setLifecycleVersioned(
        [
          { sessionId: root.id, expectedVersion: 1 },
          { sessionId: revision.id, expectedVersion: 1 },
        ],
        'archived',
      );
      assert.deepEqual(
        archived.map((record) => ({
          id: record.header.id,
          revision: record.metadataVersion,
          status: record.header.status,
        })),
        [
          { id: revision.id, revision: 2, status: 'archived' },
          { id: root.id, revision: 2, status: 'archived' },
        ],
      );

      await assert.rejects(
        store.removeVersioned([
          { sessionId: root.id, expectedVersion: 2 },
          { sessionId: revision.id, expectedVersion: 3 },
        ]),
        SessionMetadataVersionConflictError,
      );
      assert.equal((await store.probeRemoval(root.id)).kind, 'present');
      assert.equal((await store.probeRemoval(revision.id)).kind, 'present');

      const identities = [
        { sessionId: root.id, expectedVersion: 2 },
        { sessionId: revision.id, expectedVersion: 2 },
      ];
      assert.deepEqual(await store.removeVersioned(identities), [revision.id, root.id]);
      assert.deepEqual(await store.probeRemoval(root.id), { kind: 'removed' });
      assert.deepEqual(await store.probeRemoval(revision.id), { kind: 'removed' });
      assert.deepEqual(await store.listPendingSessionRetirementCleanupIds(root.id), [
        revision.id,
        root.id,
      ]);
      assert.deepEqual(await store.listPendingSessionRetirementCleanupIds(revision.id), [
        revision.id,
        root.id,
      ]);
      await store.completeSessionRetirementCleanup(revision.id);
      assert.deepEqual(await store.listPendingSessionRetirementCleanupIds(root.id), [root.id]);
      await store.completeSessionRetirementCleanup(root.id);
      assert.deepEqual(await store.listPendingSessionRetirementCleanupIds(), []);
      assert.deepEqual(await store.removeVersioned(identities), [revision.id, root.id]);
    } finally {
      store.close();
    }
  });

  test('coexists with the RuntimeEvent schema in one workspace database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-runtime-database-'));
    const path = join(root, 'runtime.sqlite');
    const runtime = createSqliteRuntimeStore(path);
    const metadata = createSqliteSessionMetadataStore(path);
    try {
      assert.equal(runtime.schemaVersion(), SQLITE_RUNTIME_SCHEMA_VERSION);
      assert.equal(metadata.schemaVersion(), SQLITE_SESSION_METADATA_SCHEMA_VERSION);
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

  test('migrates v12 sessions to durable revision-zero boundaries on first read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-boundary-v12-'));
    const path = join(root, 'sessions.sqlite');
    try {
      const initial = createSqliteSessionMetadataStore(path);
      for (const permissionMode of ['ask', 'execute', 'explore', 'bypass'] as const) {
        await initial.create(fullHeader({ id: `legacy-${permissionMode}`, permissionMode }));
      }
      initial.close();

      const v12 = new DatabaseSync(path);
      v12.exec(`
        DROP INDEX session_metadata_tombstones_by_retirement_unit;
        ALTER TABLE session_metadata_tombstones DROP COLUMN cleanup_pending;
        ALTER TABLE session_metadata_tombstones DROP COLUMN retirement_unit_id;
        DROP TABLE session_create_claims;
        DROP TABLE sandbox_boundary_log;
        DROP TABLE project_aliases;
        DROP TABLE project_locations;
        DROP TABLE projects;
        DROP TABLE session_messages;
        UPDATE session_metadata_schema
        SET version = 12
        WHERE scope = 'session_metadata';
      `);
      v12.close();

      const migrated = createSqliteSessionMetadataStore(path);
      for (const permissionMode of ['ask', 'execute', 'explore', 'bypass'] as const) {
        const boundary = await migrated.readExecutionBoundary(`legacy-${permissionMode}`);
        assert.equal(boundary.revision, 0);
        assert.equal(boundary.kind, permissionMode === 'bypass' ? 'bypass' : 'managed');
        if (boundary.kind === 'managed') {
          assert.equal(
            boundary.profile.name,
            permissionMode === 'explore' ? 'read-only' : 'workspace-write',
          );
        }
      }
      migrated.close();

      const reopened = createSqliteSessionMetadataStore(path);
      try {
        assert.deepEqual(await reopened.readExecutionBoundary('legacy-bypass'), {
          kind: 'bypass',
          revision: 0,
        });
        const readOnly = await reopened.readExecutionBoundary('legacy-explore');
        assert.equal(readOnly.kind, 'managed');
        if (readOnly.kind === 'managed') assert.equal(readOnly.profile.name, 'read-only');
      } finally {
        reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('creates a deterministic revision-zero execution boundary for every legacy mode', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    try {
      for (const mode of ['ask', 'execute', 'explore', 'bypass'] as const) {
        const header = fullHeader({
          id: `legacy-${mode}`,
          permissionMode: mode as SessionHeader['permissionMode'],
        });
        await store.create(header);

        const boundary = await store.readExecutionBoundary(header.id);
        assert.equal(boundary.revision, 0);
        assert.equal(boundary.kind, mode === 'bypass' ? 'bypass' : 'managed');
        if (boundary.kind === 'managed') {
          assert.equal(boundary.profile.name, mode === 'explore' ? 'read-only' : 'workspace-write');
        }
      }
    } finally {
      store.close();
    }
  });

  test('persists an explicitly supplied external genesis boundary', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    try {
      await store.create(fullHeader(), { kind: 'external', revision: 17 });

      assert.deepEqual(await store.readExecutionBoundary('session-1'), {
        kind: 'external',
        revision: 0,
      });
    } finally {
      store.close();
    }
  });

  test('persists one immutable normalized sandbox boundary request at the current revision', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: () => 50 });
    try {
      await store.create(fullHeader());
      const request = await store.createSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'boundary-request-1',
        turnId: 'turn-1',
        expansion: {
          filesystem: {
            entries: [
              { path: '/outside/tree/file.txt', access: 'read', scope: 'exact' },
              { path: '/outside/tree', access: 'read', scope: 'subtree' },
            ],
          },
        },
        justification: 'Read the requested source tree.',
      });

      assert.deepEqual(request, {
        sessionId: 'session-1',
        requestId: 'boundary-request-1',
        status: 'pending',
        baseRevision: 0,
        expansion: {
          filesystem: {
            entries: [{ path: '/outside/tree', access: 'read', scope: 'subtree' }],
          },
        },
        justification: 'Read the requested source tree.',
        createdAt: 50,
        turnId: 'turn-1',
      });
      assert.equal((await store.readExecutionBoundary('session-1')).revision, 0);
    } finally {
      store.close();
    }
  });

  test('serializes stale approvals without lost authority and settles retries idempotently', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(100) });
    try {
      await store.create(fullHeader());
      for (const [requestId, path] of [
        ['request-a', '/outside/a'],
        ['request-b', '/outside/b'],
      ] as const) {
        await store.createSandboxBoundaryRequest({
          sessionId: 'session-1',
          requestId,
          turnId: 'turn-1',
          expansion: {
            filesystem: { entries: [{ path, access: 'read', scope: 'subtree' }] },
          },
          justification: `Read ${path}.`,
        });
      }

      const first = await store.settleSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'request-a',
        decision: 'allow',
      });
      assert.equal(first.changed, true);
      assert.equal(first.boundary.revision, 1);

      const second = await store.settleSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'request-b',
        decision: 'allow',
      });
      assert.equal(second.changed, true);
      assert.equal(second.boundary.revision, 2);
      assert.equal(second.boundary.kind, 'managed');
      if (second.boundary.kind === 'managed') {
        assert.equal(canReadPath(second.boundary.profile, '/outside/a/file.txt'), true);
        assert.equal(canReadPath(second.boundary.profile, '/outside/b/file.txt'), true);
      }

      const retry = await store.settleSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'request-b',
        decision: 'allow',
      });
      assert.equal(retry.request.status, 'approved');
      assert.equal(retry.boundary.revision, 2);
      assert.equal((await store.readExecutionBoundary('session-1')).revision, 2);
    } finally {
      store.close();
    }
  });

  test('rejects an expansion atomically before the complete boundary exceeds capacity', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(120) });
    let rejectedRequestId: string | undefined;
    try {
      await store.create(fullHeader());
      for (let request = 0; request < 30; request += 1) {
        const requestId = `capacity-${request}`;
        await store.createSandboxBoundaryRequest({
          sessionId: 'session-1',
          requestId,
          turnId: 'turn-1',
          expansion: {
            filesystem: {
              entries: Array.from({ length: 32 }, (_, entry) => ({
                path: `/outside/${request}/${entry}-${'x'.repeat(1_800)}`,
                access: 'read' as const,
                scope: 'exact' as const,
              })),
            },
          },
          justification: 'Read generated inputs.',
        });
        const before = await store.readExecutionBoundary('session-1');
        try {
          await store.settleSandboxBoundaryRequest({
            sessionId: 'session-1',
            requestId,
            decision: 'allow',
          });
        } catch (error) {
          assert.match(String(error), /execution boundary.*size limit/i);
          rejectedRequestId = requestId;
          assert.deepEqual(await store.readExecutionBoundary('session-1'), before);
          assert.deepEqual(
            (await store.listPendingSandboxBoundaryRequests('session-1')).map(
              (pending) => pending.requestId,
            ),
            [requestId],
          );
          break;
        }
      }

      assert.ok(rejectedRequestId, 'a cumulative boundary must reach the shared capacity');
      assert.ok(
        Buffer.byteLength(JSON.stringify(await store.readExecutionBoundary('session-1')), 'utf8') <=
          MAX_EXECUTION_BOUNDARY_SERIALIZED_BYTES,
      );
    } finally {
      store.close();
    }
  });

  test('settles an already-authorized temp path without inflating the boundary revision', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(90) });
    try {
      await store.create(fullHeader());
      await store.createSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'request-tmp',
        turnId: 'turn-1',
        expansion: {
          filesystem: {
            entries: [{ path: join(tmpdir(), 'maka-output'), access: 'write', scope: 'exact' }],
          },
        },
        justification: 'Write a temporary output.',
      });

      const settlement = await store.settleSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'request-tmp',
        decision: 'allow',
      });

      assert.equal(settlement.changed, false);
      assert.equal(settlement.request.outcomeReason, 'already_applied');
      assert.equal(settlement.boundary.revision, 0);
    } finally {
      store.close();
    }
  });

  test('serializes competing approvals from independent SQLite connections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-boundary-writer-race-'));
    const path = join(root, 'sessions.sqlite');
    const setup = createSqliteSessionMetadataStore(path);
    try {
      await setup.create(fullHeader());
      for (const [requestId, outsidePath] of [
        ['request-a', '/outside/a'],
        ['request-b', '/outside/b'],
      ] as const) {
        await setup.createSandboxBoundaryRequest({
          sessionId: 'session-1',
          requestId,
          turnId: 'turn-1',
          expansion: {
            filesystem: {
              entries: [{ path: outsidePath, access: 'read', scope: 'subtree' }],
            },
          },
          justification: `Read ${outsidePath}.`,
        });
      }
    } finally {
      setup.close();
    }

    const release = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const first = boundarySettlementWorker(path, 'request-a', release);
    let second: ReturnType<typeof boundarySettlementWorker> | undefined;
    try {
      await first.ready;
      second = boundarySettlementWorker(path, 'request-b');
      await second.ready;
      first.start();
      await first.holding;
      second.start();
      await second.attempting;
      releaseWorker(release);

      const settlements = await Promise.all([first.settled, second.settled]);
      assert.deepEqual(
        settlements.map((settlement) => settlement.boundary.revision).sort((a, b) => a - b),
        [1, 2],
      );
      const verify = createSqliteSessionMetadataStore(path);
      try {
        const boundary = await verify.readExecutionBoundary('session-1');
        assert.equal(boundary.kind, 'managed');
        assert.equal(boundary.revision, 2);
        if (boundary.kind === 'managed') {
          assert.equal(canReadPath(boundary.profile, '/outside/a/file.txt'), true);
          assert.equal(canReadPath(boundary.profile, '/outside/b/file.txt'), true);
        }
      } finally {
        verify.close();
      }
    } finally {
      first.start();
      second?.start();
      releaseWorker(release);
      await Promise.all([first.terminate(), second?.terminate()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  test('records Auto and Bypass changes in the same revision log and restores managed authority', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(200) });
    try {
      await store.create(fullHeader());
      await store.createSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'approved-before-bypass',
        turnId: 'turn-1',
        expansion: {
          filesystem: {
            entries: [{ path: '/outside/kept', access: 'write', scope: 'subtree' }],
          },
        },
        justification: 'Write generated files.',
      });
      await store.settleSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'approved-before-bypass',
        decision: 'allow',
      });
      await store.createSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'stale-after-bypass',
        turnId: 'turn-1',
        expansion: { network: { enabled: true } },
        justification: 'Fetch a dependency.',
      });

      const bypass = await store.setExecutionBoundaryKind('session-1', 'bypass');
      assert.deepEqual(bypass, { kind: 'bypass', revision: 2 });
      assert.equal((await store.read('session-1')).header.permissionMode, 'bypass');
      const conflict = await store.settleSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'stale-after-bypass',
        decision: 'allow',
      });
      assert.equal(conflict.request.status, 'conflict');
      assert.equal(conflict.request.outcomeReason, 'boundary_kind_changed');
      assert.equal(conflict.boundary.revision, 2);

      const restored = await store.setExecutionBoundaryKind('session-1', 'managed');
      assert.equal(restored.kind, 'managed');
      assert.equal(restored.revision, 3);
      assert.equal((await store.read('session-1')).header.permissionMode, 'ask');
      if (restored.kind === 'managed') {
        assert.equal(canReadPath(restored.profile, '/outside/kept/file.txt'), true);
      }
      assert.equal((await store.setExecutionBoundaryKind('session-1', 'managed')).revision, 3);
    } finally {
      store.close();
    }
  });

  test('restores an unnamed managed profile after a temporary Bypass boundary', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(212) });
    const { name: _name, ...unnamedProfile } = createWorkspaceWritePermissionProfile();
    try {
      await store.create(fullHeader(), {
        kind: 'managed',
        profile: unnamedProfile,
        revision: 0,
      });

      await store.setExecutionBoundaryKind('session-1', 'bypass');
      const restored = await store.setExecutionBoundaryKind('session-1', 'managed');

      assert.equal(restored.kind, 'managed');
      if (restored.kind === 'managed') assert.deepEqual(restored.profile, unnamedProfile);
    } finally {
      store.close();
    }
  });

  test('restores canonical Auto when an Explore-origin session has no Auto history', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(218) });
    try {
      await store.create(fullHeader({ permissionMode: 'explore' }));

      await store.setExecutionBoundaryKind('session-1', 'bypass', {
        permissionMode: 'bypass',
      });
      const restored = await store.setExecutionBoundaryKind('session-1', 'managed', {
        permissionMode: 'ask',
      });

      assert.equal(restored.kind, 'managed');
      if (restored.kind === 'managed') {
        assert.deepEqual(restored.profile, createWorkspaceWritePermissionProfile());
      }
    } finally {
      store.close();
    }
  });

  test('classifies the internal read-only profile by policy instead of its display name', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(220) });
    const { name: _name, ...unnamedReadOnlyProfile } = createReadOnlyPermissionProfile();
    try {
      await store.create(fullHeader({ permissionMode: 'explore' }), {
        kind: 'managed',
        profile: unnamedReadOnlyProfile,
        revision: 0,
      });

      const restored = await store.setExecutionBoundaryKind('session-1', 'managed', {
        permissionMode: 'ask',
      });

      assert.equal(restored.kind, 'managed');
      if (restored.kind === 'managed') {
        assert.deepEqual(restored.profile, createWorkspaceWritePermissionProfile());
      }
    } finally {
      store.close();
    }
  });

  test('restores accumulated Auto authority after a temporary Explore boundary', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(225) });
    try {
      await store.create(fullHeader());
      await store.createSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'approved-before-explore',
        turnId: 'turn-1',
        expansion: {
          filesystem: {
            entries: [{ path: '/outside/kept', access: 'write', scope: 'subtree' }],
          },
        },
        justification: 'Write generated files.',
      });
      await store.settleSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'approved-before-explore',
        decision: 'allow',
      });

      const explore = await store.setExecutionBoundaryKind('session-1', 'managed', {
        permissionMode: 'explore',
      });
      assert.equal(explore.kind, 'managed');
      if (explore.kind === 'managed') assert.equal(explore.profile.name, 'read-only');

      const restored = await store.setExecutionBoundaryKind('session-1', 'managed', {
        permissionMode: 'ask',
      });
      assert.equal(restored.kind, 'managed');
      if (restored.kind === 'managed') {
        assert.equal(canReadPath(restored.profile, '/outside/kept/file.txt'), true);
      }
    } finally {
      store.close();
    }
  });

  test('projects an explicit legacy mode in the same managed-boundary transition', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(250) });
    try {
      await store.create(fullHeader({ labels: ['deep-research', 'kept'] }));

      const explore = await store.setExecutionBoundaryKind('session-1', 'managed', {
        permissionMode: 'explore',
        labels: ['kept'],
      });

      assert.equal(explore.kind, 'managed');
      assert.equal(explore.revision, 1);
      if (explore.kind === 'managed') assert.equal(explore.profile.name, 'read-only');
      const projected = (await store.read('session-1')).header;
      assert.equal(projected.permissionMode, 'explore');
      assert.deepEqual(projected.labels, ['kept']);
    } finally {
      store.close();
    }
  });

  test('reads the header projection and execution boundary from one authority snapshot', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(275) });
    try {
      await store.create(fullHeader());
      await store.setExecutionBoundaryKind('session-1', 'bypass', {
        permissionMode: 'bypass',
      });

      const snapshot = await store.readSessionAuthoritySnapshot('session-1');

      assert.equal(snapshot.record.header.permissionMode, 'bypass');
      assert.equal(snapshot.boundary.kind, 'bypass');
      assert.equal(snapshot.boundary.revision, 1);
    } finally {
      store.close();
    }
  });

  test('rolls back a boundary kind and header projection as one transaction', async () => {
    let armed = false;
    const store = createSqliteSessionMetadataStore(':memory:', {
      failpoint: (point) => {
        if (armed && point === 'after_sandbox_boundary_write') {
          throw new Error('injected boundary projection failure');
        }
      },
    });
    try {
      await store.create(fullHeader());
      armed = true;

      await assert.rejects(
        () =>
          store.setExecutionBoundaryKind('session-1', 'bypass', {
            permissionMode: 'bypass',
          }),
        /injected boundary projection failure/,
      );

      assert.equal((await store.readExecutionBoundary('session-1')).kind, 'managed');
      assert.equal((await store.read('session-1')).header.permissionMode, 'ask');
    } finally {
      store.close();
    }
  });

  test('rolls back request settlement and boundary application as one transaction', async () => {
    let armed = false;
    const store = createSqliteSessionMetadataStore(':memory:', {
      now: nextNow(300),
      failpoint: (point) => {
        if (armed && point === 'after_sandbox_boundary_write') {
          throw new Error('injected boundary commit failure');
        }
      },
    });
    try {
      await store.create(fullHeader());
      await store.createSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'atomic-request',
        turnId: 'turn-1',
        expansion: { network: { enabled: true } },
        justification: 'Fetch a dependency.',
      });

      armed = true;
      await assert.rejects(
        () =>
          store.settleSandboxBoundaryRequest({
            sessionId: 'session-1',
            requestId: 'atomic-request',
            decision: 'allow',
          }),
        /injected boundary commit failure/,
      );
      armed = false;
      assert.equal((await store.readExecutionBoundary('session-1')).revision, 0);

      const recovered = await store.settleSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'atomic-request',
        decision: 'allow',
      });
      assert.equal(recovered.request.status, 'approved');
      assert.equal(recovered.boundary.revision, 1);
    } finally {
      store.close();
    }
  });

  test('does not invent revisions for denial or an already-contained approval', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    try {
      await store.create(fullHeader());
      await store.createSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'denied-request',
        turnId: 'turn-1',
        expansion: { network: { enabled: true } },
        justification: 'Fetch a dependency.',
      });
      const denied = await store.settleSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'denied-request',
        decision: 'deny',
      });
      assert.equal(denied.request.status, 'denied');
      assert.equal(denied.boundary.revision, 0);

      await store.createSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'already-contained',
        turnId: 'turn-1',
        expansion: {
          filesystem: {
            entries: [{ path: '/workspace/repo/file.txt', access: 'read', scope: 'exact' }],
          },
        },
        justification: 'Read a workspace file.',
      });
      const noop = await store.settleSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'already-contained',
        decision: 'allow',
      });
      assert.equal(noop.request.status, 'approved');
      assert.equal(noop.request.outcomeReason, 'already_applied');
      assert.equal(noop.changed, false);
      assert.equal(noop.boundary.revision, 0);
    } finally {
      store.close();
    }
  });

  test('records host restart when recovery denies an ownerless boundary request', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(700) });
    try {
      await store.create(fullHeader());
      await store.createSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'restart-request',
        turnId: 'turn-1',
        expansion: { network: { enabled: true } },
        justification: 'Fetch a dependency.',
      });

      const recovered = await store.settleSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'restart-request',
        decision: 'deny',
        closureReason: 'host_restarted',
      });

      assert.equal(recovered.request.status, 'denied');
      assert.equal(recovered.request.outcomeReason, 'host_restarted');
      assert.equal(recovered.boundary.revision, 0);
      assert.deepEqual(await store.listPendingSandboxBoundaryRequests('session-1'), []);
      // The closure stays re-readable after it stops being pending; that is
      // what lets an interrupted recovery finish the job on its next attempt.
      assert.deepEqual(
        (await store.listSandboxBoundaryRestartClosures('session-1')).map((closure) => [
          closure.requestId,
          closure.turnId,
        ]),
        [['restart-request', 'turn-1']],
      );
    } finally {
      store.close();
    }
  });

  test('lists only host-restart closures, never other settlements', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(720) });
    try {
      await store.create(fullHeader());
      for (const requestId of ['restart-closed', 'plain-denied', 'approved', 'still-pending']) {
        await store.createSandboxBoundaryRequest({
          sessionId: 'session-1',
          requestId,
          turnId: 'turn-1',
          runId: 'run-1',
          expansion: { network: { enabled: true } },
          justification: `Request ${requestId}.`,
        });
      }
      await store.settleSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'restart-closed',
        decision: 'deny',
        closureReason: 'host_restarted',
      });
      await store.settleSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'plain-denied',
        decision: 'deny',
      });
      await store.settleSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'approved',
        decision: 'allow',
      });

      const closures = await store.listSandboxBoundaryRestartClosures('session-1');
      assert.deepEqual(
        closures.map((closure) => closure.requestId),
        ['restart-closed'],
      );
      assert.equal(closures[0]?.runId, 'run-1');
    } finally {
      store.close();
    }
  });

  test('keeps request provenance durable and rejects a reuse that changes it', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(740) });
    try {
      await store.create(fullHeader());
      const created = await store.createSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'request-1',
        turnId: 'turn-7',
        runId: 'run-9',
        expansion: { network: { enabled: true } },
        justification: 'Fetch a dependency.',
      });
      assert.equal(created.turnId, 'turn-7');
      assert.equal(created.runId, 'run-9');

      // Same id, same content: idempotent re-create returns the same row.
      const again = await store.createSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'request-1',
        turnId: 'turn-7',
        runId: 'run-9',
        expansion: { network: { enabled: true } },
        justification: 'Fetch a dependency.',
      });
      assert.deepEqual(again, created);

      await assert.rejects(
        store.createSandboxBoundaryRequest({
          sessionId: 'session-1',
          requestId: 'request-1',
          turnId: 'turn-8',
          runId: 'run-9',
          expansion: { network: { enabled: true } },
          justification: 'Fetch a dependency.',
        }),
        /identity was reused/,
      );
    } finally {
      store.close();
    }
  });

  test('migrates a v13 database and leaves legacy rows without provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-boundary-v13-'));
    const path = join(root, 'sessions.sqlite');
    try {
      const initial = createSqliteSessionMetadataStore(path);
      await initial.create(fullHeader());
      initial.close();

      // Rewind to the pre-provenance shape a shipped database would have.
      const v13 = new DatabaseSync(path);
      v13.exec(`
        DROP INDEX session_metadata_tombstones_by_retirement_unit;
        ALTER TABLE session_metadata_tombstones DROP COLUMN cleanup_pending;
        ALTER TABLE session_metadata_tombstones DROP COLUMN retirement_unit_id;
        DROP TABLE session_create_claims;
        DROP TABLE project_aliases;
        DROP TABLE project_locations;
        DROP TABLE projects;
        DROP TABLE session_messages;
        ALTER TABLE sandbox_boundary_log DROP COLUMN turn_id;
        ALTER TABLE sandbox_boundary_log DROP COLUMN run_id;
        DROP INDEX sandbox_boundary_log_settled_closures;
        INSERT INTO sandbox_boundary_log(
          session_id, entry_id, entry_kind, request_id, status, base_revision,
          expansion_json, justification, outcome_reason, created_at, settled_at
        ) VALUES (
          'session-1', 'request:legacy-request', 'expansion_request', 'legacy-request',
          'denied', 0, '{"network":{"enabled":true}}', 'Legacy request.',
          'host_restarted', 10, 11
        );
        UPDATE session_metadata_schema SET version = 13 WHERE scope = 'session_metadata';
      `);
      v13.close();

      const migrated = createSqliteSessionMetadataStore(path);
      try {
        const [legacy] = await migrated.listSandboxBoundaryRestartClosures('session-1');
        assert.equal(legacy?.requestId, 'legacy-request');
        assert.equal(legacy?.turnId, undefined);
        assert.equal(legacy?.runId, undefined);

        // New rows on the upgraded database carry provenance normally.
        await migrated.createSandboxBoundaryRequest({
          sessionId: 'session-1',
          requestId: 'fresh-request',
          turnId: 'turn-1',
          runId: 'run-1',
          expansion: { network: { enabled: true } },
          justification: 'Fetch a dependency.',
        });
        const [fresh] = await migrated.listPendingSandboxBoundaryRequests('session-1');
        assert.equal(fresh?.turnId, 'turn-1');
        assert.equal(fresh?.runId, 'run-1');
      } finally {
        migrated.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('lists only pending sandbox boundary requests for resume', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    try {
      await store.create(fullHeader());
      for (const requestId of ['keep-pending', 'settle-denied'] as const) {
        await store.createSandboxBoundaryRequest({
          sessionId: 'session-1',
          requestId,
          turnId: 'turn-1',
          expansion: { network: { enabled: true } },
          justification: `Request ${requestId}.`,
        });
      }
      await store.settleSandboxBoundaryRequest({
        sessionId: 'session-1',
        requestId: 'settle-denied',
        decision: 'deny',
      });

      assert.deepEqual(
        (await store.listPendingSandboxBoundaryRequests('session-1')).map(
          (request) => request.requestId,
        ),
        ['keep-pending'],
      );
    } finally {
      store.close();
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
      CREATE TABLE session_metadata_labels (
        session_id TEXT NOT NULL,
        label_index INTEGER NOT NULL,
        label TEXT NOT NULL,
        PRIMARY KEY(session_id, label_index),
        FOREIGN KEY(session_id) REFERENCES session_metadata(session_id) ON DELETE CASCADE
      );
      CREATE INDEX session_metadata_labels_by_label
        ON session_metadata_labels(label, session_id);
      CREATE TABLE session_metadata_tombstones (
        session_id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
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
      assert.equal(store.schemaVersion(), SQLITE_SESSION_METADATA_SCHEMA_VERSION);
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
        DROP INDEX session_metadata_tombstones_by_retirement_unit;
        ALTER TABLE session_metadata_tombstones DROP COLUMN cleanup_pending;
        ALTER TABLE session_metadata_tombstones DROP COLUMN retirement_unit_id;
        DROP TABLE session_create_claims;
        DROP TABLE sandbox_boundary_log;
        DROP TABLE project_aliases;
        DROP TABLE project_locations;
        DROP TABLE projects;
        DROP TABLE session_messages;
        DROP TABLE agent_graph_supervisor_wake_attempts;
        DROP TABLE agent_graph_supervisor_wakes;
        DROP TABLE agent_graph_client_applied_records;
        DROP TABLE agent_graph_client_terminal_activity;
        DROP TABLE agent_graph_client_operator_projections;
        DROP TABLE agent_graph_client_projections;
        DROP TABLE agent_graph_operator_provisions;
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
        assert.equal(migrated.schemaVersion(), SQLITE_SESSION_METADATA_SCHEMA_VERSION);
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

  test('keeps stable create claims across exact retries, removal, and reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-stable-session-create-'));
    const path = join(root, 'sessions.sqlite');
    const requestFingerprint = `sha256:${'a'.repeat(64)}`;
    try {
      const store = createSqliteSessionMetadataStore(path, { now: nextNow(10) });
      const header = fullHeader({ id: 'stable-session' });
      try {
        const created = await store.createStableSession(header, requestFingerprint);
        assert.equal(created.kind, 'created');
        assert.equal(created.record.metadataVersion, 1);

        const retry = await store.createStableSession(
          fullHeader({ id: 'stable-session', name: 'Changed default' }),
          requestFingerprint,
        );
        assert.equal(retry.kind, 'existing');
        assert.equal(retry.record.header.name, 'Session');
        assert.deepEqual(
          await store.probeStableSessionCreate('stable-session', `sha256:${'b'.repeat(64)}`),
          { kind: 'conflict', reason: 'identity_mismatch' },
        );
        assert.equal(await store.remove('stable-session'), true);
      } finally {
        store.close();
      }

      const reopened = createSqliteSessionMetadataStore(path);
      try {
        assert.deepEqual(
          await reopened.probeStableSessionCreate('stable-session', requestFingerprint),
          { kind: 'conflict', reason: 'removed' },
        );
        assert.deepEqual(
          await reopened.createStableSession(
            fullHeader({ id: 'stable-session' }),
            requestFingerprint,
          ),
          { kind: 'conflict', reason: 'removed' },
        );
      } finally {
        reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reserves stable create identity before metadata commit and across reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-stable-session-create-claim-'));
    const path = join(root, 'sessions.sqlite');
    const requestFingerprint = `sha256:${'c'.repeat(64)}`;
    try {
      const store = createSqliteSessionMetadataStore(path, { now: () => 10 });
      try {
        assert.deepEqual(
          await store.claimStableSessionCreate('stable-session', requestFingerprint),
          { kind: 'absent' },
        );
      } finally {
        store.close();
      }

      const reopened = createSqliteSessionMetadataStore(path, { now: () => 20 });
      try {
        assert.deepEqual(
          await reopened.probeStableSessionCreate('stable-session', requestFingerprint),
          { kind: 'absent' },
        );
        assert.deepEqual(
          await reopened.probeStableSessionCreate('stable-session', `sha256:${'d'.repeat(64)}`),
          { kind: 'conflict', reason: 'identity_mismatch' },
        );
        const created = await reopened.createStableSession(
          fullHeader({ id: 'stable-session' }),
          requestFingerprint,
        );
        assert.equal(created.kind, 'created');
      } finally {
        reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('commits configuration and sandbox boundary as one compare-and-set transaction', async () => {
    let armed = false;
    const store = createSqliteSessionMetadataStore(':memory:', {
      now: nextNow(20),
      failpoint: (point) => {
        if (armed && point === 'after_sandbox_boundary_write') {
          throw new Error('boundary failpoint');
        }
      },
    });
    const configuration = {
      expectedVersion: 1,
      configuration: {
        backend: 'ai-sdk' as const,
        llmConnectionSlug: 'openrouter',
        connectionLocked: true,
        model: 'openrouter/free',
        thinkingLevel: undefined,
        permissionMode: 'bypass' as const,
        collaborationMode: 'plan' as const,
        orchestrationMode: 'graph' as const,
        labels: ['configured'],
      },
      lifecycle: { kind: 'preserve' as const },
    };
    try {
      await store.create(
        fullHeader({
          id: 'configured-session',
          status: 'active',
          blockedReason: undefined,
          parentSessionId: undefined,
          permissionMode: 'ask',
        }),
      );

      armed = true;
      await assert.rejects(
        store.updateSessionConfiguration('configured-session', configuration),
        /boundary failpoint/,
      );
      armed = false;
      assert.equal((await store.read('configured-session')).header.permissionMode, 'ask');
      assert.deepEqual(await store.readExecutionBoundary('configured-session'), {
        kind: 'managed',
        profile: createWorkspaceWritePermissionProfile(),
        revision: 0,
      });

      const updated = await store.updateSessionConfiguration('configured-session', configuration);
      assert.equal(updated.metadataVersion, 2);
      assert.equal(updated.header.model, 'openrouter/free');
      assert.equal(updated.header.collaborationMode, 'plan');
      assert.equal(updated.header.orchestrationMode, 'graph');
      assert.deepEqual(updated.header.labels, ['configured']);
      assert.deepEqual(await store.readExecutionBoundary('configured-session'), {
        kind: 'bypass',
        revision: 1,
      });
      await assert.rejects(
        store.updateSessionConfiguration('configured-session', configuration),
        (error: unknown) => {
          assert.ok(error instanceof SessionMetadataVersionConflictError);
          assert.equal(error.expectedVersion, 1);
          assert.equal(error.actualVersion, 2);
          return true;
        },
      );
      await assert.rejects(
        store.updateSessionConfiguration('configured-session', {
          ...configuration,
          expectedVersion: 2,
          lifecycle: { kind: 'clear_connection_block', statusUpdatedAt: 30 },
        }),
        /no longer has a connection block/,
      );
    } finally {
      store.close();
    }
  });

  test('clears only the explicit connection-block lifecycle transition', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: () => 40 });
    try {
      await store.create(
        fullHeader({
          id: 'connection-blocked-session',
          status: 'blocked',
          blockedReason: 'NO_REAL_CONNECTION',
          statusUpdatedAt: 10,
        }),
      );
      const updated = await store.updateSessionConfiguration('connection-blocked-session', {
        expectedVersion: 1,
        configuration: {
          backend: 'ai-sdk',
          llmConnectionSlug: 'openrouter',
          connectionLocked: true,
          model: 'openrouter/free',
          thinkingLevel: undefined,
          permissionMode: 'ask',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
          labels: [],
        },
        lifecycle: { kind: 'clear_connection_block', statusUpdatedAt: 30 },
      });
      assert.equal(updated.header.status, 'active');
      assert.equal(updated.header.blockedReason, undefined);
      assert.equal(updated.header.statusUpdatedAt, 30);
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

  test('deletes metadata and its label projection atomically', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    try {
      await store.create(fullHeader());
      assert.equal(await store.remove('session-1'), true);
      assert.equal(await store.remove('session-1'), false);
      assert.equal(await store.has('session-1'), false);
      assert.equal(await store.isTombstoned('session-1'), true);
      assert.deepEqual(await store.list({ labelSlug: 'alpha' }), []);
      await assert.rejects(() => store.create(fullHeader()), /tombstoned/);
    } finally {
      store.close();
    }
  });
});

function boundarySettlementWorker(
  path: string,
  requestId: string,
  holdAfterBoundaryWrite?: SharedArrayBuffer,
): {
  ready: Promise<void>;
  attempting: Promise<void>;
  holding: Promise<void>;
  settled: Promise<SandboxBoundarySettlement>;
  start(): void;
  terminate(): Promise<number>;
} {
  const startSettlement = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const worker = new Worker(
    new URL('./fixtures/settle-sandbox-boundary-worker.js', import.meta.url),
    {
      workerData: {
        path,
        requestId,
        startSettlement,
        ...(holdAfterBoundaryWrite ? { holdAfterBoundaryWrite } : {}),
      },
    },
  );
  const ready = promiseWithResolvers<void>();
  const attempting = promiseWithResolvers<void>();
  const holding = promiseWithResolvers<void>();
  const settled = promiseWithResolvers<SandboxBoundarySettlement>();
  worker.on(
    'message',
    (
      message:
        | { type: 'ready' }
        | { type: 'attempting' }
        | { type: 'holding' }
        | { type: 'settled'; settlement: SandboxBoundarySettlement }
        | { type: 'failed'; message: string },
    ) => {
      if (message.type === 'ready') ready.resolve();
      else if (message.type === 'attempting') attempting.resolve();
      else if (message.type === 'holding') holding.resolve();
      else if (message.type === 'settled') settled.resolve(message.settlement);
      else {
        const error = new Error(message.message);
        ready.reject(error);
        attempting.reject(error);
        holding.reject(error);
        settled.reject(error);
      }
    },
  );
  worker.on('error', (error) => {
    ready.reject(error);
    attempting.reject(error);
    holding.reject(error);
    settled.reject(error);
  });
  return {
    ready: ready.promise,
    attempting: attempting.promise,
    holding: holding.promise,
    settled: settled.promise,
    start: () => releaseWorker(startSettlement),
    terminate: () => worker.terminate(),
  };
}

function releaseWorker(signal: SharedArrayBuffer): void {
  const state = new Int32Array(signal);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
}

function promiseWithResolvers<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('SQLite agent graph operator provisions', () => {
  test('atomically commits one child Session and monotonic topology row', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(700) });
    try {
      await store.commitAgentGraphScheduleUpdate({
        schemaVersion: 1,
        updateId: `graph_update_${'1'.repeat(32)}`,
        updateFingerprint: `sha256:${'2'.repeat(64)}`,
        graphId: 'graph-1',
        source: {
          sessionId: 'supervisor-session',
          runId: 'supervisor-run',
          turnId: 'supervisor-turn',
          toolCallId: 'schedule-tool',
        },
        addWork: [
          {
            workId: `graph_work_${'3'.repeat(32)}`,
            target: { kind: 'agent', agentId: 'local-read' },
            instruction: 'Inspect the input.',
            inputIds: [],
          },
        ],
        stop: [],
      });
      const request = graphProvisionRequest();
      const first = await store.createAgentGraphOperator(graphChildHeader(), request, 1);
      assert.equal(first.created, true);
      assert.equal(first.record.header.id, 'graph-child');
      assert.equal(first.provision.targetSessionId, 'graph-child');
      assert.deepEqual(await store.listAgentGraphOperatorProvisions('graph-1'), [first.provision]);

      const retryRequest = {
        ...request,
        initialTurnId: 'disposable-turn',
        initialRunId: 'disposable-run',
      };
      const retry = await store.createAgentGraphOperator(
        graphChildHeader({
          id: 'disposable-child',
          subagentSpawn: {
            ...graphChildHeader().subagentSpawn!,
            initialTurnId: retryRequest.initialTurnId,
            initialRunId: retryRequest.initialRunId,
          },
        }),
        retryRequest,
        1,
      );
      assert.equal(retry.created, false);
      assert.equal(retry.record.header.id, 'graph-child');
      assert.equal(retry.provision.initialRunId, request.initialRunId);

      await assert.rejects(
        store.createAgentGraphOperator(
          graphChildHeader({ id: 'drift-child' }),
          { ...request, provisionFingerprint: `sha256:${'9'.repeat(64)}` },
          1,
        ),
        /reused for different work/,
      );
      await assert.rejects(
        store.remove('graph-child'),
        /Cannot remove graph operator Session graph-child/,
      );
      assert.equal(await store.has('graph-child'), true);
      assert.equal(await store.isTombstoned('graph-child'), false);
      assert.deepEqual(await store.listAgentGraphOperatorProvisions('graph-1'), [first.provision]);
    } finally {
      store.close();
    }
  });

  test('retires a graph root with its operator and purges only that graph control state', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(800) });
    try {
      const root = await store.create(
        fullHeader({
          id: 'supervisor-session',
          parentSessionId: undefined,
          branchOfTurnId: undefined,
          revisionRootSessionId: undefined,
          revisionParentSessionId: undefined,
          revisionOfTurnId: undefined,
          revisionIndex: undefined,
          revisionState: undefined,
          status: 'active',
          blockedReason: undefined,
        }),
      );
      await store.commitAgentGraphScheduleUpdate({
        schemaVersion: 1,
        updateId: `graph_update_${'1'.repeat(32)}`,
        updateFingerprint: `sha256:${'2'.repeat(64)}`,
        graphId: 'graph-1',
        source: {
          sessionId: root.header.id,
          runId: 'supervisor-run',
          turnId: 'supervisor-turn',
          toolCallId: 'schedule-tool',
        },
        addWork: [
          {
            workId: `graph_work_${'3'.repeat(32)}`,
            target: { kind: 'agent', agentId: 'local-read' },
            instruction: 'Inspect the input.',
            inputIds: [],
          },
        ],
        stop: [],
      });
      const child = await store.createAgentGraphOperator(
        graphChildHeader(),
        graphProvisionRequest(),
        1,
      );
      await store.claimAgentGraphIntent({
        schemaVersion: 1,
        claimId: `graph_claim_${'a'.repeat(32)}`,
        graphId: 'graph-1',
        intentId: `graph_intent_${'b'.repeat(32)}`,
        intentFingerprint: `sha256:${'c'.repeat(64)}`,
        readinessContextFingerprint: `sha256:${'d'.repeat(64)}`,
        targetOperatorId: graphProvisionRequest().operatorId,
        targetSessionId: child.record.header.id,
        targetTurnId: 'graph-turn',
        targetRunId: 'graph-run',
      });
      await store.claimAgentGraphSupervisorWake({
        schemaVersion: 1,
        graphId: 'graph-1',
        wakeId: 'graph-wake',
        snapshotVersion: 'snapshot-1',
        rootSessionId: root.header.id,
      });
      await store.beginAgentGraphSupervisorWakeAttempt({
        graphId: 'graph-1',
        wakeId: 'graph-wake',
        attemptId: 'graph-attempt',
        turnId: 'supervisor-wake-turn',
      });
      await store.commitAgentGraphClientProjection({
        schemaVersion: 1,
        graphId: 'graph-1',
        rootSessionId: root.header.id,
        expectedSnapshotVersion: null,
        snapshotVersion: 'snapshot-1',
        snapshot: { status: 'running' },
        replaceOperators: true,
        operators: [{ operatorId: graphProvisionRequest().operatorId, payload: {} }],
        terminalActivities: [
          { recordId: 'terminal-record', eventTime: 1, payload: { status: 'completed' } },
        ],
        activityRecords: [{ recordId: 'terminal-record', eventTime: 1 }],
      });
      await store.commitAgentGraphScheduleUpdate({
        schemaVersion: 1,
        updateId: `graph_update_${'7'.repeat(32)}`,
        updateFingerprint: `sha256:${'8'.repeat(64)}`,
        graphId: 'graph-2',
        source: {
          sessionId: 'other-supervisor',
          runId: 'other-run',
          turnId: 'other-turn',
          toolCallId: 'other-tool',
        },
        addWork: [],
        stop: [{ targetId: 'other-target', reason: 'done' }],
      });

      await assert.rejects(
        store.removeVersioned([
          { sessionId: child.record.header.id, expectedVersion: child.record.metadataVersion },
        ]),
        /Cannot remove graph operator Session graph-child/,
      );
      await assert.rejects(
        store.removeVersioned([
          { sessionId: root.header.id, expectedVersion: root.metadataVersion },
        ]),
        /graph operator graph-child is outside the retirement unit/,
      );
      assert.deepEqual(
        await store.removeVersioned([
          { sessionId: root.header.id, expectedVersion: root.metadataVersion },
          { sessionId: child.record.header.id, expectedVersion: child.record.metadataVersion },
        ]),
        ['graph-child', 'supervisor-session'],
      );
      assert.equal(await store.has(root.header.id), false);
      assert.equal(await store.has(child.record.header.id), false);
      assert.equal((await store.listAgentGraphOperatorProvisions('graph-1')).length, 1);

      assert.equal(await store.purgeAgentGraphControlState('graph-1'), 9);
      assert.deepEqual(await store.listAgentGraphOperatorProvisions('graph-1'), []);
      assert.deepEqual(await store.listAgentGraphScheduleUpdates('graph-1'), []);
      assert.deepEqual(await store.listAgentGraphIntentClaims('graph-1'), []);
      assert.equal(await store.readAgentGraphSupervisorWake('graph-1', 'graph-wake'), undefined);
      assert.equal(await store.readAgentGraphClientProjection('graph-1'), undefined);
      assert.deepEqual(
        await store.listAgentGraphClientTerminalActivities('graph-1', { limit: 1 }),
        { records: [], hasMore: false },
      );
      assert.equal(await store.purgeAgentGraphControlState('graph-1'), 0);
      assert.equal((await store.listAgentGraphScheduleUpdates('graph-2')).length, 1);
    } finally {
      store.close();
    }
  });

  test('reconciles graph operators orphaned by legacy root-only retirement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-agent-graph-orphan-'));
    const path = join(root, 'runtime.sqlite');
    try {
      const store = createSqliteSessionMetadataStore(path, { now: () => 900 });
      const supervisor = await store.create(
        fullHeader({
          id: 'supervisor-session',
          parentSessionId: undefined,
          branchOfTurnId: undefined,
          revisionRootSessionId: undefined,
          revisionParentSessionId: undefined,
          revisionOfTurnId: undefined,
          revisionIndex: undefined,
          revisionState: undefined,
          status: 'active',
          blockedReason: undefined,
        }),
      );
      await store.commitAgentGraphScheduleUpdate({
        schemaVersion: 1,
        updateId: `graph_update_${'1'.repeat(32)}`,
        updateFingerprint: `sha256:${'2'.repeat(64)}`,
        graphId: 'graph-1',
        source: {
          sessionId: supervisor.header.id,
          runId: 'supervisor-run',
          turnId: 'supervisor-turn',
          toolCallId: 'schedule-tool',
        },
        addWork: [
          {
            workId: graphProvisionRequest().workId,
            target: { kind: 'agent', agentId: graphProvisionRequest().agentId },
            instruction: 'Inspect the input.',
            inputIds: [],
          },
        ],
        stop: [],
      });
      await store.createAgentGraphOperator(graphChildHeader(), graphProvisionRequest(), 1);
      store.close();

      const legacy = new DatabaseSync(path);
      try {
        legacy.exec('BEGIN IMMEDIATE');
        legacy
          .prepare('DELETE FROM session_metadata WHERE session_id = ?')
          .run(supervisor.header.id);
        legacy
          .prepare(`
            INSERT INTO session_metadata_tombstones(
              session_id,
              deleted_at,
              retirement_unit_id,
              cleanup_pending
            )
            VALUES (?, ?, ?, 0)
          `)
          .run(supervisor.header.id, 901, supervisor.header.id);
        legacy.exec('COMMIT');
      } catch (error) {
        legacy.exec('ROLLBACK');
        throw error;
      } finally {
        legacy.close();
      }

      const reopened = createSqliteSessionMetadataStore(path, { now: () => 902 });
      try {
        assert.equal(await reopened.has('graph-child'), true);
        assert.deepEqual(await reopened.listPendingSessionRetirementCleanupIds(), []);
        assert.deepEqual(await reopened.reconcileOrphanedAgentGraphRetirements(), ['graph-child']);
        assert.deepEqual(await reopened.probeRemoval('graph-child'), { kind: 'removed' });
        assert.deepEqual(
          await reopened.listPendingSessionRetirementCleanupIds(supervisor.header.id),
          ['graph-child', supervisor.header.id],
        );
        assert.equal((await reopened.listAgentGraphOperatorProvisions('graph-1')).length, 1);
        assert.deepEqual(await reopened.reconcileOrphanedAgentGraphRetirements(), []);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rolls back child and topology together on a provision failure', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', {
      failpoint(point) {
        if (point === 'after_agent_graph_operator_provision_write') throw new Error('crash');
      },
    });
    try {
      await store.commitAgentGraphScheduleUpdate({
        schemaVersion: 1,
        updateId: `graph_update_${'1'.repeat(32)}`,
        updateFingerprint: `sha256:${'2'.repeat(64)}`,
        graphId: 'graph-1',
        source: {
          sessionId: 'supervisor-session',
          runId: 'supervisor-run',
          turnId: 'supervisor-turn',
          toolCallId: 'schedule-tool',
        },
        addWork: [
          {
            workId: `graph_work_${'3'.repeat(32)}`,
            target: { kind: 'agent', agentId: 'local-read' },
            instruction: 'Inspect the input.',
            inputIds: [],
          },
        ],
        stop: [],
      });
      await assert.rejects(
        store.createAgentGraphOperator(graphChildHeader(), graphProvisionRequest(), 1),
        /crash/,
      );
      assert.deepEqual(await store.listAgentGraphOperatorProvisions('graph-1'), []);
      await assert.rejects(store.read('graph-child'), /not found/);
    } finally {
      store.close();
    }
  });
});

describe('SQLite agent graph client projections', () => {
  test('atomically reads a graph with an independently versioned operator row', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', {
      now: nextNow(400),
    });
    try {
      await store.create(graphRootHeader('root-session'));
      await store.commitAgentGraphClientProjection({
        schemaVersion: 1,
        graphId: 'graph-atomic-read',
        rootSessionId: 'root-session',
        expectedSnapshotVersion: null,
        snapshotVersion: 'snapshot-1',
        snapshot: { version: 1 },
        replaceOperators: true,
        operators: [
          { operatorId: 'operator-1', payload: { status: 'running' } },
          { operatorId: 'operator-2', payload: { status: 'waiting' } },
        ],
        terminalActivities: [],
        activityRecords: [],
      });
      await store.commitAgentGraphClientProjection({
        schemaVersion: 1,
        graphId: 'graph-atomic-read',
        rootSessionId: 'root-session',
        expectedSnapshotVersion: 'snapshot-1',
        snapshotVersion: 'snapshot-2',
        snapshot: { version: 2 },
        replaceOperators: false,
        operators: [{ operatorId: 'operator-1', payload: { status: 'completed' } }],
        terminalActivities: [],
        activityRecords: [{ recordId: 'record-1', eventTime: 10 }],
        incrementalRecordId: 'record-1',
      });

      const materialized = await store.readAgentGraphClientProjectionWithOperator(
        'graph-atomic-read',
        'operator-2',
      );
      assert.equal(materialized?.projection.snapshotVersion, 'snapshot-2');
      assert.equal(materialized?.operator?.snapshotVersion, 'snapshot-1');
      assert.deepEqual(materialized?.operator?.payload, { status: 'waiting' });
      assert.deepEqual(
        await store.readAgentGraphClientProjectionWithOperator(
          'graph-atomic-read',
          'missing-operator',
        ),
        {
          projection: materialized?.projection,
        },
      );
    } finally {
      store.close();
    }
  });

  test('CAS-fences stale writers and deduplicates incremental durable records', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', {
      now: nextNow(500),
    });
    try {
      await store.create(graphRootHeader('root-session'));
      await store.commitAgentGraphClientProjection({
        schemaVersion: 1,
        graphId: 'graph-cas',
        rootSessionId: 'root-session',
        expectedSnapshotVersion: null,
        snapshotVersion: 'snapshot-1',
        snapshot: { version: 1 },
        replaceOperators: true,
        operators: [{ operatorId: 'operator-1', payload: { status: 'running' } }],
        terminalActivities: [],
        activityRecords: [],
      });
      await assert.rejects(
        store.commitAgentGraphClientProjection({
          schemaVersion: 1,
          graphId: 'graph-cas',
          rootSessionId: 'root-session',
          expectedSnapshotVersion: null,
          snapshotVersion: 'snapshot-create-race',
          snapshot: { version: 99 },
          replaceOperators: true,
          operators: [],
          terminalActivities: [],
          activityRecords: [],
        }),
        /version conflict/,
      );
      await assert.rejects(
        store.commitAgentGraphClientProjection({
          schemaVersion: 1,
          graphId: 'graph-cas',
          rootSessionId: 'root-session',
          expectedSnapshotVersion: 'stale-snapshot',
          snapshotVersion: 'snapshot-stale-write',
          snapshot: { version: 99 },
          replaceOperators: false,
          operators: [],
          terminalActivities: [
            {
              recordId: 'stale-terminal',
              eventTime: 9,
              payload: { recordId: 'stale-terminal' },
            },
          ],
          activityRecords: [{ recordId: 'stale-terminal', eventTime: 9 }],
        }),
        /version conflict/,
      );
      assert.deepEqual(
        await store.listAgentGraphClientTerminalActivities('graph-cas', {
          limit: 8,
        }),
        { records: [], hasMore: false },
      );

      const applied = await store.commitAgentGraphClientProjection({
        schemaVersion: 1,
        graphId: 'graph-cas',
        rootSessionId: 'root-session',
        expectedSnapshotVersion: 'snapshot-1',
        snapshotVersion: 'snapshot-2',
        snapshot: { version: 2 },
        replaceOperators: false,
        operators: [{ operatorId: 'operator-1', payload: { status: 'completed' } }],
        terminalActivities: [],
        activityRecords: [{ recordId: 'record-1', eventTime: 10 }],
        incrementalRecordId: 'record-1',
      });
      assert.equal(applied.snapshotVersion, 'snapshot-2');

      const duplicate = await store.commitAgentGraphClientProjection({
        schemaVersion: 1,
        graphId: 'graph-cas',
        rootSessionId: 'root-session',
        expectedSnapshotVersion: 'snapshot-2',
        snapshotVersion: 'snapshot-3',
        snapshot: { version: 3 },
        replaceOperators: false,
        operators: [{ operatorId: 'operator-1', payload: { status: 'failed' } }],
        terminalActivities: [],
        activityRecords: [{ recordId: 'record-1', eventTime: 10 }],
        incrementalRecordId: 'record-1',
      });
      assert.equal(duplicate.snapshotVersion, 'snapshot-2');
      assert.deepEqual((await store.readAgentGraphClientProjection('graph-cas'))?.payload, {
        version: 2,
      });
      assert.deepEqual(
        (await store.readAgentGraphClientOperatorProjection('graph-cas', 'operator-1'))?.payload,
        { status: 'completed' },
      );
    } finally {
      store.close();
    }
  });

  test('materializes bounded current state and keyset-pages terminal activity', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', {
      now: nextNow(1_000),
    });
    try {
      await store.create(graphRootHeader('root-session'));
      const first = await store.commitAgentGraphClientProjection({
        schemaVersion: 1,
        graphId: 'graph-1',
        rootSessionId: 'root-session',
        expectedSnapshotVersion: null,
        snapshotVersion: 'snapshot-1',
        snapshot: { version: 1 },
        replaceOperators: true,
        operators: [
          { operatorId: 'operator-1', payload: { status: 'running' } },
          { operatorId: 'operator-2', payload: { status: 'completed' } },
        ],
        terminalActivities: [
          { recordId: 'record-1', eventTime: 1, payload: { recordId: 'record-1' } },
          { recordId: 'record-2', eventTime: 2, payload: { recordId: 'record-2' } },
          { recordId: 'record-3', eventTime: 3, payload: { recordId: 'record-3' } },
        ],
        activityRecords: [
          { recordId: 'record-1', eventTime: 1 },
          { recordId: 'record-2', eventTime: 2 },
          { recordId: 'record-3', eventTime: 3 },
        ],
      });
      assert.equal(first.snapshotVersion, 'snapshot-1');
      assert.deepEqual((await store.readAgentGraphClientProjection('graph-1'))?.payload, {
        version: 1,
      });
      assert.deepEqual(
        (await store.readAgentGraphClientOperatorProjection('graph-1', 'operator-1'))?.payload,
        { status: 'running' },
      );
      const firstPage = await store.listAgentGraphClientTerminalActivities('graph-1', { limit: 2 });
      assert.equal(firstPage.hasMore, true);
      assert.deepEqual(
        firstPage.records.map((record) => record.recordId),
        ['record-3', 'record-2'],
      );
      const secondPage = await store.listAgentGraphClientTerminalActivities('graph-1', {
        limit: 2,
        before: { eventTime: 2, recordId: 'record-2' },
      });
      assert.equal(secondPage.hasMore, false);
      assert.deepEqual(
        secondPage.records.map((record) => record.recordId),
        ['record-1'],
      );
      await assert.rejects(
        store.listAgentGraphClientTerminalActivities('graph-1', {
          limit: 2,
          before: { eventTime: 99, recordId: 'record-2' },
        }),
        (error: unknown) => error instanceof AgentGraphClientTerminalCursorError,
      );

      await store.commitAgentGraphClientProjection({
        schemaVersion: 1,
        graphId: 'graph-1',
        rootSessionId: 'root-session',
        expectedSnapshotVersion: 'snapshot-1',
        snapshotVersion: 'snapshot-2',
        snapshot: { version: 2 },
        replaceOperators: true,
        operators: [{ operatorId: 'operator-1', payload: { status: 'completed' } }],
        terminalActivities: [
          { recordId: 'record-3', eventTime: 3, payload: { recordId: 'record-3' } },
        ],
        activityRecords: [{ recordId: 'record-3', eventTime: 3 }],
      });
      assert.equal(
        await store.readAgentGraphClientOperatorProjection('graph-1', 'operator-2'),
        undefined,
      );
      assert.equal(
        (await store.readAgentGraphClientOperatorProjection('graph-1', 'operator-1'))
          ?.snapshotVersion,
        'snapshot-2',
      );
      await assert.rejects(
        store.commitAgentGraphClientProjection({
          schemaVersion: 1,
          graphId: 'graph-1',
          rootSessionId: 'root-session',
          expectedSnapshotVersion: 'snapshot-2',
          snapshotVersion: 'snapshot-3',
          snapshot: { version: 3 },
          replaceOperators: true,
          operators: [],
          terminalActivities: [
            { recordId: 'record-3', eventTime: 4, payload: { recordId: 'record-3' } },
          ],
          activityRecords: [{ recordId: 'record-3', eventTime: 4 }],
        }),
        /changed after materialization/,
      );
    } finally {
      store.close();
    }
  });

  test('rejects a projection commit after its root retirement cleanup completes', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    try {
      const root = await store.create(graphRootHeader('root-session'));
      const request = {
        schemaVersion: 1 as const,
        graphId: 'graph-retired-root',
        rootSessionId: root.header.id,
        expectedSnapshotVersion: null,
        snapshotVersion: 'snapshot-1',
        snapshot: { status: 'idle' },
        replaceOperators: true,
        operators: [],
        terminalActivities: [],
        activityRecords: [],
      };

      await store.removeVersioned([
        { sessionId: root.header.id, expectedVersion: root.metadataVersion },
      ]);
      await store.purgeAgentGraphControlState(request.graphId);
      await store.completeSessionRetirementCleanup(root.header.id);

      await assert.rejects(store.commitAgentGraphClientProjection(request), /not found/);
      assert.equal(await store.readAgentGraphClientProjection(request.graphId), undefined);
      assert.deepEqual(await store.listPendingSessionRetirementCleanupIds(), []);
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

function graphRootHeader(id: string): SessionHeader {
  return fullHeader({
    id,
    parentSessionId: undefined,
    branchOfTurnId: undefined,
    revisionRootSessionId: undefined,
    revisionParentSessionId: undefined,
    revisionOfTurnId: undefined,
    revisionIndex: undefined,
    revisionState: undefined,
    status: 'active',
    blockedReason: undefined,
  });
}

function graphProvisionRequest(): AgentGraphOperatorProvisionRequest {
  return {
    schemaVersion: 1,
    provisionId: `graph_provision_${'4'.repeat(32)}`,
    provisionFingerprint: `sha256:${'5'.repeat(64)}`,
    graphId: 'graph-1',
    workId: `graph_work_${'3'.repeat(32)}`,
    agentId: 'local-read',
    operatorId: `graph_operator_${'6'.repeat(32)}`,
    initialTurnId: 'graph-turn',
    initialRunId: 'graph-run',
    edges: [],
  };
}

function graphChildHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
  const request = graphProvisionRequest();
  return fullHeader({
    id: 'graph-child',
    parentSessionId: undefined,
    branchOfTurnId: undefined,
    revisionRootSessionId: undefined,
    revisionParentSessionId: undefined,
    revisionOfTurnId: undefined,
    revisionIndex: undefined,
    revisionState: undefined,
    status: 'active',
    blockedReason: undefined,
    orchestrationMode: 'default',
    subagentParent: {
      kind: 'subagent',
      parentSessionId: 'supervisor-session',
      spawnedBy: {
        parentRunId: 'supervisor-run',
        parentTurnId: 'supervisor-turn',
        toolCallId: 'schedule-tool',
      },
      graph: {
        graphId: request.graphId,
        workId: request.workId,
        operatorId: request.operatorId,
      },
      lifecycle: 'foreground',
    },
    subagentRuntime: {
      schemaVersion: 1,
      definitionVersion: 1,
      agentId: request.agentId,
      agentName: 'Local Read',
      profile: 'local_read',
      systemPrompt: 'Read only.',
      toolNames: ['Read'],
      categoryPolicy: { read: 'allow' },
      permissionCeiling: 'ask',
    },
    subagentSpawn: {
      schemaVersion: 1,
      requestFingerprint: '5'.repeat(64),
      initialTurnId: request.initialTurnId,
      initialRunId: request.initialRunId,
    },
    ...overrides,
  });
}

function nextNow(start: number): () => number {
  let current = start;
  return () => current++;
}
