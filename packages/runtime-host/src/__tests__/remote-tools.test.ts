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
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { RemoteToolsHost } from '../server/remote-tools.js';
import { remoteToolsRequest } from '../protocol/remote-tools.js';
import { operationAllowsRemoteOwner } from '../protocol/operations.js';
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'maka-remote-'));
  let count = 0,
    created = 0;
  const delivered: unknown[] = [];
  const deps: ConstructorParameters<typeof RemoteToolsHost>[1] = {
    list: async () => [{ sessionId: 'template' }],
    create: async () => {
      created++;
      return 'remote-session';
    },
    tools: async () => [
      {
        name: 'Read',
        description: 'Read file',
        parameters: z.object({ path: z.string() }).passthrough(),
        impl: async () => 'unused',
      },
      {
        name: 'SendUser',
        description: 'Forbidden',
        parameters: z.object({}),
        impl: async () => '',
      },
    ],
    execute: async (_session: string, _id: string, _tool: unknown, args: unknown) => {
      count++;
      return args;
    },
    deliver: (_session: string, input: unknown) => {
      delivered.push(input);
      return true;
    },
  };
  let host = new RemoteToolsHost(dir, deps);
  const c = (await host.request(
    { action: 'open', originHost: 'main', originSession: 'bot', templateSession: 'template' },
    'owner',
  )) as { id: string };
  return {
    dir,
    deps,
    c,
    get host() {
      return host;
    },
    get count() {
      return count;
    },
    get created() {
      return created;
    },
    delivered,
    async restart() {
      await host.close();
      host = new RemoteToolsHost(dir, deps);
    },
    async close() {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test('remote context and call receipts persist, retry never repeats an effect', async () => {
  const f = await fixture();
  try {
    const call = {
      action: 'call' as const,
      contextId: f.c.id,
      origin: { hostId: 'main', sessionId: 'bot' },
      callId: 'call',
      tool: 'Read',
      arguments: { path: 'a' },
    };
    assert.equal(((await f.host.request(call, 'owner')) as any).status, 'completed');
    await f.host.request(call, 'owner');
    assert.equal(f.count, 1);
    await f.restart();
    await f.host.request(call, 'owner');
    assert.equal(f.count, 1);
    const c = (await f.host.request(
      { action: 'open', originHost: 'main', originSession: 'bot', templateSession: 'template' },
      'owner',
    )) as any;
    assert.equal(c.id, f.c.id);
    assert.equal(f.created, 1);
    await assert.rejects(
      f.host.request({ ...call, arguments: { path: 'b' } }, 'owner'),
      /different arguments/,
    );
  } finally {
    await f.close();
  }
});
test('context isolation, explicit tool exports and original schema', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.host.request(
        {
          action: 'search',
          contextId: f.c.id,
          origin: { hostId: 'main', sessionId: 'bot' },
          query: '',
        },
        'other',
      ),
      /another principal/,
    );
    await assert.rejects(
      f.host.request(
        {
          action: 'search',
          contextId: f.c.id,
          origin: { hostId: 'main', sessionId: 'other-bot' },
          query: '',
        },
        'owner',
      ),
      /another origin conversation/,
    );
    const found = (await f.host.request(
      {
        action: 'search',
        contextId: f.c.id,
        origin: { hostId: 'main', sessionId: 'bot' },
        query: '',
      },
      'owner',
    )) as any;
    assert.deepEqual(
      found.tools.map((t: any) => t.name),
      ['Read'],
    );
    assert.ok(found.tools[0].parameters.properties.path);
    const keywords = (await f.host.request(
      {
        action: 'search',
        contextId: f.c.id,
        origin: { hostId: 'main', sessionId: 'bot' },
        query: 'read write files shell',
      },
      'owner',
    )) as any;
    assert.deepEqual(
      keywords.tools.map((t: any) => t.name),
      ['Read'],
    );
    await assert.rejects(
      f.host.request(
        {
          action: 'call',
          contextId: f.c.id,
          origin: { hostId: 'main', sessionId: 'bot' },
          callId: 'bad',
          tool: 'SendUser',
          arguments: {},
        },
        'owner',
      ),
      /not exported/,
    );
  } finally {
    await f.close();
  }
});
test('feedback is durable, scoped and acknowledged only explicitly', async () => {
  const f = await fixture();
  try {
    assert.equal(
      f.host.feedback('remote-session', {
        id: 'progress',
        type: 'task_update',
        source: 'matter',
        content: { text: 'done' },
      }),
      true,
    );
    const event = { action: 'events' as const, originHost: 'main' };
    const a = (await f.host.request(event, 'owner')) as any[];
    assert.equal(a.length, 1);
    assert.deepEqual(await f.host.request(event, 'other'), []);
    await f.restart();
    assert.deepEqual(await f.host.request(event, 'owner'), a);
    await f.host.request({ action: 'ack', ids: [a[0].id] }, 'other');
    assert.equal(((await f.host.request(event, 'owner')) as any[]).length, 1);
    await f.host.request({ action: 'ack', ids: [a[0].id] }, 'owner');
    assert.deepEqual(await f.host.request(event, 'owner'), []);
  } finally {
    await f.close();
  }
});
test('tool failure settles and later calls still run; inline reads do not wake the Bot', async () => {
  const f = await fixture();
  try {
    f.deps.execute = async () => {
      throw Error('network failed');
    };
    const call = {
      action: 'call' as const,
      contextId: f.c.id,
      origin: { hostId: 'main', sessionId: 'bot' },
      callId: 'failure',
      tool: 'Read',
      arguments: { path: 'a' },
    };
    const result = (await f.host.request(call, 'owner')) as any;
    assert.match(result.result.error, /network failed/);
    f.deps.execute = async () => ({ ok: true });
    assert.equal(
      ((await f.host.request({ ...call, callId: 'next' }, 'owner')) as any).result.ok,
      true,
    );
    assert.deepEqual(await f.host.request({ action: 'events', originHost: 'main' }, 'owner'), []);
  } finally {
    await f.close();
  }
});
test('interrupted execution is outcome_unknown after restart, never automatically replayed', async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(join(f.dir, 'remote-tools.sqlite'));
    db.prepare('INSERT INTO calls(id,context,fingerprint,status,result) VALUES(?,?,?,?,NULL)').run(
      'interrupted',
      f.c.id,
      'fingerprint',
      'running',
    );
    db.close();
    await f.restart();
    const db2 = new DatabaseSync(join(f.dir, 'remote-tools.sqlite'));
    assert.equal(
      db2.prepare('SELECT status FROM calls WHERE id=?').get('interrupted')!.status,
      'outcome_unknown',
    );
    db2.close();
    assert.equal(f.count, 0);
  } finally {
    await f.close();
  }
});
test('protocol rejects extra routing fields and grants only explicit owner operation', () => {
  assert.equal(remoteToolsRequest.safeParse({ action: 'contexts', command: 'rm' }).success, false);
  assert.equal(operationAllowsRemoteOwner('remote.tools'), true);
});

