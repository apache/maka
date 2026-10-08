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
import { createCli } from '../src/cli.js';
import { createCliSources } from '../src/cli-sources.js';
const config = {
  cliPath: '/bin/lark-cli',
  appId: 'app',
  accountId: 'user',
  instanceId: 'test',
  kinds: ['documents'] as any,
};
const caller = () => ({
  invocation: { abortSignal: new AbortController().signal },
});
const status = {
  appId: 'app',
  identities: { user: { openId: 'user', status: 'ready' } },
};
test('CLI pins account, enforces user identity and rejects mutation commands', async () => {
  let switched = false;
  let commands: string[][] = [];
  const c = createCli(config, async (args) => {
    commands.push(args);
    return args[0] === 'auth'
      ? { ...status, appId: switched ? 'other' : 'app' }
      : { ok: true, identity: 'user', data: {} };
  });
  await c.call(['task', 'tasks', 'get', '--task-guid', 'task'], caller());
  assert.deepEqual(commands[1].slice(-4), ['--as', 'user', '--format', 'json']);
  await assert.rejects(c.call(['task', 'tasks', 'delete'], caller()), /allowlist/);
  switched = true;
  await assert.rejects(c.call(['task', 'tasks', 'get'], caller()), /account changed/);
  const bot = createCli(config, async (args) =>
    args[0] === 'auth' ? status : { ok: true, identity: 'bot', data: {} },
  );
  await assert.rejects(bot.call(['task', 'tasks', 'get'], caller()), /user read/);
});
test('doc discovery uses metadata only, wiki resolves to native ID, changed revisions stay visible', async () => {
  let revision = 1;
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'auth') return status;
    let data: any;
    if (args[1] === '+search')
      data = {
        results: [{ result_meta: { url: 'https://example.feishu.cn/wiki/node' } }],
        has_more: false,
      };
    else if (args[1] === '+inspect') data = { type: 'docx', token: 'doc' };
    else if (args[0] === 'api')
      data = {
        document: {
          document_id: 'doc',
          revision_id: revision,
          title: 'Document',
        },
      };
    else if (args[1] === '+fetch')
      data = {
        document: {
          document_id: 'doc',
          revision_id: revision,
          content: 'Body',
        },
      };
    return { ok: true, identity: 'user', data };
  };
  const [source] = createCliSources(config, run);
  const page = await source.enumerate(undefined, caller());
  assert.equal(page.items[0].id, 'doc');
  assert.equal(
    calls.some((a) => a[1] === '+fetch'),
    false,
  );
  assert.equal(JSON.stringify(page).includes('Body'), false);
  revision = 2;
  const read = await source.read(page.items[0], caller());
  assert.equal(read.object.revision, '2');
  assert.equal(read.status, 'version_unavailable');
  assert.equal(read.content, undefined);
  const latest = await source.read(read.object, caller());
  assert.equal(latest.content.content, 'Body');
  await assert.rejects(
    source.read({ ...page.items[0], locator: { nativeId: 'different' } }, caller()),
    /locator/,
  );
});
test('empty provider pages retain signed cursors bound to query and source instance', async () => {
  const run = async (args: string[]) =>
    args[0] === 'auth'
      ? status
      : {
          ok: true,
          identity: 'user',
          data: {
            results: [],
            has_more: !args.includes('--page-token'),
            page_token: 'next',
          },
        };
  const [source] = createCliSources(config, run);
  const first = await source.query({ text: 'hello', limit: 3 }, caller());
  assert.equal(first.items.length, 0);
  assert.ok(first.next);
  assert.equal(
    (await source.query({ text: 'hello', limit: 3, cursor: first.next }, caller())).next,
    undefined,
  );
  await assert.rejects(
    source.query({ text: 'changed', limit: 3, cursor: first.next }, caller()),
    /query changed/,
  );
  const [other] = createCliSources(config, run);
  await assert.rejects(
    other.query({ text: 'hello', limit: 3, cursor: first.next }, caller()),
    /Invalid source cursor/,
  );
});
test('tasks preserve native fields and changed content produces a different revision', async () => {
  let completed = '0';
  const run = async (args: string[]) =>
    args[0] === 'auth'
      ? status
      : {
          ok: true,
          identity: 'user',
          data:
            args[2] === 'list'
              ? { items: [{ guid: 't' }] }
              : {
                  task: {
                    guid: 't',
                    summary: 'A',
                    completed_at: completed,
                    updated_at: '100',
                  },
                },
        };
  const [source] = createCliSources({ ...config, kinds: ['tasks'] }, run);
  const old = (await source.query({}, caller())).items[0];
  completed = '123';
  const latest = await source.read(old, caller());
  assert.notEqual(latest.object.revision, old.revision);
  assert.equal(latest.content.completed_at, '123');
});
test('calendar has explicit time bounds, reads actual event details and exposes cancellation', async () => {
  const calls: string[][] = [];
  let cancelled = false;
  const [source] = createCliSources(
    {
      ...config,
      kinds: ['calendar'],
      startTime: 1700000000,
      endTime: 1700100000,
    },
    async (args) => {
      calls.push(args);
      if (args[0] === 'auth') return status;
      return {
        ok: true,
        identity: 'user',
        data:
          args[1] === '+agenda'
            ? [{ event_id: 'event_0' }]
            : {
                event: {
                  event_id: 'event_0',
                  summary: 'Meeting',
                  status: cancelled ? 'cancelled' : 'confirmed',
                  start_time: { timestamp: '1700001000' },
                  end_time: { timestamp: '1700002000' },
                },
              },
      };
    },
  );
  const o = (await source.enumerate(undefined, caller())).items[0];
  assert.equal(o.kind, 'calendar');
  assert.ok(calls.some((a) => a.includes('2023-11-14T22:13:20.000Z')));
  assert.equal((await source.read(o, caller())).content.start_time.timestamp, '1700001000');
  cancelled = true;
  assert.equal((await source.read(o, caller())).status, 'deleted');
  assert.throws(() => createCliSources({ ...config, kinds: ['calendar'] }), /explicit/);
});

