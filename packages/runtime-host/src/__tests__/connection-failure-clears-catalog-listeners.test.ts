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
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connectRuntimeHostMessageTransport } from '../client/connection.js';
import {
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '../protocol/index.js';
import { RuntimeHostTransportError } from '../transport/framed-transport.js';
import type { EncodedProtocolMessage } from '../protocol/index.js';
import type { RuntimeHostMessageTransport } from '../transport/message-transport.js';

const COMPOSITION_ID = 'maka.interactive';
const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

/**
 * A gated in-memory RuntimeHostMessageTransport. Frame delivery only happens
 * when the test pumps one, so the read loop's consumption order is fully
 * deterministic. abort() deliberately leaves an already-armed read resolvable:
 * a real transport race lets frames already in flight surface after a
 * connection failure (buffered socket data versus destroy), and that window is
 * exactly where cleared presentation listeners must stop firing.
 */
class GatedHostTransport implements RuntimeHostMessageTransport {
  readonly closed: Promise<void>;
  readonly #closedResolve: () => void;
  #pendingRead: { resolve: (frame: unknown) => void; reject: (error: unknown) => void } | undefined;

  constructor() {
    let resolveClosed!: () => void;
    this.closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    this.#closedResolve = resolveClosed;
  }

  read(_timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.#pendingRead = { resolve, reject };
    });
  }

  async write(_message: EncodedProtocolMessage): Promise<void> {}

  closeAfterFlush(): void {}

  abort(_error?: Error): void {}

  /** Resolves once the connection has armed its next transport read. */
  async whenReadArmed(): Promise<void> {
    while (!this.#pendingRead) await Promise.resolve();
  }

  pump(frame: unknown): void {
    const read = this.#pendingRead;
    this.#pendingRead = undefined;
    read?.resolve(frame);
  }

  end(): void {
    const read = this.#pendingRead;
    this.#pendingRead = undefined;
    read?.reject(new RuntimeHostTransportError('read_eof', 'fixture transport ended'));
    this.#closedResolve();
  }
}

function acceptedHandshake() {
  return {
    kind: 'accepted',
    rootId: randomBytes(32).toString('hex'),
    hostEpoch: randomUUID(),
    connectionId: randomUUID(),
    selectedProtocol: RUNTIME_HOST_PROTOCOL_VERSION,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    compositionId: COMPOSITION_ID,
    compositionRevision: '1',
    state: 'ready',
  };
}

test('a failed connection stops invoking connection and project catalog listeners', async () => {
  const transport = new GatedHostTransport();
  const handshake = acceptedHandshake();
  const connecting = connectRuntimeHostMessageTransport({
    transport,
    expectedRootId: handshake.rootId,
    compositionId: COMPOSITION_ID,
    protocol: PROTOCOL,
    livenessIntervalMs: 120_000,
  });
  await transport.whenReadArmed();
  transport.pump(handshake);
  const result = await connecting;
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') return;
  const connection = result.connection;

  const connectionCatalogRevisions: number[] = [];
  const projectCatalogRevisions: number[] = [];
  const unsubscribeConnection = connection.subscribeConnectionCatalogChanges((revision) =>
    connectionCatalogRevisions.push(revision),
  );
  const unsubscribeProject = connection.subscribeProjectCatalogChanges((revision) =>
    projectCatalogRevisions.push(revision),
  );

  // While the connection lives, catalog frames reach their listeners.
  await transport.whenReadArmed();
  transport.pump({ kind: 'connection.catalog.changed', revision: 2 });
  await transport.whenReadArmed();
  transport.pump({ kind: 'project.catalog.changed', revision: 2 });
  await transport.whenReadArmed();
  assert.deepEqual(connectionCatalogRevisions, [2]);
  assert.deepEqual(projectCatalogRevisions, [2]);

  // Fail the connection off the read loop: the connection-scoped status
  // timeout runs #fail while the read loop is still armed on its transport.
  const statusOutcome = await connection.status(20).then(
    () => 'resolved',
    () => 'rejected',
  );
  assert.equal(statusOutcome, 'rejected');

  // A frame already in flight when the connection failed must not reach the
  // catalog listeners: #fail clears every presentation listener collection.
  transport.pump({ kind: 'connection.catalog.changed', revision: 3 });
  await transport.whenReadArmed();
  transport.pump({ kind: 'project.catalog.changed', revision: 3 });
  await transport.whenReadArmed();
  assert.deepEqual(connectionCatalogRevisions, [2]);
  assert.deepEqual(projectCatalogRevisions, [2]);

  unsubscribeConnection();
  unsubscribeProject();
  transport.end();
  await connection.closed;
});
