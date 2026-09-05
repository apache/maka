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
import { duplexPair, type Duplex } from 'node:stream';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { connect, createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { createRuntimeHostPeerListener } from '../server/peer-listener.js';
import { RuntimeHostConnectionSession } from '../server/connection-session.js';
import { LOCAL_OWNER_CONNECTION_AUTHORITY } from '../server/connection-authority.js';
import {
  createUnavailableDomainOperationHandlers,
  createUnavailableHostCoreOperationHandlers,
} from '../server/operation-dispatcher.js';
import type { RuntimeHostPeerClient } from '../client/peer-client.js';
import { connectPeerRuntimeHost } from '../client/host-profile.js';
import type { RuntimeHostConnection } from '../client/connection.js';
import {
  decodeClientFrame,
  encodeProtocolMessage,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
} from '../protocol/index.js';
import {
  ResumablePeerStream,
  PeerResumeRejectedError,
} from '../transport/resumable-peer-stream.js';
import type { RuntimeHostPeerNativeStream } from '../transport/peer-native.js';

function wire(socket: Duplex, peerId: string, dropAck = false): RuntimeHostPeerNativeStream {
  const iterator = socket[Symbol.asyncIterator]();
  socket.on('error', () => {});
  return {
    peerId,
    path: { kind: 'direct', transport: 'tcp' },
    read: async () => {
      const next = await iterator.next();
      return next.done ? null : Buffer.from(next.value as Buffer);
    },
    write: async (bytes) => {
      if (dropAck && bytes[0] === 2) return;
      await new Promise<void>((resolve, reject) =>
        socket.write(bytes, (error) => (error ? reject(error) : resolve())),
      );
    },
    close: async () => {
      socket.destroy();
    },
    abort: () => {
      socket.destroy();
    },
  };
}

function attach(left: ResumablePeerStream, right: ResumablePeerStream, dropAck = false) {
  const [a, b] = duplexPair({ highWaterMark: 1024 });
  const state = left.nextAttachment();
  right.reserve(state);
  const received = right.received;
  right.attach(state.generation, {
    stream: wire(b, left.peerId, dropAck),
    remainder: Buffer.alloc(0),
    received: state.received,
  });
  left.attach(state.generation, {
    stream: wire(a, right.peerId),
    remainder: Buffer.alloc(0),
    received,
  });
  return () => {
    a.destroy();
    b.destroy();
  };
}

function sessions() {
  // Each test endpoint sees the same authenticated identity in its synthetic wire.
  const left = new ResumablePeerStream({ peerId: 'peer' });
  const right = new ResumablePeerStream({ peerId: 'peer', sessionId: left.sessionId });
  return { left, right };
}

function payload(size: number, seed: number): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++)
    bytes[i] = (Math.imul(i, 31) ^ (i >>> 8) ^ Math.imul(i >>> 16, 17) ^ seed) & 255;
  return bytes;
}

async function receive(stream: ResumablePeerStream, expected: Buffer) {
  let count = 0;
  while (count < expected.length) {
    const bytes = await stream.read();
    assert.ok(bytes);
    assert.deepEqual(bytes, expected.subarray(count, count + bytes.length));
    count += bytes.length;
  }
  assert.equal(count, expected.length);
}

