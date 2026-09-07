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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import {
  MODEL_CALL_ATTEMPT_EVENT_TYPE,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import {
  createSqliteModelCallLedger,
  ModelCallLedgerClosedError,
  ModelCallLedgerPublicationError,
  type ModelCallLedger,
  type ModelCallLedgerReader,
} from '../model-call-ledger.js';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import { MODEL_CALL_COLUMNS } from '../sqlite-usage-schema.js';
import { createSqliteAgentRunStore } from '../agent-run-store.js';
import { openInvocation } from './fixtures/invocation-opening.js';
import {
  appendAuthorityEvent,
  modelCallAttempt as attempt,
  MODEL_CALL_NOW as NOW,
  withLedger,
} from './fixtures/model-call-attempt.js';

/** The calls a window holds, newest first, as the Usage log surface sees them. */
function ids(ledger: ModelCallLedgerReader, from = 0, sessionId?: string): string[] {
  return ledger
    .logs({ range: { from, to: NOW }, ...(sessionId ? { sessionId } : {}) }, NOW, 0, 100)
    .projection.rows.map((row) => row.id);
}

function unreadable(ledger: ModelCallLedgerReader, sessionId?: string): number {
  return ledger.logs(
    { range: { from: 0, to: NOW }, ...(sessionId ? { sessionId } : {}) },
    NOW,
    0,
    1,
  ).unreadableRecords;
}

/** Records one call whose pricing was lost before the ledger held columns. */
function insertTombstone(root: string, attemptId: string, sessionId?: string): void {
  const lease = acquireOperationalStateDatabase(root);
  try {
    lease.transaction('write', () => {
      lease.database
        .prepare(
          'INSERT INTO usage_model_call_attempts(attempt_id, completed_at, session_id) VALUES (?, ?, ?)',
        )
        .run(attemptId, NOW - 400, sessionId ?? null);
    });
  } finally {
    lease.close();
  }
}

describe('canonical model call ledger', () => {
  test('reads back what it recorded, bounded to the queried window', async () => {
    await withLedger(async (ledger, root) => {
      appendAuthorityEvent(root, 0, attempt({ attemptId: 'inside', completedAt: NOW - 500 }));
      appendAuthorityEvent(
        root,
        1,
        attempt({ attemptId: 'before', startedAt: NOW - 10_500, completedAt: NOW - 10_000 }),
      );
      await ledger.catchUpProjection();

      assert.deepEqual(ids(ledger, NOW - 1_000), ['inside']);
      assert.equal(unreadable(ledger), 0);
    });
  });

  test('a failed call keeps its pricing basis and drops what pricing cannot use', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-model-call-ledger-reopen-'));
    const first = createSqliteModelCallLedger(root);
    try {
      appendAuthorityEvent(
        root,
        0,
        attempt({
          callKind: 'history_compact',
          historyCompactRoute: 'provider_native',
          providerId: 'openai-codex',
          status: 'failed',
          usageBasis: 'missing',
          inputTokens: undefined,
          outputTokens: undefined,
          costBasis: 'unpriced',
          costUsd: undefined,
          errorClass: 'RequestRejected',
          httpStatus: 400,
          providerCode: 'invalid_request_error',
          providerRequestId: 'req-reopen-1',
          retryable: false,
        }),
      );
      await first.catchUpProjection();
      await first.close();

      const reopened = createSqliteModelCallLedger(root);
      try {
        const restored = reopened.logs({ range: { from: 0, to: NOW } }, NOW, 0, 10).projection
          .rows[0];
        assert.equal(restored?.callKind, 'history_compact');
        assert.equal(restored?.status, 'error');
        assert.equal(restored?.costBasis, 'unpriced');
        assert.equal(Object.hasOwn(restored ?? {}, 'costUsd'), false);
        // The Usage log row shows this one; the rest of the provider diagnostics
        // have nowhere to land here and are answered from the AgentRun authority.
        assert.equal(restored?.errorClass, 'RequestRejected');
        const lease = acquireOperationalStateDatabase(root);
        try {
          assert.deepEqual(
            (
              lease.database
                .prepare('PRAGMA table_info(usage_model_call_attempts)')
                .all() as Array<{
                name: string;
              }>
            ).map((column) => column.name),
            [...MODEL_CALL_COLUMNS],
          );
        } finally {
          lease.close();
        }
      } finally {
        await reopened.close();
      }
    } finally {
      await first.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  test('migration deletes legacy repair intent without losing discoverable authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-model-call-ledger-migrate-'));
    const first = createSqliteModelCallLedger(root);
    appendAuthorityEvent(root, 0, attempt({ attemptId: 'pre-checkpoint' }));
    await first.close();

    const database = new DatabaseSync(join(root, 'runtime.sqlite'));
    database.exec(`
      DROP TABLE usage_model_call_projection_checkpoints;
      CREATE TABLE usage_model_call_reprojection (
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        marked_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, run_id)
      );
      INSERT INTO usage_model_call_reprojection VALUES ('session-1', 'run-1', 1);
      UPDATE operational_schema_migrations SET version = 4 WHERE scope = 'usage';
    `);
    database.close();

    const migrated = createSqliteModelCallLedger(root);
    try {
      await migrated.catchUpProjection();
      assert.deepEqual(ids(migrated), ['pre-checkpoint']);
      const lease = acquireOperationalStateDatabase(root);
      try {
        assert.equal(
          lease.database
            .prepare(
              "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'usage_model_call_reprojection'",
            )
            .get()?.count,
          0,
        );
      } finally {
        lease.close();
      }
    } finally {
      await migrated.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a row converted in place keeps spend the authority can no longer replay', async () => {
    // Deleting a Session drops its runs and cascades their events, but leaves
    // its ledger rows. Converging those rows by wiping and re-projecting would
    // erase that spend from the all-time totals, so they are converted in place.
    const root = await mkdtemp(join(tmpdir(), 'maka-model-call-ledger-convert-'));
    const first = createSqliteModelCallLedger(root);
    await first.close();

    const database = new DatabaseSync(join(root, 'runtime.sqlite'));
    database.exec(`
      PRAGMA foreign_keys = ON;
      DROP TABLE usage_model_call_attempts;
      CREATE TABLE usage_model_call_attempts (
        attempt_id TEXT PRIMARY KEY,
        completed_at INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        session_id TEXT
      );
      UPDATE operational_schema_migrations SET version = 6 WHERE scope = 'usage';
    `);
    database
      .prepare('INSERT INTO usage_model_call_attempts VALUES (?, ?, ?, ?)')
      .run(
        'deleted-session-call',
        NOW - 500,
        JSON.stringify(attempt({ attemptId: 'deleted-session-call' })),
        'session-1',
      );
    database.close();

    const migrated = createSqliteModelCallLedger(root);
    try {
      const page = migrated.logs({ range: { from: 0, to: NOW } }, NOW, 0, 10);
      assert.equal(page.unreadableRecords, 0);
      assert.equal(page.projection.rows[0]?.id, 'deleted-session-call');
      assert.equal(page.projection.rows[0]?.costUsd, 0.004);
    } finally {
      await migrated.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a late settlement replaces the provisional record under the same attempt id', async () => {
    // The abort path records provisionally without usage; a `finish` arriving
    // afterwards settles the same attempt. Two rows would double-count it.
    await withLedger(async (ledger, root) => {
      appendAuthorityEvent(
        root,
        0,
        attempt({
          status: 'aborted',
          usageBasis: 'missing',
          inputTokens: undefined,
          outputTokens: undefined,
        }),
      );
      appendAuthorityEvent(root, 1, attempt({ status: 'completed', usageBasis: 'reported' }));
      await ledger.catchUpProjection();

      const rows = ledger.logs({ range: { from: 0, to: NOW } }, NOW, 0, 10).projection.rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, 'success');
      assert.equal(rows[0]?.inputTokens, 100);
    });
  });

  test('reports an authority record that does not satisfy the canonical schema', async () => {
    await withLedger(async (ledger, root) => {
      appendAuthorityEvent(root, 0, attempt({ costBasis: 'unpriced', costUsd: 0.004 }));
      const result = await ledger.catchUpProjection();
      assert.equal(result.unreadableEvents, 1);
      assert.equal(ids(ledger).length, 0);
    });
  });

  test('one unreadable row is reported rather than failing the whole query', async () => {
    await withLedger(async (ledger, root) => {
      appendAuthorityEvent(root, 0, attempt({ attemptId: 'good' }));
      await ledger.catchUpProjection();
      insertTombstone(root, 'lost');

      assert.deepEqual(ids(ledger), ['good']);
      assert.equal(unreadable(ledger), 1);
    });
  });

  test('a Session-scoped read excludes another Session records and corruption', async () => {
    await withLedger(async (ledger, root) => {
      appendAuthorityEvent(
        root,
        0,
        attempt({ attemptId: 'session-a-call', sessionId: 'session-a', runId: 'run-a' }),
        'session-a',
        'run-a',
      );
      appendAuthorityEvent(
        root,
        0,
        attempt({ attemptId: 'session-b-call', sessionId: 'session-b', runId: 'run-b' }),
        'session-b',
        'run-b',
      );
      await ledger.catchUpProjection();
      insertTombstone(root, 'session-b-lost', 'session-b');

      assert.deepEqual(ids(ledger, 0, 'session-a'), ['session-a-call']);
      assert.equal(unreadable(ledger, 'session-a'), 0);
      // The other Session's lost row is still reported to whoever asks for it.
      assert.equal(unreadable(ledger, 'session-b'), 1);
    });
  });

  test('reads and catch-up after close report the lifecycle rather than corrupting state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-model-call-ledger-'));
    const ledger = createSqliteModelCallLedger(root);
    appendAuthorityEvent(root, 0, attempt());
    await ledger.close();

    await assert.rejects(() => ledger.catchUpProjection(), ModelCallLedgerClosedError);
    assert.throws(() => ledger.summary({ range: 'all' }, NOW), ModelCallLedgerClosedError);
    await rm(root, { recursive: true, force: true });
  });
});

