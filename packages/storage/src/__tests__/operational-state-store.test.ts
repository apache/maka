import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { SessionHeader } from '@maka/core';
import {
  acquireOperationalStateDatabase,
  type OperationalStateCutoverFailpoint,
} from '../operational-state-store.js';
import {
  createSqliteRuntimeStore,
  SQLITE_RUNTIME_SCHEMA_VERSION,
} from '../sqlite-runtime-store.js';
import {
  createSqliteSessionMetadataStore,
  SQLITE_SESSION_METADATA_SCHEMA_VERSION,
} from '../sqlite-session-metadata-store.js';

describe('operational state database cutover', () => {
  test('keeps the owner alive until an admitted online backup completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-operational-backup-owner-'));
    const backupPath = join(root, 'backup.sqlite');
    try {
      const lease = acquireOperationalStateDatabase(root);
      const metadata = createSqliteSessionMetadataStore(join(root, 'runtime.sqlite'), {
        databaseLease: lease,
      });
      await metadata.create(sessionHeader({ name: 'Backup session' }));
      const backup = lease.backup(backupPath);
      metadata.close();
      assert.ok((await backup) > 0);

      const reopened = new DatabaseSync(backupPath, { readOnly: true });
      try {
        assert.equal(
          (
            reopened.prepare('SELECT COUNT(*) AS count FROM session_metadata').get() as {
              count: number;
            }
          ).count,
          1,
        );
      } finally {
        reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('imports sessions.sqlite into runtime.sqlite once and rejects later legacy changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-operational-cutover-'));
    const legacyPath = join(root, 'sessions.sqlite');
    const runtimePath = join(root, 'runtime.sqlite');
    try {
      const legacy = createSqliteSessionMetadataStore(legacyPath, { now: () => 10 });
      await legacy.create(sessionHeader());
      legacy.close();

      const lease = acquireOperationalStateDatabase(root, { now: () => 20 });
      const secondLease = acquireOperationalStateDatabase(root);
      assert.equal(secondLease.database, lease.database);
      secondLease.close();
      const metadata = createSqliteSessionMetadataStore(runtimePath, {
        databaseLease: lease,
        now: () => 30,
      });
      assert.equal((await metadata.read('session-1')).header.name, 'Legacy session');
      assert.deepEqual(
        lease.database
          .prepare(`SELECT scope, version FROM operational_schema_migrations ORDER BY scope`)
          .all()
          .map((row) => ({ ...row })),
        [
          { scope: 'artifact', version: 1 },
          { scope: 'automation', version: 1 },
          { scope: 'core_execution', version: 1 },
          { scope: 'operational', version: 1 },
          { scope: 'runtime', version: SQLITE_RUNTIME_SCHEMA_VERSION },
          { scope: 'session_metadata', version: SQLITE_SESSION_METADATA_SCHEMA_VERSION },
          { scope: 'usage', version: 1 },
          { scope: 'workflow', version: 1 },
        ],
      );
      assert.deepEqual(
        {
          ...(lease.database
            .prepare(`
            SELECT state, source_path, validation_json
            FROM cutover_journal
            WHERE store_name = 'session_metadata'
          `)
            .get() as Record<string, unknown>),
        },
        {
          state: 'completed',
          source_path: legacyPath,
          validation_json: JSON.stringify({
            session_metadata: 1,
            session_metadata_labels: 1,
            session_metadata_import_sources: 0,
            session_metadata_tombstones: 0,
            subagent_spawns: 0,
            agent_graph_intent_claims: 0,
            agent_graph_schedule_updates: 0,
            agent_graph_operator_provisions: 0,
            agent_graph_client_projections: 0,
            agent_graph_client_operator_projections: 0,
            agent_graph_client_terminal_activity: 0,
            agent_graph_client_applied_records: 0,
            agent_graph_supervisor_wakes: 0,
            agent_graph_supervisor_wake_attempts: 0,
            sandbox_boundary_log: 1,
          }),
        },
      );
      metadata.close();
      assert.ok((await stat(legacyPath)).isFile(), 'legacy database remains as cutover evidence');

      const reopenedLease = acquireOperationalStateDatabase(root);
      reopenedLease.close();

      const changedLegacy = createSqliteSessionMetadataStore(legacyPath);
      await changedLegacy.update('session-1', { name: 'Changed by an old binary' });
      changedLegacy.close();
      assert.throws(
        () => acquireOperationalStateDatabase(root),
        /changed after session metadata cutover completed/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed instead of merging conflicting canonical and legacy rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-operational-cutover-conflict-'));
    const legacyPath = join(root, 'sessions.sqlite');
    const runtimePath = join(root, 'runtime.sqlite');
    try {
      const legacy = createSqliteSessionMetadataStore(legacyPath);
      await legacy.create(sessionHeader());
      legacy.close();

      const runtime = createSqliteRuntimeStore(runtimePath);
      runtime.close();
      const canonical = createSqliteSessionMetadataStore(runtimePath);
      await canonical.create(sessionHeader({ name: 'Canonical session' }));
      canonical.close();

      assert.throws(
        () => acquireOperationalStateDatabase(root),
        /Session metadata cutover conflict in table session_metadata/,
      );
      const verified = createSqliteSessionMetadataStore(runtimePath);
      try {
        assert.equal((await verified.read('session-1')).header.name, 'Canonical session');
      } finally {
        verified.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects an empty legacy database instead of recording an empty cutover', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-operational-cutover-empty-'));
    try {
      await writeFile(join(root, 'sessions.sqlite'), '');
      assert.throws(
        () => acquireOperationalStateDatabase(root),
        /not a non-empty regular database file/,
      );
      const target = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        assert.equal(
          (
            target.prepare(`SELECT COUNT(*) AS count FROM cutover_journal`).get() as {
              count: number;
            }
          ).count,
          0,
        );
      } finally {
        target.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const failpoint of [
    'after_cutover_started',
    'after_cutover_rows_copied',
    'after_cutover_validated',
  ] satisfies OperationalStateCutoverFailpoint[]) {
    test(`resumes atomically after ${failpoint}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'maka-operational-cutover-crash-'));
      const legacyPath = join(root, 'sessions.sqlite');
      const runtimePath = join(root, 'runtime.sqlite');
      try {
        const legacy = createSqliteSessionMetadataStore(legacyPath);
        await legacy.create(sessionHeader());
        legacy.close();

        assert.throws(
          () =>
            acquireOperationalStateDatabase(root, {
              failpoint: (point) => {
                if (point === failpoint) throw new Error(`failpoint:${point}`);
              },
            }),
          new RegExp(`failpoint:${failpoint}`),
        );

        const interrupted = new DatabaseSync(runtimePath);
        try {
          assert.deepEqual(
            {
              ...(interrupted
                .prepare(`
                SELECT state, completed_at
                FROM cutover_journal
                WHERE store_name = 'session_metadata'
              `)
                .get() as Record<string, unknown>),
            },
            { state: 'started', completed_at: null },
          );
          assert.equal(
            (
              interrupted.prepare(`SELECT COUNT(*) AS count FROM session_metadata`).get() as {
                count: number;
              }
            ).count,
            0,
          );
        } finally {
          interrupted.close();
        }

        const resumed = acquireOperationalStateDatabase(root);
        try {
          assert.equal(
            (
              resumed.database.prepare(`SELECT COUNT(*) AS count FROM session_metadata`).get() as {
                count: number;
              }
            ).count,
            1,
          );
          assert.equal(
            (
              resumed.database
                .prepare(`
                  SELECT state
                  FROM cutover_journal
                  WHERE store_name = 'session_metadata'
                `)
                .get() as { state: string }
            ).state,
            'completed',
          );
        } finally {
          resumed.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

function sessionHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 2,
    name: 'Legacy session',
    titleIsManual: true,
    isFlagged: false,
    labels: ['legacy'],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'fake',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test-model',
    thinkingLevel: 'medium',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'swarm',
    schemaVersion: 1,
    ...overrides,
  };
}