test('seeded fragmented full-duplex faults retain byte order and release every raw path', {
  timeout: 180_000,
}, async (t) => {
  const seeds = Number(process.env.MAKA_PEER_STRESS_SEEDS ?? 8);
  assert.ok(Number.isSafeInteger(seeds) && seeds >= 1 && seeds <= 256);
  const latencies: number[] = [];
  let failures = 0;
  let livePaths = 0;
  let peakPaths = 0;
  const started = performance.now();
  const run = async (seed: number) => {
    let rng = seed;
    const random = (limit: number) => {
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      return rng % limit;
    };
    let right!: ResumablePeerStream;
    let cuts = 0;
    let attempts = 0;
    let failedAt = 0;
    const paths = new Set<Duplex>();
    const candidate = (state: ReturnType<ResumablePeerStream['nextAttachment']>) => {
      const [a, b] = duplexPair({ highWaterMark: 1024 });
      for (const socket of [a, b]) {
        paths.add(socket);
        livePaths++;
        peakPaths = Math.max(peakPaths, livePaths);
        socket.once('close', () => {
          paths.delete(socket);
          livePaths--;
        });
      }
      const cutAfter = cuts < 4 ? 128 * 1024 + random(384 * 1024) : Infinity;
      let written = 0;
      let cut = false;
      const fragmented = (socket: Duplex) => {
        const raw = wire(socket, 'peer');
        return {
          ...raw,
          write: async (bytes: Buffer) => {
            const prefix = Math.min(bytes.length, 1 + random(31));
            for (const part of [bytes.subarray(0, prefix), bytes.subarray(prefix)]) {
              if (part.length === 0) continue;
              const remaining = cutAfter - written;
              if (!cut && part.length > remaining) {
                cut = true;
                if (remaining > 0) await raw.write(part.subarray(0, remaining));
                cuts++;
                failures++;
                failedAt = performance.now();
                a.destroy();
                b.destroy();
                throw new Error(`seed ${seed}: cut inside a frame`);
              }
              written += part.length;
              await raw.write(part);
            }
          },
        };
      };
      right.reserve(state);
      const received = right.received;
      right.attach(state.generation, {
        stream: fragmented(b),
        remainder: Buffer.alloc(0),
        received: state.received,
      });
      return { stream: fragmented(a), remainder: Buffer.alloc(0), received };
    };
    const left = new ResumablePeerStream({
      peerId: 'peer',
      reconnect: async (state) => {
        // Failed candidates and a retained unread window coexist with replay.
        if (++attempts % 3 === 1) throw new Error(`seed ${seed}: dial unavailable`);
        await delay(random(4));
        const result = candidate(state);
        latencies.push(performance.now() - failedAt);
        return result;
      },
    });
    right = new ResumablePeerStream({ peerId: 'peer', sessionId: left.sessionId });
    const send = async (stream: ResumablePeerStream, bytes: Buffer) => {
      for (let offset = 0; offset < bytes.length; ) {
        const size = Math.min(bytes.length - offset, 1 + random(128 * 1024));
        await stream.write(bytes.subarray(offset, offset + size));
        offset += size;
      }
    };
    const drain = async (stream: ResumablePeerStream, bytes: Buffer) => {
      for (let offset = 0; offset < bytes.length; ) {
        if (random(8) === 0) await delay(1);
        const chunk = await stream.read();
        assert.ok(chunk, `seed ${seed}: premature EOF at ${offset}`);
        assert.deepEqual(
          chunk,
          bytes.subarray(offset, offset + chunk.length),
          `seed ${seed}, offset ${offset}`,
        );
        offset += chunk.length;
      }
    };
    try {
      const state = left.nextAttachment();
      left.attach(state.generation, candidate(state));
      const a = payload(4 * 1024 * 1024, seed);
      const b = payload(4 * 1024 * 1024, seed ^ 0xff);
      await Promise.all([send(left, a), send(right, b), drain(right, a), drain(left, b)]);
      assert.equal(cuts, 4, `seed ${seed}: all faults must occur during traffic`);
      await left.close();
      await right.closed;
    } finally {
      left.abort();
      right.abort();
      await tick();
      assert.equal(paths.size, 0, `seed ${seed}: leaked raw paths`);
    }
  };
  for (let seed = 1; seed <= seeds; seed += 4) {
    await Promise.all(
      Array.from({ length: Math.min(4, seeds - seed + 1) }, (_, index) => run(seed + index)),
    );
  }
  latencies.sort((a, b) => a - b);
  assert.equal(livePaths, 0);
  t.diagnostic(
    JSON.stringify({
      seeds,
      bytesVerified: seeds * 8 * 1024 * 1024,
      failures,
      peakRawHalves: peakPaths,
      elapsedMs: Math.round(performance.now() - started),
      attachmentP50Ms: Math.round(latencies[Math.floor(latencies.length * 0.5)]!),
      attachmentP95Ms: Math.round(latencies[Math.floor(latencies.length * 0.95)]!),
      attachmentMaxMs: Math.round(latencies.at(-1)!),
    }),
  );
});

test('full duplex exceeds the replay window and survives repeated path replacement', {
  timeout: 10_000,
}, async (t) => {
  const { left, right } = sessions();
  t.after(() => {
    left.abort();
    right.abort();
  });
  let cut = attach(left, right);
  const size = 8 * 1024 * 1024;
  const a = payload(size, 1);
  const b = payload(size, 2);
  const traffic = Promise.all([left.write(a), right.write(b), receive(left, b), receive(right, a)]);
  for (let i = 0; i < 5; i++) {
    await tick();
    cut();
    await tick();
    cut = attach(left, right);
  }
  await traffic;
  await left.close();
  await right.closed;
});

