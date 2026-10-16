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
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../src/message-cache.js';
import plugin from '../src/host.js';

test('host reuses official cache directory/key across reload, CLI sync is exclusive and reads remain local', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'feishu-host-local-'));
  const cli = join(root, 'fake-cli'),
    log = join(root, 'calls.jsonl'),
    base = join(root, 'existing-cache');
  const message = {
    message_id: 'm',
    chat_id: 'private',
    create_time: '2000',
    msg_type: 'text',
    body: { content: 'synthetic' },
  };
  writeFileSync(
    cli,
    `#!${process.execPath}
const fs=require('node:fs'), args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
const status={appId:'app',identities:{user:{openId:'user',status:'ready'}}};
const path=args[2], data=path?.endsWith('/chats')?{items:[{chat_id:'private'}]}:path?.endsWith('/search')?{items:[]}:{items:[${JSON.stringify(message)}]};
console.log(JSON.stringify(args[0]==='auth'?status:{ok:true,identity:'user',data}));
`,
    { mode: 0o700 },
  );
  const values = new Map<string, any>([
    ['message-cache-directory', base],
    ['cursor-signing-key', Buffer.alloc(32, 7).toString('base64url')],
  ]);
  const writes: string[] = [],
    effects: any[] = [];
  let sources: any[] = [],
    tools: any[] = [];
  const ctx = {
    maka: { rootId: 'profile' },
    storage: {
      get: async (name: string) => ({ value: values.get(name), revision: 0 }),
      set: async (name: string, value: any) => {
        writes.push(name);
        values.set(name, value);
      },
    },
    sources: { register: (s: any) => sources.push(s) },
    tools: { register: (tool: any) => tools.push(tool) },
    effect: (fn: any) => effects.push(fn()),
    credentials: { declare: () => assert.fail('CLI must not request token credentials') },
  };
  const config = {
    instanceId: 'local',
    accountId: 'user',
    appId: 'app',
    cliPath: cli,
    kinds: '[]',
    dataDirectory: join(root, 'ignored'),
    messageStartTime: 1,
    messageEndTime: 10,
  };
  const close = async () => {
    for (const fn of effects.splice(0)) await fn();
  };
  t.after(async () => {
    await close();
    rmSync(root, { recursive: true, force: true });
  });
  await plugin.host.apply(ctx, config);
  assert.deepEqual(writes, []);
  const path = join(base, hash(['local', 'user', 'app']), 'messages.sqlite');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(existsSync(config.dataDirectory), false);
  const sync = tools.find((x) => x.name === 'FeishuSync'),
    status = tools.find((x) => x.name === 'FeishuSyncStatus');
  assert.equal(sync.executionSemantics, 'exclusive_step');
  assert.equal(status.executionSemantics, 'parallel');
  assert.equal((await status.impl({}, {})).synchronized, false);
  assert.equal((await sync.impl({ startTime: 1, endTime: 10 }, {})).status, 'complete');
  assert.equal((await status.impl({}, {})).discoveredChats, 1);
  await close();
  sources = [];
  tools = [];
  await plugin.host.apply(ctx, config);
  const before = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x))
    .filter((x) => x[0] === 'api').length;
  assert.equal((await sources[0].query({}, { invocation: {} })).items.length, 1);
  const after = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x))
    .filter((x) => x[0] === 'api');
  assert.equal(after.length, before, 'query does not fetch messages');
  const chats = after.find((x) => x[2].endsWith('/chats'));
  assert.equal(JSON.parse(chats[chats.indexOf('--params') + 1]).types, 'p2p,group');
  assert.deepEqual(writes, []);
  writeFileSync(
    cli,
    `#!${process.execPath}\nconsole.log(JSON.stringify({appId:'other',identities:{user:{openId:'other',status:'ready'}}}));\n`,
    { mode: 0o700 },
  );
  const unavailable = await tools.find((x) => x.name === 'FeishuSyncStatus').impl({}, {});
  assert.equal(unavailable.synchronized, null);
  assert.equal(unavailable.authorization, 'failed');
  assert.equal(
    unavailable.jobId,
    undefined,
    'failed identity must not disclose cached job details',
  );
  assert.equal(typeof unavailable.schedule.enabled, 'boolean');
  assert.equal(
    (await tools.find((x) => x.name === 'FeishuSyncControl').impl({ action: 'pause' }, {})).enabled,
    false,
  );
});

test('initial CLI storage persists configured base directory and a 32-byte signing key', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'feishu-host-init-'));
  const values = new Map<string, any>(),
    effects: any[] = [];
  t.after(async () => {
    for (const fn of effects) await fn();
    rmSync(root, { recursive: true, force: true });
  });
  await plugin.host.apply(
    {
      maka: { rootId: 'profile' },
      storage: {
        get: async (name: string) => ({ value: values.get(name), revision: 0 }),
        set: async (name: string, value: any) => {
          values.set(name, value);
        },
      },
      sources: { register: () => {} },
      tools: { register: () => {} },
      effect: (fn: any) => effects.push(fn()),
    },
    {
      instanceId: 'local',
      accountId: 'user',
      appId: 'app',
      cliPath: '/bin/false',
      kinds: '[]',
      dataDirectory: root,
    },
  );
  assert.equal(values.get('message-cache-directory'), root);
  assert.equal(Buffer.from(values.get('cursor-signing-key'), 'base64url').length, 32);
  assert.equal(values.has('data-directory'), false);
});

test('token mode registers only the on-demand remote adapter and never opens local message storage', async () => {
  const sources: any[] = [],
    tools: any[] = [];
  await plugin.host.apply(
    {
      maka: { rootId: 'profile' },
      storage: { get: () => assert.fail('token mode must not use message cache') },
      sources: { register: (s: any) => sources.push(s) },
      tools: { register: (t: any) => tools.push(t) },
      credentials: { declare: () => {} },
    },
    {
      instanceId: 'token',
      accountId: 'user',
      appId: 'app',
      containers: JSON.stringify([{ type: 'chat', id: 'chat' }]),
      startTime: 1,
      endTime: 10,
    },
  );
  assert.equal(sources[0].id, 'feishu.token');
  assert.deepEqual(tools, []);
});
