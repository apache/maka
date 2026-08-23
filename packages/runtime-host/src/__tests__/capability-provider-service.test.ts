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
import { ClientCapabilityChannel } from '../client/client-capability-channel.js';
import type { ClientCapabilityProvider } from '../client/client-capability.js';
import { startRuntimeHostCapabilityProviderService } from '../client/capability-provider-service.js';
import type { ClientCapabilityReplaceInput } from '../protocol/index.js';

test('capability publication degrades in place and recovers from an invalid snapshot', async () => {
  const connections: FakeConnection[] = [];
  let provider: ClientCapabilityProvider | undefined = providerWithOffers(1);
  const service = await startRuntimeHostCapabilityProviderService({
    connect: async () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
    createProvider: () => provider,
    backoff: { minMs: 0, maxMs: 0, stableConnectionMs: 0 },
  });

  assert.equal(connections[0]?.replacements.length, 1);
  assert.equal(connections[0]?.replacements[0]?.offers[0]?.offerId, 'offer-0');

  provider = providerWithOffers(33);
  await assert.rejects(service.refresh(), /Invalid Client Capability offers/u);
  assert.equal(connections.length, 1);
  assert.equal(connections[0]?.unregistrations, 1);

  provider = providerWithOffers(1);
  await service.refresh();
  assert.equal(connections[0]?.replacements.length, 2);

  connections[0]?.disconnect();
  await waitFor(() => connections.length === 2);
  assert.equal(connections[1]?.replacements.length, 1);

  await service.close();
  assert.equal(connections[1]?.closeCalls, 1);
});

test('capability provider startup rejects an invalid initial snapshot', async () => {
  const connection = new FakeConnection();
  await assert.rejects(
    startRuntimeHostCapabilityProviderService({
      connect: async () => connection,
      createProvider: () => providerWithOffers(33),
    }),
    /Invalid Client Capability offers/u,
  );
  assert.equal(connection.closeCalls, 1);
});

class FakeConnection {
  readonly #closed = deferred();
  readonly #channel: ClientCapabilityChannel;
  readonly replacements: ClientCapabilityReplaceInput[] = [];
  unregistrations = 0;
  closeCalls = 0;

  constructor() {
    this.#channel = new ClientCapabilityChannel({
      write: async () => undefined,
      replace: async (input) => {
        this.replacements.push(input);
        return { registrationId: input.registrationId, revision: this.replacements.length };
      },
      unregister: async (input) => {
        this.unregistrations += 1;
        return { registrationId: input.registrationId, revision: this.unregistrations };
      },
      onFailure: (error) => {
        throw error;
      },
    });
  }

  readonly closed = this.#closed.promise;

  replaceClientCapabilities(provider: ClientCapabilityProvider, timeoutMs = 1_000) {
    return this.#channel.replace(provider, timeoutMs);
  }

  unregisterClientCapabilities(timeoutMs = 1_000) {
    return this.#channel.unregister(timeoutMs);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.#channel.close(new Error('Connection closed'));
    this.#closed.resolve();
  }

  disconnect(): void {
    this.#channel.close(new Error('Connection lost'));
    this.#closed.resolve();
  }
}

function providerWithOffers(count: number): ClientCapabilityProvider {
  return {
    offers: () =>
      Array.from({ length: count }, (_, index) => ({
        offerId: `offer-${index}`,
        version: '0',
        affinity: 'session' as const,
        hostPathAccess: 'none' as const,
        label: `Offer ${index}`,
        tools: [
          {
            serverId: `server-${index}`,
            name: 'echo',
            inputSchema: { type: 'object' },
          },
        ],
      })),
  };
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('Timed out waiting for reconnect');
}