test('lost ACK and retained unread bytes are not delivered twice on a new path', {
  timeout: 5_000,
}, async (t) => {
  const { left, right } = sessions();
  t.after(() => {
    left.abort();
    right.abort();
  });
  const cut = attach(left, right, true);
  const bytes = payload(128 * 1024, 3);
  const writing = left.write(bytes);
  const first = await right.read();
  assert.deepEqual(first, bytes.subarray(0, 64 * 1024));
  await tick();
  cut();
  await tick();
  attach(left, right);
  await receive(right, bytes.subarray(64 * 1024));
  await writing;
  const marker = left.write(Buffer.from([4]));
  assert.deepEqual(await right.read(), Buffer.from([4]));
  await marker;
});

test('rejects stale generation, another peer, and impossible acknowledgment without replacing the live path', async (t) => {
  const { left, right } = sessions();
  t.after(() => {
    left.abort();
    right.abort();
  });
  attach(left, right);
  assert.throws(
    () => right.reserve({ sessionId: left.sessionId, generation: 1, received: 0 }),
    PeerResumeRejectedError,
  );
  assert.throws(
    () => right.reserve({ sessionId: left.sessionId, generation: 2, received: 100 }),
    PeerResumeRejectedError,
  );
  const state = left.nextAttachment();
  right.reserve(state);
  const [a, b] = duplexPair();
  assert.throws(
    () =>
      right.attach(state.generation, {
        stream: wire(a, 'impostor'),
        remainder: Buffer.alloc(0),
        received: 0,
      }),
    PeerResumeRejectedError,
  );
  b.destroy();
  const writing = left.write(Buffer.from([9]));
  assert.deepEqual(await right.read(), Buffer.from([9]));
  await writing;
});

test('one-way blackhole triggers automatic recovery and preserves the pending read', {
  timeout: 5_000,
}, async (t) => {
  let right!: ResumablePeerStream;
  let reattachments = 0;
  const left = new ResumablePeerStream({
    peerId: 'peer',
    heartbeatMs: 20,
    heartbeatTimeoutMs: 60,
    recoveryMs: 500,
    reconnect: async (state) => {
      reattachments++;
      const [a, b] = duplexPair();
      right.reserve(state);
      const received = right.received;
      right.attach(state.generation, {
        stream: wire(b, 'peer'),
        received: state.received,
        remainder: Buffer.alloc(0),
      });
      return { stream: wire(a, 'peer'), received, remainder: Buffer.alloc(0) };
    },
  });
  right = new ResumablePeerStream({ peerId: 'peer', sessionId: left.sessionId });
  t.after(() => {
    left.abort();
    right.abort();
  });
  const [a, b] = duplexPair();
  const state = left.nextAttachment();
  right.reserve(state);
  const blackhole = wire(a, 'peer');
  left.attach(state.generation, {
    stream: { ...blackhole, write: async () => {} },
    received: 0,
    remainder: Buffer.alloc(0),
  });
  right.attach(state.generation, {
    stream: wire(b, 'peer'),
    received: 0,
    remainder: Buffer.alloc(0),
  });
  const writing = left.write(Buffer.from('survives'));
  assert.deepEqual(await right.read(), Buffer.from('survives'));
  await writing;
  assert.equal(reattachments, 1);
});

test('continuous incoming traffic cannot starve outbound data or heartbeat behind ACKs', {
  timeout: 3_000,
}, async (t) => {
  const left = new ResumablePeerStream({
    peerId: 'peer',
    heartbeatMs: 20,
    heartbeatTimeoutMs: 80,
    recoveryMs: 100,
  });
  const right = new ResumablePeerStream({ peerId: 'peer', sessionId: left.sessionId });
  t.after(() => {
    left.abort();
    right.abort();
  });
  const [a, b] = duplexPair();
  const slow = wire(a, 'peer');
  const state = left.nextAttachment();
  right.reserve(state);
  right.attach(state.generation, {
    stream: wire(b, 'peer'),
    received: 0,
    remainder: Buffer.alloc(0),
  });
  left.attach(state.generation, {
    stream: {
      ...slow,
      write: async (bytes) => {
        await delay(5);
        await slow.write(bytes);
      },
    },
    received: 0,
    remainder: Buffer.alloc(0),
  });
  const bytes = payload(150 * 512, 41);
  await Promise.all([
    receive(left, bytes),
    receive(right, Buffer.from('outbound must progress')),
    left.write(Buffer.from('outbound must progress')),
    (async () => {
      for (let offset = 0; offset < bytes.length; offset += 512) {
        await right.write(bytes.subarray(offset, offset + 512));
        await delay(2);
      }
    })(),
  ]);
});

