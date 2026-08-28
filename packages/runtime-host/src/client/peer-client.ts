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
  identity(): Readonly<{
    peerId: string;
    listenAddresses: readonly string[];
    coordinationRelays: readonly string[];
  }>;
  connect(
    input: RuntimeHostPeerConnectInput,
    signal?: AbortSignal,
  ): Promise<RuntimeHostPeerNativeStream>;
  connectMeshControl(
    input: RuntimeHostPeerConnectInput,
    signal?: AbortSignal,
  ): Promise<RuntimeHostPeerNativeStream>;
  serveMeshControl(
    onStream: (stream: RuntimeHostPeerNativeStream) => void,
    signal: AbortSignal,
  ): Promise<void>;
  close(): Promise<void>;
}

export function createRuntimeHostPeerClientFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: {
    readonly listenAddresses?: readonly string[];
    readonly coordinationRelays?: readonly string[];
  } = {},
): RuntimeHostPeerClient {
  const nativePath = environment.MAKA_RUNTIME_HOST_PEER_NATIVE_PATH;
  const keyPath = environment.MAKA_RUNTIME_HOST_PEER_KEY_PATH;
  if (!nativePath || !keyPath) {
    throw new RuntimeHostPeerError(
      'peer_native_unavailable',
      'Experimental direct peer requires MAKA_RUNTIME_HOST_PEER_NATIVE_PATH and MAKA_RUNTIME_HOST_PEER_KEY_PATH',
    );
  }
  return createRuntimeHostPeerClient({ nativePath, keyPath, ...options });
}

export function createRuntimeHostPeerClient(input: {
  readonly nativePath: string;
  readonly keyPath: string;
  readonly listenAddresses?: readonly string[];
  readonly coordinationRelays?: readonly string[];
}): RuntimeHostPeerClient {
  return new RuntimeHostPeerClientImpl(input);
}

class RuntimeHostPeerClientImpl implements RuntimeHostPeerClient {
  readonly #nativePath: string;
  readonly #keyPath: string;
  readonly #listenAddresses: readonly string[] | undefined;
  readonly #coordinationRelays: readonly string[] | undefined;
  #endpoint: RuntimeHostPeerNativeEndpoint | undefined;
  #draining: Promise<void> | undefined;
  #meshDraining: Promise<void> | undefined;
  #meshConsumer:
    | {
        readonly onStream: (stream: RuntimeHostPeerNativeStream) => void;
        readonly resolve: () => void;
        readonly reject: (error: Error) => void;
      }
    | undefined;
  #terminalError: Error | undefined;
  #nextRequestId = 1;
  #closed = false;
  #closeTask: Promise<void> | undefined;

  constructor(input: {
    readonly nativePath: string;
    readonly keyPath: string;
    readonly listenAddresses?: readonly string[];
    readonly coordinationRelays?: readonly string[];
  }) {
    this.#nativePath = input.nativePath;
    this.#keyPath = input.keyPath;
    this.#listenAddresses = input.listenAddresses;
    this.#coordinationRelays = input.coordinationRelays;
  }

  identity(): Readonly<{
    peerId: string;
    listenAddresses: readonly string[];
    coordinationRelays: readonly string[];
  }> {
    const endpoint = this.#requireEndpoint();
    return Object.freeze({
      peerId: endpoint.peerId,
      listenAddresses: Object.freeze([...endpoint.listenAddresses]),
      coordinationRelays: Object.freeze([...(this.#coordinationRelays ?? [])]),
    });
  }

  async connect(
    input: RuntimeHostPeerConnectInput,
    signal?: AbortSignal,
  ): Promise<RuntimeHostPeerNativeStream> {
    return this.#connect(input, signal, 'application');
  }

  async connectMeshControl(
    input: RuntimeHostPeerConnectInput,
    signal?: AbortSignal,
  ): Promise<RuntimeHostPeerNativeStream> {
    return this.#connect(input, signal, 'mesh-control');
  }

  serveMeshControl(
    onStream: (stream: RuntimeHostPeerNativeStream) => void,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.#meshConsumer) {
      return Promise.reject(new Error('Runtime Host peer Mesh control is already being served'));
    }
    this.#requireEndpoint();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const serving = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const consumer = { onStream, resolve, reject };
    this.#meshConsumer = consumer;
    const stop = () => {
      if (this.#meshConsumer !== consumer) return;
      this.#meshConsumer = undefined;
      resolve();
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    return serving.finally(() => {
      signal.removeEventListener('abort', stop);
      if (this.#meshConsumer === consumer) this.#meshConsumer = undefined;
    });
  }

  async #connect(
    input: RuntimeHostPeerConnectInput,
    signal: AbortSignal | undefined,
    kind: 'application' | 'mesh-control',
  ): Promise<RuntimeHostPeerNativeStream> {
    signal?.throwIfAborted();
    const endpoint = this.#requireEndpoint();
    const requestId = this.#allocateRequestId();
    const connection = endpoint[kind === 'application' ? 'connect' : 'connectMeshControl']({
      ...input,
      requestId,
    });
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
      ...(this.#listenAddresses ? { listenAddresses: this.#listenAddresses } : {}),
      ...(this.#coordinationRelays ? { coordinationRelays: this.#coordinationRelays } : {}),
    });
    this.#endpoint = endpoint;
    this.#draining = this.#drainInbound(endpoint);
    this.#meshDraining = this.#drainMeshInbound(endpoint);
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

  async #drainMeshInbound(endpoint: RuntimeHostPeerNativeEndpoint): Promise<void> {
    try {
      while (true) {
        const stream = await endpoint.acceptMeshControl();
        if (!stream) {
          const error = new Error('Runtime Host peer networking stopped unexpectedly');
          if (!this.#closed) this.#terminalError = error;
          this.#finishMeshConsumer(this.#closed ? undefined : error);
          return;
        }
        const consumer = this.#meshConsumer;
        if (consumer) consumer.onStream(stream);
        else stream.abort();
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!this.#closed) this.#terminalError = failure;
      this.#finishMeshConsumer(this.#closed ? undefined : failure);
    }
  }

  #finishMeshConsumer(error?: Error): void {
    const consumer = this.#meshConsumer;
    if (!consumer) return;
    this.#meshConsumer = undefined;
    if (error) consumer.reject(error);
    else consumer.resolve();
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
    await Promise.all([this.#draining, this.#meshDraining]);
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
