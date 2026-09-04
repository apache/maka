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

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { RuntimeHostByteStream } from './framed-byte-stream-transport.js';

const AUTHENTICATION_MAX_BYTES = 12 * 1024;
const AUTHENTICATION_RESULT_MAX_BYTES = 256;
export const RUNTIME_HOST_PEER_AUTHENTICATION_TIMEOUT_MS = 5_000;
const require = createRequire(import.meta.url);

export type RuntimeHostPeerErrorCode =
  | 'peer_identity_mismatch'
  | 'direct_path_unavailable'
  | 'mesh_control_unavailable'
  | 'coordination_unavailable'
  | 'transit_unavailable'
  | 'peer_native_unavailable'
  | 'peer_native_failed'
  | 'peer_connect_in_progress';

export class RuntimeHostPeerError extends Error {
  constructor(
    readonly code: RuntimeHostPeerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostPeerError';
  }
}

export interface RuntimeHostPeerNativeStream {
  readonly peerId: string;
  readonly path?: RuntimeHostPeerConnectionPath;
  read(): Promise<Buffer | null>;
  write(bytes: Buffer): Promise<void>;
  close(): Promise<void>;
  abort(): void;
}

export type RuntimeHostPeerConnectionPath =
  | {
      readonly kind: 'direct';
      readonly transport: 'quic' | 'tcp' | 'webrtc' | 'other';
    }
  | {
      readonly kind: 'transit';
      readonly relayPeerId: string;
    };

export interface RuntimeHostPeerIdentityProof {
  readonly publicKey: Buffer;
  readonly signature: Buffer;
}

export interface RuntimeHostPeerNativeEndpoint {
  readonly peerId: string;
  readonly reachabilitySnapshot: RuntimeHostPeerNativeReachabilitySnapshot;
  readonly connectivitySnapshot: RuntimeHostPeerNativeConnectivitySnapshot;
  readonly transitSnapshot: RuntimeHostPeerTransitSnapshot;
  watchReachability(afterGeneration: number, timeoutMs: number): Promise<number>;
  watchConnectivity(
    afterGeneration: number,
    timeoutMs: number,
  ): Promise<RuntimeHostPeerNativeConnectivitySnapshot>;
  connect(options: {
    readonly requestId: number;
    readonly peerId: string;
    readonly routeHints: readonly string[];
    readonly coordinationRelays?: readonly string[];
    readonly transitRelayPeerIds?: readonly string[];
    readonly directDeadlineMs: number;
  }): Promise<RuntimeHostPeerNativeStream>;
  connectMeshControl(options: {
    readonly requestId: number;
    readonly peerId: string;
    readonly routeHints: readonly string[];
    readonly coordinationRelays?: readonly string[];
    readonly transitRelayPeerIds?: readonly string[];
    readonly directDeadlineMs: number;
  }): Promise<RuntimeHostPeerNativeStream>;
  updateConnect(options: {
    readonly requestId: number;
    readonly routeHints: readonly string[];
    readonly coordinationRelays?: readonly string[];
    readonly transitRelayPeerIds?: readonly string[];
  }): Promise<boolean>;
  configureTransit(options: {
    readonly allowedPeerIds: readonly string[];
    readonly approvedRelayPeerIds: readonly string[];
    readonly relayCandidates: readonly RuntimeHostPeerTransitRelayCandidate[];
  }): Promise<void>;
  cancelConnect(requestId: number): Promise<boolean>;
  accept(): Promise<RuntimeHostPeerNativeStream | null>;
  acceptMeshControl(): Promise<RuntimeHostPeerNativeStream | null>;
  close(): Promise<void>;
}

export interface RuntimeHostPeerNativeReachabilitySnapshot {
  readonly generation: number;
  readonly listenAddresses: readonly string[];
  readonly activeCoordinationRelays: readonly string[];
}

export interface RuntimeHostPeerNativeConnectivitySnapshot {
  readonly generation: number;
  readonly connectedPeerIds: readonly string[];
}

