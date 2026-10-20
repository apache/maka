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
import { remoteStream } from '../client-plugin-remote-stream.js';
import type { MakaClientRemoteRequest, MakaClientRemoteTransport } from '../client-plugin-runtime.js';

const request: MakaClientRemoteRequest = {
  authorityEpoch: 1, revision: 'revision', entryId: 'entry', extensionId: 'fixture',
  generation: 1, contentDigest: 'content', clientDigest: 'client', method: 'watch', input: {},
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<MakaClientRemoteTransport> = {}) {
  const closed: string[] = [];
  const pulling = deferred<void>();
  const transport: MakaClientRemoteTransport = {
    call: async () => ({ value: null }), open: async () => ({ streamId: 'stream' }),
    next: () => { pulling.resolve(); return new Promise(() => {}); },
    close: async ({ streamId }) => { closed.push(streamId); }, ...overrides,
  };
  return { transport, closed, pulling };
}

test('return interrupts a pending pull without another producer event', { timeout: 1000 }, async () => {
  const { transport, closed, pulling } = fixture();
  const iterator = remoteStream(transport, request, [])[Symbol.asyncIterator]();
  const next = iterator.next();
  await pulling.promise;
  assert.equal((await iterator.return!()).done, true);
  assert.equal((await next).done, true);
  await iterator.return!();
  assert.deepEqual(closed, ['stream']);
});

test('abort rejects a pending pull and closes exactly once', { timeout: 1000 }, async () => {
  const { transport, closed, pulling } = fixture();
  const abort = new AbortController();
  const iterator = remoteStream(transport, request, [abort.signal])[Symbol.asyncIterator]();
  const next = iterator.next();
  const rejected = assert.rejects(next, { name: 'AbortError' });
  await pulling.promise;
  abort.abort();
  await rejected;
  await iterator.return!();
  assert.deepEqual(closed, ['stream']);
});

test('abort during open returns promptly and closes the late remote handle', { timeout: 1000 }, async () => {
  const opening = deferred<{ streamId: string }>();
  const { transport, closed } = fixture({ open: () => opening.promise });
  const abort = new AbortController();
  const iterator = remoteStream(transport, request, [abort.signal])[Symbol.asyncIterator]();
  const next = iterator.next();
  const rejected = assert.rejects(next, { name: 'AbortError' });
  abort.abort();
  await rejected;
  opening.resolve({ streamId: 'late' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(closed, ['late']);
});

test('pre-aborted streams never open, and late transport errors are consumed', async () => {
  const abort = new AbortController(); abort.abort();
  let opens = 0;
  const { transport } = fixture({ open: async () => { opens++; return { streamId: 'unexpected' }; } });
  await assert.rejects(remoteStream(transport, request, [abort.signal])[Symbol.asyncIterator]().next(), { name: 'AbortError' });
  assert.equal(opens, 0);
  const pull = deferred<{ done: true }>();
  const started = deferred<void>();
  const second = fixture({ next: () => { started.resolve(); return pull.promise; } });
  const iterator = remoteStream(second.transport, request, [])[Symbol.asyncIterator]();
  const pending = iterator.next(); await started.promise;
  await iterator.return!(); await pending;
  pull.reject(new Error('late disconnect'));
  await new Promise(resolve => setImmediate(resolve));
});

test('finite streams return their values and close on normal exhaustion', async () => {
  let n = 0;
  const { transport, closed } = fixture({ next: async () => ++n < 3 ? { done: false, value: n } : { done: true } });
  const result = [];
  for await (const value of remoteStream(transport, request, [])) result.push(value);
  assert.deepEqual(result, [1, 2]);
  assert.deepEqual(closed, ['stream']);
});
