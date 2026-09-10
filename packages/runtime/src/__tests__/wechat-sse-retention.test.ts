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
import { readSseJsonObjects } from '../bots/wechat-bridge.js';

const CHILD_SOURCE = String.raw`
  import assert from 'node:assert/strict';
  import { once } from 'node:events';
  import { createServer } from 'node:http';
  const { WechatBridge, readSseJsonObjects } = await import(process.argv[1]);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const refs = new Map();
  function track(label, object) {
    if (!refs.has(label)) refs.set(label, []);
    refs.get(label).push(new WeakRef(object));
    return object;
  }
  async function collected(labels) {
    for (let i = 0; i < 8; i++) { await tick(); global.gc(); }
    for (const label of labels) {
      assert(refs.get(label)?.length, 'missing witness: ' + label);
      assert.equal(refs.get(label).filter(ref => ref.deref()).length, 0, label);
    }
    await tick();
  }
  if (process.argv[2] === 'parser') {
    let release;
    let first = track('chunk', Buffer.from('data: ' + JSON.stringify({
      text: 'x'.repeat(1024 * 1024)
    }) + '\n\n'));
    let reads = 0;
    const body = { [Symbol.asyncIterator]() { return this; }, next() {
      reads++;
      if (first) { const value = first; first = null; return Promise.resolve({ value, done: false }); }
      return new Promise(resolve => { release = resolve; });
    }};
    const stream = readSseJsonObjects(body);
    await (async () => { track('raw', (await stream.next()).value); })();
    const pending = stream.next();
    await tick();
    assert.equal(reads, 2);
    try { await collected(['chunk', 'raw']); }
    finally { release({ done: true }); await pending; }
  } else {
    let response;
    const requests = [];
    const server = createServer((req, res) => {
      requests.push(req.url);
      response = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const bridge = new WechatBridge({ enabled: true, token: '', allowedUserIds: [],
      webhookUrl: 'http://127.0.0.1:' + server.address().port });
    bridge.running = true;
    let emitted = 0;
    bridge.on('message', event => {
      emitted++; track('mapped', event);
      if (process.argv[2] === 'bridge-failure') throw new Error('listener failure');
    });
    const parse = JSON.parse;
    JSON.parse = function(text, ...args) {
      const value = parse(text, ...args);
      if (Array.isArray(value) && value[0]?.retentionProbe) {
        track('array', value);
        for (const item of value) track('raw', item);
      } else if (value?.retentionProbe) track('raw', value);
      return value;
    };
    const running = bridge.streamLiveMessages(10);
    try {
      while (!response) await tick();
      const send = (ids, array) => response.write('data: ' + JSON.stringify(
        array ? ids.map(makeMessage) : makeMessage(ids[0])) + '\n\n');
      function makeMessage(id) { return { retentionProbe: true, id: String(id),
        chatId: 'chat', senderId: 'user', timestamp: id, text: 'x'.repeat(1024 * 1024) }; }
      send([20], false);
      while (emitted < 1) await tick();
      if (process.argv[2] === 'bridge-failure') {
        while (requests.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
        assert.deepEqual(requests, ['/messages/stream?since=10', '/messages/stream?since=20']);
      } else {
      await collected(['raw', 'mapped']);
      send([30, 25], true);
      while (emitted < 3) await tick();
      // No heartbeat or following event is required to release the last payload.
      await collected(['array', 'raw', 'mapped']);
      response.end();
      while (requests.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
      assert.deepEqual(requests, ['/messages/stream?since=10', '/messages/stream?since=30']);
      }
      await bridge.stop();
      await running;
      assert.equal(bridge.getStatus().reason, 'stopped');
    } finally {
      JSON.parse = parse;
      await bridge.stop();
      await running;
      response?.end();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('collected');
`;

for (const mode of ['parser', 'bridge', 'bridge-failure']) {
  test(
    mode === 'bridge-failure'
      ? 'WeChat reconnects at the advanced cursor after a message listener fails'
      : `idle WeChat ${mode} releases the last payload while its stream is open`,
    () => {
      const result = spawnSync(
        process.execPath,
        [
          '--expose-gc',
          '--input-type=module',
          '--eval',
          CHILD_SOURCE,
          new URL('../bots/wechat-bridge.js', import.meta.url).href,
          mode,
        ],
        { encoding: 'utf8', timeout: 15_000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'collected');
    },
  );
}

function source(next: AsyncIterator<Uint8Array>['next'], failClose = false) {
  let closes = 0;
  return {
    get closes() {
      return closes;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    next,
    async return(): Promise<IteratorResult<Uint8Array>> {
      closes++;
      if (failClose) throw new Error('close failed');
      return { done: true, value: undefined };
    },
  };
}

test('SSE parser preserves partial UTF-8, CRLF, multiline data, arrays, and comment handling', async () => {
  const bytes = Buffer.from(
    ': comment\r\n\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\n' +
      'data: [{"id":1},null]\n\ndata: false\n\ndata: {"incomplete":',
  );
  for (const width of [1, 2, 3, bytes.length]) {
    let offset = 0;
    const body = source(async () =>
      offset >= bytes.length
        ? { done: true, value: undefined }
        : { done: false, value: bytes.subarray(offset, (offset += width)) },
    );
    const values = [];
    for await (const value of readSseJsonObjects(body)) values.push(value);
    assert.deepEqual(values, [{ text: '你好' }, [{ id: 1 }, null], false]);
    assert.equal(body.closes, 0, 'normal EOF does not call return');
  }
});

test('SSE return and consumer throw close once; a close failure is propagated on return', async () => {
  for (const failClose of [false, true]) {
    const body = source(
      async () => ({ value: Buffer.from('data: {}\n\n'), done: false }),
      failClose,
    );
    const stream = readSseJsonObjects(body);
    await stream.next();
    if (failClose) await assert.rejects(stream.return(undefined), /close failed/);
    else assert.deepEqual(await stream.return(undefined), { done: true, value: undefined });
    assert.equal(body.closes, 1);
    const throwingBody = source(
      async () => ({ value: Buffer.from('data: {}\n\n'), done: false }),
      failClose,
    );
    const throwing = readSseJsonObjects(throwingBody);
    await throwing.next();
    const error = new Error('consumer failed');
    await assert.rejects(throwing.throw(error), (value) => value === error);
    assert.equal(throwingBody.closes, 1);
  }
});

test('SSE malformed JSON closes once and preserves its error even if close fails', async () => {
  for (const failClose of [false, true]) {
    const body = source(
      async () => ({ value: Buffer.from('data: {broken}\n\n'), done: false }),
      failClose,
    );
    await assert.rejects(readSseJsonObjects(body).next(), SyntaxError);
    assert.equal(body.closes, 1);
  }
});

test('SSE read rejection and abort preserve their error without calling return', async () => {
  for (const name of ['Error', 'AbortError']) {
    const error = Object.assign(new Error('read failed'), { name });
    const body = source(async () => {
      throw error;
    });
    await assert.rejects(readSseJsonObjects(body).next(), (value) => value === error);
    assert.equal(body.closes, 0);
  }
});
