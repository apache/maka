import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION } from '@maka/core/agent-graph-control';
import {
  AgentGraphIntentClaimConflictError,
  createSqliteSessionMetadataStore,
  SQLITE_SESSION_METADATA_SCHEMA_VERSION,
} from '../sqlite-session-metadata-store.js';

describe('SQLite agent graph intent claims', () => {
  test('atomically allocates one stable activation identity per intent', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: () => 42 });
    try {
      const first = await store.claimAgentGraphIntent(request());
      const retry = await store.claimAgentGraphIntent(
        request({ targetTurnId: 'discarded-turn', targetRunId: 'discarded-run' }),
      );
      assert.equal(first.created, true);
      assert.equal(retry.created, false);
      assert.deepEqual(retry.claim, first.claim);
      assert.equal(retry.claim.targetTurnId, 'turn-next');
      assert.equal(retry.claim.targetRunId, 'run-next');
      assert.deepEqual(await store.readAgentGraphIntentClaim('graph-1', request().intentId), {
        ...request(),
        claimedAt: 42,
      });
      assert.deepEqual(await store.listAgentGraphIntentClaims('graph-1'), [first.claim]);
    } finally {
      store.close();
    }
  });

  test('rejects reused intent and activation identities with different semantics', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    try {
      await store.claimAgentGraphIntent(request());
      await assert.rejects(
        store.claimAgentGraphIntent(request({ intentFingerprint: `sha256:${'e'.repeat(64)}` })),
        AgentGraphIntentClaimConflictError,
      );
      await assert.rejects(
        store.claimAgentGraphIntent(
          request({
            claimId: `graph_claim_${'f'.repeat(32)}`,
            intentId: `graph_intent_${'e'.repeat(32)}`,
          }),
        ),
        AgentGraphIntentClaimConflictError,
      );
      await assert.rejects(
        store.claimAgentGraphIntent(
          request({
            claimId: `graph_claim_${'1'.repeat(32)}`,
            intentId: `graph_intent_${'2'.repeat(32)}`,
            targetRunId: 'different-run',
          }),
        ),
        AgentGraphIntentClaimConflictError,
      );
      assert.equal((await store.listAgentGraphIntentClaims()).length, 1);
    } finally {
      store.close();
    }
  });

  test('rolls back a claim when the transaction fails before commit', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', {
      failpoint(point) {
        if (point === 'after_agent_graph_intent_claim_write') throw new Error('crash');
      },
    });
    try {
      await assert.rejects(store.claimAgentGraphIntent(request()), /crash/);
      assert.deepEqual(await store.listAgentGraphIntentClaims(), []);
    } finally {
      store.close();
    }
  });

  test('atomically transitions claimed work to executing or cancelled', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(50) });
    try {
      await store.claimAgentGraphIntent(request());
      assert.deepEqual(
        await store.beginAgentGraphIntentExecutionAtScheduleRevision(
          'graph-1',
          request().intentId,
          0,
        ),
        {
          state: 'executing',
          previousState: 'claimed',
          changed: true,
        },
      );
      assert.deepEqual(
        await store.cancelAgentGraphIntentExecution(
          'graph-1',
          request().intentId,
          'Supervisor stopped the work.',
        ),
        {
          state: 'cancelled',
          previousState: 'executing',
          changed: true,
        },
      );
      assert.deepEqual(
        await store.beginAgentGraphIntentExecutionAtScheduleRevision(
          'graph-1',
          request().intentId,
          0,
        ),
        {
          state: 'cancelled',
          previousState: 'cancelled',
          changed: false,
        },
      );
    } finally {
      store.close();
    }
  });

  test('migrates legacy claims conservatively as already executing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-graph-claim-v7-'));
    const path = join(root, 'sessions.sqlite');
    try {
      const initial = createSqliteSessionMetadataStore(path);
      await initial.claimAgentGraphIntent(request());
      initial.close();

      const legacy = new DatabaseSync(path);
      legacy.exec(`
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
        DROP INDEX agent_graph_intent_claims_by_graph;
        ALTER TABLE agent_graph_intent_claims RENAME TO agent_graph_intent_claims_v8;
        CREATE TABLE agent_graph_intent_claims (
          claim_id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          graph_id TEXT NOT NULL,
          intent_id TEXT NOT NULL,
          intent_fingerprint TEXT NOT NULL,
          readiness_context_fingerprint TEXT NOT NULL,
          target_operator_id TEXT NOT NULL,
          target_session_id TEXT NOT NULL,
          target_turn_id TEXT NOT NULL,
          target_run_id TEXT NOT NULL,
          claimed_at INTEGER NOT NULL,
          UNIQUE(graph_id, intent_id),
          UNIQUE(target_session_id, target_turn_id),
          UNIQUE(target_session_id, target_run_id)
        );
        INSERT INTO agent_graph_intent_claims
        SELECT
          claim_id,
          schema_version,
          graph_id,
          intent_id,
          intent_fingerprint,
          readiness_context_fingerprint,
          target_operator_id,
          target_session_id,
          target_turn_id,
          target_run_id,
          claimed_at
        FROM agent_graph_intent_claims_v8;
        DROP TABLE agent_graph_intent_claims_v8;
        CREATE INDEX agent_graph_intent_claims_by_graph
          ON agent_graph_intent_claims(graph_id, claimed_at, intent_id);
        UPDATE session_metadata_schema
        SET version = 7
        WHERE scope = 'session_metadata';
      `);
      legacy.close();

      const migrated = createSqliteSessionMetadataStore(path);
      try {
        assert.equal(migrated.schemaVersion(), SQLITE_SESSION_METADATA_SCHEMA_VERSION);
        assert.deepEqual(
          await migrated.beginAgentGraphIntentExecutionAtScheduleRevision(
            'graph-1',
            request().intentId,
            0,
          ),
          {
            state: 'executing',
            previousState: 'executing',
            changed: false,
          },
        );
      } finally {
        migrated.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function request(
  overrides: Partial<ReturnType<typeof baseRequest>> = {},
): ReturnType<typeof baseRequest> {
  return { ...baseRequest(), ...overrides };
}

function baseRequest() {
  return {
    schemaVersion: AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION,
    claimId: `graph_claim_${'a'.repeat(32)}`,
    graphId: 'graph-1',
    intentId: `graph_intent_${'b'.repeat(32)}`,
    intentFingerprint: `sha256:${'c'.repeat(64)}`,
    readinessContextFingerprint: `sha256:${'d'.repeat(64)}`,
    targetOperatorId: 'summarizer',
    targetSessionId: 'session-child',
    targetTurnId: 'turn-next',
    targetRunId: 'run-next',
  };
}

function nextNumber(start: number): () => number {
  let value = start;
  return () => value++;
}
