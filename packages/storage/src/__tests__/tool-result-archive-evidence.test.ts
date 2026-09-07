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
import { test, after, type TestContext } from 'node:test';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import { openToolResultArchiveEvidenceReader } from '../tool-result-archive-evidence.js';
import { MODEL_PROJECTION_TARGET_SQL } from '../sqlite-core-execution-schema.js';
import {
  trackControlDirectory,
  removeTrackedControlDirectories,
} from './fixtures/control-directory-hygiene.js';

after(removeTrackedControlDirectories);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'maka-archive-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const reader = await openToolResultArchiveEvidenceReader(owner.lease);
  const db = new DatabaseSync(join(root, 'runtime.sqlite'));
  t.after(async () => {
    db.close();
    reader.close();
    await owner.close();
  });
  const event = {
    id: 'response',
    sessionId: 'session',
    runId: 'run',
    invocationId: 'invocation',
    turnId: 'turn',
    ts: 1,
    partial: false,
    author: 'tool',
    role: 'tool',
    content: {
      kind: 'function_response',
      id: 'call',
      name: 'Read',
      result: 'raw',
      modelProjection: { version: 1, kind: 'text', text: 'model' },
    },
  };
  db.prepare(
    'INSERT INTO runtime_events(event_id, session_id, invocation_id, run_id, turn_id, event_seq, event_kind, payload_json, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'response',
    'session',
    'invocation',
    'run',
    'turn',
    1,
    'function_response',
    JSON.stringify(event),
    1,
  );
  db.prepare('INSERT INTO core_agent_runs(session_id, run_id, created_at) VALUES (?, ?, ?)').run(
    'session',
    'run',
    1,
  );
  const insert = (sequence: number, target: string | null, padding = '') => {
    const record = {
      id: 'transition-' + sequence,
      type: 'model_projection_transition_recorded',
      sessionId: 'session',
      runId: 'run',
      turnId: 'turn',
      ts: 2,
      data: { ...(target === null ? {} : { runtimeEventId: target }), padding },
    };
    db.prepare('INSERT INTO core_agent_run_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'session',
      'run',
      sequence,
      record.id,
      record.type,
      2,
      JSON.stringify(record),
    );
  };
  return { root, owner, reader, db, insert };
}

test('target evidence ignores 12k unrelated records, survives reopen and checks Session scope', async (t) => {
  const f = await fixture(t);
  f.db.exec('BEGIN');
  for (let i = 0; i < 12000; i += 1) f.insert(i, 'unrelated-' + i);
  f.insert(12000, 'response');
  f.db.exec('COMMIT');
  const result = await f.reader.read({ sessionId: 'session', runtimeEventId: 'response' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.transitions.length, 1);
  assert.deepEqual(await f.reader.read({ sessionId: 'foreign', runtimeEventId: 'response' }), {
    ok: false,
    reason: 'not_found',
  });
  f.reader.close();
  const reopened = await openToolResultArchiveEvidenceReader(f.owner.lease);
  try {
    assert.deepEqual(
      await reopened.read({ sessionId: 'session', runtimeEventId: 'response' }),
      result,
    );
  } finally {
    reopened.close();
  }
  const plan = f.db
    .prepare(`EXPLAIN QUERY PLAN SELECT run_id, sequence FROM core_agent_run_events INDEXED BY core_model_projection_target
    WHERE event_type = 'model_projection_transition_recorded' AND session_id = ? AND ${MODEL_PROJECTION_TARGET_SQL} = ? LIMIT ?`)
    .all('session', 'response', 65);
  assert.match(JSON.stringify(plan), /SEARCH.*core_model_projection_target/);
});

test('checks byte and record budgets before fetching any ledger JSON', async (t) => {
  const f = await fixture(t);
  f.insert(1, 'response', 'x'.repeat(3 * 1024 * 1024));
  let materialized = 0;
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    const get = statement.get.bind(statement);
    const all = statement.all.bind(statement);
    const count = (row: Record<string, unknown> | undefined) => {
      for (const key of ['payload_json', 'record_json'])
        if (typeof row?.[key] === 'string') materialized += Buffer.byteLength(row[key]);
    };
    t.mock.method(statement, 'get', (...args: Parameters<typeof get>) => {
      const row = get(...args);
      count(row);
      return row;
    });
    t.mock.method(statement, 'all', (...args: Parameters<typeof all>) => {
      const rows = all(...args);
      rows.forEach(count);
      return rows;
    });
    return statement;
  });
  assert.deepEqual(await f.reader.read({ sessionId: 'session', runtimeEventId: 'response' }), {
    ok: false,
    reason: 'too_large',
  });
  assert.equal(materialized, 0);
  f.db.exec('DELETE FROM core_agent_run_events');
  for (let i = 0; i < 65; i += 1) f.insert(i, 'response');
  assert.deepEqual(await f.reader.read({ sessionId: 'session', runtimeEventId: 'response' }), {
    ok: false,
    reason: 'too_large',
  });
  assert.equal(materialized, 0);
});

test('unscoped malformed transitions prevent a false complete history', async (t) => {
  const f = await fixture(t);
  f.insert(1, null);
  assert.deepEqual(await f.reader.read({ sessionId: 'session', runtimeEventId: 'response' }), {
    ok: false,
    reason: 'corrupt',
  });
  f.db.exec('DELETE FROM core_agent_run_events');
  f.insert(1, 'response');
  f.db.exec("UPDATE core_agent_run_events SET record_json = '{'");
  assert.deepEqual(await f.reader.read({ sessionId: 'session', runtimeEventId: 'response' }), {
    ok: false,
    reason: 'corrupt',
  });
});

test('upgrades the target index without rewriting immutable transition records', async (t) => {
  const f = await fixture(t);
  f.insert(1, 'response');
  const before = f.db.prepare('SELECT record_json FROM core_agent_run_events').all();
  f.reader.close();
  f.db.exec(
    "DROP INDEX core_model_projection_target; UPDATE operational_schema_migrations SET version = 8 WHERE scope = 'core_execution'",
  );
  const reader = await openToolResultArchiveEvidenceReader(f.owner.lease);
  try {
    assert.equal(
      (await reader.read({ sessionId: 'session', runtimeEventId: 'response' })).ok,
      true,
    );
    assert.deepEqual(f.db.prepare('SELECT record_json FROM core_agent_run_events').all(), before);
    assert.equal(
      f.db
        .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'core_execution'")
        .get()?.version,
      9,
    );
  } finally {
    reader.close();
  }
});

test('reader close and root revocation never return evidence', async (t) => {
  const f = await fixture(t);
  await f.owner.close();
  assert.equal(
    (await f.reader.read({ sessionId: 'session', runtimeEventId: 'response' })).ok,
    false,
  );
  f.reader.close();
  assert.deepEqual(await f.reader.read({ sessionId: 'session', runtimeEventId: 'response' }), {
    ok: false,
    reason: 'unavailable',
  });
});
