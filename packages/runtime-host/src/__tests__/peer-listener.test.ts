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
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { createRuntimeHostPeerListener } from '../server/peer-listener.js';
import type {
  RuntimeHostPeerNativeEndpoint,
  RuntimeHostPeerNativeStream,
} from '../transport/peer-native.js';

test('bounds and aborts pending peer authentication', async () => {
  const streams = Array.from({ length: 17 }, () => pendingStream());
  const listener = createRuntimeHostPeerListener(endpointWith([...streams]), {} as never, () => {});
  await waitForImmediate();

  assert.equal(streams.filter((stream) => stream.aborted).length, 1);
  await listener.closeAdmission();
  assert.equal(
    streams.every((stream) => stream.aborted),
    true,
  );
  await listener.cleanup();
});

test('expires a peer that does not send its credential', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = pendingStream();
  const listener = createRuntimeHostPeerListener(endpointWith([stream]), {} as never, () => {});
  await waitForImmediate();

  context.mock.timers.tick(5_000);
  await waitForImmediate();
  assert.equal(stream.aborted, true);
  await listener.cleanup();
});

test('reports an explicit authentication rejection before closing the stream', async () => {
  const stream = recordingStream(Buffer.from('{"v":1,"credential":"rejected"}\n'));
  const listener = createRuntimeHostPeerListener(
    endpointWith([stream]),
    { authenticate: () => null } as never,
    () => {},
  );
  await waitForImmediate();
  await waitForImmediate();

  assert.deepEqual(stream.writes, [Buffer.from('{"v":1,"accepted":false}\n')]);
  assert.equal(stream.closed, true);
  await listener.cleanup();
});

test('rechecks peer authority at admission after the authentication response is written', async () => {
  let releaseWrite!: () => void;
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let aborted = false;
  let reads = 0;
  const stream: RuntimeHostPeerNativeStream = {
    read: async () => (reads++ === 0 ? Buffer.from('{"v":1,"credential":"revoked"}\n') : null),
    write: async () => writeReleased,
    close: async () => undefined,
    abort: () => {
      aborted = true;
    },
  };
  let authentications = 0;
  let accepted = false;
  const listener = createRuntimeHostPeerListener(
    endpointWith([stream]),
    {
      authenticate: () => (authentications++ === 0 ? { operationGrants: 'all' } : null),
    } as never,
    () => {
      accepted = true;
    },
  );
  await waitForImmediate();

  releaseWrite();
  await waitForImmediate();
  await waitForImmediate();

  assert.equal(authentications, 2);
  assert.equal(accepted, false);
  assert.equal(aborted, true);
  await listener.cleanup();
});

function endpointWith(streams: RuntimeHostPeerNativeStream[]): RuntimeHostPeerNativeEndpoint {
  return {
    peerId: 'peer',
    listenAddresses: [],
    connect: async () => {
      throw new Error('not used');
    },
    accept: async () => streams.shift() ?? null,
    close: async () => undefined,
  };
}

function pendingStream(): RuntimeHostPeerNativeStream & { readonly aborted: boolean } {
  let finish!: (value: null) => void;
  const read = new Promise<null>((resolve) => {
    finish = resolve;
  });
  let aborted = false;
  return {
    get aborted() {
      return aborted;
    },
    read: () => read,
    write: async () => undefined,
    close: async () => undefined,
    abort: () => {
      aborted = true;
      finish(null);
    },
  };
}

function recordingStream(initial: Buffer): RuntimeHostPeerNativeStream & {
  readonly writes: readonly Buffer[];
  readonly closed: boolean;
} {
  let pending: Buffer | null = initial;
  let closed = false;
  const writes: Buffer[] = [];
  return {
    get writes() {
      return writes;
    },
    get closed() {
      return closed;
    },
    read: async () => {
      const value = pending;
      pending = null;
      return value;
    },
    write: async (bytes) => {
      writes.push(Buffer.from(bytes));
    },
    close: async () => {
      closed = true;
    },
    abort: () => undefined,
  };
}
