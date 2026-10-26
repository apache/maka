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
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageCache, hash } from '../src/message-cache.js';
import { MessageSync } from '../src/message-sync.js';
import { messageObject } from '../src/adapter.js';
const config = {
  instanceId: 'local',
  accountId: 'user',
  appId: 'app',
  containers: [],
  startTime: 0,
};
const key = Buffer.alloc(32, 7).toString('base64url');
const caller = () => ({ invocation: { abortSignal: new AbortController().signal } });
const raw = (id: string, time = 2000, content = id, chat = 'chat') => ({
  message_id: id,
  chat_id: chat,
  create_time: String(time),
  msg_type: 'text',
  body: { content },
});
// Deliberately independent DDL: tests open a pre-existing local format, not a cache created by the implementation.
const ddl = `CREATE TABLE sync_jobs(id TEXT PRIMARY KEY,request TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
CREATE TABLE sync_chats(job TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(job,id));
CREATE TABLE originals(id TEXT NOT NULL,revision TEXT NOT NULL,object TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE TABLE sync_members(job TEXT NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(job,id));
CREATE TABLE sync_tokens(job TEXT NOT NULL,kind TEXT NOT NULL,token TEXT NOT NULL,PRIMARY KEY(job,kind,token));
CREATE TABLE publications(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,revision TEXT NOT NULL,created_at INTEGER NOT NULL,kind TEXT NOT NULL,object TEXT NOT NULL);
CREATE INDEX publication_object ON publications(id,seq);
CREATE TABLE heads(id TEXT PRIMARY KEY,seq INTEGER NOT NULL);`;
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'feishu-local-format-'));
  const dir = join(root, hash([config.instanceId, config.accountId, config.appId]));
  mkdirSync(dir);
  const path = join(dir, 'messages.sqlite');
  const db = new DatabaseSync(path);
  db.exec(ddl);
  const request = JSON.stringify({ startTime: 1, endTime: 10, containers: [] });
  const payload = {
    phase: 'history',
    chatsPage: null,
    searchPage: null,
    pages: 3,
    startedAt: 100,
    updatedAt: 200,
    finishedAt: null,
    error: 'interrupted',
  };
  db.prepare('INSERT INTO sync_jobs VALUES(?,?,?,?)').run(
    'pending',
    request,
    'incomplete',
    JSON.stringify(payload),
  );
  db.prepare('INSERT INTO sync_jobs VALUES(?,?,?,?)').run(
    'done',
    request,
    'complete',
    JSON.stringify({ ...payload, phase: 'complete', finishedAt: 150 }),
  );
  db.prepare('INSERT INTO sync_chats VALUES(?,?,?)').run(
    'pending',
    'chat',
    JSON.stringify({ page: 'page-two', done: false }),
  );
  db.prepare('INSERT INTO sync_tokens VALUES(?,?,?)').run('pending', 'chat:chat', 'page-two');
  const m = raw('existing'),
    o = messageObject(m);
  db.prepare('INSERT INTO originals VALUES(?,?,?,?)').run(
    o.id,
    o.revision,
    JSON.stringify(o),
    JSON.stringify(m),
  );
  db.prepare('INSERT INTO sync_members VALUES(?,?,?)').run('pending', o.id, o.revision);
  db.prepare('INSERT INTO publications(id,revision,created_at,kind,object) VALUES(?,?,?,?,?)').run(
    o.id,
    o.revision,
    2000,
    o.kind,
    JSON.stringify(o),
  );
  db.prepare('INSERT INTO heads VALUES(?,?)').run(o.id, 1);
  db.close();
  const cache = new MessageCache(root, config, key);
  t.after(() => {
    cache.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, path, cache, o, m };
}
test('opens the exact local schema, reads published originals and resumes existing chat progress before reusing completed jobs', async (t) => {
  const { cache, path, o, m } = fixture(t);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const source = cache.source('feishu.local.messages', async () => {});
  assert.deepEqual(((await source.read(o, caller())) as any).content, m);
  const calls: any[] = [];
  const sync = new MessageSync(
    cache,
    async (_method, path, params) => {
      calls.push({ path, params });
      if (path.endsWith('/search')) return { items: [] };
      assert.equal(path, '/im/v1/messages');
      assert.equal(params.page_token, 'page-two');
      return { items: [raw('new', 3000)] };
    },
    async () => {},
  );
  const result = await sync.sync({ startTime: 1, endTime: 10 }, caller());
  assert.equal(result.jobId, 'pending');
  assert.equal(result.status, 'complete');
  assert.equal(result.discoveredChats, 1);
  assert.equal(result.completedChats, 1);
  assert.equal(result.downloadedMessages, 2);
  assert.equal(result.pages, 5);
  assert.equal(result.startedAt, 100);
  assert.ok(result.finishedAt);
  assert.equal(cache.boundary(), 2, 'unchanged existing version is not republished');
  assert.equal(calls.length, 2, 'no chat discovery or completed history is redownloaded');
  assert.deepEqual(
    cache.db.prepare('SELECT request FROM sync_jobs WHERE id=?').get('pending')!.request,
    JSON.stringify({ startTime: 1, endTime: 10, containers: [] }),
  );
  assert.deepEqual(
    Object.keys(
      JSON.parse(
        String(
          cache.db.prepare('SELECT payload FROM sync_jobs WHERE id=?').get('pending')!.payload,
        ),
      ),
    ),
    ['phase', 'chatsPage', 'searchPage', 'pages', 'startedAt', 'updatedAt', 'finishedAt', 'error'],
  );
  const complete = await sync.sync({ startTime: 1, endTime: 10 }, caller());
  assert.equal(complete.reused, true);
  assert.equal(calls.length, 2);
  assert.equal(
    cache.db
      .prepare(
        "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('versions','staged','published','meta')",
      )
      .get()!.n,
    0,
  );
  assert.equal((await source.enumerate(undefined, caller())).items.length, 2);
  assert.equal(sync.status().jobId, 'done', 'without id only the newest created job is returned');
  assert.equal(sync.status('pending').jobId, 'pending');
});
test('publication is per changed message version and atomic with job completion; partial originals remain unreadable', async (t) => {
  const { cache, o } = fixture(t);
  const source = cache.source('local', async () => {});
  const job = cache.begin(10, 20, true),
    m = raw('unpublished', 11000);
  cache.page(job, [m, raw('existing', 2000, 'changed')]);
  assert.equal((await source.read(messageObject(m), caller())).status, 'unavailable');
  assert.equal((await source.query({}, caller())).items.length, 1);
  cache.db.exec(
    "CREATE TRIGGER fail_complete BEFORE UPDATE ON sync_jobs WHEN NEW.status='complete' BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END",
  );
  assert.throws(() => cache.publish(job), /synthetic write failure/);
  assert.equal(cache.boundary(), 1);
  assert.equal(cache.job(job.id).status, 'incomplete');
  cache.db.exec('DROP TRIGGER fail_complete');
  cache.publish(cache.job(job.id));
  assert.equal(cache.boundary(), 3);
  assert.equal(cache.job(job.id).status, 'complete');
  assert.equal(
    cache.db.prepare("SELECT created_at FROM publications WHERE id='unpublished'").get()!
      .created_at,
    11000,
  );
  assert.equal(
    (await source.read(o, caller())).status,
    'ok',
    'old published version still resolves',
  );
  const again = cache.begin(20, 30, true);
  cache.page(again, [m]);
  cache.publish(again);
  assert.equal(cache.boundary(), 3);
});
test('frozen highWater pagination uses creation time then ID, enforces scope everywhere and requires an initial sync', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'feishu-paging-'));
  let cache = new MessageCache(root, config, key);
  t.after(() => {
    cache.close();
    rmSync(root, { recursive: true, force: true });
  });
  let source = cache.source('local', async () => {});
  const sync = new MessageSync(
    cache,
    async () => ({ items: [] }),
    async () => {},
  );
  assert.deepEqual(sync.status(), {
    configured: true,
    synchronized: false,
    source: 'feishu.local.messages',
  });
  await assert.rejects(source.query({}, caller()), /FeishuSync first/);
  const job = cache.begin(1, 20);
  cache.page(job, [
    raw('z', 1000),
    raw('b', 2000),
    raw('a', 2000),
    raw('outside', 15000, 'outside', 'other'),
  ]);
  cache.publish(job);
  const page = await source.query({ limit: 1 }, caller());
  assert.equal(page.items[0].id, 'z');
  assert.deepEqual(Object.keys(cache.decode(page.next!)), ['hash', 'highWater', 'offset']);
  const high = cache.boundary();
  const update = cache.begin(1, 20, true);
  cache.page(update, [raw('new-earlier', 500), raw('a', 2000, 'updated')]);
  cache.publish(update);
  cache.close();
  cache = new MessageCache(root, config, key);
  source = cache.source('local', async () => {});
  const next = await source.query({ limit: 1, cursor: page.next }, caller());
  assert.equal(next.items[0].id, 'a');
  assert.equal(cache.decode(next.next!).highWater, high);
  assert.equal(((await source.read(next.items[0], caller())) as any).content.body.content, 'a');
  await assert.rejects(source.query({ limit: 2, cursor: page.next }, caller()), /query changed/);
  const restricted = new MessageCache(
    root,
    { ...config, startTime: 1, endTime: 10, containers: [{ type: 'chat', id: 'chat' }] },
    key,
  );
  try {
    const limited = restricted.source('limited', async () => {});
    assert.deepEqual(
      (await limited.query({}, caller())).items.map((o) => o.id),
      ['z', 'a', 'b'],
    );
    const outside = messageObject(raw('outside', 15000, 'outside', 'other'));
    assert.deepEqual(await limited.authorize([outside], caller()), []);
    assert.equal((await limited.read(outside, caller())).status, 'unavailable');
    assert.equal((await limited.query({ chatId: 'other' }, caller())).items.length, 0);
    await assert.rejects(
      limited.query({ limit: 1, cursor: page.next }, caller()),
      /scope or query changed/,
    );
  } finally {
    restricted.close();
  }
  const many = cache.begin(1, 20, true);
  cache.page(
    many,
    Array.from({ length: 510 }, (_, i) => raw('m' + String(i).padStart(3, '0'), 4000 + i)),
  );
  cache.publish(many);
  assert.equal((await source.query({}, caller())).items.length, 50);
  const enumeration = await source.enumerate(undefined, caller());
  assert.equal(enumeration.items.length, 500);
  assert.ok(enumeration.next);
});
test('persisted repeated chat tokens reject only that page and leave job resumable', async (t) => {
  const { cache } = fixture(t);
  const sync = new MessageSync(
    cache,
    async () => ({ items: [raw('discarded')], has_more: true, page_token: 'page-two' }),
    async () => {},
  );
  const result = await sync.sync({ startTime: 1, endTime: 10 }, caller());
  assert.equal(result.status, 'incomplete');
  assert.match(result.error!, /Repeated/);
  assert.equal(cache.has('pending', 'discarded'), false);
  assert.equal(cache.job('pending').pages, 3);
  assert.equal(cache.nextChat('pending').page, 'page-two');
});