test('cancelled callers never launch CLI and raw writes are rejected', async () => {
  const abort = new AbortController();
  abort.abort(new Error('test cancelled'));
  let launched = 0;
  const cli = createCli(config, async () => {
    launched++;
    return status;
  });
  await assert.rejects(
    cli.call(['task', 'tasks', 'get'], { invocation: { abortSignal: abort.signal } }),
    /test cancelled/,
  );
  await assert.rejects(
    cli.call(['api', 'DELETE', '/open-apis/im/v1/messages/om_1'], caller()),
    /allowlist/,
  );
  assert.equal(launched, 0);
});

test('provider permission failure cannot become a successful empty scan', async () => {
  const [source] = createCliSources(config, async (args) =>
    args[0] === 'auth' ? status : { ok: false, identity: 'user', error: { code: 99991672 } },
  );
  await assert.rejects(source.enumerate(undefined, caller()), /read failed/);
});

test('explicit CLI profile applies to both identity validation and data reads', async () => {
  const calls: string[][] = [];
  const cli = createCli({ ...config, cliProfile: 'personal' }, async (args) => {
    calls.push(args);
    return args[0] === 'auth' ? status : { ok: true, identity: 'user', data: {} };
  });
  await cli.call(['task', 'tasks', 'get', '--task-guid', 't'], caller());
  assert.ok(calls.every((a) => a.slice(-2).join(' ') === '--profile personal'));
});