export interface RuntimeHostPeerTransitSnapshot {
  readonly allowedPeerCount: number;
  readonly activeReservationCount: number;
  readonly activeCircuitCount: number;
  readonly maxReservationCount: number;
  readonly maxCircuitCount: number;
  readonly maxCircuitsPerPeer: number;
  readonly maxCircuitDurationSeconds: number;
  readonly maxCircuitBytes: number;
}

export interface RuntimeHostPeerTransitRelayCandidate {
  readonly peerId: string;
  readonly addresses: readonly string[];
  readonly coordinationRelays: readonly string[];
}

interface RuntimeHostPeerNativeModule {
  ensurePeerIdentity(keyPath: string): Promise<string>;
  signPeerIdentity(
    keyPath: string,
    expectedPeerId: string,
    payload: Buffer,
  ): Promise<RuntimeHostPeerIdentityProof>;
  verifyPeerIdentity(
    peerId: string,
    publicKey: Buffer,
    payload: Buffer,
    signature: Buffer,
  ): boolean;
  startPeerEndpoint(options: {
    readonly keyPath: string;
    readonly relayAnchorPath?: string;
    readonly expectedPeerId?: string;
    readonly listenAddresses?: readonly string[];
    readonly coordinationRelays?: readonly string[];
    readonly automaticRelayDiscovery?: boolean;
    readonly webRtcStunUrls?: readonly string[];
  }): unknown;
}

export async function signRuntimeHostPeerIdentity(input: {
  readonly nativePath: string;
  readonly keyPath: string;
  readonly expectedPeerId: string;
  readonly payload: Buffer;
}): Promise<RuntimeHostPeerIdentityProof> {
  try {
    const proof = await loadNativeModule(input.nativePath).signPeerIdentity(
      input.keyPath,
      input.expectedPeerId,
      input.payload,
    );
    if (!isPeerIdentityProof(proof)) {
      throw new RuntimeHostPeerError(
        'peer_native_failed',
        'Native peer identity signature is invalid',
      );
    }
    return Object.freeze({
      publicKey: Buffer.from(proof.publicKey),
      signature: Buffer.from(proof.signature),
    });
  } catch (error) {
    throw normalizePeerError(error);
  }
}

export function verifyRuntimeHostPeerIdentity(input: {
  readonly nativePath: string;
  readonly peerId: string;
  readonly publicKey: Buffer;
  readonly payload: Buffer;
  readonly signature: Buffer;
}): boolean {
  try {
    return loadNativeModule(input.nativePath).verifyPeerIdentity(
      input.peerId,
      input.publicKey,
      input.payload,
      input.signature,
    );
  } catch (error) {
    throw normalizePeerError(error);
  }
}

export async function ensureRuntimeHostPeerIdentity(input: {
  readonly nativePath: string;
  readonly keyPath: string;
}): Promise<string> {
  try {
    const peerId = await loadNativeModule(input.nativePath).ensurePeerIdentity(input.keyPath);
    if (!isPeerId(peerId)) {
      throw new RuntimeHostPeerError('peer_native_failed', 'Native peer identity is invalid');
    }
    return peerId;
  } catch (error) {
    throw normalizePeerError(error);
  }
}

export function startRuntimeHostPeerEndpoint(input: {
  readonly nativePath: string;
  readonly keyPath: string;
  readonly relayAnchorPath?: string;
  readonly expectedPeerId?: string;
  readonly listenAddresses?: readonly string[];
  readonly coordinationRelays?: readonly string[];
  readonly automaticRelayDiscovery?: boolean;
  readonly webRtcStunUrls?: readonly string[];
}): RuntimeHostPeerNativeEndpoint {
  try {
    const endpoint = loadNativeModule(input.nativePath).startPeerEndpoint({
      keyPath: input.keyPath,
      ...(input.relayAnchorPath ? { relayAnchorPath: input.relayAnchorPath } : {}),
      ...(input.expectedPeerId ? { expectedPeerId: input.expectedPeerId } : {}),
      ...(input.listenAddresses ? { listenAddresses: input.listenAddresses } : {}),
      ...(input.coordinationRelays ? { coordinationRelays: input.coordinationRelays } : {}),
      ...(input.automaticRelayDiscovery === undefined
        ? {}
        : { automaticRelayDiscovery: input.automaticRelayDiscovery }),
      ...(input.webRtcStunUrls === undefined ? {} : { webRtcStunUrls: input.webRtcStunUrls }),
    });
    if (!isPeerNativeEndpoint(endpoint)) {
      throw new RuntimeHostPeerError(
        'peer_native_unavailable',
        'Runtime Host peer native endpoint has an incompatible API',
      );
    }
    return endpoint;
  } catch (error) {
    throw normalizePeerError(error);
  }
}

