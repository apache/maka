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

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import { createServer, Socket, type Server } from 'node:net';
import { test } from 'node:test';
import {
  encodeProtocolMessage,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '../protocol/index.js';
import { FramedTransport, RuntimeHostTransportError } from '../transport/framed-transport.js';
import { frameLocalIpcProtocolMessage } from '../transport/local-ipc-framing.js';

test('drains clean half-open input before reporting typed read EOF', async () => {
  await withSocketPair(async (transport, peer) => {
    const ended = endSocket(peer, Buffer.from(`${JSON.stringify({ accepted: true })}\n`));
    assert.deepEqual(await transport.read(1_000), { accepted: true });
    await assert.rejects(
      transport.read(1_000),
      (error: unknown) => error instanceof RuntimeHostTransportError && error.code === 'read_eof',
    );

    const reply = encodeProtocolMessage({
      kind: 'draining',
      hostEpoch: 'host-1',
      compositionId: 'maka.interactive',
      compositionRevision: '1',
    });
    const received = readSocket(peer, reply.byteLength + 1);
    await transport.write(reply);
    assert.deepEqual(await received, Buffer.concat([reply, Buffer.from('\n')]));
    await ended;

    const failure = new Error('forced transport failure');
    transport.abort(failure);
    await transport.closed;
    await assert.rejects(transport.read(0), (error: unknown) => error === failure);
  });
});

test('normalizes a native socket failure as a typed transport interruption', async () => {
  await withSocketPair(async (transport) => {
    const failure = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    const pending = transport.read(1_000);
    transport.socket.destroy(failure);
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof RuntimeHostTransportError &&
        error.code === 'closed' &&
        error.cause === failure,
    );
    await transport.closed;
  });
});

test('drains a paused frame burst before reporting a terminal partial frame', async () => {
  await withSocketPair(async (transport, peer) => {
    const frames = Array.from({ length: 96 }, (_, index) => ({ index }));
    const ended = endSocket(
      peer,
      Buffer.from(`${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n{"partial":`),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    for (const expected of frames) {
      assert.deepEqual(await transport.read(2_000), expected);
    }
    await assert.rejects(
      transport.read(2_000),
      (error: unknown) =>
        error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame',
    );
    await ended;
    await transport.closed;
  });
});

test('applies byte backpressure without dropping large valid frames', async () => {
  await withSocketPair(async (transport, peer) => {
    const payload = 'x'.repeat(60 * 1024);
    const frames = Array.from({ length: 40 }, (_, index) => ({ index, payload }));
    const sent = writeSocket(
      peer,
      Buffer.from(`${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    for (const expected of frames) {
      assert.deepEqual(await transport.read(5_000), expected);
    }
    await sent;
    await writeSocket(peer, Buffer.from(`${JSON.stringify({ resumed: true })}\n`));
    assert.deepEqual(await transport.read(2_000), { resumed: true });
  });
});

test('fails closed on an oversized unterminated frame over a real socket', async () => {
  await withSocketPair(async (transport, peer) => {
    const read = transport.read(1_000);
    peer.write(Buffer.alloc(RUNTIME_HOST_MAX_MESSAGE_BYTES + 1, 0x61));
    await assert.rejects(
      read,
      (error: unknown) =>
        error instanceof RuntimeHostProtocolError && error.code === 'frame_too_large',
    );
    await transport.closed;
  });
});

test('decodes split UTF-8 and coalesced Local IPC frames', async () => {
  await withSocketPair(async (transport, peer) => {
    const hello = {
      kind: 'hello' as const,
      clientInstanceId: '客户端',
      protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
      protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
      compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
      compositionId: 'maka.interactive',
    };
    const status = { requestId: 'status-1', operation: 'host.status', input: {} } as const;
    const wire = Buffer.concat([
      frameLocalIpcProtocolMessage(encodeProtocolMessage(hello)),
      frameLocalIpcProtocolMessage(encodeProtocolMessage(status)),
    ]);
    const split = wire.indexOf(Buffer.from('端')) + 1;

    peer.write(wire.subarray(0, split));
    await new Promise<void>((resolve) => setImmediate(resolve));
    peer.write(wire.subarray(split));

    assert.deepEqual(await transport.read(1_000), hello);
    assert.deepEqual(await transport.read(1_000), status);
  });
});

async function withSocketPair(
  run: (transport: FramedTransport, peer: Socket) => Promise<void>,
): Promise<void> {
  const accepted = deferred<Socket>();
  const server = createServer(accepted.resolve);
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const socket = new Socket({ allowHalfOpen: true });
  socket.connect(address.port, '127.0.0.1');
  await onceConnected(socket);
  const peer = await accepted.promise;
  const transport = new FramedTransport(socket);
  try {
    await run(transport, peer);
  } finally {
    transport.abort();
    peer.destroy();
    await transport.closed;
    await closeServer(server);
  }
}

function readSocket(socket: Socket, expectedBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      receivedBytes += chunk.byteLength;
      if (receivedBytes < expectedBytes) return;
      cleanup();
      resolve(Buffer.concat(chunks, receivedBytes));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

function writeSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(bytes, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function endSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    socket.once('error', onError);
    socket.end(bytes, () => {
      socket.off('error', onError);
      resolve();
    });
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function onceConnected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
