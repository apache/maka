import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION } from '@maka/core';
import {
  createSqliteSessionMetadataStore,
  SQLITE_SESSION_METADATA_SCHEMA_VERSION,
} from '../sqlite-session-metadata-store.js';

describe('SQLite Agent Graph supervisor wakes', () => {
  test('tracks retry attempts separately and marks delivery only after completion', async () => {
    let now = 10;
    const store = createSqliteSessionMetadataStore(':memory:', { now: () => now++ });
    try {
      const claim = await store.claimAgentGraphSupervisorWake({
        schemaVersion: AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION,
        graphId: 'graph-1',
        wakeId: 'wake-1',
        snapshotVersion: 'snapshot-1',
        rootSessionId: 'session-1',
      });
      assert.equal(claim.created, true);
      assert.equal(claim.wake.status, 'pending');

      const first = await store.beginAgentGraphSupervisorWakeAttempt({
        graphId: 'graph-1',
        wakeId: 'wake-1',
        attemptId: 'attempt-1',
        turnId: 'turn-1',
      });
      assert.equal(first.acquired, true);
      assert.equal(first.wake.status, 'running');
      assert.equal(first.wake.attemptCount, 1);
      await store.completeAgentGraphSupervisorWakeAttempt({
        graphId: 'graph-1',
        wakeId: 'wake-1',
        attemptId: 'attempt-1',
        status: 'retryable_failed',
        failureReason: 'provider failed after prompt persistence',
      });

      const second = await store.beginAgentGraphSupervisorWakeAttempt({
        graphId: 'graph-1',
        wakeId: 'wake-1',
        attemptId: 'attempt-2',
        turnId: 'turn-2',
      });
      assert.equal(second.acquired, true);
      assert.equal(second.wake.attemptCount, 2);
      const parked = await store.completeAgentGraphSupervisorWakeAttempt({
        graphId: 'graph-1',
        wakeId: 'wake-1',
        attemptId: 'attempt-2',
        status: 'waiting_permission',
      });
      assert.equal(parked.status, 'waiting_permission');
      assert.equal(
        (await store.listAgentGraphSupervisorWakeAttempts('graph-1', 'wake-1'))[1]?.completedAt,
        undefined,
      );
      assert.equal(
        (
          await store.beginAgentGraphSupervisorWakeAttempt({
            graphId: 'graph-1',
            wakeId: 'wake-1',
            attemptId: 'attempt-3',
            turnId: 'turn-3',
          })
        ).acquired,
        false,
      );
      const delivered = await store.completeAgentGraphSupervisorWakeAttempt({
        graphId: 'graph-1',
        wakeId: 'wake-1',
        attemptId: 'attempt-2',
        status: 'delivered',
      });
      assert.equal(delivered.status, 'delivered');
      assert.deepEqual(
        (await store.listAgentGraphSupervisorWakeAttempts('graph-1', 'wake-1')).map(
          (attempt) => attempt.status,
        ),
        ['retryable_failed', 'delivered'],
      );
      assert.equal(
        (
          await store.beginAgentGraphSupervisorWakeAttempt({
            graphId: 'graph-1',
            wakeId: 'wake-1',
            attemptId: 'attempt-3',
            turnId: 'turn-3',
          })
        ).acquired,
        false,
      );
    } finally {
      store.close();
    }
  });

  test('recovers pre-run pending wakes without guessing the AgentRun state', async () => {
    let now = 20;
    const store = createSqliteSessionMetadataStore(':memory:', { now: () => now++ });
    try {
      await store.claimAgentGraphSupervisorWake({
        schemaVersion: AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION,
        graphId: 'graph-pending',
        wakeId: 'wake-pending',
        snapshotVersion: 'snapshot-pending',
        rootSessionId: 'session-pending',
      });
      await store.claimAgentGraphSupervisorWake({
        schemaVersion: AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION,
        graphId: 'graph-running',
        wakeId: 'wake-running',
        snapshotVersion: 'snapshot-running',
        rootSessionId: 'session-running',
      });
      await store.beginAgentGraphSupervisorWakeAttempt({
        graphId: 'graph-running',
        wakeId: 'wake-running',
        attemptId: 'attempt-running',
        turnId: 'turn-running',
      });

      assert.equal(await store.recoverAgentGraphSupervisorWakes(), 1);
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-pending', 'wake-pending'))?.status,
        'retryable_failed',
      );
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-running', 'wake-running'))?.status,
        'running',
      );
      assert.equal(
        (await store.listAgentGraphSupervisorWakeAttempts('graph-running', 'wake-running'))[0]
          ?.failureReason,
        undefined,
      );
      assert.deepEqual(
        (await store.listUnsettledAgentGraphSupervisorWakes()).map((wake) => wake.wakeId),
        ['wake-running'],
      );
    } finally {
      store.close();
    }
  });

  test('terminally supersedes only non-delivered wakes for retired Sessions', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    try {
      for (const wakeId of ['wake-pending', 'wake-running', 'wake-delivered']) {
        await store.claimAgentGraphSupervisorWake({
          schemaVersion: AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION,
          graphId: 'graph-1',
          wakeId,
          snapshotVersion: wakeId,
          rootSessionId: 'session-1',
        });
      }
      for (const wakeId of ['wake-running', 'wake-delivered']) {
        await store.beginAgentGraphSupervisorWakeAttempt({
          graphId: 'graph-1',
          wakeId,
          attemptId: `${wakeId}-attempt`,
          turnId: `${wakeId}-turn`,
        });
      }
      await store.completeAgentGraphSupervisorWakeAttempt({
        graphId: 'graph-1',
        wakeId: 'wake-delivered',
        attemptId: 'wake-delivered-attempt',
        status: 'delivered',
      });

      assert.equal(
        await store.supersedeAgentGraphSupervisorWakes({
          rootSessionIds: ['session-1'],
          reason: 'session_retired',
        }),
        2,
      );
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-1', 'wake-pending'))?.status,
        'superseded',
      );
      assert.equal(
        (await store.listAgentGraphSupervisorWakeAttempts('graph-1', 'wake-running'))[0]?.status,
        'superseded',
      );
      assert.equal(
        (await store.readAgentGraphSupervisorWake('graph-1', 'wake-delivered'))?.status,
        'delivered',
      );
      assert.deepEqual(await store.listRetryableAgentGraphSupervisorWakes(), []);
    } finally {
      store.close();
    }
  });

  test('migrates version 11 wake attempts without losing correlation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-supervisor-wake-v11-'));
    const path = join(root, 'sessions.sqlite');
    try {
      const initial = createSqliteSessionMetadataStore(path);
      await initial.claimAgentGraphSupervisorWake({
        schemaVersion: AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION,
        graphId: 'graph-1',
        wakeId: 'wake-1',
        snapshotVersion: 'snapshot-1',
        rootSessionId: 'session-1',
      });
      await initial.beginAgentGraphSupervisorWakeAttempt({
        graphId: 'graph-1',
        wakeId: 'wake-1',
        attemptId: 'attempt-1',
        turnId: 'turn-1',
      });
      initial.close();

      const v11 = new DatabaseSync(path);
      v11.exec(`
        DROP INDEX session_metadata_tombstones_by_retirement_unit;
        ALTER TABLE session_metadata_tombstones DROP COLUMN cleanup_pending;
        ALTER TABLE session_metadata_tombstones DROP COLUMN retirement_unit_id;
        DROP TABLE session_create_claims;
        DROP TABLE sandbox_boundary_log;
        DROP TABLE project_aliases;
        DROP TABLE project_locations;
        DROP TABLE projects;
        DROP TABLE session_messages;
      `);
      v11
        .prepare(`UPDATE session_metadata_schema SET version = 11 WHERE scope = 'session_metadata'`)
        .run();
      v11.close();

      const migrated = createSqliteSessionMetadataStore(path);
      assert.equal(migrated.schemaVersion(), SQLITE_SESSION_METADATA_SCHEMA_VERSION);
      assert.equal(
        (await migrated.readAgentGraphSupervisorWake('graph-1', 'wake-1'))?.status,
        'running',
      );
      assert.equal(
        (await migrated.listAgentGraphSupervisorWakeAttempts('graph-1', 'wake-1'))[0]?.attemptId,
        'attempt-1',
      );
      migrated.close();

      const verified = new DatabaseSync(path);
      assert.deepEqual(verified.prepare('PRAGMA foreign_key_check').all(), []);
      verified.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
