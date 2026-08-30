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
  signRuntimeHostPeerIdentity,
  startRuntimeHostPeerEndpoint,
  verifyRuntimeHostPeerIdentity,
  type RuntimeHostPeerIdentityProof,
  type RuntimeHostPeerNativeEndpoint,
  type RuntimeHostPeerNativeStream,
  type RuntimeHostPeerTransitRelayCandidate,
  type RuntimeHostPeerTransitSnapshot,
} from '../transport/peer-native.js';
import { RuntimeHostPermanentReconnectError } from './reconnect-lifecycle.js';

export interface RuntimeHostPeerConnectInput {
  readonly peerId: string;
  readonly routeHints: readonly string[];
  readonly coordinationRelays?: readonly string[];
  readonly transitRelayPeerIds?: readonly string[];
  readonly directDeadlineMs: number;
}

export interface RuntimeHostPeerRouteResolver {
  resolveRoutes(peerId: string):
    | {
        readonly routeHints: readonly string[];
        readonly coordinationRelays: readonly string[];
        readonly transitRelayPeerIds?: readonly string[];
      }
    | undefined;
}

export interface RuntimeHostPeerClient {
  identity(): Readonly<{
    peerId: string;
    listenAddresses: readonly string[];
    coordinationRelays: readonly string[];
  }>;
  signIdentity(payload: Buffer): Promise<RuntimeHostPeerIdentityProof>;
  verifyIdentity(peerId: string, payload: Buffer, proof: RuntimeHostPeerIdentityProof): boolean;
  transitSnapshot(): RuntimeHostPeerTransitSnapshot;
  configureTransit(input: {
    readonly allowedPeerIds: readonly string[];
    readonly relayCandidates: readonly RuntimeHostPeerTransitRelayCandidate[];
  }): Promise<void>;
  connect(
    input: RuntimeHostPeerConnectInput,
    signal?: AbortSignal,
  ): Promise<RuntimeHostPeerNativeStream>;
  connectMeshControl(
    input: RuntimeHostPeerConnectInput,
    signal?: AbortSignal,
  ): Promise<RuntimeHostPeerNativeStream>;
  serveApplication(
    onStream: (stream: RuntimeHostPeerNativeStream) => void,
    signal: AbortSignal,
  ): Promise<void>;
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
    readonly automaticRelayDiscovery?: boolean;
    readonly routeResolver?: RuntimeHostPeerRouteResolver;
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
  readonly expectedPeerId?: string;
  readonly listenAddresses?: readonly string[];
  readonly coordinationRelays?: readonly string[];
  readonly automaticRelayDiscovery?: boolean;
  readonly routeResolver?: RuntimeHostPeerRouteResolver;
}): RuntimeHostPeerClient {
  return new RuntimeHostPeerClientImpl(input);
}

class RuntimeHostPeerClientImpl implements RuntimeHostPeerClient {
  readonly #nativePath: string;
  readonly #keyPath: string;
  readonly #expectedPeerId: string | undefined;
  readonly #listenAddresses: readonly string[] | undefined;
  readonly #coordinationRelays: readonly string[] | undefined;
  readonly #automaticRelayDiscovery: boolean;
  readonly #routeResolver: RuntimeHostPeerRouteResolver | undefined;
  #endpoint: RuntimeHostPeerNativeEndpoint | undefined;
  #draining: Promise<void> | undefined;
  #meshDraining: Promise<void> | undefined;
  #applicationConsumer: InboundConsumer | undefined;
  #meshConsumer: InboundConsumer | undefined;
  #terminalError: Error | undefined;
  readonly #connectTails = new Map<string, Promise<void>>();
  #nextRequestId = 1;
  #closed = false;
  #closeTask: Promise<void> | undefined;

