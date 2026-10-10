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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageCache } from '../src/message-cache.js';
import { MessageSync } from '../src/message-sync.js';
import { createCli } from '../src/cli.js';
const scope = { instanceId: 'test', accountId: 'user', appId: 'app', containers: [], startTime: 0 };
const caller = () => ({ invocation: { abortSignal: new AbortController().signal } });
const raw = (id: string, extra: any = {}) => ({
  message_id: id,
  chat_id: 'chat',
  create_time: '2000',
  msg_type: 'text',
  body: { content: id },
  ...extra,
});
const setup = (t: any) => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-sync-'));
  let cache = new MessageCache(dir, scope);
  t.after(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    get cache() {
      return cache;
    },
    restart: () => {
      cache.close();
      cache = new MessageCache(dir, scope);
      return cache;
    },
  };
};
const ok = async () => {};

test('failed pages resume after restart; partial refresh never replaces published originals', async (t) => {
  const f = setup(t);
  const requests: string[] = [];
  let broken = false,
    revision = 'old';
  const api = async (method: any, path: string, params: any) => {
    requests.push(path + ':' + (params.page_token ?? ''));
    if (path.endsWith('/chats')) return { items: [{ chat_id: 'chat' }], has_more: false };
    if (path.endsWith('/search'))
      return { items: [{ meta_data: { message_id: 'reply' } }], has_more: false };
    if (path.endsWith('/mget')) {
      if (broken) throw Error('network interrupted');
      return { items: [raw('reply', { body: { content: revision } })] };
    }
    assert.equal(params.start_time, '1');
    assert.equal(params.end_time, '4');
    assert.equal(params.container_id_type, 'chat');
    return { items: [raw('root', { body: { content: revision } })], has_more: false };
  };
  const sync = new MessageSync(f.cache, api, ok);
  assert.equal(
    (await sync.sync({ startTime: 1, endTime: 4 }, caller())).jobs[0].status,
    'complete',
  );
  const before = f.cache.boundary();
  const count = requests.length;
  assert.equal((await sync.sync({ startTime: 1, endTime: 4 }, caller())).reused, true);
  assert.equal(requests.length, count);
  broken = true;
  revision = 'new';
  const failed = await sync.sync({ startTime: 1, endTime: 4, refresh: true }, caller());
  assert.equal(failed.jobs[0].status, 'failed');
  assert.equal(f.cache.boundary(), before);
  assert.ok(f.cache.rows().every((r) => String(r.body).includes('old')));
  f.restart();
  requests.length = 0;
  broken = false;
  const retried = await new MessageSync(f.cache, api, ok).sync(
    { startTime: 1, endTime: 4 },
    caller(),
  );
  assert.equal(retried.jobs[0].jobId, failed.jobs[0].jobId);
  assert.equal(retried.jobs[0].status, 'complete');
  assert.ok(requests.every((x) => !x.includes('/chats') && !x.endsWith('/messages:')));
  assert.ok(f.cache.rows().every((r) => String(r.body).includes('new')));
  assert.ok(f.cache.rows(before).every((r) => String(r.body).includes('old')));
});

test('search deduplicates IDs and uses mget batches <=50, never one request per message or old threads', async (t) => {
  const f = setup(t);
  const batches: string[][] = [];
  const sync = new MessageSync(
    f.cache,
    async (method, path, params, body) => {
      if (path.endsWith('/chats')) return { items: [{ chat_id: 'chat' }], has_more: false };
      if (path.endsWith('/search')) {
        assert.equal(method, 'POST');
        assert.equal(body.filter.time_range.start_time, '1970-01-01T00:00:01Z');
        return {
          items: ['root', ...Array.from({ length: 105 }, (_, i) => `m${i}`), 'm0'].map((id) => ({
            meta_data: { message_id: id },
          })),
          has_more: false,
        };
      }
      if (path.endsWith('/mget')) {
        batches.push(params.message_ids);
        return { items: params.message_ids.map((id: string) => raw(id)) };
      }
      assert.equal(path, '/im/v1/messages');
      assert.equal(params.start_time, '1');
      return { items: [raw('root', { thread_id: 'old_thread' })], has_more: false };
    },
    ok,
  );
  const result = await sync.sync({ startTime: 1, endTime: 3 }, caller());
  assert.equal(result.jobs[0].messages, 106);
  assert.deepEqual(
    batches.map((x) => x.length),
    [50, 50, 5],
  );
  assert.equal(new Set(batches.flat()).size, 105);
  assert.ok(!batches.flat().includes('root'));
});

test('local cursors bind publication, query, scope and persisted signing key; reads never call remote APIs', async (t) => {
  const f = setup(t);
  const publish = (messages: any[]) => {
    const j = f.cache.begin(1, 3, true);
    f.cache.page(j, messages);
    f.cache.publish(j);
  };
  publish([raw('a'), raw('b')]);
  let verifications = 0;
  const verify = async () => {
    verifications++;
  };
  const source = f.cache.source('feishu.test.messages', verify);
  const page = await source.query({ limit: 1 }, caller());
  assert.ok(page.next);
  publish([raw('aa'), raw('b', { body: { content: 'updated' } })]);
  f.restart();
  const restored = f.cache.source('feishu.test.messages', verify);
  const next = await restored.query({ limit: 1, cursor: page.next }, caller());
  assert.equal(next.items[0].id, 'b');
  assert.equal(((await restored.read(next.items[0], caller())) as any).content.body.content, 'b');
  assert.equal(next.next, undefined);
  await assert.rejects(restored.query({ limit: 2, cursor: page.next }, caller()), /query changed/);
  await assert.rejects(
    restored.query({ limit: 1, cursor: page.next + 'bad' }, caller()),
    /Invalid/,
  );
  const other = new MessageCache(f.dir, { ...scope, accountId: 'other' });
  try {
    assert.equal(other.rows().length, 0);
    await assert.rejects(
      other.source('other', ok).query({ limit: 1, cursor: page.next }, caller()),
      /scope/,
    );
  } finally {
    other.close();
  }
  assert.ok(verifications > 0);
});

