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
import { decodeRuntimeEvent } from '@maka/core/runtime-event';
import { createSqliteAgentRunStore } from '../agent-run-store.js';
import { OPERATIONAL_STATE_DATABASE_NAME } from '../operational-state-store.js';
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
      } finally {
        db.close();
      }
    });
  });
});

/** Undo the v16 step so the migration under test runs against real header rows. */
function rewindRuntimeSchemaToPreviousVersion(db: DatabaseSync): void {
  db.exec('DROP INDEX IF EXISTS runtime_events_by_session_kind');
  db.exec("DELETE FROM runtime_events WHERE event_kind = 'invocation_opened'");
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