describe('catching the read model up from the AgentRun authority', () => {
  test('consumes the high-water published by the real AgentRun append path', async () => {
    await withLedger(async (ledger, root) => {
      await openInvocation(root, { sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1' });
      const runStore = createSqliteAgentRunStore(root);
      await runStore.appendEvent('session-1', 'run-1', {
        id: 'attempt-real-append',
        type: MODEL_CALL_ATTEMPT_EVENT_TYPE,
        ts: NOW,
        sessionId: 'session-1',
        runId: 'run-1',
        turnId: 'turn-1',
        data: { ...attempt({ attemptId: 'real-append' }) },
      });
      runStore.close?.();

      await ledger.catchUpProjection({ sessionId: 'session-1' });

      assert.deepEqual(ids(ledger), ['real-append']);
    });
  });

  test('recovers an authority append even when no repair marker was written', async () => {
    await withLedger(async (ledger, root) => {
      appendAuthorityEvent(root, 0, attempt({ attemptId: 'missed' }));

      const result = await ledger.catchUpProjection({ sessionId: 'session-1' });

      assert.deepEqual(result, {
        changedSessionIds: ['session-1'],
        pendingRuns: 0,
        unreadableEvents: 0,
      });
      assert.deepEqual(ids(ledger), ['missed']);
    });
  });

  test('a later authority append remains discoverable after an earlier catch-up', async () => {
    await withLedger(async (ledger, root) => {
      appendAuthorityEvent(root, 0, attempt({ attemptId: 'old' }));
      await ledger.catchUpProjection({ sessionId: 'session-1', runId: 'run-1' });

      appendAuthorityEvent(root, 1, attempt({ attemptId: 'new' }));
      const result = await ledger.catchUpProjection({ sessionId: 'session-1' });

      assert.equal(result.pendingRuns, 0);
      assert.deepEqual(ids(ledger).sort(), ['new', 'old']);
    });
  });

  test('persists corrupt authority evidence without pinning later events', async () => {
    await withLedger(async (ledger, root) => {
      appendAuthorityEvent(root, 0, { schemaVersion: 1 });
      appendAuthorityEvent(root, 1, attempt({ attemptId: 'good' }));

      const first = await ledger.catchUpProjection({ sessionId: 'session-1' });
      const second = await ledger.catchUpProjection({ sessionId: 'session-1' });

      assert.equal(first.unreadableEvents, 1);
      assert.equal(first.pendingRuns, 0);
      assert.equal(second.unreadableEvents, 1);
      assert.deepEqual(second.changedSessionIds, []);
      assert.deepEqual(ids(ledger), ['good']);
    });
  });

  test('reports a run as pending until a bounded catch-up reaches its high-water mark', async () => {
    await withLedger(async (ledger, root) => {
      appendAuthorityEvent(root, 0, attempt({ attemptId: 'first' }));
      appendAuthorityEvent(root, 1, attempt({ attemptId: 'second' }));

      const first = await ledger.catchUpProjection({
        sessionId: 'session-1',
        eventsPerRun: 1,
      });
      const second = await ledger.catchUpProjection({
        sessionId: 'session-1',
        eventsPerRun: 1,
      });

      assert.equal(first.pendingRuns, 1);
      assert.equal(second.pendingRuns, 0);
      assert.equal(ids(ledger).length, 2);
    });
  });

  test('does not advance the checkpoint when projection storage fails', async () => {
    await withLedger(async (ledger, root) => {
      appendAuthorityEvent(root, 0, attempt({ attemptId: 'retry-after-storage-failure' }));
      const lease = acquireOperationalStateDatabase(root);
      try {
        lease.transaction('write', () => {
          lease.database.exec(`
            CREATE TRIGGER reject_model_call_projection
            BEFORE INSERT ON usage_model_call_attempts
            BEGIN
              SELECT RAISE(ABORT, 'projection unavailable');
            END;
          `);
        });
        await assert.rejects(() => ledger.catchUpProjection(), ModelCallLedgerPublicationError);
        lease.transaction('write', () => {
          lease.database.exec('DROP TRIGGER reject_model_call_projection');
        });
      } finally {
        lease.close();
      }

      const recovered = await ledger.catchUpProjection();
      assert.equal(recovered.pendingRuns, 0);
      assert.deepEqual(ids(ledger), ['retry-after-storage-failure']);
    });
  });
});
