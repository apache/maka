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
  RuntimeHostPeerByteStream,
  startRuntimeHostPeerEndpoint,
  type RuntimeHostPeerNativeEndpoint,
  type RuntimeHostPeerNativeStream,
} from '../transport/peer-native.js';
import type { RuntimeHostAccessAuthority } from './access-authority.js';
import type {
  RuntimeHostListenerConnection,
  RuntimeHostPeerListener as RuntimeHostPeerListenerContract,
} from './listener-set.js';

export interface StartRuntimeHostPeerListenerOptions {
  readonly nativePath: string;
  readonly keyPath: string;
  readonly listenAddresses?: readonly string[];
  readonly coordinationRelays?: readonly string[];
  readonly accessAuthority: RuntimeHostAccessAuthority;
  readonly accept: (connection: RuntimeHostListenerConnection) => void;
}

export function startRuntimeHostPeerListener(
  options: StartRuntimeHostPeerListenerOptions,
): RuntimeHostPeerListenerContract {
  const endpoint = startRuntimeHostPeerEndpoint(options);
  return new RuntimeHostPeerListener(endpoint, options.accessAuthority, options.accept);
}

class RuntimeHostPeerListener implements RuntimeHostPeerListenerContract {
  readonly kind = 'libp2p_direct' as const;
  readonly endpoint: string;
  readonly peerId: string;
  readonly listenAddresses: readonly string[];
  readonly #endpoint: RuntimeHostPeerNativeEndpoint;
  readonly #accessAuthority: RuntimeHostAccessAuthority;
  readonly #accept: (connection: RuntimeHostListenerConnection) => void;
  readonly #transports = new Set<FramedByteStreamTransport>();
  readonly #acceptTask: Promise<void>;
  #acceptFailure: unknown;
  #admitting = true;
  #cleanupTask: Promise<void> | undefined;

  constructor(
    endpoint: RuntimeHostPeerNativeEndpoint,
    accessAuthority: RuntimeHostAccessAuthority,
    accept: (connection: RuntimeHostListenerConnection) => void,
  ) {
    this.endpoint = endpoint.peerId;
    this.peerId = endpoint.peerId;
    this.listenAddresses = Object.freeze([...endpoint.listenAddresses]);
    this.#endpoint = endpoint;
    this.#accessAuthority = accessAuthority;
    this.#accept = accept;
    this.#acceptTask = this.#acceptStreams().catch((error: unknown) => {
      this.#acceptFailure = error;
    });
  }

  closeAdmission(): Promise<void> {
    this.#admitting = false;
    return Promise.resolve();
  }

  cleanup(): Promise<void> {
    this.#cleanupTask ??= (async () => {
      this.#admitting = false;
      for (const transport of this.#transports) transport.abort();
      await this.#endpoint.close();
      await this.#acceptTask;
      if (this.#acceptFailure) throw this.#acceptFailure;
    })();
    return this.#cleanupTask;
  }

  async #acceptStreams(): Promise<void> {
    while (true) {
      let stream: RuntimeHostPeerNativeStream | null;
      try {
        stream = await this.#endpoint.accept();
      } catch (error) {
        if (this.#cleanupTask) return;
        throw error;
      }
      if (!stream) return;
      if (!this.#admitting) {
        stream.abort();
        continue;
      }
      void this.#authenticateAndAccept(stream);
    }
  }

  async #authenticateAndAccept(stream: RuntimeHostPeerNativeStream): Promise<void> {
    try {
      const authenticated = await readRuntimeHostPeerAuthentication(stream);
      const authority = this.#accessAuthority.authenticate(authenticated.credential);
      if (!authority || !this.#admitting) {
        stream.abort();
        return;
      }
      const transport = new FramedByteStreamTransport(
        new RuntimeHostPeerByteStream(stream, authenticated.remainder),
      );
      this.#transports.add(transport);
      void transport.closed.then(() => this.#transports.delete(transport));
      try {
        this.#accept({ transport, authority });
      } catch (error) {
        transport.abort(asError(error));
      }
    } catch {
      stream.abort();
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