test('deferred calls keep running, reject overlapping work, and support explicit cancellation', async () => {
  const f = await fixture();
  try {
    f.deps.execute = async (_s, _id, _tool, _args, _event, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    const call = {
      action: 'call' as const,
      contextId: f.c.id,
      origin: { hostId: 'main', sessionId: 'bot' },
      callId: 'long',
      tool: 'Read',
      arguments: { path: 'a' },
    };
    assert.equal(((await f.host.request(call, 'owner')) as any).status, 'running');
    await assert.rejects(
      f.host.request({ ...call, callId: 'overlap' }, 'owner'),
      /active tool call/,
    );
    await assert.rejects(
      f.host.request(
        {
          action: 'cancel',
          contextId: f.c.id,
          origin: { hostId: 'main', sessionId: 'bot' },
          callId: 'long',
        },
        'other',
      ),
      /another principal/,
    );
    await f.host.request(
      {
        action: 'cancel',
        contextId: f.c.id,
        origin: { hostId: 'main', sessionId: 'bot' },
        callId: 'long',
      },
      'owner',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = (await f.host.request(
      {
        action: 'result',
        contextId: f.c.id,
        origin: { hostId: 'main', sessionId: 'bot' },
        callId: 'long',
      },
      'owner',
    )) as any;
    assert.equal(result.status, 'outcome_unknown');
    assert.match(result.result.error, /cancelled/);
    const events = (await f.host.request(
      { action: 'events', originHost: 'main' },
      'owner',
    )) as any[];
    assert.equal(events.length, 1);
    assert.equal(events[0].content.callId, 'long');
  } finally {
    await f.close();
  }
});

test('all Bot business capabilities are exported; its chat loop remains local', async () => {
  const { BOT_TOOLS, BOT_DELEGATION_TOOLS } = await import('../assistant/bot/capabilities.js');
  const { REMOTE_TOOL_NAMES } = await import('../server/remote-tools.js');
  for (const name of BOT_DELEGATION_TOOLS) assert.ok(REMOTE_TOOL_NAMES.has(name), name);
  for (const name of BOT_TOOLS)
    if (!BOT_DELEGATION_TOOLS.has(name)) assert.equal(REMOTE_TOOL_NAMES.has(name), false, name);
});
test('retry argument object order is irrelevant; discovery feedback retains its type', async () => {
  const f = await fixture();
  try {
    const call = {
      action: 'call' as const,
      contextId: f.c.id,
      origin: { hostId: 'main', sessionId: 'bot' },
      callId: 'order',
      tool: 'Read',
      arguments: { path: 'a', options: { first: 1, second: 2 } },
    };
    await f.host.request(call, 'owner');
    await f.host.request(
      { ...call, arguments: { options: { second: 2, first: 1 }, path: 'a' } },
      'owner',
    );
    assert.equal(f.count, 1);
    await f.host.request(
      {
        action: 'deliver',
        sessionId: 'bot',
        id: 'd',
        source: 'remote',
        content: { type: 'discovery', content: 'finding' },
      },
      'owner',
    );
    assert.equal((f.delivered[0] as any).type, 'discovery');
  } finally {
    await f.close();
  }
});

test('large results and batched feedback remain transportable without repeating work', async () => {
  const f = await fixture();
  try {
    let effects = 0;
    f.deps.execute = async () => {
      effects++;
      return { text: 'x'.repeat(3 * 1024 * 1024) };
    };
    const call = {
      action: 'call' as const,
      contextId: f.c.id,
      origin: { hostId: 'main', sessionId: 'bot' },
      callId: 'large',
      tool: 'Read',
      arguments: { path: 'large' },
    };
    const receipt = (await f.host.request(call, 'owner')) as any;
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.resultUnavailable.code, 'result_too_large');
    await f.host.request(call, 'owner');
    assert.equal(effects, 1);
    for (let i = 0; i < 5; i++)
      f.host.feedback('remote-session', {
        id: `big-${i}`,
        type: 'system_event',
        source: 'test',
        content: 'x'.repeat(800_000),
      });
    let count = 0;
    for (;;) {
      const events = (await f.host.request(
        { action: 'events', originHost: 'main' },
        'owner',
      )) as any[];
      if (!events.length) break;
      assert.ok(Buffer.byteLength(JSON.stringify({ value: events })) < 2 * 1024 * 1024);
      count += events.length;
      await f.host.request({ action: 'ack', ids: events.map((e) => e.id) }, 'owner');
    }
    assert.equal(count, 5);
  } finally {
    await f.close();
  }
});
