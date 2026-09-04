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
import { describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { encodeCanonicalRuntimeEvent } from '@maka/core/canonical-runtime-event';
import { createRunCompositionSnapshot } from '@maka/core/run-composition';
import { decodeRuntimeEvent } from '@maka/core/runtime-event';
import type { LegacyRunHeader } from '../legacy-run-header.js';
import { OPERATIONAL_STATE_DATABASE_NAME } from '../operational-state-store.js';
import { migrateSqliteCoreExecutionDatabase } from '../sqlite-core-execution-schema.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';
import {
  migrateSqliteRuntimeDatabase,
  SQLITE_RUNTIME_SCHEMA_VERSION,
} from '../sqlite-runtime-schema.js';
describe('invocation opening fact backfill', () => {
  test('gives every header-only run the opening fact it never wrote', async () => {
    await withHeaderOnlyRuns(async (databasePath) => {
      const db = new DatabaseSync(databasePath);
      try {
        // One run already owns an immutable sequence; the backfill must leave it
        // alone rather than rewrite its position one.
        db.prepare(`
          INSERT INTO runtime_events (
            event_id, session_id, invocation_id, run_id, turn_id, event_seq,
            event_kind, payload_json, committed_at
          ) VALUES ('existing-1', 'session-1', 'run-with-events', 'run-with-events',
                    'turn-with-events', 1, 'text', '{}', 1)
        `).run();
        migrateSqliteRuntimeDatabase(db);
        assert.equal(readUserVersion(db), SQLITE_RUNTIME_SCHEMA_VERSION);

        const rows = db
          .prepare(`
            SELECT event_id, invocation_id, run_id, turn_id, event_seq, payload_json
            FROM runtime_events
            WHERE event_kind = 'invocation_opened'
            ORDER BY run_id ASC
          `)
          .all() as Array<{
          event_id: string;
          invocation_id: string;
          run_id: string;
          turn_id: string;
          event_seq: number;
          payload_json: string;
        }>;

        assert.deepEqual(
          rows.map((row) => row.run_id),
          ['run-legacy-route', 'run-scheduled'],
          'only the header-only runs are backfilled',
        );
        assert.deepEqual(
          rows.map((row) => row.event_seq),
          [1, 1],
          'a synthesized opening fact is event one of an otherwise empty invocation',
        );

        const legacy = decodeRuntimeEvent(JSON.parse(rows[0]!.payload_json));
        assert.equal(legacy.content?.kind, 'invocation_opened');
        if (legacy.content?.kind !== 'invocation_opened') throw new Error('unreachable');
        assert.equal(
          legacy.content.route.provenance,
          'unknown',
          'a header with no Connection identity must not claim an authenticated route',
        );
        assert.equal(legacy.content.route.modelId, 'legacy-model');
        assert.equal(legacy.content.source.kind, 'fresh');
        assert.equal(legacy.invocationId, 'run-legacy-route');

        const scheduled = decodeRuntimeEvent(JSON.parse(rows[1]!.payload_json));
        if (scheduled.content?.kind !== 'invocation_opened') throw new Error('unreachable');
        assert.deepEqual(scheduled.content.root, {
          kind: 'scheduled_task',
          scheduledTaskId: 'task-9',
        });
        assert.equal(scheduled.content.route.provenance, 'runtime');

        // Both header-only runs were marked completed, so each gets the ending
        // its header recorded, right after its opening.
        const backfilled = db
          .prepare(`
            SELECT run_id, event_seq, event_kind FROM runtime_events
            WHERE run_id IN ('run-legacy-route', 'run-scheduled')
            ORDER BY run_id ASC, event_seq ASC
          `)
          .all() as Array<{ run_id: string; event_seq: number; event_kind: string }>;
        assert.deepEqual(
          backfilled.map(({ run_id, event_seq, event_kind }) => ({
            run_id,
            event_seq,
            event_kind,
          })),
          [
            { run_id: 'run-legacy-route', event_seq: 1, event_kind: 'invocation_opened' },
            { run_id: 'run-legacy-route', event_seq: 2, event_kind: 'completed' },
            { run_id: 'run-scheduled', event_seq: 1, event_kind: 'invocation_opened' },
            { run_id: 'run-scheduled', event_seq: 2, event_kind: 'completed' },
          ],
        );
        const ordinals = db
          .prepare('SELECT COUNT(*) AS total FROM runtime_session_event_ordinals')
          .get() as { total: number };
        assert.equal(
          ordinals.total,
          backfilled.length,
          'every backfilled event joins the Session ordinal stream',
        );

        // The run that already owns an immutable sequence keeps it untouched:
        // rewriting its position one would break digests other facts signed.
        const withEvents = db
          .prepare(
            "SELECT event_id FROM runtime_events WHERE run_id = 'run-with-events' ORDER BY event_seq",
          )
          .all() as Array<{ event_id: string }>;
        assert.deepEqual(
          withEvents.map((row) => row.event_id),
          ['existing-1'],
        );

        // Its opening is not lost, though: it goes on the legacy shelf, keyed by
        // the invocation id its own events already carry.
        const legacyRows = db
          .prepare(`
            SELECT invocation_id, session_id, run_id, turn_id, opened_at, opening_json,
                   anchor_event_id
            FROM runtime_legacy_invocation_openings
            ORDER BY invocation_id
          `)
          .all() as Array<{
          invocation_id: string;
          session_id: string;
          run_id: string;
          turn_id: string;
          opened_at: number;
          opening_json: string;
          anchor_event_id: string;
        }>;
        assert.deepEqual(
          legacyRows.map((row) => row.invocation_id),
          ['run-with-events'],
          'only a run whose sequence is already immutable takes the legacy shelf',
        );
        assert.equal(legacyRows[0]!.run_id, 'run-with-events');
        assert.equal(legacyRows[0]!.turn_id, 'turn-with-events');
        assert.equal(legacyRows[0]!.opened_at, 1);
        assert.equal(
          (JSON.parse(legacyRows[0]!.opening_json) as { kind: string }).kind,
          'invocation_opened',
        );
        // The shelved opening describes that ledger, so it is anchored to the
        // ledger's first event and cannot outlive it.
        assert.equal(
          legacyRows[0]!.anchor_event_id,
          'existing-1',
          'the shelved opening is anchored to the first event of the run it describes',
        );
      } finally {
        db.close();
      }
    });
  });

  test('enumerates event openings and migrated ones as one inventory', async () => {
    await withHeaderOnlyRuns(async (databasePath) => {
      const db = new DatabaseSync(databasePath);
      try {
        const { json } = encodeCanonicalRuntimeEvent({
          id: 'existing-1',
          invocationId: 'run-with-events',
          runId: 'run-with-events',
          sessionId: 'session-1',
          turnId: 'turn-with-events',
          ts: 1,
          partial: false,
          role: 'user',
          author: 'user',
          modelVisibility: 'visible',
          content: { kind: 'text', text: 'already immutable' },
        });
        db.prepare(`
          INSERT INTO runtime_events (
            event_id, session_id, invocation_id, run_id, turn_id, event_seq,
            event_kind, payload_json, committed_at
          ) VALUES ('existing-1', 'session-1', 'run-with-events', 'run-with-events',
                    'turn-with-events', 1, 'text', ?, 1)
        `).run(json);
        migrateSqliteRuntimeDatabase(db);
      } finally {
        db.close();
      }

      const store = createSqliteRuntimeStore(databasePath);
      try {
        const invocations = await store.listSessionInvocations('session-1');
        assert.deepEqual(
          invocations.map((invocation) => invocation.invocationId),
          ['run-legacy-route', 'run-scheduled', 'run-with-events'],
          'a migrated opening is enumerated beside the ones the events carry',
        );
        for (const invocation of invocations) {
          assert.equal(invocation.opening.kind, 'invocation_opened');
          assert.equal(invocation.sessionId, 'session-1');
        }
        const migrated = invocations.find(
          (invocation) => invocation.invocationId === 'run-with-events',
        );
        assert.equal(migrated?.turnId, 'turn-with-events');
        assert.equal(migrated?.terminalEvent, undefined);
      } finally {
        store.close();
      }
    });
  });

  test('purging a migrated Session takes its shelved openings with it', async () => {
    await withHeaderOnlyRuns(async (databasePath) => {
      const db = new DatabaseSync(databasePath);
      try {
        const { json } = encodeCanonicalRuntimeEvent({
          id: 'existing-1',
          invocationId: 'run-with-events',
          runId: 'run-with-events',
          sessionId: 'session-1',
          turnId: 'turn-with-events',
          ts: 1,
          partial: false,
          role: 'user',
          author: 'user',
          modelVisibility: 'visible',
          content: { kind: 'text', text: 'already immutable' },
        });
        db.prepare(`
          INSERT INTO runtime_events (
            event_id, session_id, invocation_id, run_id, turn_id, event_seq,
            event_kind, payload_json, committed_at
          ) VALUES ('existing-1', 'session-1', 'run-with-events', 'run-with-events',
                    'turn-with-events', 1, 'text', ?, 1)
        `).run(json);
        migrateSqliteRuntimeDatabase(db);
      } finally {
        db.close();
      }

      // What purging a conversation does to this database: delete the Session's
      // events. `conversation-operational-state.ts` runs exactly this statement
      // on a lease that has `PRAGMA foreign_keys = ON`, which is also how
      // `runtime_session_event_ordinals` is cleaned up today.
      const purge = new DatabaseSync(databasePath);
      try {
        purge.exec('PRAGMA foreign_keys = ON');
        purge.prepare('DELETE FROM runtime_events WHERE session_id = ?').run('session-1');
      } finally {
        purge.close();
      }

      // The shelved opening is only read when its invocation has no opening
      // event, so a purge that deleted the events but left the shelf would make
      // a completed run reappear as an active one.
      const store = createSqliteRuntimeStore(databasePath);
      try {
        assert.deepEqual(await store.listSessionInvocations('session-1'), []);
        assert.equal(await store.readRunInvocation('session-1', 'run-with-events'), undefined);
      } finally {
        store.close();
      }

      const check = new DatabaseSync(databasePath);
      try {
        assert.equal(
          (
            check
              .prepare('SELECT COUNT(*) AS count FROM runtime_legacy_invocation_openings')
              .get() as { count: number }
          ).count,
          0,
          'the shelf is empty, not merely unreadable',
        );
      } finally {
        check.close();
      }
    });
  });

  test('bounds, pages and addresses the same inventory', async () => {
    await withHeaderOnlyRuns(async (databasePath) => {
      const db = new DatabaseSync(databasePath);
      try {
        migrateSqliteRuntimeDatabase(db);
      } finally {
        db.close();
      }

      const store = createSqliteRuntimeStore(databasePath);
      try {
        const bounded = await store.listSessionInvocationsBounded('session-1', 2);
        assert.deepEqual(
          bounded.invocations.map((invocation) => invocation.invocationId),
          ['run-legacy-route', 'run-scheduled'],
        );
        assert.equal(bounded.truncated, true, 'the extra row read past the limit reports the rest');

        const first = await store.listSessionInvocationsPage('session-1', { limit: 2 });
        assert.deepEqual(
          first.invocations.map((invocation) => invocation.invocationId),
          ['run-with-events', 'run-scheduled'],
          'a page runs newest first',
        );
        const second = await store.listSessionInvocationsPage('session-1', {
          limit: 2,
          ...(first.nextCursor ? { before: first.nextCursor } : {}),
        });
        assert.deepEqual(
          second.invocations.map((invocation) => invocation.invocationId),
          ['run-legacy-route'],
          'the cursor resumes without repeating or skipping a tied opening time',
        );
        assert.equal(second.nextCursor, null);

        const one = await store.readInvocation('session-1', 'run-scheduled');
        assert.equal(one.turnId, 'turn-scheduled');
        assert.deepEqual(one.opening.root, { kind: 'scheduled_task', scheduledTaskId: 'task-9' });

        await assert.rejects(
          () => store.listSessionInvocationsPage('session-1', { limit: 0 }),
          /between 1 and 256/,
        );
        await assert.rejects(
          () =>
            store.listSessionInvocationsPage('session-1', {
              limit: 1,
              before: { openedAt: Number.NaN, invocationId: 'run-scheduled' },
            }),
          /Invalid invocation page cursor/,
        );
      } finally {
        store.close();
      }
    });
  });

  // Built from what the header era actually wrote, not from what the decoder
  // accepts: every run that reached a provider carried the composition snapshot.
  test('migrates a header exactly as the header era wrote it, composition included', async () => {
    await withHeaderOnlyRuns(async (databasePath) => {
      const db = new DatabaseSync(databasePath);
      try {
        const insert = db.prepare(
          'INSERT INTO core_agent_runs(session_id, run_id, created_at, record_json) VALUES (?, ?, ?, ?)',
        );
        for (const record of [
          header({
            runId: 'run-composed',
            turnId: 'turn-composed',
            status: 'failed',
            failureClass: 'provider_error',
            failureMessage: 'the provider said no',
            completedAt: 7,
            runComposition: headerEraComposition(),
          }),
          header({
            runId: 'run-composed-events',
            turnId: 'turn-composed-events',
            runComposition: headerEraComposition(),
          }),
        ]) {
          insert.run(record.sessionId, record.runId, record.createdAt, JSON.stringify(record));
        }
        const { json } = encodeCanonicalRuntimeEvent({
          id: 'composed-1',
          invocationId: 'run-composed-events',
          runId: 'run-composed-events',
          sessionId: 'session-1',
          turnId: 'turn-composed-events',
          ts: 1,
          partial: false,
          role: 'user',
          author: 'user',
          modelVisibility: 'visible',
          content: { kind: 'text', text: 'already immutable' },
        });
        db.prepare(`
          INSERT INTO runtime_events (
            event_id, session_id, invocation_id, run_id, turn_id, event_seq,
            event_kind, payload_json, committed_at
          ) VALUES ('composed-1', 'session-1', 'run-composed-events', 'run-composed-events',
                    'turn-composed-events', 1, 'text', ?, 1)
        `).run(json);
        migrateSqliteRuntimeDatabase(db);
        migrateSqliteCoreExecutionDatabase(db);
      } finally {
        db.close();
      }

      const store = createSqliteRuntimeStore(databasePath);
      try {
        const invocations = await store.listSessionInvocations('session-1');
        assert.deepEqual(
          invocations.map((invocation) => invocation.invocationId).sort(),
          [
            'run-composed',
            'run-composed-events',
            'run-legacy-route',
            'run-scheduled',
            'run-with-events',
          ],
          'a run whose header carried a composition snapshot is still a run',
        );
        const composed = await store.readInvocation('session-1', 'run-composed');
        assert.equal(composed.terminalEvent?.status, 'failed');
        assert.equal(composed.terminalEvent?.ts, 7);
        assert.equal(composed.terminalEvent?.actions?.stateDelta?.failureClass, 'provider_error');
        assert.equal(
          composed.terminalEvent?.content?.kind === 'error'
            ? composed.terminalEvent.content.message
            : undefined,
          'the provider said no',
        );
      } finally {
        store.close();
      }
    });
  });

  test('refuses to migrate a header it cannot read, and drops nothing', async () => {
    await withHeaderOnlyRuns(async (databasePath) => {
      const db = new DatabaseSync(databasePath);
      try {
        // A graph wake with no delivery attempt is corruption. Inventing a root
        // authority for it would be worse than refusing, and dropping the header
        // would be worse still: the migration stops, and the database stays as
        // the header era left it.
        const corrupt = header({
          runId: 'run-corrupt-root',
          turnId: 'turn-corrupt',
          agentGraphWakeId: 'wake-1',
        });
        db.prepare(
          'INSERT INTO core_agent_runs(session_id, run_id, created_at, record_json) VALUES (?, ?, ?, ?)',
        ).run(corrupt.sessionId, corrupt.runId, corrupt.createdAt, JSON.stringify(corrupt));
        assert.throws(() => migrateSqliteRuntimeDatabase(db), /session-1\/run-corrupt-root/);
        assert.equal(readUserVersion(db), SQLITE_RUNTIME_SCHEMA_VERSION - 1);
        const openings = db
          .prepare(
            "SELECT COUNT(*) AS total FROM runtime_events WHERE event_kind = 'invocation_opened'",
          )
          .get() as { total: number };
        assert.equal(openings.total, 0, 'the transaction rolled every other run back too');
        const headers = db
          .prepare('SELECT COUNT(*) AS total FROM core_agent_runs WHERE record_json IS NOT NULL')
          .get() as { total: number };
        assert.equal(headers.total, 4, 'every header is still there to be read by a fixed build');
      } finally {
        db.close();
      }
    });
  });
});

function headerEraComposition() {
  return createRunCompositionSnapshot({
    composerId: 'maka.default',
    composerRevision: '1',
    sourceRevisions: [{ id: 'system-prompt', revision: '1' }],
    baseSystemPromptHash: `sha256:${'a'.repeat(64)}`,
    toolCatalogHash: `sha256:${'b'.repeat(64)}`,
    toolAvailabilityHash: `sha256:${'c'.repeat(64)}`,
    baseProviderOptionsHash: `sha256:${'d'.repeat(64)}`,
    toolNames: ['read_file'],
    contextWindow: 200_000,
  });
}

/**
 * Put the database back the way the header era left it: runtime schema one step
 * behind, no opening facts, and a `core_agent_runs` row that still carries the
 * header the migration under test has to read.
 */
function rewindToHeaderEra(db: DatabaseSync): void {
  db.exec('DROP INDEX IF EXISTS runtime_events_by_session_kind');
  db.exec('DROP INDEX IF EXISTS runtime_events_one_opening_per_invocation');
  db.exec('DROP INDEX IF EXISTS runtime_legacy_invocation_openings_by_session');
  db.exec('DROP TABLE IF EXISTS runtime_legacy_invocation_openings');
  db.exec("DELETE FROM runtime_events WHERE event_kind = 'invocation_opened'");
  db.exec(
    'ALTER TABLE runtime_continuation_claims RENAME COLUMN target_opening_json TO target_run_header_json',
  );
  db.exec('ALTER TABLE core_agent_runs ADD COLUMN record_json TEXT');
  db.exec(`PRAGMA user_version = ${SQLITE_RUNTIME_SCHEMA_VERSION - 1}`);
}

function readUserVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

async function withHeaderOnlyRuns(run: (databasePath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-opening-backfill-'));
  try {
    const databasePath = join(root, OPERATIONAL_STATE_DATABASE_NAME);
    const db = new DatabaseSync(databasePath);
    try {
      migrateSqliteRuntimeDatabase(db);
      migrateSqliteCoreExecutionDatabase(db);
      rewindToHeaderEra(db);
      const insert = db.prepare(
        'INSERT INTO core_agent_runs(session_id, run_id, created_at, record_json) VALUES (?, ?, ?, ?)',
      );
      for (const record of [
        header({ runId: 'run-legacy-route', turnId: 'turn-legacy', modelId: 'legacy-model' }),
        header({
          runId: 'run-scheduled',
          turnId: 'turn-scheduled',
          llmConnectionId: 'connection-1',
          scheduledTaskId: 'task-9',
        }),
        header({ runId: 'run-with-events', turnId: 'turn-with-events' }),
      ]) {
        insert.run(record.sessionId, record.runId, record.createdAt, JSON.stringify(record));
      }
    } finally {
      db.close();
    }

    await run(databasePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function header(overrides: Partial<LegacyRunHeader>): LegacyRunHeader {
  return {
    runId: 'run-1',
    invocationId: overrides.runId ?? 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    status: 'completed',
    backendKind: 'ai-sdk',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/cwd',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}
