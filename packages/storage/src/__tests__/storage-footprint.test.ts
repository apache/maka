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
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
} from '../operational-state-store.js';
import { openStorageFootprintReader } from '../storage-footprint.js';

test('storage footprint measures known Sessions from their rows and totals from files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-storage-footprint-'));
  const owner = acquireOperationalStateDatabase(root);
  const contextCalls: Array<string | undefined> = [];
  const reader = openStorageFootprintReader(root, {
    contextOffload: {
      usage: async (sessionId?: string) => {
        contextCalls.push(sessionId);
        return { references: 1, logicalBytes: sessionId ? 700 : 900, physicalBytes: 400 };
      },
    },
  });
  try {
    const db = owner.database;
    insertSession(db, 'parent', {});
    insertSession(db, 'child', { subagentWorkspace: { kind: 'git_worktree' } }, 'parent');
    insertSession(db, 'other', {});
    insertMessage(db, 'parent', 0, 'x'.repeat(100));
    // Multi-byte text is measured in bytes, not characters.
    insertMessage(db, 'parent', 1, 'é'.repeat(10));
    db.prepare('INSERT INTO session_message_payloads VALUES (?, ?, ?, ?)').run(
      'parent',
      1,
      64 * 1024 + 1,
      'a'.repeat(64),
    );
    db.prepare('INSERT INTO session_message_chunks VALUES (?, ?, ?, ?, ?)').run(
      'parent',
      1,
      0,
      Buffer.alloc(300),
      'b'.repeat(64),
    );
    insertMessage(db, 'other', 0, 'y'.repeat(50));
    db.prepare(
      `INSERT INTO runtime_events(
         event_id, session_id, invocation_id, run_id, turn_id, event_seq, event_kind,
         payload_json, committed_at
       ) VALUES ('event-1', 'parent', 'invocation-1', 'run-1', 'turn-1', 1, 'kind', ?, 1)`,
    ).run('z'.repeat(40));
    db.prepare('INSERT INTO artifact_records VALUES (?, ?, ?, ?, ?)').run(
      'artifact-1',
      'parent',
      1,
      'parent/artifact-1-file',
      JSON.stringify({ sizeBytes: 1234 }),
    );
    db.prepare(
      'INSERT INTO usage_llm_calls(storage_key, id, ts, record_json, session_id) VALUES (?, ?, ?, ?, ?)',
    ).run('usage-1', 'usage-1', 1, 'u'.repeat(30), 'gone');
    await writeFile(join(root, 'memory.sqlite'), Buffer.alloc(2048));
    await writeFile(join(root, 'memory.sqlite-journal'), Buffer.alloc(16));
    await writeFile(join(root, 'context-offload.sqlite'), Buffer.alloc(4096));
    await mkdir(join(root, 'subagent-worktrees', 'lease-a'), { recursive: true });
    await mkdir(join(root, 'subagent-worktrees', 'lease-b'), { recursive: true });

    const sessions = await reader.measureSessions(['parent', 'child', 'missing', 'parent']);
    assert.deepEqual(sessions, [
      {
        sessionId: 'parent',
        // 'x' * 100 + JSON quotes, 'é' * 10 as 20 bytes + quotes, one 300-byte chunk.
        bytes: { transcript: 102 + 22 + 300, runtime: 40, artifacts: 1234, context: 700 },
        worktreeCount: 1,
      },
      {
        sessionId: 'child',
        bytes: { transcript: 0, runtime: 0, artifacts: 0, context: 700 },
        worktreeCount: 1,
      },
    ]);
    // Unknown ids are omitted rather than reported as empty.
    assert.deepEqual(contextCalls, ['parent', 'child']);

    const footprint = await reader.measure();
    const totals = new Map(footprint.totals.map((total) => [total.kind, total]));
    assert.deepEqual(
      footprint.totals.map((total) => total.kind),
      ['database', 'artifacts', 'context_offload', 'memory'],
    );
    assert.deepEqual(totals.get('database'), {
      kind: 'database',
      bytes: await databaseFileBytes(root),
      exact: true,
    });
    assert.deepEqual(totals.get('artifacts'), { kind: 'artifacts', bytes: 1234, exact: false });
    assert.deepEqual(totals.get('context_offload'), {
      kind: 'context_offload',
      bytes: 400 + 4096,
      exact: false,
    });
    assert.deepEqual(totals.get('memory'), { kind: 'memory', bytes: 2048 + 16, exact: true });
    assert.equal(footprint.worktreeCount, 2);
    const pageSize = Number(
      (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size,
    );
    const freePages = Number(
      (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count,
    );
    assert.equal(footprint.reclaimableBytes, pageSize * freePages);
  } finally {
    reader.close();
    owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('storage footprint omits context usage when the Store is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-storage-footprint-no-context-'));
  const owner = acquireOperationalStateDatabase(root);
  const reader = openStorageFootprintReader(root);
  try {
    insertSession(owner.database, 'alone', {});
    const [session] = await reader.measureSessions(['alone']);
    assert.deepEqual(session?.bytes, { transcript: 0, runtime: 0, artifacts: 0 });
    const footprint = await reader.measure();
    assert.equal(
      footprint.totals.some((total) => total.kind === 'context_offload'),
      false,
    );
    assert.equal(footprint.worktreeCount, 0);
  } finally {
    reader.close();
    owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

function insertSession(
  db: DatabaseSync,
  sessionId: string,
  header: Record<string, unknown>,
  subagentParentSessionId?: string,
): void {
  db.prepare(
    `INSERT INTO session_metadata(
       session_id, payload_json, created_at, name, is_flagged, is_archived, has_unread,
       backend, llm_connection_slug, model, metadata_version, committed_at,
       subagent_parent_session_id
     ) VALUES (?, ?, 1, ?, 0, 0, 0, 'backend', 'connection', 'model', 1, 1, ?)`,
  ).run(
    sessionId,
    JSON.stringify({ id: sessionId, ...header }),
    sessionId,
    subagentParentSessionId ?? null,
  );
}

function insertMessage(db: DatabaseSync, sessionId: string, sequence: number, text: string): void {
  db.prepare(
    `INSERT INTO session_messages(
       session_id, sequence, message_id, message_type, message_ts, record_json
     ) VALUES (?, ?, ?, 'user', 1, ?)`,
  ).run(sessionId, sequence, `${sessionId}-${sequence}`, JSON.stringify(text));
}

async function databaseFileBytes(root: string): Promise<number> {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      total += (await stat(join(root, `${OPERATIONAL_STATE_DATABASE_NAME}${suffix}`))).size;
    } catch {}
  }
  return total;
}
