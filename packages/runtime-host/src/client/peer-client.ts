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
  authenticateSignedPeerReachabilityLease,
  isPeerReachabilityLeaseCurrent,
  isPeerReachabilityLeaseRecoverable,
  PEER_REACHABILITY_MAX_CLOCK_SKEW_MS,
  peerReachabilityLeaseReceipt,
  verifySignedPeerReachabilityLease,
  type PeerReachabilityLeaseReceipt,
  type SignedPeerReachabilityLeaseV1,
} from '../peer-reachability/index.js';
import {
  normalizePeerError,
  RuntimeHostPeerError,
  signRuntimeHostPeerIdentity,
  startRuntimeHostPeerEndpoint,
  verifyRuntimeHostPeerIdentity,
  type RuntimeHostPeerIdentityProof,
  type RuntimeHostPeerNativeEndpoint,
  type RuntimeHostPeerNativeReachabilitySnapshot,
  type RuntimeHostPeerNativeStream,
  type RuntimeHostPeerTransitRelayCandidate,
  type RuntimeHostPeerTransitSnapshot,
} from '../transport/peer-native.js';
import { RuntimeHostPermanentReconnectError } from './reconnect-lifecycle.js';

// One Desktop endpoint can retain 32 Host profiles and 128 guest mounts.
const AUTHENTICATED_REACHABILITY_MAX_ENTRIES = 160;

export interface RuntimeHostPeerConnectInput {
  readonly peerId: string;
  readonly routeHints: readonly string[];
  readonly coordinationRelays?: readonly string[];
  readonly transitRelayPeerIds?: readonly string[];
  readonly directDeadlineMs: number;
  readonly refreshRoutes?: boolean;
}

export type RuntimeHostPeerConnectionPhase = 'discovering' | 'connecting';

interface RuntimeHostPeerRouteCandidateSnapshot {
  readonly routeHints: readonly string[];
  readonly coordinationRelays: readonly string[];
  readonly transitRelayPeerIds: readonly string[];
}

export type RuntimeHostPeerRouteResolution =
  | (RuntimeHostPeerRouteCandidateSnapshot & { readonly state: 'available' })
  | (RuntimeHostPeerRouteCandidateSnapshot & { readonly state: 'recovering' })
  | (RuntimeHostPeerRouteCandidateSnapshot & { readonly state: 'exhausted' });

export interface RuntimeHostPeerRouteResolver {
  resolveRoutes(peerId: string): RuntimeHostPeerRouteResolution;
  prepareRoutes(peerId: string, signal: AbortSignal): Promise<void>;
  subscribeRoutes(peerId: string, listener: () => void): () => void;
}

export class RuntimeHostPeerReachabilityUnavailableError extends Error {
  readonly code = 'peer_reachability_needs_repair';

  constructor(peerId: string) {
    super(`Peer ${peerId} has no usable or recoverable route`);
    this.name = 'RuntimeHostPeerReachabilityUnavailableError';
  }
}

export interface RuntimeHostPeerClient {
  reachability(): RuntimeHostPeerNativeReachabilitySnapshot;
  watchReachability(
    afterGeneration: number,
    timeoutMs: number,
  ): Promise<RuntimeHostPeerNativeReachabilitySnapshot>;
  identity(): Readonly<{
    peerId: string;
  }>;
  signIdentity(payload: Buffer): Promise<RuntimeHostPeerIdentityProof>;
  verifyIdentity(peerId: string, payload: Buffer, proof: RuntimeHostPeerIdentityProof): boolean;
  isConnected(peerId: string): boolean;
  transitSnapshot(): RuntimeHostPeerTransitSnapshot;
  configureTransit(input: {
    readonly allowedPeerIds: readonly string[];
    readonly approvedRelayPeerIds: readonly string[];
    readonly relayCandidates: readonly RuntimeHostPeerTransitRelayCandidate[];
  }): Promise<void>;
  attachRouteResolver(resolver: RuntimeHostPeerRouteResolver): () => void;
  subscribeRoutes(peerId: string, listener: () => void): () => void;
  observeAuthenticatedReachability(input: {
    readonly expectedPeerId: string;
    readonly value: unknown;
    readonly allowHistorical?: boolean;
  }): SignedPeerReachabilityLeaseV1;
  connect(
    input: RuntimeHostPeerConnectInput,
    signal?: AbortSignal,
    onPhase?: (phase: RuntimeHostPeerConnectionPhase) => void,
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
    readonly relayAnchorPath?: string;
    readonly coordinationRelays?: readonly string[];
    readonly automaticRelayDiscovery?: boolean;
    readonly webRtcStunUrls?: readonly string[];
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
  readonly relayAnchorPath?: string;
  readonly expectedPeerId?: string;
  readonly listenAddresses?: readonly string[];
  readonly coordinationRelays?: readonly string[];
  readonly automaticRelayDiscovery?: boolean;
  readonly webRtcStunUrls?: readonly string[];
}): RuntimeHostPeerClient {
  return new RuntimeHostPeerClientImpl(input);
}

