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

import {
  RuntimeHostPeerError,
  startRuntimeHostPeerEndpoint,
  type RuntimeHostPeerNativeEndpoint,
  type RuntimeHostPeerNativeStream,
} from '../transport/peer-native.js';
import { RuntimeHostPermanentReconnectError } from './reconnect-lifecycle.js';

export interface RuntimeHostPeerConnectInput {
  readonly peerId: string;
  readonly routeHints: readonly string[];
  readonly coordinationRelays?: readonly string[];
  readonly directDeadlineMs: number;
}

export interface RuntimeHostPeerClient {
  connect(
    input: RuntimeHostPeerConnectInput,
    signal?: AbortSignal,
  ): Promise<RuntimeHostPeerNativeStream>;
  close(): Promise<void>;
}

export function createRuntimeHostPeerClientFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeHostPeerClient {
  const nativePath = environment.MAKA_RUNTIME_HOST_PEER_NATIVE_PATH;
  const keyPath = environment.MAKA_RUNTIME_HOST_PEER_KEY_PATH;
  if (!nativePath || !keyPath) {
    throw new RuntimeHostPeerError(
      'peer_native_unavailable',
      'Experimental direct peer requires MAKA_RUNTIME_HOST_PEER_NATIVE_PATH and MAKA_RUNTIME_HOST_PEER_KEY_PATH',
    );
  }
  return createRuntimeHostPeerClient({ nativePath, keyPath });
}

export function createRuntimeHostPeerClient(input: {
  readonly nativePath: string;
  readonly keyPath: string;
}): RuntimeHostPeerClient {
  return new RuntimeHostPeerClientImpl(input);
}

class RuntimeHostPeerClientImpl implements RuntimeHostPeerClient {
  readonly #nativePath: string;
  readonly #keyPath: string;
  #endpoint: RuntimeHostPeerNativeEndpoint | undefined;
  #draining: Promise<void> | undefined;
  #terminalError: Error | undefined;
  #nextRequestId = 1;
  #closed = false;
  #closeTask: Promise<void> | undefined;

  constructor(input: { readonly nativePath: string; readonly keyPath: string }) {
    this.#nativePath = input.nativePath;
    this.#keyPath = input.keyPath;
  }

  async connect(
    input: RuntimeHostPeerConnectInput,
    signal?: AbortSignal,
  ): Promise<RuntimeHostPeerNativeStream> {
    signal?.throwIfAborted();
    const endpoint = this.#requireEndpoint();
    const requestId = this.#allocateRequestId();
    const connection = endpoint.connect({ ...input, requestId });
    let settled = false;
    const cancel = () => {
      void cancelPeerConnect(endpoint, requestId, () => settled);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const stream = await connection;
      if (signal?.aborted) {
        stream.abort();
        signal.throwIfAborted();
      }
      return stream;
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally {
      settled = true;
      signal?.removeEventListener('abort', cancel);
    }
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#close();
    return this.#closeTask;
  }

  #requireEndpoint(): RuntimeHostPeerNativeEndpoint {
    if (this.#closed) {
      throw new RuntimeHostPeerError('peer_native_failed', 'Runtime Host peer client is closed');
    }
    if (this.#terminalError) {
      throw new RuntimeHostPermanentReconnectError(
        'Runtime Host peer networking stopped and cannot recover until this Client restarts',
        { cause: this.#terminalError },
      );
    }
    if (this.#endpoint) return this.#endpoint;
    const endpoint = startRuntimeHostPeerEndpoint({
      nativePath: this.#nativePath,
      keyPath: this.#keyPath,
    });
    this.#endpoint = endpoint;
    this.#draining = this.#drainInbound(endpoint);
    return endpoint;
  }

  async #drainInbound(endpoint: RuntimeHostPeerNativeEndpoint): Promise<void> {
    try {
      while (true) {
        const stream = await endpoint.accept();
        if (!stream) {
          if (!this.#closed) {
            this.#terminalError = new Error('Runtime Host peer networking stopped unexpectedly');
          }
          return;
        }
        stream.abort();
      }
    } catch (error) {
      // Connection attempts and streams expose a terminal native failure to
      // their existing reconnect owners. This owner never replaces its Swarm.
      this.#terminalError = error instanceof Error ? error : new Error(String(error));
    }
  }

  async #close(): Promise<void> {
    this.#closed = true;
    const endpoint = this.#endpoint;
    this.#endpoint = undefined;
    if (!endpoint) return;
    let closeError: unknown;
    let closeFailed = false;
    try {
      await endpoint.close();
    } catch (error) {
      closeFailed = true;
      closeError = error;
    }
    await this.#draining;
    if (closeFailed) throw closeError;
  }

  #allocateRequestId(): number {
    const requestId = this.#nextRequestId;
    this.#nextRequestId = requestId === 0xffff_ffff ? 1 : requestId + 1;
    return requestId;
  }
}

async function cancelPeerConnect(
  endpoint: RuntimeHostPeerNativeEndpoint,
  requestId: number,
  isSettled: () => boolean,
): Promise<void> {
  try {
    while (!isSettled() && !(await endpoint.cancelConnect(requestId))) {
      // N-API schedules connect and cancel independently. Retry until the
      // engine has observed the request or the connect promise settles.
    }
  } catch {
    // The endpoint closing also settles the connect promise.
  }
}
