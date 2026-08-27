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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { connectPeerRuntimeHost } from '../client/host-profile.js';
import {
  ensureRuntimeHostPeerIdentity,
  readRuntimeHostPeerAuthentication,
  readRuntimeHostPeerAuthenticationResult,
  RuntimeHostPeerError,
  startRuntimeHostPeerEndpoint,
  type RuntimeHostPeerNativeStream,
} from '../transport/peer-native.js';

test('closes an in-flight peer endpoint when connection is cancelled', {
  timeout: 2_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-peer-abort-'));
  const nativePath = join(directory, 'peer.cjs');
  const previousNativePath = process.env.MAKA_RUNTIME_HOST_PEER_NATIVE_PATH;
  const previousKeyPath = process.env.MAKA_RUNTIME_HOST_PEER_KEY_PATH;
  try {
    await writeFile(
      nativePath,
      `let rejectConnect;
module.exports = {
  ensurePeerIdentity: async () => 'client',
  startPeerEndpoint: () => ({
    peerId: 'client',
    listenAddresses: [],
    connect: () => new Promise((_resolve, reject) => { rejectConnect = reject; }),
    close: async () => rejectConnect?.(new Error('closed by abort')),
  }),
};
`,
    );
    process.env.MAKA_RUNTIME_HOST_PEER_NATIVE_PATH = nativePath;
    process.env.MAKA_RUNTIME_HOST_PEER_KEY_PATH = join(directory, 'peer.key');
    const abort = new AbortController();
    const connection = connectPeerRuntimeHost({
      profileId: 'peer-test',
      transport: {
        kind: 'libp2p-direct',
        peerId: 'target',
        routeHints: ['/memory/1'],
        coordinationRelays: [],
      },
      credential: 'credential',
      expectedRootId: '00000000-0000-4000-8000-000000000001',
      clientInstanceId: 'client-test',
      signal: abort.signal,
      connectTimeoutMs: 120_000,
    });
    await waitForImmediate();
    abort.abort();
    await assert.rejects(connection, /closed by abort/u);
  } finally {
    restoreEnvironment('MAKA_RUNTIME_HOST_PEER_NATIVE_PATH', previousNativePath);
    restoreEnvironment('MAKA_RUNTIME_HOST_PEER_KEY_PATH', previousKeyPath);
    await rm(directory, { recursive: true, force: true });
  }
});

test('loads a relative native module path from the process working directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-peer-native-'));
  try {
    const modulePath = join(directory, 'peer.cjs');
    await writeFile(
      modulePath,
      'module.exports = { ensurePeerIdentity: async () => "peer", startPeerEndpoint: () => ({ peerId: "peer", listenAddresses: [] }) };\n',
    );
    const endpoint = startRuntimeHostPeerEndpoint({
      nativePath: relative(process.cwd(), modulePath),
      keyPath: 'unused',
    });
    assert.equal(endpoint.peerId, 'peer');
    assert.equal(
      await ensureRuntimeHostPeerIdentity({ nativePath: modulePath, keyPath: 'unused' }),
      'peer',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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

  const result = await readRuntimeHostPeerAuthenticationResult(
    streamWith(Buffer.concat([Buffer.from('{"v":1,"accepted":true}\n'), frame])),
  );
  assert.equal(result.accepted, true);
  assert.deepEqual(result.remainder, frame);
});

function streamWith(chunk: Buffer): RuntimeHostPeerNativeStream {
  let pending: Buffer | null = chunk;
  return {
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