test('unrecoverable path has a bounded lifetime and abort wakes blocked reads and writes', {
  timeout: 2_000,
}, async (t) => {
  const left = new ResumablePeerStream({ peerId: 'peer', recoveryMs: 60, heartbeatMs: 20 });
  const right = new ResumablePeerStream({ peerId: 'peer', sessionId: left.sessionId });
  t.after(() => {
    left.abort();
    right.abort();
  });
  const cut = attach(left, right);
  const read = assert.rejects(left.read(), /recovery deadline/u);
  const write = assert.rejects(left.write(Buffer.alloc(3 * 1024 * 1024)), /recovery deadline/u);
  cut();
  await Promise.all([read, write, delay(100)]);
  assert.throws(() => left.nextAttachment(), /recovery deadline/u);
});

test('close has a hard deadline even when a healthy peer never drains its receive window', {
  timeout: 3_000,
}, async (t) => {
  const { left, right } = sessions();
  t.after(() => {
    left.abort();
    right.abort();
  });
  attach(left, right);
  const blocked = assert.rejects(left.write(Buffer.alloc(3 * 1024 * 1024)), /aborted/u);
  await tick();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closing = left.close();
  t.mock.timers.tick(5_000);
  await Promise.all([closing, blocked]);
});

test('failed proactive upgrade preserves transit; a later direct attachment keeps the logical stream', {
  timeout: 13_000,
}, async (t) => {
  let right!: ResumablePeerStream;
  let upgrades = 0;
  const left = new ResumablePeerStream({
    peerId: 'peer',
    reconnect: async (state, _signal, upgrade) => {
      assert.equal(upgrade, true);
      upgrades++;
      if (upgrades === 1) {
        await right.write(Buffer.from('rejected-upgrade-retains-old'));
        throw new PeerResumeRejectedError('candidate rejected');
      }
      const [a, b] = duplexPair();
      right.reserve(state);
      const received = right.received;
      right.attach(state.generation, {
        stream: wire(b, 'peer'),
        received: state.received,
        remainder: Buffer.alloc(0),
      });
      await right.write(Buffer.from('during-path-change'));
      return { stream: wire(a, 'peer'), received, remainder: Buffer.alloc(0) };
    },
  });
  right = new ResumablePeerStream({ peerId: 'peer', sessionId: left.sessionId });
  t.after(() => {
    left.abort();
    right.abort();
  });
  const [a, b] = duplexPair();
  const state = left.nextAttachment();
  right.reserve(state);
  const transit = (stream: RuntimeHostPeerNativeStream): RuntimeHostPeerNativeStream => ({
    ...stream,
    path: { kind: 'transit', relayPeerId: 'approved' },
  });
  right.attach(state.generation, {
    stream: transit(wire(b, 'peer')),
    received: 0,
    remainder: Buffer.alloc(0),
  });
  left.attach(state.generation, {
    stream: transit(wire(a, 'peer')),
    received: 0,
    remainder: Buffer.alloc(0),
  });
  await left.write(Buffer.from('before-upgrade'));
  assert.deepEqual(await right.read(), Buffer.from('before-upgrade'));
  assert.deepEqual(await left.read(), Buffer.from('rejected-upgrade-retains-old'));
  assert.equal(left.path?.kind, 'transit');
  await left.write(Buffer.from('old-path-still-live'));
  assert.deepEqual(await right.read(), Buffer.from('old-path-still-live'));
  assert.deepEqual(await left.read(), Buffer.from('during-path-change'));
  assert.equal(left.path?.kind, 'direct');
  assert.equal(upgrades, 2);
  await left.write(Buffer.from('after-upgrade'));
  assert.deepEqual(await right.read(), Buffer.from('after-upgrade'));
});