function loadNativeModule(path: string): RuntimeHostPeerNativeModule {
  const nativePath = resolve(path);
  let loaded: unknown;
  try {
    loaded = require(nativePath);
  } catch (error) {
    throw new RuntimeHostPeerError(
      'peer_native_unavailable',
      `Runtime Host peer native module could not be loaded: ${nativePath}`,
      { cause: asError(error) },
    );
  }
  if (!isPeerNativeModule(loaded)) {
    throw new RuntimeHostPeerError(
      'peer_native_unavailable',
      'Runtime Host peer native module has an incompatible API',
    );
  }
  return loaded;
}

export async function writeRuntimeHostPeerAuthentication(
  stream: RuntimeHostPeerNativeStream,
  credential: string,
): Promise<void> {
  if (!credential || /\s/u.test(credential)) {
    throw new RuntimeHostPeerError(
      'peer_native_failed',
      'Runtime Host access credential is invalid',
    );
  }
  await stream.write(Buffer.from(`${JSON.stringify({ v: 1, credential })}\n`, 'utf8'));
}

export async function writeRuntimeHostPeerAuthenticationResult(
  stream: RuntimeHostPeerNativeStream,
  accepted: boolean,
): Promise<void> {
  await stream.write(Buffer.from(`${JSON.stringify({ v: 1, accepted })}\n`, 'utf8'));
}

export async function readRuntimeHostPeerAuthentication(
  stream: RuntimeHostPeerNativeStream,
): Promise<{ readonly credential: string; readonly remainder: Buffer }> {
  const decoded = await readBoundedJsonLine(
    stream,
    AUTHENTICATION_MAX_BYTES,
    'Peer authentication preface',
  );
  if (!isAuthenticationPreface(decoded.value)) {
    throw new RuntimeHostPeerError('peer_native_failed', 'Peer authentication preface is invalid');
  }
  return { credential: decoded.value.credential, remainder: decoded.remainder };
}

export async function readRuntimeHostPeerAuthenticationResult(
  stream: RuntimeHostPeerNativeStream,
  timeoutMs = RUNTIME_HOST_PEER_AUTHENTICATION_TIMEOUT_MS,
): Promise<{ readonly accepted: boolean; readonly remainder: Buffer }> {
  const decoded = await withStreamDeadline(
    readBoundedJsonLine(stream, AUTHENTICATION_RESULT_MAX_BYTES, 'Peer authentication result'),
    stream,
    timeoutMs,
    'Timed out waiting for peer authentication result',
  );
  if (!isAuthenticationResult(decoded.value)) {
    throw new RuntimeHostPeerError('peer_native_failed', 'Peer authentication result is invalid');
  }
  return { accepted: decoded.value.accepted, remainder: decoded.remainder };
}

async function readBoundedJsonLine(
  stream: RuntimeHostPeerNativeStream,
  maxBytes: number,
  label: string,
): Promise<{ readonly value: unknown; readonly remainder: Buffer }> {
  let buffered = Buffer.alloc(0);
  while (true) {
    const newline = buffered.indexOf(0x0a);
    if (newline !== -1) {
      if (newline > maxBytes) {
        throw new RuntimeHostPeerError('peer_native_failed', `${label} is too large`);
      }
      const encoded = buffered.subarray(0, newline);
      return {
        value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded)) as unknown,
        remainder: buffered.subarray(newline + 1),
      };
    }
    if (buffered.byteLength >= maxBytes) {
      throw new RuntimeHostPeerError('peer_native_failed', `${label} is too large`);
    }
    const chunk = await stream.read();
    if (!chunk) {
      throw new RuntimeHostPeerError('peer_native_failed', `Peer stream ended before ${label}`);
    }
    buffered = buffered.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk]);
  }
}

