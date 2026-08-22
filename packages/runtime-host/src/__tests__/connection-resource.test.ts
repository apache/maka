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
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { connectRemoteRuntimeHost, RuntimeHostRequestInterruptedError } from '../client/index.js';
import type { RuntimeHostConnectionResource } from '../client/connection.js';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type RequestFrame,
} from '../protocol/index.js';
import { RuntimeHostTransportError } from '../transport/framed-transport.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
const ROOT_ID = 'a'.repeat(64);

for (const settlement of ['resolve', 'reject'] as const) {
  test(`connection resource ${settlement} interrupts dispatched requests with transport semantics`, async () => {
    const resource = deferredResource();
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const requestsObserved = deferred<void>();
    server.once('connection', (socket) => servePendingRequests(socket, requestsObserved));

    try {
      const connected = await connectRemoteRuntimeHost({
        url: `ws://127.0.0.1:${address.port}`,
        allowInsecureRemote: true,
        credential: 'test-credential',
        expectedRootId: ROOT_ID,
        compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
        protocol: PROTOCOL,
        connectionResource: resource,
      });
      assert.equal(connected.kind, 'connected');
      if (connected.kind !== 'connected') return;

      const query = connected.connection.request('session.catalog.query', {
        kind: 'get',
        sessionId: 'pending-query',
      });
      const command = connected.connection.request('session.create', {
        sessionId: 'pending-command',
        workspace: { kind: 'host_path', path: '/tmp' },
        modelTarget: { kind: 'default' },
      });
      await requestsObserved.promise;
      const resourceFailure = new Error('tunnel process exited');
      if (settlement === 'resolve') resource.resolve();
      else resource.reject(resourceFailure);

      await assert.rejects(query, (error: unknown) =>
        isResourceInterruption(
          error,
          'session.catalog.query',
          'query',
          resourceFailure,
          settlement,
        ),
      );
      await assert.rejects(command, (error: unknown) =>
        isResourceInterruption(error, 'session.create', 'command', resourceFailure, settlement),
      );
      await connected.connection.closed;
      assert.equal(resource.closeCalls(), 1);
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

function servePendingRequests(socket: WebSocket, requestsObserved: Deferred<void>): void {
  let requestCount = 0;
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as { kind?: string } | RequestFrame;
    if ('kind' in frame) {
      assert.equal(frame.kind, 'hello');
      socket.send(
        JSON.stringify({
          kind: 'accepted',
          rootId: ROOT_ID,
          hostEpoch: 'host-1',
          connectionId: 'connection-1',
          selectedProtocol: RUNTIME_HOST_PROTOCOL_VERSION,
          compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
          compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
          compositionRevision: '1',
          state: 'ready',
        }),
      );
      return;
    }
    requestCount += 1;
    if (requestCount === 2) requestsObserved.resolve();
  });
}

function isResourceInterruption(
  error: unknown,
  operation: 'session.catalog.query' | 'session.create',
  mode: 'query' | 'command',
  resourceFailure: Error,
  settlement: 'resolve' | 'reject',
): boolean {
  if (!(error instanceof RuntimeHostRequestInterruptedError)) return false;
  assert.equal(error.operation, operation);
  assert.equal(error.mode, mode);
  assert.equal(error.dispatch, 'dispatched');
  assert.equal(error.reason, 'connection_lost');
  assert.equal(error.retryable, mode === 'query');
  assert.ok(error.cause instanceof RuntimeHostTransportError);
  assert.equal(error.cause.code, 'closed');
  if (settlement === 'reject') assert.equal(error.cause.cause, resourceFailure);
  else assert.ok(error.cause.cause instanceof Error);
  return true;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function deferredResource(): RuntimeHostConnectionResource & {
  resolve(): void;
  reject(error: Error): void;
  closeCalls(): number;
} {
  const closed = deferred<void>();
  let closes = 0;
  return {
    closed: closed.promise,
    resolve: () => closed.resolve(),
    reject: closed.reject,
    close: async () => {
      closes += 1;
    },
    closeCalls: () => closes,
  };
}
