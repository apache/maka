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
import { createRuntimeHostPeerClient } from '../client/peer-client.js';
import {
  ensureRuntimeHostPeerIdentity,
  readRuntimeHostPeerAuthentication,
  readRuntimeHostPeerAuthenticationResult,
  RuntimeHostPeerError,
  startRuntimeHostPeerEndpoint,
  type RuntimeHostPeerNativeStream,
} from '../transport/peer-native.js';

test('shares one peer endpoint while cancelling connection attempts independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-peer-abort-'));
  const nativePath = join(directory, 'peer.cjs');
  try {
    await writeFile(
      nativePath,
      `let finishAccept;
let finishMeshAccept;
const pending = new Map();
const stats = { starts: 0, closes: 0, requests: [], cancellations: [] };
let missFirstCancellation = true;
const stream = { read: async () => null, write: async () => {}, close: async () => {}, abort: () => {} };
module.exports = {
  stats,
  failEndpoint: () => { finishAccept?.(null); finishMeshAccept?.(null); },
  ensurePeerIdentity: async () => 'client',
  startPeerEndpoint: () => {
    stats.starts += 1;
    return {
      peerId: 'client',
      listenAddresses: [],
      connect: ({ requestId, peerId }) => {
        stats.requests.push(requestId);
        if (peerId === 'ready') return Promise.resolve(stream);
        return new Promise((_resolve, reject) => pending.set(requestId, reject));
      },
      connectMeshControl: ({ requestId, peerId }) => {
        stats.requests.push(requestId);
        if (peerId === 'ready') return Promise.resolve(stream);
        return new Promise((_resolve, reject) => pending.set(requestId, reject));
      },
      cancelConnect: async (requestId) => {
        stats.cancellations.push(requestId);
        if (missFirstCancellation) {
          missFirstCancellation = false;
          return false;
        }
        pending.get(requestId)?.(new Error('peer_connect_cancelled: cancelled'));
        pending.delete(requestId);
        return true;
      },
      accept: () => new Promise((resolve) => { finishAccept = resolve; }),
      acceptMeshControl: () => new Promise((resolve) => { finishMeshAccept = resolve; }),
      close: async () => { stats.closes += 1; finishAccept?.(null); finishMeshAccept?.(null); },
    };
  },
};
`,
    );
    const client = createRuntimeHostPeerClient({
      nativePath,
      keyPath: join(directory, 'peer.key'),
    });
    const abort = new AbortController();
    const pending = client.connect(peerConnectInput('pending'), abort.signal);
    abort.abort();
    await assert.rejects(pending, /aborted/u);

    await client.connect(peerConnectInput('ready'));
    const native = await import(nativePath);
    assert.deepEqual(native.default.stats, {
      starts: 1,
      closes: 0,
      requests: [1, 2],
      cancellations: [1, 1],
    });

    native.default.failEndpoint();
    await waitForImmediate();
    await assert.rejects(
      client.connect(peerConnectInput('ready')),
      /cannot recover until this Client restarts/u,
    );
    assert.equal(native.default.stats.starts, 1);

    await client.close();
    assert.equal(native.default.stats.closes, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects an incomplete endpoint API and loads a compatible relative native module', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-peer-native-'));
  try {
    const incompletePath = join(directory, 'incomplete.cjs');
    await writeFile(
      incompletePath,
      'module.exports = { ensurePeerIdentity: async () => "peer", startPeerEndpoint: () => ({ peerId: "peer", listenAddresses: [] }) };\n',
    );
    assert.throws(
      () =>
        startRuntimeHostPeerEndpoint({
          nativePath: relative(process.cwd(), incompletePath),
          keyPath: 'unused',
        }),
      (error: unknown) =>
        error instanceof RuntimeHostPeerError && error.code === 'peer_native_unavailable',
    );

    const modulePath = join(directory, 'peer.cjs');
    await writeFile(
      modulePath,
      `const stream = { read: async () => null, write: async () => {}, close: async () => {}, abort: () => {} };
module.exports = {
  ensurePeerIdentity: async () => 'peer',
  startPeerEndpoint: () => ({
    peerId: 'peer',
    listenAddresses: [],
    connect: async () => stream,
    connectMeshControl: async () => stream,
    cancelConnect: async () => true,
    accept: async () => null,
    acceptMeshControl: async () => null,
    close: async () => {},
  }),
};
`,
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
    peerId: 'remote-peer',
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

function peerConnectInput(peerId: string) {
  return {
    peerId,
    routeHints: ['/memory/1'],
    coordinationRelays: [],
    directDeadlineMs: 1_000,
  } as const;
}