test('deletions are tombstones, missing mget originals and permission errors are real failures', async (t) => {
  const f = setup(t);
  let missing = false;
  const api = async (_: any, path: string) =>
    path.endsWith('/chats')
      ? { items: [] }
      : path.endsWith('/search')
        ? { items: [{ meta_data: { message_id: 'gone' } }] }
        : { items: missing ? [] : [raw('gone', { deleted: true })] };
  const sync = new MessageSync(f.cache, api, ok);
  assert.equal(
    (await sync.sync({ startTime: 1, endTime: 3 }, caller())).jobs[0].status,
    'complete',
  );
  const source = f.cache.source('test', ok),
    o = (await source.query({}, caller())).items[0];
  assert.equal((await source.read(o, caller())).status, 'deleted');
  missing = true;
  const failed = await sync.sync({ startTime: 1, endTime: 3, refresh: true }, caller());
  assert.match(failed.jobs[0].error, /cannot assume deletion/);
  await assert.rejects(
    f.cache
      .source('test', async () => {
        throw Error('permission revoked');
      })
      .read(o, caller()),
    /permission revoked/,
  );
});

test('same range concurrent callers share work and final identity failure does not publish', async (t) => {
  const f = setup(t);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const sync = new MessageSync(
    f.cache,
    async () => {
      calls++;
      await gate;
      return { items: [] };
    },
    ok,
  );
  const a = sync.sync({ startTime: 1, endTime: 3 }, caller()),
    b = sync.sync({ startTime: 1, endTime: 3 }, caller());
  await new Promise((r) => setTimeout(r, 5));
  release();
  const [x, y] = await Promise.all([a, b]);
  assert.equal(x.jobs[0].jobId, y.jobs[0].jobId);
  assert.equal(calls, 2);
  let checks = 0;
  const denied = new MessageSync(
    f.cache,
    async () => ({ items: [] }),
    async () => {
      if (++checks > 1) throw Error('account changed');
    },
  );
  const old = f.cache.boundary();
  const failed = await denied.sync({ startTime: 4, endTime: 5 }, caller());
  assert.equal(failed.jobs[0].status, 'failed');
  assert.equal(f.cache.boundary(), old);
});

test('repeated pagination and unapproved time ranges fail explicitly', async (t) => {
  const f = setup(t);
  const sync = new MessageSync(
    f.cache,
    async () => ({ items: [], has_more: true, page_token: 'same' }),
    ok,
  );
  const result = await sync.sync({ startTime: 1, endTime: 3 }, caller());
  assert.match(result.jobs[0].error, /Repeated/);
  assert.equal(f.cache.boundary(), 0);
  await assert.rejects(sync.sync({ startTime: 3, endTime: 1 }, caller()), /Time bounds/);
});

test('CLI allows only read-only search POST and native mget GET', async () => {
  const requests: string[][] = [];
  const cli = createCli(
    { cliPath: '/bin/lark-cli', appId: 'app', accountId: 'user' },
    async (args) => {
      requests.push(args);
      return args[0] === 'auth'
        ? { appId: 'app', identities: { user: { openId: 'user', status: 'ready' } } }
        : { ok: true, identity: 'user', data: { items: [] } };
    },
    async () => {},
  );
  await cli.call(['api', 'POST', '/open-apis/im/v1/messages/search', '--data', '{}'], caller());
  await cli.call(
    ['api', 'GET', '/open-apis/im/v1/messages/mget', '--params', '{"message_ids":["m1","m2"]}'],
    caller(),
  );
  await assert.rejects(
    cli.call(['api', 'POST', '/open-apis/im/v1/messages'], caller()),
    /allowlist/,
  );
  assert.equal(requests.filter((a) => a[0] === 'api').length, 2);
});

test('plugin shutdown interrupts a download and retains the last committed page for resume', async (t) => {
  const f = setup(t);
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const sync = new MessageSync(
    f.cache,
    async (_method, _path, _params, _body, c) => {
      entered();
      await new Promise((_, reject) =>
        c.invocation.abortSignal.addEventListener(
          'abort',
          () => reject(c.invocation.abortSignal.reason),
          { once: true },
        ),
      );
      return { items: [] };
    },
    ok,
  );
  const running = sync.sync({ startTime: 1, endTime: 3 }, caller());
  await ready;
  await sync.close();
  const result = await running;
  assert.equal(result.jobs[0].status, 'failed');
  assert.equal(f.cache.boundary(), 0);
  const resumed = await new MessageSync(f.cache, async () => ({ items: [] }), ok).sync(
    { startTime: 1, endTime: 3 },
    caller(),
  );
  assert.equal(resumed.jobs[0].jobId, result.jobs[0].jobId);
  assert.equal(resumed.jobs[0].status, 'complete');
});
