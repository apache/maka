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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodexSource } from '../src/source.js';
const since = Date.parse('2026-10-01T00:00:00+08:00');
const caller = { invocation: { abortSignal: new AbortController().signal } };
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'codex-source-中文-'));
  const home = join(root, 'codex');
  mkdirSync(home);
  const s = new DatabaseSync(join(home, 'state_5.sqlite'));
  s.exec(
    'CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,history_mode TEXT,updated_at INTEGER)',
  );
  s.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(
    'old-session',
    '旧会话中的新消息',
    'paginated',
    since / 1000,
  );
  const h = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
  h.exec(`CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,updated_at_ordinal INTEGER,created_at_ms INTEGER,item_type TEXT,item_json TEXT,PRIMARY KEY(thread_id,turn_id,item_id));
    CREATE TABLE thread_realtime_items(thread_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_type TEXT,item_json TEXT);`);
  const put = (
    id: string,
    at: number,
    ordinal: number,
    type = 'userMessage',
    text = id,
    thread = 'old-session',
  ) =>
    h
      .prepare('INSERT OR REPLACE INTO thread_items VALUES(?,?,?,?,?,?,?,?)')
      .run(thread, 'turn', id, ordinal, ordinal, at, type, JSON.stringify({ type, id, text }));
  const dir = join(root, 'cache');
  let a = new CodexSource(home, since, dir, 'test-signing-key');
  t.after(() => {
    a.close();
    h.close();
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    a,
    h,
    s,
    put,
    dir,
    home,
    restart: () => {
      a.close();
      a = new CodexSource(home, since, dir, 'test-signing-key');
      return a;
    },
  };
}
test('October boundary is per item, old sessions gain new originals and visible tool types are retained', async (t) => {
  const { a, put } = fixture(t);
  put('before', since - 1, 1);
  put('boundary', since, 2);
  put('tool', since + 1, 3, 'commandExecution');
  put('private', since + 2, 4, 'reasoning');
  const p = await a.enumerate(undefined, caller);
  assert.equal(p.items.length, 2);
  assert.deepEqual(
    p.items.map((x) => x.kind),
    ['userMessage', 'commandExecution'],
  );
  assert.equal((await a.read(p.items[0], caller)).content?.item.text, 'boundary');
  put('new', since + 5, 5);
  assert.equal((await a.query({}, caller)).items.length, 3);
  const q = await a.query({ types: ['commandExecution'], text: 'tool' }, caller);
  assert.equal(q.items.length, 1);
});
test('pagination freezes metadata, survives restart and rejects scope/query/signature changes', async (t) => {
  const f = fixture(t);
  f.put('a', since, 1);
  f.put('b', since + 1, 2);
  const first = await f.a.query({ limit: 1 }, caller);
  assert.ok(first.next);
  f.put('c', since + 2, 3);
  const a = f.restart();
  const second = await a.query({ limit: 1, cursor: first.next }, caller);
  assert.equal(second.items.length, 1);
  assert.equal(second.next, undefined);
  assert.equal((await a.query({}, caller)).items.length, 3);
  await assert.rejects(a.query({ limit: 2, cursor: first.next }, caller), /scope or query/);
  await assert.rejects(
    a.query({ limit: 1, cursor: first.next + 'bad' }, caller),
    /Invalid source cursor/,
  );
  const b = new CodexSource(f.home, since + 1, join(f.dir, 'other'), 'test-signing-key');
  try {
    await assert.rejects(b.query({ limit: 1, cursor: first.next }, caller), /scope or query/);
  } finally {
    b.close();
  }
});
test('changed item versions are detected; original locators cannot escape scope', async (t) => {
  const { a, put, h } = fixture(t);
  put('a', since, 1);
  const old = (await a.query({}, caller)).items[0];
  h.prepare('UPDATE thread_items SET item_json=?,updated_at_ordinal=? WHERE item_id=?').run(
    JSON.stringify({ text: 'finished' }),
    9,
    'a',
  );
  const read = await a.read(old, caller);
  assert.equal(read.status, 'version_unavailable');
  const updated = (await a.query({}, caller)).items[0];
  assert.equal(updated.id, old.id);
  assert.notEqual(updated.revision, old.revision);
  assert.equal((await a.read(updated, caller)).content?.item.text, 'finished');
  put('before', since - 100, 10);
  const bad = {
    ...old,
    id: Buffer.from(JSON.stringify(['thread_items', 'old-session', 'turn', 'before'])).toString(
      'base64url',
    ),
  };
  assert.deepEqual(await a.authorize([bad, { ...old, id: 'malformed' }], caller), []);
  assert.deepEqual(await a.authorize([{ ...old, locator: { table: 'evil' } }], caller), [old.id]);
});
test('read permission is checked again; missing source fails instead of publishing an empty range', async (t) => {
  const { a, put, s, home } = fixture(t);
  put('a', since, 1);
  const old = (await a.query({}, caller)).items[0];
  s.exec('DELETE FROM threads');
  assert.deepEqual(await a.authorize([old], caller), []);
  rmSync(join(home, 'thread_history_1.sqlite'));
  await assert.rejects(a.query({}, caller));
});
test('legacy history cannot silently masquerade as complete; cancellation stops reads', async (t) => {
  const { a, s } = fixture(t);
  s.exec("UPDATE threads SET history_mode='legacy'");
  await assert.rejects(a.query({}, caller), /legacy/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(a.query({}, { invocation: { abortSignal: controller.signal } }));
});
test('voice transcript, new thread, read-only stores and private cache permissions', async (t) => {
  const { a, h, s, dir } = fixture(t);
  s.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(
    'new-session',
    'new',
    'paginated',
    since / 1000,
  );
  h.prepare('INSERT INTO thread_realtime_items VALUES(?,?,?,?,?,?)').run(
    'new-session',
    'voice',
    1,
    since,
    'transcript_segment',
    JSON.stringify({ text: 'voice' }),
  );
  const page = await a.query({ threadId: 'new-session' }, caller);
  assert.equal(page.items.length, 1);
  assert.equal((await a.read(page.items[0], caller)).content?.item.text, 'voice');
  assert.equal(statSync(join(dir, 'pages.sqlite')).mode & 0o777, 0o600);
  assert.equal(h.prepare('SELECT count(*) AS n FROM thread_items').get()?.n, 0);
});

test('change feed baselines history, captures edits and late arrivals, replays and survives restart', async (t) => {
  const f = fixture(t);
  f.put('old', since, 1);
  const baseline = await f.a.changes(undefined, 1, caller);
  assert.equal(baseline.items.length, 0);
  f.put('old', since, 2, 'userMessage', 'edited');
  f.put('late', since, 3);
  const first = await f.a.changes(baseline.cursor, 1, caller);
  assert.equal(first.items.length, 1);
  assert.equal(first.more, true);
  assert.deepEqual(await f.a.changes(baseline.cursor, 1, caller), first);
  const restarted = f.restart();
  const next = await restarted.changes(first.cursor, 10, caller);
  assert.equal(next.items.length, 1);
  assert.equal((await restarted.changes(next.cursor, 10, caller)).items.length, 0);
});
test('changes revoke deleted threads and reject foreign scope/signatures', async (t) => {
  const f = fixture(t);
  const start = await f.a.changes(undefined, 10, caller);
  f.put('new', since, 1);
  const page = await f.a.changes(start.cursor, 10, caller);
  assert.equal(page.items.length, 1);
  f.s.prepare('DELETE FROM threads').run();
  assert.equal((await f.a.changes(start.cursor, 10, caller)).items.length, 0);
  await assert.rejects(f.a.changes(start.cursor + 'bad', 10, caller), /cursor/);
  const other = new CodexSource(f.home, since + 1, join(f.dir, 'other'), 'test-signing-key');
  try {
    await assert.rejects(other.changes(start.cursor, 10, caller), /scope/);
  } finally {
    other.close();
  }
});

test('latest-first history queries apply time/thread filters before frozen pagination', async (t) => {
  const f = fixture(t);
  f.put('old', since, 1, 'userMessage', 'card broken');
  f.put('fix', since + 10, 2, 'agentMessage', 'card fixed');
  f.put('verified', since + 20, 3, 'agentMessage', 'card verified');
  const query = {
    text: 'card',
    threadId: 'old-session',
    startTime: since + 1,
    order: 'desc' as const,
    limit: 1,
  };
  const first = await f.a.query(query, caller);
  assert.equal((await f.a.read(first.items[0], caller)).content?.item.text, 'card verified');
  f.put('later', since + 30, 4, 'agentMessage', 'card newer');
  const a = f.restart();
  const next = await a.query({ ...query, cursor: first.next }, caller);
  assert.equal((await a.read(next.items[0], caller)).content?.item.text, 'card fixed');
  assert.equal(next.next, undefined);
  await assert.rejects(
    a.query({ ...query, order: 'asc', cursor: first.next }, caller),
    /scope or query/,
  );
  const fresh = await a.query(query, caller);
  assert.equal((await a.read(fresh.items[0], caller)).content?.item.text, 'card newer');
});
