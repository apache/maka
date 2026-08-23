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

import type { ClientCapabilityProvider } from './client-capability.js';
import type { RuntimeHostConnection } from './connection.js';
import { decodeClientCapabilityReplaceInput } from '../protocol/index.js';
import {
  startRuntimeHostReconnectLifecycle,
  type RuntimeHostReconnectBackoff,
  type RuntimeHostReconnectLifecycle,
  type RuntimeHostReconnectResource,
} from './reconnect-lifecycle.js';

interface PublishedCapabilityConnection extends RuntimeHostReconnectResource {
  refresh(): Promise<void>;
}

type CapabilityProviderConnection = Pick<
  RuntimeHostConnection,
  'closed' | 'replaceClientCapabilities' | 'unregisterClientCapabilities' | 'close'
>;

class CapabilityProviderPublicationError extends Error {
  readonly name = 'CapabilityProviderPublicationError';

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export interface RuntimeHostCapabilityProviderService {
  readonly closed: Promise<void>;
  refresh(): Promise<void>;
  close(): Promise<void>;
}

export async function startRuntimeHostCapabilityProviderService(input: {
  readonly connect: (signal: AbortSignal) => Promise<CapabilityProviderConnection>;
  readonly createProvider: () => ClientCapabilityProvider | undefined;
  readonly backoff?: RuntimeHostReconnectBackoff;
  readonly onReconnectError?: (error: Error) => void;
  readonly onPublicationError?: (error: Error) => void;
  readonly onFatalError?: (error: Error) => void;
}): Promise<RuntimeHostCapabilityProviderService> {
  let established = false;
  const lifecycle = await startRuntimeHostReconnectLifecycle({
    connect: async (signal) => {
      const connection = await input.connect(signal);
      const published = new PublishedCapabilityConnectionImpl(connection, input.createProvider);
      try {
        signal.throwIfAborted();
        await published.refresh();
        signal.throwIfAborted();
        return published;
      } catch (error) {
        if (error instanceof CapabilityProviderPublicationError) {
          if (!established) {
            await published.close().catch(() => undefined);
            throw error;
          }
          input.onPublicationError?.(error);
          return published;
        }
        await published.close().catch(() => undefined);
        throw error;
      }
    },
    ...(input.backoff ? { backoff: input.backoff } : {}),
    ...(input.onReconnectError ? { onReconnectError: input.onReconnectError } : {}),
    ...(input.onFatalError ? { onFatalError: input.onFatalError } : {}),
  });
  established = true;
  return new RuntimeHostCapabilityProviderServiceImpl(lifecycle);
}

class RuntimeHostCapabilityProviderServiceImpl implements RuntimeHostCapabilityProviderService {
  readonly closed: Promise<void>;
  readonly #lifecycle: RuntimeHostReconnectLifecycle<PublishedCapabilityConnection>;
  #refreshQueue = Promise.resolve();

  constructor(lifecycle: RuntimeHostReconnectLifecycle<PublishedCapabilityConnection>) {
    this.#lifecycle = lifecycle;
    this.closed = lifecycle.closed;
  }

  refresh(): Promise<void> {
    const refresh = this.#refreshQueue
      .catch(() => undefined)
      .then(async () => {
        await this.#lifecycle.current?.refresh();
      });
    this.#refreshQueue = refresh;
    return refresh;
  }

  async close(): Promise<void> {
    await this.#lifecycle.close();
    await this.#refreshQueue.catch(() => undefined);
  }
}

class PublishedCapabilityConnectionImpl implements PublishedCapabilityConnection {
  readonly closed: Promise<void>;
  readonly #connection: CapabilityProviderConnection;
  readonly #createProvider: () => ClientCapabilityProvider | undefined;
  #registered = false;

  constructor(
    connection: CapabilityProviderConnection,
    createProvider: () => ClientCapabilityProvider | undefined,
  ) {
    this.#connection = connection;
    this.#createProvider = createProvider;
    this.closed = connection.closed;
  }

  async refresh(): Promise<void> {
    let candidate: ClientCapabilityProvider | undefined;
    let provider: ClientCapabilityProvider | undefined;
    try {
      candidate = this.#createProvider();
      provider = candidate ? snapshotProvider(candidate) : undefined;
    } catch (error) {
      await closeProvider(candidate);
      await this.#clearRegistration();
      throw new CapabilityProviderPublicationError(error);
    }
    if (!provider) {
      await this.#clearRegistration();
      return;
    }
    try {
      await this.#connection.replaceClientCapabilities(provider);
      this.#registered = true;
    } catch (error) {
      await closeProvider(provider);
      await this.#connection.close().catch(() => undefined);
      throw error;
    }
  }

  close(): Promise<void> {
    return this.#connection.close();
  }

  async #clearRegistration(): Promise<void> {
    if (!this.#registered) return;
    try {
      await this.#connection.unregisterClientCapabilities();
      this.#registered = false;
    } catch (error) {
      await this.#connection.close().catch(() => undefined);
      throw error;
    }
  }
}

function snapshotProvider(provider: ClientCapabilityProvider): ClientCapabilityProvider {
  const services = provider.services?.() ?? [];
  const canonical = decodeClientCapabilityReplaceInput({
    registrationId: '00000000-0000-4000-8000-000000000000',
    offers: provider.offers(),
    ...(services.length === 0 ? {} : { services }),
  });
  const call = provider.call?.bind(provider);
  const callService = provider.callService?.bind(provider);
  const close = provider.close?.bind(provider);
  return {
    offers: () => canonical.offers,
    ...(canonical.services === undefined ? {} : { services: () => canonical.services ?? [] }),
    ...(call ? { call } : {}),
    ...(callService ? { callService } : {}),
    ...(close ? { close } : {}),
  };
}

async function closeProvider(provider: ClientCapabilityProvider | undefined): Promise<void> {
  if (!provider) return;
  try {
    await provider.close?.();
  } catch {
    // The registration failed before the Host could own provider teardown.
  }
}