  constructor(input: {
    readonly nativePath: string;
    readonly keyPath: string;
    readonly expectedPeerId?: string;
    readonly listenAddresses?: readonly string[];
    readonly coordinationRelays?: readonly string[];
    readonly automaticRelayDiscovery?: boolean;
    readonly routeResolver?: RuntimeHostPeerRouteResolver;
  }) {
    this.#nativePath = input.nativePath;
    this.#keyPath = input.keyPath;
    this.#expectedPeerId = input.expectedPeerId;
    this.#listenAddresses = input.listenAddresses;
    this.#coordinationRelays = input.coordinationRelays;
    this.#automaticRelayDiscovery = input.automaticRelayDiscovery ?? false;
    this.#routeResolver = input.routeResolver;
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
      coordinationRelays: Object.freeze([...endpoint.activeCoordinationRelays]),
    });
  }

  signIdentity(payload: Buffer): Promise<RuntimeHostPeerIdentityProof> {
    const peerId = this.#requireEndpoint().peerId;
    return signRuntimeHostPeerIdentity({
      nativePath: this.#nativePath,
      keyPath: this.#keyPath,
      expectedPeerId: peerId,
      payload,
    });
  }

  verifyIdentity(peerId: string, payload: Buffer, proof: RuntimeHostPeerIdentityProof): boolean {
    return verifyRuntimeHostPeerIdentity({
      nativePath: this.#nativePath,
      peerId,
      payload,
      publicKey: proof.publicKey,
      signature: proof.signature,
    });
  }

  transitSnapshot(): RuntimeHostPeerTransitSnapshot {
    return Object.freeze({ ...this.#requireEndpoint().transitSnapshot });
  }

  configureTransit(input: {
    readonly allowedPeerIds: readonly string[];
    readonly relayCandidates: readonly RuntimeHostPeerTransitRelayCandidate[];
  }): Promise<void> {
    return this.#requireEndpoint().configureTransit(input);
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

  serveApplication(
    onStream: (stream: RuntimeHostPeerNativeStream) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#serve('application', onStream, signal);
  }

  serveMeshControl(
    onStream: (stream: RuntimeHostPeerNativeStream) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#serve('mesh', onStream, signal);
  }

  #serve(
    kind: 'application' | 'mesh',
    onStream: (stream: RuntimeHostPeerNativeStream) => void,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (kind === 'application' ? this.#applicationConsumer : this.#meshConsumer) {
      return Promise.reject(
        new Error(
          kind === 'application'
            ? 'Runtime Host peer application traffic is already being served'
            : 'Runtime Host peer Mesh control is already being served',
        ),
      );
    }
    this.#requireEndpoint();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const serving = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const consumer = { onStream, resolve, reject };
    if (kind === 'application') this.#applicationConsumer = consumer;
    else this.#meshConsumer = consumer;
    const stop = () => {
      if (kind === 'application') {
        if (this.#applicationConsumer !== consumer) return;
        this.#applicationConsumer = undefined;
      } else {
        if (this.#meshConsumer !== consumer) return;
        this.#meshConsumer = undefined;
      }
      resolve();
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    return serving.finally(() => {
      signal.removeEventListener('abort', stop);
      if (kind === 'application' && this.#applicationConsumer === consumer) {
        this.#applicationConsumer = undefined;
      }
      if (kind === 'mesh' && this.#meshConsumer === consumer) this.#meshConsumer = undefined;
    });
  }

  async #connect(
    input: RuntimeHostPeerConnectInput,
    signal: AbortSignal | undefined,
    kind: 'application' | 'mesh-control',
  ): Promise<RuntimeHostPeerNativeStream> {
    const previous = this.#connectTails.get(input.peerId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    this.#connectTails.set(input.peerId, tail);
    try {
      await waitForPeerConnectTurn(previous, signal);
      return await this.#startConnect(input, signal, kind);
    } finally {
      release();
      void tail.then(() => {
        if (this.#connectTails.get(input.peerId) === tail) this.#connectTails.delete(input.peerId);
      });
    }
  }

  async #startConnect(
    input: RuntimeHostPeerConnectInput,
    signal: AbortSignal | undefined,
    kind: 'application' | 'mesh-control',
  ): Promise<RuntimeHostPeerNativeStream> {
    signal?.throwIfAborted();
    const endpoint = this.#requireEndpoint();
    const requestId = this.#allocateRequestId();
    const discovered =
      kind === 'application' ? this.#routeResolver?.resolveRoutes(input.peerId) : undefined;
    const connection = endpoint[kind === 'application' ? 'connect' : 'connectMeshControl']({
      ...input,
      routeHints: mergeAddresses(discovered?.routeHints ?? [], input.routeHints),
      coordinationRelays: mergeAddresses(
        discovered?.coordinationRelays ?? [],
        input.coordinationRelays,
      ),
      transitRelayPeerIds: mergeValues(
        discovered?.transitRelayPeerIds ?? [],
        input.transitRelayPeerIds,
        64,
      ),
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
      ...(this.#expectedPeerId ? { expectedPeerId: this.#expectedPeerId } : {}),
      ...(this.#listenAddresses ? { listenAddresses: this.#listenAddresses } : {}),
      ...(this.#coordinationRelays ? { coordinationRelays: this.#coordinationRelays } : {}),
      automaticRelayDiscovery: this.#automaticRelayDiscovery,
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
          const error = new Error('Runtime Host peer networking stopped unexpectedly');
          if (!this.#closed) this.#terminalError = error;
          this.#finishConsumer('application', this.#closed ? undefined : error);
          return;
        }
        const consumer = this.#applicationConsumer;
        if (consumer) consumer.onStream(stream);
        else stream.abort();
      }
    } catch (error) {
      // Connection attempts and streams expose a terminal native failure to
      // their existing reconnect owners. This owner never replaces its Swarm.
      this.#terminalError = error instanceof Error ? error : new Error(String(error));
      this.#finishConsumer('application', this.#closed ? undefined : this.#terminalError);
    }
  }

  async #drainMeshInbound(endpoint: RuntimeHostPeerNativeEndpoint): Promise<void> {
    try {
      while (true) {
        const stream = await endpoint.acceptMeshControl();
        if (!stream) {
          const error = new Error('Runtime Host peer networking stopped unexpectedly');
          if (!this.#closed) this.#terminalError = error;
          this.#finishConsumer('mesh', this.#closed ? undefined : error);
          return;
        }
        const consumer = this.#meshConsumer;
        if (consumer) consumer.onStream(stream);
        else stream.abort();
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!this.#closed) this.#terminalError = failure;
      this.#finishConsumer('mesh', this.#closed ? undefined : failure);
    }
  }

  #finishConsumer(kind: 'application' | 'mesh', error?: Error): void {
    const consumer = kind === 'application' ? this.#applicationConsumer : this.#meshConsumer;
    if (!consumer) return;
    if (kind === 'application') this.#applicationConsumer = undefined;
    else this.#meshConsumer = undefined;
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

interface InboundConsumer {
  readonly onStream: (stream: RuntimeHostPeerNativeStream) => void;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function waitForPeerConnectTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

function mergeAddresses(
  primary: readonly string[],
  secondary: readonly string[] | undefined,
): readonly string[] {
  return mergeValues(primary, secondary, 32);
}

function mergeValues(
  primary: readonly string[],
  secondary: readonly string[] | undefined,
  limit: number,
): readonly string[] {
  return Object.freeze([...new Set([...primary, ...(secondary ?? [])])].slice(0, limit));
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
