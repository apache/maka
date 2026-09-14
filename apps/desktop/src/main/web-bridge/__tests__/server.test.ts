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
import { test } from 'node:test';
import { WebBridgeRegistry } from '../registry.js';
import {
  authorizeUpgrade,
  createBridgeConnection,
} from '../server.js';
import type { BridgeResponse } from '../protocol.js';

const TOKEN = 'test-token';

test('authorizeUpgrade gates token, origin, and shape', () => {
  assert.deepEqual(authorizeUpgrade('/?token=test-token', 'http://localhost:5173', TOKEN), { ok: true });
  assert.deepEqual(authorizeUpgrade('/?token=test-token', 'http://127.0.0.1:5174', TOKEN), { ok: true });
  assert.deepEqual(authorizeUpgrade('/?token=wrong', 'http://localhost:5173', TOKEN), {
    ok: false,
    code: 401,
    message: 'Unauthorized',
  });
  assert.deepEqual(authorizeUpgrade('/', 'http://localhost:5173', TOKEN), {
    ok: false,
    code: 401,
    message: 'Unauthorized',
  });
  assert.deepEqual(authorizeUpgrade('/?token=test-token', 'https://evil.example', TOKEN), {
    ok: false,
    code: 403,
    message: 'Forbidden',
  });
  assert.deepEqual(authorizeUpgrade('/?token=test-token', undefined, TOKEN), {
    ok: false,
    code: 403,
    message: 'Forbidden',
  });
  // file:// and other non-http origins never pass.
  assert.deepEqual(authorizeUpgrade('/?token=test-token', 'null', TOKEN), {
    ok: false,
    code: 403,
    message: 'Forbidden',
  });
});

test('connection router dispatches invokes with a virtual sender', async () => {
  const registry = new WebBridgeRegistry();
  const delivered: BridgeResponse[] = [];
  let seenSenderId = 0;
  registry.handle('test:echo', (async (event: unknown, ...args: unknown[]) => {
    seenSenderId = (event as { sender: { id: number } }).sender.id;
    if (args[0] === 'fail') throw new Error('boom');
    return { echoed: args };
  }) as never);

  const connection = createBridgeConnection(registry, (frame) => delivered.push(frame));
  try {
    // Virtual sender ids never collide with real WebContents ids.
    assert.ok(connection.sender.id < 0);

    connection.handleMessage(JSON.stringify({ t: 'invoke', id: 1, channel: 'test:echo', args: ['a', 2] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(delivered, [{ t: 'result', id: 1, ok: true, value: { echoed: ['a', 2] } }]);
    assert.ok(seenSenderId < 0);

    connection.handleMessage(JSON.stringify({ t: 'invoke', id: 2, channel: 'test:echo', args: ['fail'] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match((delivered[1] as { error: string }).error, /boom/);

    connection.handleMessage(JSON.stringify({ t: 'invoke', id: 3, channel: 'test:nope', args: [] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match((delivered[2] as { error: string }).error, /no channel/);

    // Malformed frames are dropped without killing the connection.
    const before = delivered.length;
    connection.handleMessage('this is not json{{{');
    connection.handleMessage(JSON.stringify({ t: 'invoke', id: 4, channel: 'test:echo', args: [] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(delivered.length, before + 1);
    assert.equal((delivered[before] as { id: number }).id, 4);

    // Fire-and-forget notifies produce no frames.
    const quiet = delivered.length;
    connection.handleMessage(JSON.stringify({ t: 'notify', channel: 'browser:hide-active-session', args: [] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(delivered.length, quiet);
  } finally {
    connection.destroy();
  }
});

test('virtual sender delivery becomes connection event frames', () => {
  const registry = new WebBridgeRegistry();
  const delivered: BridgeResponse[] = [];
  const connection = createBridgeConnection(registry, (frame) => delivered.push(frame));
  try {
    connection.sender.send('sessions:changed', { reason: 'updated' });
    assert.deepEqual(delivered, [
      { t: 'event', channel: 'sessions:changed', args: [{ reason: 'updated' }] },
    ]);
    connection.destroy();
    connection.sender.send('sessions:changed', {});
    assert.equal(delivered.length, 1);
  } finally {
    connection.destroy();
  }
});
