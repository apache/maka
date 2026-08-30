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

import { FramedByteStreamTransport } from '../transport/framed-byte-stream-transport.js';
import {
  readRuntimeHostPeerAuthentication,
  RUNTIME_HOST_PEER_AUTHENTICATION_TIMEOUT_MS,
  RuntimeHostPeerByteStream,
  writeRuntimeHostPeerAuthenticationResult,
  type RuntimeHostPeerNativeStream,
} from '../transport/peer-native.js';
import { createRuntimeHostPeerClient, type RuntimeHostPeerClient } from '../client/peer-client.js';
import type { RuntimeHostAccessAuthority } from './access-authority.js';
import type {
  RuntimeHostListenerConnection,
  RuntimeHostPeerListener as RuntimeHostPeerListenerContract,
} from './listener-set.js';

const MAX_PENDING_AUTHENTICATIONS = 16;
const MAX_ACTIVE_STREAMS = 64;
const MAX_ACTIVE_STREAMS_PER_PEER = 4;

export interface RuntimeHostPeerListenerConfiguration {
  readonly nativePath: string;
  readonly keyPath: string;
  readonly expectedPeerId?: string;
  readonly listenAddresses?: readonly string[];
  readonly coordinationRelays?: readonly string[];
  readonly automaticRelayDiscovery?: boolean;
}

export type RuntimeHostPeerListenerEndpointOptions =
  | RuntimeHostPeerListenerConfiguration
  | { readonly client: RuntimeHostPeerClient };

export type StartRuntimeHostPeerListenerOptions = RuntimeHostPeerListenerEndpointOptions & {
  readonly accessAuthority: RuntimeHostAccessAuthority;
  readonly accept: (connection: RuntimeHostListenerConnection) => void;
};

export function startRuntimeHostPeerListener(
  options: StartRuntimeHostPeerListenerOptions,
): RuntimeHostPeerListenerContract {
  if ('client' in options) {
    return createRuntimeHostPeerListener(
      options.client,
      options.accessAuthority,
      options.accept,
      false,
    );
  }
  const client = createRuntimeHostPeerClient(options);
  return createRuntimeHostPeerListener(client, options.accessAuthority, options.accept, true);
}

export function createRuntimeHostPeerListener(
  client: RuntimeHostPeerClient,
  accessAuthority: RuntimeHostAccessAuthority,
  accept: (connection: RuntimeHostListenerConnection) => void,
  ownsClient = false,
): RuntimeHostPeerListenerContract {
  return new RuntimeHostPeerListener(client, accessAuthority, accept, ownsClient);
}

class RuntimeHostPeerListener implements RuntimeHostPeerListenerContract {
  readonly kind = 'libp2p_direct' as const;
  readonly endpoint: string;
  readonly peerId: string;
  readonly listenAddresses: readonly string[];
  readonly #client: RuntimeHostPeerClient;
  readonly #ownsClient: boolean;
  readonly #accessAuthority: RuntimeHostAccessAuthority;
  readonly #accept: (connection: RuntimeHostListenerConnection) => void;
  readonly #transports = new Set<FramedByteStreamTransport>();
  readonly #streams = new Set<RuntimeHostPeerNativeStream>();
  readonly #authentications = new Map<RuntimeHostPeerNativeStream, Promise<void>>();
  readonly #serving: Promise<void>;
  readonly #serveLifetime = new AbortController();
  #acceptFailure: unknown;
  #admitting = true;
  #closeAdmissionTask: Promise<void> | undefined;
  #cleanupTask: Promise<void> | undefined;

  constructor(
    client: RuntimeHostPeerClient,
    accessAuthority: RuntimeHostAccessAuthority,
    accept: (connection: RuntimeHostListenerConnection) => void,
    ownsClient: boolean,
  ) {
    const identity = client.identity();
    this.endpoint = identity.peerId;
    this.peerId = identity.peerId;
    this.listenAddresses = Object.freeze([...identity.listenAddresses]);
    this.#client = client;
    this.#ownsClient = ownsClient;
    this.#accessAuthority = accessAuthority;
    this.#accept = accept;
    const captureFailure = (error: unknown) => {
      this.#acceptFailure ??= error;
    };
    this.#serving = client
      .serveApplication((stream) => this.#acceptStream(stream), this.#serveLifetime.signal)
      .catch(captureFailure);
  }

  closeAdmission(): Promise<void> {
    this.#closeAdmissionTask ??= (async () => {
      this.#admitting = false;
      for (const stream of this.#authentications.keys()) stream.abort();
      await Promise.allSettled([...this.#authentications.values()]);
    })();
    return this.#closeAdmissionTask;
  }

  cleanup(): Promise<void> {
    this.#cleanupTask ??= (async () => {
      await this.closeAdmission();
      for (const transport of this.#transports) transport.abort();
      this.#serveLifetime.abort();
      await this.#serving;
      if (this.#ownsClient) await this.#client.close();
      if (this.#acceptFailure) throw this.#acceptFailure;
    })();
    return this.#cleanupTask;
  }

  #acceptStream(stream: RuntimeHostPeerNativeStream): void {
    if (!this.#admitting || this.#authentications.size >= MAX_PENDING_AUTHENTICATIONS) {
      stream.abort();
      return;
    }
    let peerStreams = 0;
    for (const admitted of this.#streams) {
      if (admitted.peerId === stream.peerId) peerStreams += 1;
    }
    if (this.#streams.size >= MAX_ACTIVE_STREAMS || peerStreams >= MAX_ACTIVE_STREAMS_PER_PEER) {
      stream.abort();
      return;
    }
    this.#streams.add(stream);
    const task = this.#authenticateAndAccept(stream).finally(() => {
      this.#authentications.delete(stream);
    });
    this.#authentications.set(stream, task);
    void task;
  }

  async #authenticateAndAccept(stream: RuntimeHostPeerNativeStream): Promise<void> {
    let transportOwnsStream = false;
    try {
      const authenticated = await withDeadline(
        readRuntimeHostPeerAuthentication(stream),
        RUNTIME_HOST_PEER_AUTHENTICATION_TIMEOUT_MS,
        () => stream.abort(),
      );
      const authority = this.#accessAuthority.authenticate(authenticated.credential);
      if (!authority) {
        await writeRuntimeHostPeerAuthenticationResult(stream, false);
        await stream.close();
        return;
      }
      if (!this.#admitting) {
        stream.abort();
        return;
      }
      await writeRuntimeHostPeerAuthenticationResult(stream, true);
      if (!this.#admitting) {
        stream.abort();
        return;
      }
      const admittedAuthority = this.#accessAuthority.authenticate(authenticated.credential);
      if (!admittedAuthority) {
        stream.abort();
        return;
      }
      const transport = new FramedByteStreamTransport(
        new RuntimeHostPeerByteStream(stream, authenticated.remainder),
      );
      this.#transports.add(transport);
      transportOwnsStream = true;
      void transport.closed.then(() => {
        this.#transports.delete(transport);
        this.#streams.delete(stream);
      });
      try {
        this.#accept({ transport, authority: admittedAuthority });
      } catch (error) {
        transport.abort(asError(error));
      }
    } catch {
      stream.abort();
    } finally {
      if (!transportOwnsStream) this.#streams.delete(stream);
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error('Peer authentication timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
