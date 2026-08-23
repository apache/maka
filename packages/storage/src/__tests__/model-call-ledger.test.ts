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
import type { AgentRunHeader } from '@maka/core/agent-run';
import {
  MODEL_CALL_ATTEMPT_EVENT_TYPE,
  MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import {
  createSqliteModelCallLedger,
  ModelCallLedgerClosedError,
  ModelCallLedgerPublicationError,
  type ModelCallLedger,
} from '../model-call-ledger.js';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import { createSqliteAgentRunStore } from '../agent-run-store.js';

const NOW = 1_750_000_000_000;

function attempt(overrides: Partial<ModelCallAttempt> = {}): ModelCallAttempt {
  return {
    schemaVersion: MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
    logicalCallId: 'call-1',
    attemptId: 'attempt-1',
    traceId: 'trace-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    step: 0,
    attempt: 0,
    callKind: 'main',
    providerId: 'anthropic',
    modelId: 'claude-opus-5',
    startedAt: NOW - 1_000,
    completedAt: NOW - 500,
    latencyMs: 500,
    status: 'completed',
    usageBasis: 'reported',
    inputTokens: 100,
    outputTokens: 20,
    costBasis: 'priced',
    costUsd: 0.004,
    ...overrides,
  };
}

async function withLedger(run: (ledger: ModelCallLedger, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-call-ledger-'));
  const ledger = createSqliteModelCallLedger(root);
  try {
    await run(ledger, root);
  } finally {
    await ledger.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

function appendAuthorityEvent(
  root: string,
  sequence: number,
  value: ModelCallAttempt | { readonly schemaVersion: number },
  sessionId = 'session-1',
  runId = 'run-1',
): void {
  const lease = acquireOperationalStateDatabase(root);
  try {
    lease.transaction('write', () => {
      lease.database
        .prepare(`
          INSERT OR IGNORE INTO core_agent_runs(session_id, run_id, created_at, record_json)
          VALUES (?, ?, ?, '{}')
        `)
        .run(sessionId, runId, NOW - 1_000);
      lease.database
        .prepare(`
          INSERT INTO core_agent_run_events(
            session_id, run_id, sequence, event_id, event_type, event_ts, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          sessionId,
          runId,
          sequence,
          `event-${sessionId}-${runId}-${sequence}`,
          MODEL_CALL_ATTEMPT_EVENT_TYPE,
          NOW - 500 + sequence,
          JSON.stringify({
            id: `event-${sessionId}-${runId}-${sequence}`,
            type: MODEL_CALL_ATTEMPT_EVENT_TYPE,
            ts: NOW - 500 + sequence,
            sessionId,
            runId,
            turnId: 'turn-1',
            data: value,
          }),
        );
      lease.database
        .prepare(`
          UPDATE core_agent_runs
          SET latest_model_call_sequence = ?
          WHERE session_id = ? AND run_id = ?
        `)
        .run(sequence, sessionId, runId);
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

      const page = ledger.read({ from: NOW - 1_000, to: NOW });
      assert.deepEqual(
        page.attempts.map((row) => row.attemptId),
        ['inside'],
      );
      assert.equal(page.unreadableRecords, 0);
    });
  });

  test('provider failure diagnostics survive closing and reopening the ledger', async () => {
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
        const restored = reopened.read({ from: 0, to: NOW }).attempts[0];
        assert.equal(restored?.historyCompactRoute, 'provider_native');
        assert.equal(restored?.errorClass, 'RequestRejected');
        assert.equal(restored?.httpStatus, 400);
        assert.equal(restored?.providerCode, 'invalid_request_error');
        assert.equal(restored?.providerRequestId, 'req-reopen-1');
        assert.equal(restored?.retryable, false);
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
      assert.deepEqual(
        migrated.read({ from: 0, to: NOW }).attempts.map((row) => row.attemptId),
        ['pre-checkpoint'],
      );
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

      const page = ledger.read({ from: 0, to: NOW });
      assert.equal(page.attempts.length, 1);
      assert.equal(page.attempts[0]?.status, 'completed');
      assert.equal(page.attempts[0]?.inputTokens, 100);
    });
  });

  test('reports an authority record that does not satisfy the canonical schema', async () => {
    await withLedger(async (ledger, root) => {
      appendAuthorityEvent(root, 0, attempt({ costBasis: 'unpriced', costUsd: 0.004 }));
      const result = await ledger.catchUpProjection();
      assert.equal(result.unreadableEvents, 1);
      assert.equal(ledger.read({ from: 0, to: NOW }).attempts.length, 0);
    });
  });

  test('one unreadable row is reported rather than failing the whole query', async () => {
    await withLedger(async (ledger, root) => {
      appendAuthorityEvent(root, 0, attempt({ attemptId: 'good' }));
      await ledger.catchUpProjection();
      const lease = acquireOperationalStateDatabase(root);
      try {
        lease.transaction('write', () => {
          lease.database
            .prepare(
              'INSERT INTO usage_model_call_attempts(attempt_id, completed_at, record_json) VALUES (?, ?, ?)',
            )
            .run('corrupt', NOW - 400, '{"schemaVersion":1,');
        });
      } finally {
        lease.close();
      }

      const page = ledger.read({ from: 0, to: NOW });
      assert.deepEqual(
        page.attempts.map((row) => row.attemptId),
        ['good'],
      );
      assert.equal(page.unreadableRecords, 1);
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
      const lease = acquireOperationalStateDatabase(root);
      try {
        lease.transaction('write', () => {
          lease.database
            .prepare(
              `INSERT INTO usage_model_call_attempts(
                attempt_id, completed_at, record_json, session_id
              ) VALUES (?, ?, ?, ?)`,
            )
            .run('session-b-corrupt', NOW - 400, '{', 'session-b');
        });
      } finally {
        lease.close();
      }

      const page = ledger.read({ from: 0, to: NOW }, 'session-a');
      assert.deepEqual(
        page.attempts.map((row) => row.attemptId),
        ['session-a-call'],
      );
      assert.equal(page.unreadableRecords, 0);
    });
  });

  test('reads and catch-up after close report the lifecycle rather than corrupting state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-model-call-ledger-'));
    const ledger = createSqliteModelCallLedger(root);
    appendAuthorityEvent(root, 0, attempt());
    await ledger.close();

    await assert.rejects(() => ledger.catchUpProjection(), ModelCallLedgerClosedError);
    assert.throws(() => ledger.read({ from: 0, to: NOW }), ModelCallLedgerClosedError);
    await rm(root, { recursive: true, force: true });
  });
});

describe('catching the read model up from the AgentRun authority', () => {
  test('consumes the high-water published by the real AgentRun append path', async () => {
    await withLedger(async (ledger, root) => {
      const runStore = createSqliteAgentRunStore(root);
      const header: AgentRunHeader = {
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        status: 'created',
        backendKind: 'fake',
        llmConnectionSlug: 'fake',
        modelId: 'fake-model',
        cwd: '/tmp/cwd',
        permissionMode: 'ask',
        createdAt: 1,
        updatedAt: 1,
      };
      await runStore.createRun(header);
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

      assert.deepEqual(
        ledger.read({ from: 0, to: NOW }).attempts.map((row) => row.attemptId),
        ['real-append'],
      );
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
      assert.deepEqual(
        ledger.read({ from: 0, to: NOW }).attempts.map((row) => row.attemptId),
        ['missed'],
      );
    });
  });

  test('a later authority append remains discoverable after an earlier catch-up', async () => {
    await withLedger(async (ledger, root) => {
      appendAuthorityEvent(root, 0, attempt({ attemptId: 'old' }));
      await ledger.catchUpProjection({ sessionId: 'session-1', runId: 'run-1' });

      appendAuthorityEvent(root, 1, attempt({ attemptId: 'new' }));
      const result = await ledger.catchUpProjection({ sessionId: 'session-1' });

      assert.equal(result.pendingRuns, 0);
      assert.deepEqual(
        ledger
          .read({ from: 0, to: NOW })
          .attempts.map((row) => row.attemptId)
          .sort(),
        ['new', 'old'],
      );
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
      assert.deepEqual(
        ledger.read({ from: 0, to: NOW }).attempts.map((row) => row.attemptId),
        ['good'],
      );
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
      assert.equal(ledger.read({ from: 0, to: NOW }).attempts.length, 2);
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
      assert.deepEqual(
        ledger.read({ from: 0, to: NOW }).attempts.map((row) => row.attemptId),
        ['retry-after-storage-failure'],
      );
    });
  });
});