test('real TCP replacement preserves one Host dispatcher and does not re-execute a control operation; revocation ends recovery', {
  timeout: 10_000,
}, async (t) => {
  let acceptStream!: (stream: RuntimeHostPeerNativeStream) => void;
  let revoke!: (credentialId: string) => void;
  let revoked = false;
  let admissions = 0;
  let executions = 0;
  let teardowns = 0;
  let entered!: () => void;
  let release!: () => void;
  const handlerEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const handlerReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runs: Promise<void>[] = [];
  const sockets = new Set<Socket>();
  const authority = { ...LOCAL_OWNER_CONNECTION_AUTHORITY, credentialId: 'credential' };
  const rootId = 'a'.repeat(64);
  const listener = createRuntimeHostPeerListener(
    {
      identity: () => ({ peerId: 'server' }),
      serveApplication: async (accept, signal) => {
        acceptStream = accept;
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      },
    } as RuntimeHostPeerClient,
    {} as never,
    {
      authenticate: (credential: string) =>
        !revoked && credential === 'secret' ? authority : undefined,
      subscribeRevocations: (callback: typeof revoke) => {
        revoke = callback;
        return () => {};
      },
    } as never,
    ({ transport, authority: admittedAuthority }) => {
      admissions++;
      const session = new RuntimeHostConnectionSession({
        transport,
        connection: {
          hostEpoch: 'host',
          connectionId: 'same-connection',
          clientInstanceId: 'client',
          authority: admittedAuthority,
        },
        resolveContinuity: () => undefined,
        resolveHandlers: () => ({
          ...createUnavailableDomainOperationHandlers(),
          ...createUnavailableHostCoreOperationHandlers(),
          'host.status': async () => ({
            ok: true,
            result: {
              hostEpoch: 'host',
              compositionId: 'maka.interactive',
              compositionRevision: '1',
              state: 'ready',
              connections: 1,
              activeOperations: 0,
              activeResidencies: 0,
            },
          }),
          'host.diagnostics.query': async () => ({
            ok: false,
            error: { code: 'internal_failure', message: 'not used' },
          }),
          'host.resources.query': async () => ({
            ok: false,
            error: { code: 'internal_failure', message: 'not used' },
          }),
          'host.upgrade.prepare': async () => ({
            ok: false,
            error: { code: 'internal_failure', message: 'not used' },
          }),
          'turn.stop': async () => {
            executions++;
            entered();
            await handlerReleased;
            return {
              ok: false,
              error: { code: 'not_found', message: 'single execution result' },
            };
          },
        }),
        beginOperation: async () => ({
          acquireResidency: () => ({ release() {} }),
          seal() {},
          finish() {},
        }),
        onTeardown: () => {
          teardowns++;
        },
      });
      runs.push(
        (async () => {
          const hello = decodeClientFrame(await transport.read(1_000));
          assert.ok('kind' in hello && hello.kind === 'hello');
          await transport.write(
            encodeProtocolMessage({
              kind: 'accepted',
              rootId,
              hostEpoch: 'host',
              connectionId: 'same-connection',
              selectedProtocol: RUNTIME_HOST_PROTOCOL_VERSION,
              compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
              compositionId: 'maka.interactive',
              compositionRevision: '1',
              state: 'ready',
            }),
          );
          await session.run();
        })(),
      );
    },
  );
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    acceptStream(wire(socket, 'client'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const dial = async () => {
    const socket = connect(address.port, '127.0.0.1');
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    await once(socket, 'connect');
    return wire(socket, 'server');
  };
  let connection: RuntimeHostConnection | undefined;
  t.after(async () => {
    release();
    await connection?.close();
    await listener.cleanup();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(runs);
  });
  const reachability = {
    lease: {
      version: 1 as const,
      peerId: 'server',
      revision: 1,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      directRoutes: [],
      coordinationRoutes: [],
    },
    publicKey: 'AA',
    signature: 'AA',
  };
  connection = await connectPeerRuntimeHost({
    profileId: 'test',
    transport: { kind: 'libp2p-direct', reachability },
    credential: 'secret',
    expectedRootId: rootId,
    clientInstanceId: 'client',
    peerClient: {
      observeAuthenticatedReachability: () => reachability,
      connect: dial,
    } as unknown as RuntimeHostPeerClient,
  });
  const response = assert.rejects(
    connection.request('turn.stop', { sessionId: 'session', turnId: 'turn', runId: 'run' }, 5_000),
    /single execution result/u,
  );
  await handlerEntered;
  for (const socket of sockets) socket.destroy();
  release();
  await response;
  assert.equal(connection.connectionId, 'same-connection');
  assert.equal(admissions, 1);
  assert.equal(executions, 1);
  assert.equal(teardowns, 0);
  revoked = true;
  revoke('credential');
  await connection.closed;
  await assert.rejects(
    connection.request('turn.stop', { sessionId: 'session', turnId: 'turn', runId: 'run' }),
  );
  assert.equal(admissions, 1);
  assert.equal(executions, 1);
});