test('rate limits back off and retry reads, while authorization errors fail immediately', async () => {
  let reads = 0;
  const waits: number[] = [];
  const cli = createCli(
    config,
    async (args) => {
      if (args[0] === 'auth') return status;
      reads++;
      return reads < 3
        ? { ok: false, identity: 'user', error: { code: 99991400 } }
        : { ok: true, identity: 'user', data: { ok: true } };
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  assert.deepEqual(await cli.call(['task', 'tasks', 'get'], caller()), { ok: true });
  assert.equal(reads, 3);
  assert.ok(waits.includes(1000));
  assert.ok(waits.includes(2000));
  let denied = 0;
  const bad = createCli(
    config,
    async (args) =>
      args[0] === 'auth'
        ? status
        : (denied++, { ok: false, identity: 'user', error: { code: 99991672 } }),
    async () => {},
  );
  await assert.rejects(bad.call(['task', 'tasks', 'get'], caller()), /99991672/);
  assert.equal(denied, 1);
});

test('CLI default discovers group and p2p chats, search and enumeration share native revisions, calendar dates do not constrain messages', async () => {
  const calls: string[][] = [];
  const raw = {
    message_id: 'om_one',
    chat_id: 'oc_private',
    create_time: '2000',
    msg_type: 'text',
    body: { content: '原始消息' },
  };
  const sources = createCliSources(
    { ...config, kinds: [], startTime: 9999, endTime: 10000 },
    async (args) => {
      calls.push(args);
      if (args[0] === 'auth') return status;
      let data: any;
      if (args[1] === '+chat-list')
        data = { chats: [{ chat_id: 'oc_private' }], has_more: false };
      else if (args[1] === '+messages-search')
        data = {
          messages: [{ message_id: 'om_one', create_time: 'formatted', content: 'formatted' }],
          has_more: !args.includes('--page-token'),
          page_token: 's2',
        };
      else data = { items: [raw], has_more: false };
      return { ok: true, identity: 'user', data };
    },
  );
  const source = sources.find((s) => s.id.endsWith('.messages'))!;
  assert.equal(source.scope.startTime, 0);
  assert.equal(source.scope.endTime, 'scan-start');
  const page = await source.enumerate(undefined, caller());
  assert.equal(page.items[0].id, 'om_one');
  assert.ok(calls.some((a) => a[1] === '+chat-list' && a.includes('p2p,group')));
  const c = caller(),
    q = { text: '原始', chatId: 'oc_private', limit: 2 };
  const found = await source.query(q, c);
  assert.ok(found.next);
  assert.equal(found.items[0].revision, page.items[0].revision);
  assert.equal((await source.read(found.items[0], c)).content.body.content, '原始消息');
  const next = await source.query({ ...q, cursor: found.next }, caller());
  assert.equal(next.next, undefined);
  await assert.rejects(
    source.query({ ...q, text: 'changed', cursor: found.next }, caller()),
    /query changed/,
  );
  const search = calls.find((a) => a[1] === '+messages-search')!;
  assert.ok(search.includes('--chat-id'));
  assert.ok(search.includes('--no-reactions'));
  assert.ok(
    !search.some((a) => a.endsWith('.000Z')),
    'Feishu search rejects fractional-second timestamps',
  );
  assert.ok(!search.includes('--start'), 'Unbounded start omits the optional filter');
});

test('refreshable pinned login can read; switched identities and unusable login states cannot', async () => {
  for (const [state, appId, openId, allowed] of [
    ['needs_refresh', 'app', 'user', true],
    ['needs_refresh', 'other', 'user', false],
    ['needs_refresh', 'app', 'other', false],
    ['expired', 'app', 'user', false],
    ['not_logged_in', 'app', 'user', false],
    ['unknown', 'app', 'user', false],
  ] as const) {
    let reads = 0;
    const cli = createCli(config, async (args) => {
      if (args[0] === 'auth')
        return { appId, identities: { user: { openId, status: state } } };
      reads++;
      return { ok: true, identity: 'user', data: { refreshed: true } };
    });
    const request = cli.call(['task', 'tasks', 'get'], caller());
    if (allowed) assert.deepEqual(await request, { refreshed: true });
    else await assert.rejects(request, /account changed/);
    assert.equal(reads, allowed ? 1 : 0);
  }
});
