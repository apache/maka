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
import {
  readRuntimeHostPeerAuthentication,
  RuntimeHostPeerError,
  type RuntimeHostPeerNativeStream,
} from '../transport/peer-native.js';

test('bounds and separates the peer credential preface from Runtime Host frames', async () => {
  const frame = Buffer.from('{"kind":"hello"}\n');
  const authenticated = await readRuntimeHostPeerAuthentication(
    streamWith(Buffer.concat([Buffer.from('{"v":1,"credential":"token"}\n'), frame])),
  );
  assert.equal(authenticated.credential, 'token');
  assert.deepEqual(authenticated.remainder, frame);

  await assert.rejects(
    readRuntimeHostPeerAuthentication(
      streamWith(Buffer.concat([Buffer.alloc(12 * 1024 + 1), Buffer.from('\n')])),
    ),
    (error: unknown) =>
      error instanceof RuntimeHostPeerError && /preface is too large/u.test(error.message),
  );
});

function streamWith(chunk: Buffer): RuntimeHostPeerNativeStream {
  let pending: Buffer | null = chunk;
  return {
    peerId: 'peer',
    read: async () => {
      const value = pending;
      pending = null;
      return value;
    },
    write: async () => undefined,
    close: async () => undefined,
    abort: () => undefined,
  };
}