export class RuntimeHostPeerByteStream implements RuntimeHostByteStream {
  readonly closed: Promise<void>;
  readonly #dataListeners = new Set<(chunk: Buffer) => void>();
  readonly #endListeners = new Set<() => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  readonly #stream: RuntimeHostPeerNativeStream;
  readonly #initialData: Buffer;
  #resolveClosed!: () => void;
  #resume: (() => void) | undefined;
  #paused = false;
  #closed = false;

  constructor(stream: RuntimeHostPeerNativeStream, initialData: Buffer = Buffer.alloc(0)) {
    this.#stream = stream;
    this.#initialData = initialData;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    queueMicrotask(() => void this.#pump());
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.#dataListeners.add(listener);
  }

  onEnd(listener: () => void): void {
    this.#endListeners.add(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.#errorListeners.add(listener);
  }

  async write(chunk: Buffer): Promise<void> {
    try {
      await this.#stream.write(chunk);
    } catch (error) {
      throw normalizePeerError(error);
    }
  }

  closeAfterFlush(): void {
    void this.#stream.close().catch((error) => this.#emitError(normalizePeerError(error)));
  }

  abort(): void {
    this.#stream.abort();
    this.#finish();
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
    this.#resume?.();
    this.#resume = undefined;
  }

  async #pump(): Promise<void> {
    try {
      if (this.#initialData.byteLength > 0) this.#emitData(this.#initialData);
      while (!this.#closed) {
        if (this.#paused) {
          await new Promise<void>((resolve) => {
            this.#resume = resolve;
          });
          if (this.#closed) return;
        }
        const chunk = await this.#stream.read();
        if (!chunk) {
          for (const listener of this.#endListeners) listener();
          return;
        }
        this.#emitData(chunk);
      }
    } catch (error) {
      this.#emitError(normalizePeerError(error));
    } finally {
      this.#finish();
    }
  }

  #emitData(chunk: Buffer): void {
    for (const listener of this.#dataListeners) listener(chunk);
  }

  #emitError(error: Error): void {
    for (const listener of this.#errorListeners) listener(error);
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#resume?.();
    this.#resolveClosed();
  }
}

export function normalizePeerError(error: unknown): RuntimeHostPeerError {
  if (error instanceof RuntimeHostPeerError) return error;
  const cause = asError(error);
  const match =
    /^(peer_[a-z_]+|direct_path_unavailable|mesh_control_unavailable|coordination_unavailable|transit_unavailable):\s*(.*)$/su.exec(
      cause.message,
    );
  if (match && isPeerErrorCode(match[1])) {
    return new RuntimeHostPeerError(match[1], match[2] || match[1], { cause });
  }
  return new RuntimeHostPeerError('peer_native_failed', cause.message, { cause });
}

function isPeerNativeModule(value: unknown): value is RuntimeHostPeerNativeModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ensurePeerIdentity' in value &&
    typeof value.ensurePeerIdentity === 'function' &&
    'signPeerIdentity' in value &&
    typeof value.signPeerIdentity === 'function' &&
    'verifyPeerIdentity' in value &&
    typeof value.verifyPeerIdentity === 'function' &&
    'startPeerEndpoint' in value &&
    typeof value.startPeerEndpoint === 'function'
  );
}

function isPeerIdentityProof(value: unknown): value is RuntimeHostPeerIdentityProof {
  return (
    typeof value === 'object' &&
    value !== null &&
    'publicKey' in value &&
    Buffer.isBuffer(value.publicKey) &&
    value.publicKey.byteLength > 0 &&
    value.publicKey.byteLength <= 256 &&
    'signature' in value &&
    Buffer.isBuffer(value.signature) &&
    value.signature.byteLength > 0 &&
    value.signature.byteLength <= 256
  );
}

