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
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageCache } from '../src/message-cache.js';

// Local-format fixture, deliberately independent of MessageCache.hash/encode/decode.
const savedKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64url');
function localCursor(scope: any, shape: any, highWater: number, offset: number) {
  const hash = createHash('sha256').update(JSON.stringify({ scope, shape })).digest('hex');
  const state = { hash, highWater, offset };
  const encoded = Buffer.from(JSON.stringify(state)).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(savedKey, 'base64url'))
    .update(encoded)
    .digest('hex');
  return { state, cursor: encoded + '.' + signature };
}
const caller = () => ({ invocation: {} });
const raw = (id: string, chat = 'allowed', text = 'common original') => ({
  message_id: id,
  chat_id: chat,
  create_time: '2000',
  msg_type: 'text',
  body: { content: text },
});

for (const bounds of [{}, { startTime: 1, endTime: 10 }]) {
  test(`independent local cursor interoperates before/after restart with frozen publication and scoped reads: ${JSON.stringify(bounds)}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'feishu-cursor-alignment-'));
    const config = {
      accountId: 'user',
      appId: 'app',
      instanceId: 'test',
      containers: [{ type: 'chat', id: 'allowed' }],
      ...bounds,
    };
    const scope = {
      accountId: 'user',
      appId: 'app',
      instanceId: 'test',
      mode: 'local-originals',
      startTime: 'startTime' in bounds ? bounds.startTime : 0,
      endTime: 'endTime' in bounds ? bounds.endTime : null,
    };
    let cache = new MessageCache(root, config, savedKey);
    t.after(() => {
      cache.close();
      rmSync(root, { recursive: true, force: true });
    });
    const initial = cache.begin(1, 10);
    cache.page(initial, [raw('a'), raw('b'), raw('c'), raw('x', 'other')]);
    cache.publish(initial);
    const highWater = cache.boundary();
    const shape = { limit: 1, text: 'common' };
    const local = localCursor(scope, shape, highWater, 1);
    let source = cache.source('test', async () => {});
    assert.deepEqual(
      source.scope.containers,
      config.containers,
      'source scope still includes chats',
    );
    const first = await source.query({ ...shape, cursor: local.cursor }, caller());
    assert.deepEqual(
      first.items.map((o) => o.id),
      ['b'],
    );
    assert.equal(
      first.next,
      localCursor(scope, shape, highWater, 2).cursor,
      'emitted signature and fingerprint match the independent local encoder',
    );
    const b = first.items[0];
    const update = cache.begin(1, 10, true);
    cache.page(update, [raw('aa'), raw('b', 'allowed', 'common updated')]);
    cache.publish(update);
    assert.ok(cache.boundary() > highWater);
    const frozen = await source.query({ ...shape, cursor: local.cursor }, caller());
    assert.equal(frozen.items[0].id, 'b', 'new earlier row cannot shift the frozen offset');
    assert.equal(
      frozen.items[0].revision,
      b.revision,
      'new version cannot replace the frozen version',
    );
    cache.close();
    cache = new MessageCache(root, config, savedKey);
    source = cache.source('test', async () => {});
    const resumed = await source.query({ ...shape, cursor: first.next }, caller());
    assert.deepEqual(
      resumed.items.map((o) => o.id),
      ['c'],
    );
    assert.equal(resumed.next, undefined);
    assert.equal(((await source.read(b, caller())) as any).content.body.content, 'common original');
    assert.equal(
      (await source.query({ ...shape, cursor: local.cursor }, caller())).next,
      first.next,
    );
    const tampered = local.cursor.slice(0, -1) + (local.cursor.endsWith('0') ? '1' : '0');
    await assert.rejects(
      source.query({ ...shape, cursor: tampered }, caller()),
      /Invalid source cursor/,
    );
    await assert.rejects(
      source.query({ ...shape, text: 'changed', cursor: local.cursor }, caller()),
      /scope or query changed/,
    );
    const changed = new MessageCache(
      root,
      { ...config, containers: [{ type: 'chat', id: 'other' }] },
      savedKey,
    );
    try {
      const restricted = changed.source('test', async () => {});
      assert.notDeepEqual(
        restricted.scope,
        source.scope,
        'scan scope changes even though cursor fingerprint excludes chats',
      );
      assert.deepEqual(
        (await restricted.query(shape, caller())).items.map((o) => o.id),
        ['x'],
      );
      assert.deepEqual(await restricted.authorize([b], caller()), []);
      assert.equal((await restricted.read(b, caller())).status, 'unavailable');
      assert.deepEqual(
        (await restricted.query({ ...shape, cursor: local.cursor }, caller())).items,
        [],
        'current chat filtering applies even to a correctly signed old cursor',
      );
    } finally {
      changed.close();
    }
  });
}

test('invalid stored signing key fails without regenerating or replacing it', async (t) => {
  const { default: plugin } = await import('../src/host.js');
  const root = mkdtempSync(join(tmpdir(), 'feishu-invalid-key-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const length of [0, 31, 33]) {
    assert.throws(
      () => new MessageCache(root, {}, Buffer.alloc(length).toString('base64url')),
      /decode to 32 bytes/,
    );
  }
  for (const length of [0, 31, 33]) {
    const storedKey = Buffer.alloc(length).toString('base64url');
    const values = new Map([
      ['message-cache-directory', root],
      ['cursor-signing-key', storedKey],
    ]);
    await assert.rejects(
      plugin.host.apply(
        {
          maka: { rootId: 'profile' },
          storage: {
            get: async (name: string) => ({ value: values.get(name) }),
            set: async () => assert.fail('must not replace the existing key'),
          },
        },
        { instanceId: 'test', accountId: 'user', appId: 'app', cliPath: '/bin/false' },
      ),
      /decode to 32 bytes/,
    );
    assert.equal(values.get('cursor-signing-key'), storedKey);
  }
});