for (const phase of ['discover', 'search', 'publish']) {
  test(`local ${phase} phase resumes its persisted cursor without repeating earlier phases`, async (t) => {
    const { cache } = fixture(t);
    const row = cache.db.prepare('SELECT payload FROM sync_jobs WHERE id=?').get('pending')!;
    const payload = {
      ...JSON.parse(String(row.payload)),
      phase,
      chatsPage: phase === 'discover' ? 'saved-discovery' : null,
      searchPage: phase === 'search' ? 'saved-search' : null,
    };
    cache.db
      .prepare('UPDATE sync_jobs SET payload=? WHERE id=?')
      .run(JSON.stringify(payload), 'pending');
    const calls: string[] = [];
    const sync = new MessageSync(
      cache,
      async (_method, path, params) => {
        calls.push(path);
        if (path.endsWith('/chats')) {
          assert.equal(phase, 'discover');
          assert.equal(params.types, 'p2p,group');
          assert.equal(params.page_token, 'saved-discovery');
          return { items: [] };
        }
        if (path.endsWith('/search')) {
          if (phase === 'search') assert.equal(params.page_token, 'saved-search');
          return { items: [] };
        }
        assert.equal(phase, 'discover');
        assert.equal(params.page_token, 'page-two');
        return { items: [] };
      },
      async () => {},
    );
    assert.equal((await sync.sync({ startTime: 1, endTime: 10 }, caller())).status, 'complete');
    assert.deepEqual(
      calls,
      phase === 'discover'
        ? ['/im/v1/chats', '/im/v1/messages', '/im/v1/messages/search']
        : phase === 'search'
          ? ['/im/v1/messages/search']
          : [],
    );
    assert.equal(cache.boundary(), 1, 'unchanged existing originals are not published again');
  });
}

test('activity observation is permission checked, published-only and never reads original bodies', async (t) => {
  const { cache } = fixture(t);
  let allowed = true,
    checks = 0;
  const source = cache.source('feishu.local.messages', async () => {
    checks++;
    if (!allowed) throw Error('permission denied');
  });
  const first = await source.activityToken(caller());
  assert.equal(typeof first, 'string');
  cache.db.prepare('INSERT INTO sync_members VALUES(?,?,?)').run('pending', 'staged-only', '1');
  assert.equal(await source.activityToken(caller()), first);
  cache.db
    .prepare('INSERT INTO publications(id,revision,created_at,kind,object) VALUES(?,?,?,?,?)')
    .run('published-new', '1', 4000, 'message', '{}');
  assert.notEqual(await source.activityToken(caller()), first);
  allowed = false;
  await assert.rejects(source.activityToken(caller()), /permission denied/);
  assert.equal(checks, 4);
});
