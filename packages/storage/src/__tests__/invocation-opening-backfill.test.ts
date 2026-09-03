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
import type { AgentRunHeader } from '@maka/core/agent-run';
import { encodeCanonicalRuntimeEvent } from '@maka/core/canonical-runtime-event';
import { decodeRuntimeEvent } from '@maka/core/runtime-event';
import { createSqliteAgentRunStore } from '../agent-run-store.js';
import { OPERATIONAL_STATE_DATABASE_NAME } from '../operational-state-store.js';
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
        rewindRuntimeSchemaToPreviousVersion(db);
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
          'only the header-only runs are backfilled, and the corrupt one is skipped',
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

        const ordinals = db
          .prepare('SELECT COUNT(*) AS total FROM runtime_session_event_ordinals')
          .get() as { total: number };
        assert.equal(
          ordinals.total,
          rows.length,
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
            SELECT invocation_id, session_id, run_id, turn_id, opened_at, opening_json
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
        rewindRuntimeSchemaToPreviousVersion(db);
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

  test('bounds, pages and addresses the same inventory', async () => {
    await withHeaderOnlyRuns(async (databasePath) => {
      const db = new DatabaseSync(databasePath);
      try {
        rewindRuntimeSchemaToPreviousVersion(db);
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
          () => store.readInvocation('session-1', 'run-corrupt-root'),
          /Runtime invocation not found/,
          'a header the backfill refused to project has no invocation to read',
        );
      } finally {
        store.close();
      }
    });
  });
});

/** Undo the v16 step so the migration under test runs against real header rows. */
function rewindRuntimeSchemaToPreviousVersion(db: DatabaseSync): void {
  db.exec('DROP INDEX IF EXISTS runtime_events_by_session_kind');
  db.exec('DROP INDEX IF EXISTS runtime_legacy_invocation_openings_by_session');
  db.exec('DROP TABLE IF EXISTS runtime_legacy_invocation_openings');
  db.exec("DELETE FROM runtime_events WHERE event_kind = 'invocation_opened'");
  db.exec(
    'ALTER TABLE runtime_continuation_claims RENAME COLUMN target_opening_json TO target_run_header_json',
  );
  db.exec(`PRAGMA user_version = ${SQLITE_RUNTIME_SCHEMA_VERSION - 1}`);
}

function readUserVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

async function withHeaderOnlyRuns(run: (databasePath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-opening-backfill-'));
  try {
    const store = createSqliteAgentRunStore(root);
    await store.createRun(
      header({
        runId: 'run-legacy-route',
        turnId: 'turn-legacy',
        modelId: 'legacy-model',
      }),
    );
    await store.createRun(
      header({
        runId: 'run-scheduled',
        turnId: 'turn-scheduled',
        llmConnectionId: 'connection-1',
        scheduledTaskId: 'task-9',
      }),
    );
    // A graph wake with no delivery attempt is corruption; the backfill must
    // skip it rather than invent a root authority for it.
    await store.createRun(
      header({
        runId: 'run-corrupt-root',
        turnId: 'turn-corrupt',
        agentGraphWakeId: 'wake-1',
      }),
    );
    await store.createRun(header({ runId: 'run-with-events', turnId: 'turn-with-events' }));
    store.close?.();

    const databasePath = join(root, OPERATIONAL_STATE_DATABASE_NAME);
    await run(databasePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function header(overrides: Partial<AgentRunHeader>): AgentRunHeader {
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
