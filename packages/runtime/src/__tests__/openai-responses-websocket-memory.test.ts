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
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const CHILD_SOURCE = String.raw`
  import assert from 'node:assert/strict';
  import { createHash, randomUUID } from 'node:crypto';
  import { once } from 'node:events';
  import { createServer } from 'node:http';
  import { createRequire } from 'node:module';
  import { setImmediate as tick } from 'node:timers/promises';
  import { getHeapSnapshot } from 'node:v8';
  const { WebSocketServer } = createRequire(process.argv[1])('ws');
  const { createOpenAiResponsesTransportState, OPENAI_RESPONSES_LANE_HEADER } =
    await import(process.argv[1]);
  const markers = Object.fromEntries(['initial', 'output', 'delta'].map(label =>
    [label, 'wire-memory-' + label + '-' + randomUUID() + ':']));
  function item(label) {
    return { type: 'message', role: label === 'output' ? 'assistant' : 'user', content: [{
      type: label === 'output' ? 'output_text' : 'input_text',
      text: markers[label] + 'x'.repeat(128 * 1024),
    }] };
  }
  const hash = value => createHash('sha256').update(value).digest('hex');
  async function counts() {
    for (let i = 0; i < 6; i++) { await tick(); global.gc(); }
    const chunks = [];
    for await (const chunk of getHeapSnapshot()) chunks.push(chunk);
    const heap = JSON.parse(Buffer.concat(chunks).toString());
    const fields = heap.snapshot.meta.node_fields;
    const types = heap.snapshot.meta.node_types[fields.indexOf('type')];
    const result = { initial: 0, output: 0, delta: 0 };
    for (let i = 0; i < heap.nodes.length; i += fields.length) {
      if (types[heap.nodes[i + fields.indexOf('type')]] !== 'string') continue;
      const name = heap.strings[heap.nodes[i + fields.indexOf('name')]];
      for (const [label, marker] of Object.entries(markers)) {
        // Snapshot names may be truncated; the unique prefix identifies each full payload.
        if (name.startsWith(marker) && name.length > marker.length) result[label]++;
      }
    }
    return result;
  }
  const server = createServer();
  const sockets = new Set();
  const ws = new WebSocketServer({ server });
  const frames = [];
  let observed;
  ws.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', data => {
      // Keep only hashes so the server cannot become a second owner of request payloads.
      frames.push(hash(data));
      if (frames.length === 1) complete(socket, 'first', [item('output')]);
      observed?.();
    });
  });
  function complete(socket, id, output) {
    socket.send(JSON.stringify({ type: 'response.completed', response: { id, output } }));
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port + '/v1/responses';
  const state = createOpenAiResponsesTransportState();
  const wrapped = state.wrapFetch(async () => assert.fail('unexpected HTTP fallback'));
  function request(continuation) {
    return wrapped(url, { method: 'POST', headers: { [OPENAI_RESPONSES_LANE_HEADER]: 'memory' },
      body: JSON.stringify({ model: 'fixture', stream: true,
        input: [item(continuation ? 'delta' : 'initial')],
        ...(continuation ? { previous_response_id: 'first' } : {}),
      }),
    });
  }
  function expectedFrame(continuation) {
    return hash(JSON.stringify({ type: 'response.create', model: 'fixture',
      input: [item(continuation ? 'delta' : 'initial')],
      ...(continuation ? { previous_response_id: 'first' } : {}),
    }));
  }
  let pending;
  try {
    await (await request(false)).text();
    assert.deepEqual(frames, [expectedFrame(false)]);
    // Positive controls prove the snapshot sees both necessary baseline payloads.
    assert.deepEqual(await counts(), { initial: 1, output: 1, delta: 0 }, 'baseline witnesses');
    const received = new Promise(resolve => { observed = resolve; });
    pending = request(true).then(response => response.text());
    // Attach a handler now so cleanup cannot cause an unhandled rejection on assertion failure.
    pending.catch(() => {});
    await received;
    observed = undefined;
    assert.deepEqual(frames, [expectedFrame(false), expectedFrame(true)]);
    assert.deepEqual(await counts(), { initial: 1, output: 1, delta: 1 },
      'pending continuation must not duplicate privately owned history');
    for (const socket of sockets) complete(socket, 'second', []);
    await pending;
    pending = undefined;
    assert.deepEqual(await counts(), { initial: 1, output: 1, delta: 1 },
      'completed continuation preserves all required history');
    state.endLane('memory');
    assert.deepEqual(await counts(), { initial: 0, output: 0, delta: 0 },
      'ending the lane releases history');
  } finally {
    state.close();
    for (const socket of sockets) socket.terminate();
    await pending?.catch(() => {});
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
  assert.equal(sockets.size, 0);
`;

test('pending Responses continuation shares private history and releases it at lane end', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '--eval',
      CHILD_SOURCE,
      new URL('../openai-responses-websocket.js', import.meta.url).href,
    ],
    { encoding: 'utf8', timeout: 45_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