function isPeerNativeEndpoint(value: unknown): value is RuntimeHostPeerNativeEndpoint {
  return (
    typeof value === 'object' &&
    value !== null &&
    'peerId' in value &&
    isPeerId(value.peerId) &&
    'reachabilitySnapshot' in value &&
    isPeerReachabilitySnapshot(value.reachabilitySnapshot) &&
    'connectivitySnapshot' in value &&
    isPeerConnectivitySnapshot(value.connectivitySnapshot) &&
    'transitSnapshot' in value &&
    isPeerTransitSnapshot(value.transitSnapshot) &&
    'connect' in value &&
    typeof value.connect === 'function' &&
    'connectMeshControl' in value &&
    typeof value.connectMeshControl === 'function' &&
    'updateConnect' in value &&
    typeof value.updateConnect === 'function' &&
    'configureTransit' in value &&
    typeof value.configureTransit === 'function' &&
    'watchReachability' in value &&
    typeof value.watchReachability === 'function' &&
    'watchConnectivity' in value &&
    typeof value.watchConnectivity === 'function' &&
    'cancelConnect' in value &&
    typeof value.cancelConnect === 'function' &&
    'accept' in value &&
    typeof value.accept === 'function' &&
    'acceptMeshControl' in value &&
    typeof value.acceptMeshControl === 'function' &&
    'close' in value &&
    typeof value.close === 'function'
  );
}

function isPeerConnectivitySnapshot(
  value: unknown,
): value is RuntimeHostPeerNativeConnectivitySnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    'generation' in value &&
    isCount(value.generation) &&
    'connectedPeerIds' in value &&
    Array.isArray(value.connectedPeerIds) &&
    value.connectedPeerIds.every((peerId) => typeof peerId === 'string')
  );
}

function isPeerReachabilitySnapshot(
  value: unknown,
): value is RuntimeHostPeerNativeReachabilitySnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    'generation' in value &&
    isCount(value.generation) &&
    'listenAddresses' in value &&
    Array.isArray(value.listenAddresses) &&
    value.listenAddresses.every((address) => typeof address === 'string') &&
    'activeCoordinationRelays' in value &&
    Array.isArray(value.activeCoordinationRelays) &&
    value.activeCoordinationRelays.every((address) => typeof address === 'string')
  );
}

function isPeerTransitSnapshot(value: unknown): value is RuntimeHostPeerTransitSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    'allowedPeerCount' in value &&
    isCount(value.allowedPeerCount) &&
    'activeReservationCount' in value &&
    isCount(value.activeReservationCount) &&
    'activeCircuitCount' in value &&
    isCount(value.activeCircuitCount) &&
    'maxReservationCount' in value &&
    isCount(value.maxReservationCount) &&
    'maxCircuitCount' in value &&
    isCount(value.maxCircuitCount) &&
    'maxCircuitsPerPeer' in value &&
    isCount(value.maxCircuitsPerPeer) &&
    'maxCircuitDurationSeconds' in value &&
    isCount(value.maxCircuitDurationSeconds) &&
    'maxCircuitBytes' in value &&
    isCount(value.maxCircuitBytes)
  );
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isAuthenticationPreface(value: unknown): value is { v: 1; credential: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    'v' in value &&
    value.v === 1 &&
    'credential' in value &&
    typeof value.credential === 'string' &&
    value.credential.length > 0 &&
    !/\s/u.test(value.credential)
  );
}

function isAuthenticationResult(value: unknown): value is { v: 1; accepted: boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    'v' in value &&
    value.v === 1 &&
    'accepted' in value &&
    typeof value.accepted === 'boolean'
  );
}

async function withStreamDeadline<T>(
  operation: Promise<T>,
  stream: RuntimeHostPeerNativeStream,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          stream.abort();
          reject(new RuntimeHostPeerError('peer_native_failed', message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isPeerErrorCode(value: string | undefined): value is RuntimeHostPeerErrorCode {
  return (
    value === 'peer_identity_mismatch' ||
    value === 'direct_path_unavailable' ||
    value === 'mesh_control_unavailable' ||
    value === 'coordination_unavailable' ||
    value === 'transit_unavailable' ||
    value === 'peer_native_unavailable' ||
    value === 'peer_native_failed' ||
    value === 'peer_connect_in_progress'
  );
}

function isPeerId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
