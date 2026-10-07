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
import { createFeishuSource } from '../src/adapter.js';
test('Feishu pages, thread expansion, permission reads and stable versions are read-only', async () => {
  const root = {
    message_id: 'om_root',
    chat_id: 'oc_chat',
    thread_id: 'omt_t',
    msg_type: 'text',
    create_time: '2000',
    body: { content: '采购进展' },
  };
  const reply = {
    ...root,
    message_id: 'om_reply',
    parent_id: 'om_root',
    create_time: '3000',
    body: { content: '周五交付' },
  };
  const requests: any[] = [];
  const source = createFeishuSource(
    {
      instanceId: 'test',
      containers: [{ type: 'chat', id: 'oc_chat' }],
      startTime: 1,
      endTime: 10,
    },
    async () => 'test-token',
    async (url, init) => {
      requests.push({ url: String(url), method: init?.method });
      assert.equal(init?.headers?.['Authorization'], 'Bearer test-token');
      const u = new URL(String(url));
      let data: any;
      if (u.pathname.endsWith('/om_reply')) data = { items: [reply] };
      else if (u.searchParams.get('container_id_type') === 'thread')
        data = { items: [reply], has_more: false };
      else data = { items: [root], has_more: false };
      return new Response(JSON.stringify({ code: 0, data }), { status: 200 });
    },
  );
  const caller = { invocation: { abortSignal: new AbortController().signal } };
  const first = await source.enumerate(undefined, caller);
  assert.equal(first.items.length, 1);
  assert.ok(first.next);
  const second = await source.enumerate(first.next, caller);
  assert.equal(second.items[0].id, 'om_reply');
  assert.equal(second.next, undefined);
  assert.deepEqual(await source.authorize(second.items, caller), ['om_reply']);
  assert.equal(requests.length, 2);
  const read = await source.read(second.items[0], { invocation: {} });
  assert.equal(read.object.revision, second.items[0].revision);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((r) => r.method === 'GET'));
  await assert.rejects(source.enumerate(first.next + 'tampered', caller), /cursor/);
});
test('empty filtered page retains cursor; API errors and unconfigured containers fail closed', async () => {
  assert.throws(
    () => createFeishuSource({ instanceId: 'x', containers: [], startTime: 1 }, async () => ''),
    /containers/,
  );
  const source = createFeishuSource(
    { instanceId: 'x', containers: [{ type: 'chat', id: 'oc_a' }], startTime: 1 },
    async () => 'test',
    async () =>
      new Response(
        JSON.stringify({ code: 0, data: { items: [], has_more: true, page_token: 'next' } }),
      ),
  );
  const page = await source.query({ text: 'missing' }, { invocation: {} });
  assert.equal(page.items.length, 0);
  assert.ok(page.next);
  const denied = createFeishuSource(
    { instanceId: 'x', containers: [{ type: 'chat', id: 'oc_a' }], startTime: 1 },
    async () => 'test',
    async () => new Response(JSON.stringify({ code: 99991672, msg: 'secret should not leak' })),
  );
  await assert.rejects(denied.enumerate(undefined, { invocation: {} }), /99991672/);
});

test('recent replies on old roots remain discoverable within the requested time scope', async () => {
  const source = createFeishuSource(
    {
      instanceId: 'old-root',
      containers: [{ type: 'chat', id: 'oc_chat' }],
      startTime: 10,
      endTime: 30,
    },
    async () => 'test',
    async (url) => {
      const u = new URL(String(url));
      const thread = u.searchParams.get('container_id_type') === 'thread';
      const m = {
        message_id: thread ? 'om_reply' : 'om_old',
        chat_id: 'oc_chat',
        thread_id: 'omt_t',
        create_time: thread ? '20000' : '1000',
        msg_type: 'text',
        body: { content: 'content' },
      };
      return new Response(JSON.stringify({ code: 0, data: { items: [m], has_more: false } }));
    },
  );
  const caller = { invocation: {} };
  const first = await source.enumerate(undefined, caller);
  assert.equal(first.items.length, 0);
  assert.ok(first.next);
  const next = await source.enumerate(first.next, caller);
  assert.equal(next.items[0].id, 'om_reply');
});