class RuntimeHostPeerClientImpl implements RuntimeHostPeerClient {
  readonly #nativePath: string;
  readonly #keyPath: string;
  readonly #relayAnchorPath: string | undefined;
  readonly #expectedPeerId: string | undefined;
  readonly #listenAddresses: readonly string[] | undefined;
  readonly #coordinationRelays: readonly string[] | undefined;
  readonly #automaticRelayDiscovery: boolean;
  readonly #webRtcStunUrls: readonly string[] | undefined;
  #routeResolver: RuntimeHostPeerRouteResolver | undefined;
  readonly #routeListeners = new Map<string, Set<() => void>>();
  readonly #routeResolverSubscriptions = new Map<string, () => void>();
  readonly #authenticatedReachability = new Map<string, AuthenticatedReachability>();
  #endpoint: RuntimeHostPeerNativeEndpoint | undefined;
  #draining: Promise<void> | undefined;
  #meshDraining: Promise<void> | undefined;
  #connectivityDraining: Promise<void> | undefined;
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
    readonly relayAnchorPath?: string;
    readonly expectedPeerId?: string;
    readonly listenAddresses?: readonly string[];
    readonly coordinationRelays?: readonly string[];
    readonly automaticRelayDiscovery?: boolean;
    readonly webRtcStunUrls?: readonly string[];
  }) {
    this.#nativePath = input.nativePath;
    this.#keyPath = input.keyPath;
    this.#relayAnchorPath = input.relayAnchorPath;
    this.#expectedPeerId = input.expectedPeerId;
    this.#listenAddresses = input.listenAddresses;
    this.#coordinationRelays = input.coordinationRelays;
    this.#automaticRelayDiscovery = input.automaticRelayDiscovery ?? false;
    this.#webRtcStunUrls =
      input.webRtcStunUrls === undefined ? undefined : [...input.webRtcStunUrls];
  }

  identity(): Readonly<{
    peerId: string;
  }> {
    return Object.freeze({ peerId: this.#requireEndpoint().peerId });
  }

  reachability(): RuntimeHostPeerNativeReachabilitySnapshot {
    return freezeReachability(this.#requireEndpoint().reachabilitySnapshot);
  }

  async watchReachability(
    afterGeneration: number,
    timeoutMs: number,
  ): Promise<RuntimeHostPeerNativeReachabilitySnapshot> {
    try {
      return freezeReachability(
        await this.#requireEndpoint().watchReachability(afterGeneration, timeoutMs),
      );
    } catch (error) {
      throw normalizePeerError(error);
    }
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

  isConnected(peerId: string): boolean {
    return this.#endpoint?.connectivitySnapshot.connectedPeerIds.includes(peerId) ?? false;
  }

  transitSnapshot(): RuntimeHostPeerTransitSnapshot {
    return Object.freeze({ ...this.#requireEndpoint().transitSnapshot });
  }

  configureTransit(input: {
    readonly allowedPeerIds: readonly string[];
    readonly approvedRelayPeerIds: readonly string[];
    readonly relayCandidates: readonly RuntimeHostPeerTransitRelayCandidate[];
  }): Promise<void> {
    return this.#requireEndpoint()
      .configureTransit(input)
      .catch((error: unknown) => {
        throw normalizePeerError(error);
      });
  }

  attachRouteResolver(resolver: RuntimeHostPeerRouteResolver): () => void {
    if (this.#routeResolver && this.#routeResolver !== resolver) {
      throw new Error('Runtime Host peer client already has a reachability resolver');
    }
    if (this.#routeResolver === resolver) return () => undefined;
    this.#routeResolver = resolver;
    for (const peerId of this.#routeListeners.keys()) {
      this.#subscribeResolver(peerId);
      this.#notifyRouteChange(peerId);
    }
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      if (this.#routeResolver !== resolver) return;
      this.#routeResolver = undefined;
      for (const unsubscribe of this.#routeResolverSubscriptions.values()) unsubscribe();
      this.#routeResolverSubscriptions.clear();
      for (const peerId of this.#routeListeners.keys()) this.#notifyRouteChange(peerId);
    };
  }

  subscribeRoutes(peerId: string, listener: () => void): () => void {
    const listeners = this.#routeListeners.get(peerId) ?? new Set<() => void>();
    const first = listeners.size === 0;
    listeners.add(listener);
    this.#routeListeners.set(peerId, listeners);
    if (first) this.#subscribeResolver(peerId);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      if (listeners.size > 0) return;
      this.#routeListeners.delete(peerId);
      this.#routeResolverSubscriptions.get(peerId)?.();
      this.#routeResolverSubscriptions.delete(peerId);
    };
  }

  observeAuthenticatedReachability(input: {
    readonly expectedPeerId: string;
    readonly value: unknown;
    readonly allowHistorical?: boolean;
  }): SignedPeerReachabilityLeaseV1 {
    const now = Date.now();
    const identity = {
      value: input.value,
      expectedPeerId: input.expectedPeerId,
      verifyIdentity: this.verifyIdentity.bind(this),
    };
    const next = input.allowHistorical
      ? authenticateSignedPeerReachabilityLease(identity)
      : verifySignedPeerReachabilityLease({ ...identity, now });
    this.#pruneAuthenticatedReachability(now);
    let current = this.#authenticatedReachability.get(input.expectedPeerId);
    if (!isPeerReachabilityLeaseRecoverable(next.lease, now)) return current?.signed ?? next;
    if (current && current.signed.lease.revision >= next.lease.revision) {
      if (
        current.signed.lease.revision === next.lease.revision &&
        !sameReachability(current.signed, next)
      ) {
        throw new Error('Peer reachability revision contains conflicting signed facts');
      }
      this.#rememberAuthenticatedReachability(input.expectedPeerId, current);
      return current.signed;
    }
    this.#rememberAuthenticatedReachability(input.expectedPeerId, {
      signed: next,
      ...(next.lease.issuedAt <= now + PEER_REACHABILITY_MAX_CLOCK_SKEW_MS
        ? {
            receipt: peerReachabilityLeaseReceipt({
              signed: next,
              wallNow: now,
              monotonicNow: performance.now(),
            }),
          }
        : {}),
    });
    this.#notifyRouteChange(input.expectedPeerId);
    return next;
  }

  #pruneAuthenticatedReachability(now: number): void {
    for (const [peerId, authenticated] of this.#authenticatedReachability) {
      if (!isPeerReachabilityLeaseRecoverable(authenticated.signed.lease, now)) {
        this.#authenticatedReachability.delete(peerId);
        this.#notifyRouteChange(peerId);
      }
    }
  }

  #rememberAuthenticatedReachability(
    peerId: string,
    authenticated: AuthenticatedReachability,
  ): void {
    this.#authenticatedReachability.delete(peerId);
    this.#authenticatedReachability.set(peerId, authenticated);
    while (this.#authenticatedReachability.size > AUTHENTICATED_REACHABILITY_MAX_ENTRIES) {
      let unobservedPeerId: string | undefined;
      for (const candidatePeerId of this.#authenticatedReachability.keys()) {
        if (this.#routeListeners.has(candidatePeerId)) continue;
        unobservedPeerId = candidatePeerId;
        break;
      }
      const evictedPeerId = unobservedPeerId ?? this.#authenticatedReachability.keys().next().value;
      if (evictedPeerId === undefined) break;
      this.#authenticatedReachability.delete(evictedPeerId);
      this.#notifyRouteChange(evictedPeerId);
    }
  }

  async connect(
    input: RuntimeHostPeerConnectInput,
    signal?: AbortSignal,
    onPhase?: (phase: RuntimeHostPeerConnectionPhase) => void,
  ): Promise<RuntimeHostPeerNativeStream> {
    if (input.refreshRoutes !== false && this.#routeResolver) {
      notifyPhase(onPhase, 'discovering');
    }
    notifyPhase(onPhase, 'connecting');
    return this.#connect(input, signal, 'application');
  }

  async #prepareRoutes(
    input: RuntimeHostPeerConnectInput,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const resolver = this.#routeResolver;
    if (!resolver) return;
    const deadline = AbortSignal.timeout(Math.min(10_000, input.directDeadlineMs));
    const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      await resolver.prepareRoutes(input.peerId, operationSignal);
    } catch {
      // Route preparation enriches an invitation/profile with fresher Mesh
      // routes. It must not suppress explicit routes the caller already has.
      signal?.throwIfAborted();
    }
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
    let settled = false;
    let preparing = Boolean(
      kind === 'application' && input.refreshRoutes !== false && this.#routeResolver,
    );
    const snapshot = () => this.#connectionResolution(input, kind, preparing);
    let resolution = snapshot();
    if (resolution.state === 'exhausted') {
      throw new RuntimeHostPeerReachabilityUnavailableError(input.peerId);
    }
    const requestId = this.#allocateRequestId();
    const attemptLifetime = new AbortController();
    let reachabilityFailure: RuntimeHostPeerReachabilityUnavailableError | undefined;
    let updateTail = Promise.resolve();
    const update = () => {
      if (settled) return;
      const next = snapshot();
      if (sameConnectionResolution(resolution, next)) return;
      const candidatesChanged = !sameCandidates(resolution, next);
      resolution = next;
      if (next.state === 'exhausted') {
        reachabilityFailure ??= new RuntimeHostPeerReachabilityUnavailableError(input.peerId);
        void cancelPeerConnect(endpoint, requestId, () => settled);
        return;
      }
      if (!candidatesChanged) return;
      const candidates = connectCandidates(next);
      updateTail = updateTail.then(
        () => updatePeerConnect(endpoint, requestId, candidates, () => settled),
        () => updatePeerConnect(endpoint, requestId, candidates, () => settled),
      );
      void updateTail.catch(() => undefined);
    };
    const unsubscribe =
      kind === 'application' ? this.subscribeRoutes(input.peerId, update) : undefined;
    let connection: Promise<RuntimeHostPeerNativeStream>;
    try {
      connection = endpoint[kind === 'application' ? 'connect' : 'connectMeshControl']({
        ...input,
        ...connectCandidates(resolution),
        requestId,
      });
    } catch (error) {
      settled = true;
      attemptLifetime.abort();
      unsubscribe?.();
      throw normalizePeerError(error);
    }
    if (preparing) {
      const prepared = this.#prepareRoutes(
        input,
        signal ? AbortSignal.any([signal, attemptLifetime.signal]) : attemptLifetime.signal,
      );
      void prepared.then(
        () => {
          preparing = false;
          update();
        },
        () => {
          preparing = false;
          update();
        },
      );
    }
    const cancel = () => {
      void cancelPeerConnect(endpoint, requestId, () => settled);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const stream = await connection;
      if (reachabilityFailure) {
        stream.abort();
        throw reachabilityFailure;
      }
      if (signal?.aborted) {
        stream.abort();
        signal.throwIfAborted();
      }
      return stream;
    } catch (error) {
      signal?.throwIfAborted();
      if (reachabilityFailure) throw reachabilityFailure;
      throw normalizePeerError(error);
    } finally {
      settled = true;
      attemptLifetime.abort();
      unsubscribe?.();
      signal?.removeEventListener('abort', cancel);
    }
  }

  #connectionResolution(
    input: RuntimeHostPeerConnectInput,
    kind: 'application' | 'mesh-control',
    preparing: boolean,
  ): RuntimeHostPeerConnectResolution {
    const discovered =
      kind === 'application' ? this.#routeResolver?.resolveRoutes(input.peerId) : undefined;
    const rememberedEntry =
      kind === 'application' ? this.#authenticatedReachability.get(input.peerId) : undefined;
    const remembered = rememberedEntry?.signed;
    const authenticated =
      remembered && isPeerReachabilityLeaseRecoverable(remembered.lease, Date.now())
        ? remembered
        : undefined;
    if (remembered && !authenticated) this.#authenticatedReachability.delete(input.peerId);
    const currentAuthenticated = Boolean(
      authenticated &&
        rememberedEntry &&
        isPeerReachabilityLeaseCurrent(authenticated, rememberedEntry.receipt, performance.now()),
    );
    const candidates = {
      routeHints: mergeAddresses(discovered?.routeHints ?? [], [
        ...(currentAuthenticated ? (authenticated?.lease.directRoutes ?? []) : []),
        ...input.routeHints,
        ...(!currentAuthenticated ? (authenticated?.lease.directRoutes ?? []) : []),
      ]),
      coordinationRelays: mergeAddresses(discovered?.coordinationRelays ?? [], [
        ...(currentAuthenticated ? (authenticated?.lease.coordinationRoutes ?? []) : []),
        ...(input.coordinationRelays ?? []),
        ...(!currentAuthenticated ? (authenticated?.lease.coordinationRoutes ?? []) : []),
      ]),
      transitRelayPeerIds: mergeValues(
        discovered?.transitRelayPeerIds ?? [],
        input.transitRelayPeerIds,
        64,
      ),
    };
    const connected =
      this.#endpoint?.connectivitySnapshot.connectedPeerIds.includes(input.peerId) ?? false;
    return Object.freeze({
      ...candidates,
      state:
        hasConnectionCandidates(candidates) || connected
          ? 'available'
          : preparing
            ? 'recovering'
            : (discovered?.state ?? 'exhausted'),
    });
  }

  #subscribeResolver(peerId: string): void {
    if (this.#routeResolverSubscriptions.has(peerId)) return;
    const resolver = this.#routeResolver;
    if (!resolver) return;
    const unsubscribe = resolver.subscribeRoutes(peerId, () => {
      this.#notifyRouteChange(peerId);
    });
    this.#routeResolverSubscriptions.set(peerId, unsubscribe);
  }

  #notifyRouteChange(peerId: string): void {
    for (const listener of this.#routeListeners.get(peerId) ?? []) {
      try {
        listener();
      } catch {
        // Reachability evidence cannot let one observer disrupt the others.
      }
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
      ...(this.#relayAnchorPath ? { relayAnchorPath: this.#relayAnchorPath } : {}),
      ...(this.#expectedPeerId ? { expectedPeerId: this.#expectedPeerId } : {}),
      ...(this.#listenAddresses ? { listenAddresses: this.#listenAddresses } : {}),
      ...(this.#coordinationRelays ? { coordinationRelays: this.#coordinationRelays } : {}),
      automaticRelayDiscovery: this.#automaticRelayDiscovery,
      ...(this.#webRtcStunUrls === undefined ? {} : { webRtcStunUrls: this.#webRtcStunUrls }),
    });
    this.#endpoint = endpoint;
    this.#draining = this.#drainInbound(endpoint);
    this.#meshDraining = this.#drainMeshInbound(endpoint);
    this.#connectivityDraining = this.#drainConnectivity(endpoint);
    return endpoint;
  }

  async #drainConnectivity(endpoint: RuntimeHostPeerNativeEndpoint): Promise<void> {
    let current = endpoint.connectivitySnapshot;
    try {
      while (!this.#closed) {
        const next = await endpoint.watchConnectivity(current.generation, 300_000);
        const previousPeers = new Set(current.connectedPeerIds);
        const nextPeers = new Set(next.connectedPeerIds);
        current = next;
        for (const peerId of new Set([...previousPeers, ...nextPeers])) {
          if (previousPeers.has(peerId) !== nextPeers.has(peerId)) this.#notifyRouteChange(peerId);
        }
      }
    } catch (error) {
      if (this.#closed) return;
      this.#terminalError = error instanceof Error ? error : new Error(String(error));
      this.#finishConsumer('application', this.#terminalError);
      this.#finishConsumer('mesh', this.#terminalError);
    }
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
    for (const unsubscribe of this.#routeResolverSubscriptions.values()) unsubscribe();
    this.#routeResolverSubscriptions.clear();
    this.#routeListeners.clear();
    this.#authenticatedReachability.clear();
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
    await Promise.all([this.#draining, this.#meshDraining, this.#connectivityDraining]);
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

interface AuthenticatedReachability {
  readonly signed: SignedPeerReachabilityLeaseV1;
  readonly receipt?: PeerReachabilityLeaseReceipt;
}

interface RuntimeHostPeerConnectCandidates {
  readonly routeHints: readonly string[];
  readonly coordinationRelays: readonly string[];
  readonly transitRelayPeerIds: readonly string[];
}

interface RuntimeHostPeerConnectResolution extends RuntimeHostPeerConnectCandidates {
  readonly state: RuntimeHostPeerRouteResolution['state'];
}

function notifyPhase(
  observer: ((phase: RuntimeHostPeerConnectionPhase) => void) | undefined,
  phase: RuntimeHostPeerConnectionPhase,
): void {
  try {
    observer?.(phase);
  } catch {
    // Connection progress is diagnostic state and cannot control the connection.
  }
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

function freezeReachability(
  snapshot: RuntimeHostPeerNativeReachabilitySnapshot,
): RuntimeHostPeerNativeReachabilitySnapshot {
  return Object.freeze({
    generation: snapshot.generation,
    listenAddresses: Object.freeze([...snapshot.listenAddresses]),
    activeCoordinationRelays: Object.freeze([...snapshot.activeCoordinationRelays]),
  });
}

function mergeValues(
  primary: readonly string[],
  secondary: readonly string[] | undefined,
  limit: number,
): readonly string[] {
  return Object.freeze([...new Set([...primary, ...(secondary ?? [])])].slice(0, limit));
}

function sameCandidates(
  left: RuntimeHostPeerConnectCandidates,
  right: RuntimeHostPeerConnectCandidates,
): boolean {
  return (
    sameValues(left.routeHints, right.routeHints) &&
    sameValues(left.coordinationRelays, right.coordinationRelays) &&
    sameValues(left.transitRelayPeerIds, right.transitRelayPeerIds)
  );
}

function sameConnectionResolution(
  left: RuntimeHostPeerConnectResolution,
  right: RuntimeHostPeerConnectResolution,
): boolean {
  return left.state === right.state && sameCandidates(left, right);
}

function hasConnectionCandidates(candidates: RuntimeHostPeerConnectCandidates): boolean {
  return (
    candidates.routeHints.length > 0 ||
    candidates.coordinationRelays.length > 0 ||
    candidates.transitRelayPeerIds.length > 0
  );
}

function connectCandidates(
  resolution: RuntimeHostPeerConnectResolution,
): RuntimeHostPeerConnectCandidates {
  return {
    routeHints: resolution.routeHints,
    coordinationRelays: resolution.coordinationRelays,
    transitRelayPeerIds: resolution.transitRelayPeerIds,
  };
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameReachability(
  left: SignedPeerReachabilityLeaseV1,
  right: SignedPeerReachabilityLeaseV1,
): boolean {
  return (
    left.publicKey === right.publicKey &&
    left.signature === right.signature &&
    left.lease.peerId === right.lease.peerId &&
    left.lease.revision === right.lease.revision &&
    left.lease.issuedAt === right.lease.issuedAt &&
    left.lease.expiresAt === right.lease.expiresAt &&
    sameValues(left.lease.directRoutes, right.lease.directRoutes) &&
    sameValues(left.lease.coordinationRoutes, right.lease.coordinationRoutes)
  );
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

async function updatePeerConnect(
  endpoint: RuntimeHostPeerNativeEndpoint,
  requestId: number,
  candidates: RuntimeHostPeerConnectCandidates,
  isSettled: () => boolean,
): Promise<void> {
  try {
    while (!isSettled() && !(await endpoint.updateConnect({ requestId, ...candidates }))) {
      // N-API schedules connect and updates independently. Retry until the
      // engine has observed the request or the connect promise settles.
    }
  } catch {
    // The active connection owns failures; route enrichment is best effort.
  }
}
