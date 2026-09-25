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
  requireCount,
  requireId,
  requireRecord,
  requireString,
  requireShapedRecord,
  requireExactRecord,
} from './codec.js';
import { invalidProtocolFrame, RuntimeHostProtocolError } from './errors.js';
import {
  decodeHostActivitySnapshot,
  requireHostLifecycleState,
  type HostActivitySnapshot,
} from './host-status.js';
import {
  decodeSubscriptionFrame,
  isSubscriptionFrameKind,
  type SubscriptionFrame,
} from './session-continuity.js';
import {
  decodeClientCapabilityClientFrame,
  decodeClientCapabilityHostFrame,
  isClientCapabilityClientFrameKind,
  isClientCapabilityHostFrameKind,
  type ClientCapabilityClientFrame,
  type ClientCapabilityHostFrame,
} from './client-capability.js';
import {
  decodeConfigurationChangedFrame,
  type ConfigurationChangedFrame,
} from './configuration-change.js';
import {
  decodeSessionCatalogChangedFrame,
  type SessionCatalogChangedFrame,
} from './session-catalog-change.js';
import {
  decodeScheduledTaskChangedFrame,
  type ScheduledTaskChangedFrame,
} from './scheduled-task-change.js';
import { decodePluginClientChangedFrame, type PluginClientChangedFrame } from './plugin-client.js';
import {
  decodePluginPlatformChangedFrame,
  type PluginPlatformChangedFrame,
  decodePluginTerminalChangedFrame,
  type PluginTerminalChangedFrame,
} from './plugin-platform.js';
import {
  decodeProjectCatalogChangedFrame,
  type ProjectCatalogChangedFrame,
} from './project-catalog-change.js';
import {
  decodeConnectionCatalogChangedFrame,
  type ConnectionCatalogChangedFrame,
} from './connection-catalog-change.js';
import {
  decodeRequestFrame,
  decodeResponseFrame,
  type HostLifecycleState,
  type RequestFrame,
  type ResponseFrame,
} from './operations.js';
import { isCanonicalRuntimeHostWebSocketPath } from './websocket-path.js';
import {
  decodeModelProviderCatalogChangedFrame,
  type ModelProviderCatalogChangedFrame,
} from './model-provider.js';

export * from './access-authority.js';
export * from './agent-graph.js';
export * from './interaction.js';
export * from './daily-review.js';
export * from './client-capability.js';
export * from './configuration-change.js';
export * from './connection-catalog-change.js';
export * from './goal.js';
export * from './hosted-execution.js';
export * from './host-resources.js';
export * from './plan.js';
export * from './peer-mesh.js';
export * from './project-catalog.js';
export * from './project-catalog-change.js';
export * from './execution-inspect.js';
export * from './external-session.js';
export * from './message.js';
export * from './model-provider.js';
export * from './operations.js';
export * from './runtime-resource.js';
export * from './session-continuity.js';
export * from './session-catalog-change.js';
export * from './session-collaboration.js';
export * from './scheduled-task-change.js';
export * from './session-retirement.js';
export * from './session-transcript.js';
export * from './session-turns.js';
export * from './session-todo.js';
export * from './workspace.js';
export * from './workhub-coordination.js';
export * from './websocket-path.js';

export const RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION = 1 as const;
export const RUNTIME_HOST_PROTOCOL_VERSION = 0 as const;
// Increment when the same protocol version no longer guarantees safe Client-Host
// interoperability. Mismatches are rejected before domain commands are admitted.
// Native bundle bindings and whole-catalog invalidation require matching clients.
export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 195 as const;
export const RUNTIME_HOST_MAX_MESSAGE_BYTES = 768 * 1024;
export const RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS = 64;
export const INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID = 'maka.interactive' as const;

declare const encodedProtocolMessageBrand: unique symbol;

export type EncodedProtocolMessage = Buffer & {
  readonly [encodedProtocolMessageBrand]: true;
};

export interface ProtocolRange {
  min: number;
  max: number;
}

export interface ClientHello {
  kind: 'hello';
  clientInstanceId: string;
  protocolMin: number;
  protocolMax: number;
  compatibilityEpoch: number;
  compositionId: string;
  generation?: string;
  takeover?: { expectedHostEpoch: string };
}

export interface HostAccepted {
  kind: 'accepted';
  rootId: string;
  hostEpoch: string;
  connectionId: string;
  selectedProtocol: number;
  compatibilityEpoch: number;
  compositionId: string;
  compositionRevision: string;
  state: Exclude<HostLifecycleState, 'draining'>;
  cooperativeHandoff?: true;
}

export interface HostIncompatible {
  kind: 'incompatible';
  hostEpoch: string;
  protocolMin: number;
  protocolMax: number;
  compatibilityEpoch: number;
  compositionId: string;
  compositionRevision: string;
  generation?: string;
  state: HostLifecycleState;
  replacement: 'blocked_by_residency' | 'wait_for_idle_exit';
  activity?: HostActivitySnapshot;
}

export interface HostDraining {
  kind: 'draining';
  hostEpoch: string;
  compositionId: string;
  compositionRevision: string;
}

export type HostHandshakeResult = HostAccepted | HostIncompatible | HostDraining;

export type ClientFrame = ClientHello | RequestFrame | ClientCapabilityClientFrame;
export type HostFrame =
  | HostHandshakeResult
  | ResponseFrame
  | SubscriptionFrame
  | ClientCapabilityHostFrame
  | ConfigurationChangedFrame
  | ConnectionCatalogChangedFrame
  | ModelProviderCatalogChangedFrame
  | ProjectCatalogChangedFrame
  | PluginClientChangedFrame
  | PluginPlatformChangedFrame
  | PluginTerminalChangedFrame
  | SessionCatalogChangedFrame
  | ScheduledTaskChangedFrame;

export interface HostRegistration {
  kind: 'maka-runtime-host';
  schemaVersion: typeof RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION;
  rootId: string;
  hostEpoch: string;
  endpoint: string;
  websocketEndpoints?: readonly string[];
  protocolMin: number;
  protocolMax: number;
  compatibilityEpoch: number;
  compositionId: string;
  compositionRevision: string;
  lifecycleMode?: 'ephemeral' | 'service';
  generation?: string;
  state: HostLifecycleState;
  pid: number;
  createdAt: string;
}

export function negotiateProtocol(client: ProtocolRange, host: ProtocolRange): number | undefined {
  validateProtocolRange(client);
  validateProtocolRange(host);
  const selected = Math.min(client.max, host.max);
  return selected >= Math.max(client.min, host.min) ? selected : undefined;
}

export function validateProtocolRange(range: ProtocolRange): void {
  if (
    !Number.isSafeInteger(range.min) ||
    !Number.isSafeInteger(range.max) ||
    range.min < 0 ||
    range.max < range.min
  ) {
    throw invalidProtocolFrame('Invalid protocol range');
  }
}

export function requireClientInstanceId(value: unknown): string {
  return requireId(value, 'clientInstanceId');
}

export function requireHostGeneration(value: unknown): string {
  return requireId(value, 'generation');
}

export function decodeClientFrame(value: unknown): ClientFrame {
  const frame = requireRecord(value, 'client frame');
  if (frame.kind === 'hello') {
    requireShapedRecord(
      frame,
      'Client hello',
      [
        'kind',
        'clientInstanceId',
        'protocolMin',
        'protocolMax',
        'compatibilityEpoch',
        'compositionId',
      ],
      ['generation', 'takeover'],
    );
    const protocolMin = requireProtocolVersion(frame.protocolMin, 'protocolMin');
    const protocolMax = requireProtocolVersion(frame.protocolMax, 'protocolMax');
    validateProtocolRange({ min: protocolMin, max: protocolMax });
    const generation =
      frame.generation === undefined ? undefined : requireHostGeneration(frame.generation);
    const takeover = decodeTakeover(frame.takeover);
    if (takeover !== undefined && generation === undefined) {
      throw invalidProtocolFrame('Runtime Host takeover requires a generation');
    }
    return {
      kind: 'hello',
      clientInstanceId: requireClientInstanceId(frame.clientInstanceId),
      protocolMin,
      protocolMax,
      compatibilityEpoch: requireCompatibilityEpoch(frame.compatibilityEpoch),
      compositionId: requireHostCompositionId(frame.compositionId),
      ...(generation === undefined ? {} : { generation }),
      ...(takeover === undefined ? {} : { takeover }),
    } satisfies ClientHello;
  }
  if (isClientCapabilityClientFrameKind(frame.kind)) {
    return decodeClientCapabilityClientFrame(frame);
  }
  return decodeRequestFrame(frame);
}

export function decodeHostFrame(value: unknown): HostFrame {
  const frame = requireRecord(value, 'host frame');
  if (frame.kind === 'accepted') {
    if (frame.cooperativeHandoff !== undefined && frame.cooperativeHandoff !== true) {
      throw invalidProtocolFrame('Invalid Runtime Host cooperative handoff capability');
    }
    return {
      kind: 'accepted',
      ...(frame.cooperativeHandoff === true ? { cooperativeHandoff: true as const } : {}),
      rootId: requireHostRootId(frame.rootId),
      hostEpoch: requireId(frame.hostEpoch, 'hostEpoch'),
      connectionId: requireId(frame.connectionId, 'connectionId'),
      selectedProtocol: requireProtocolVersion(frame.selectedProtocol, 'selectedProtocol'),
      compatibilityEpoch: requireCompatibilityEpoch(frame.compatibilityEpoch),
      compositionId: requireHostCompositionId(frame.compositionId),
      compositionRevision: requireCompositionRevision(frame.compositionRevision),
      state: requireAcceptedState(frame.state),
    } satisfies HostAccepted;
  }
  if (frame.kind === 'incompatible') {
    const protocolMin = requireProtocolVersion(frame.protocolMin, 'protocolMin');
    const protocolMax = requireProtocolVersion(frame.protocolMax, 'protocolMax');
    validateProtocolRange({ min: protocolMin, max: protocolMax });
    return {
      kind: 'incompatible',
      hostEpoch: requireId(frame.hostEpoch, 'hostEpoch'),
      protocolMin,
      protocolMax,
      compatibilityEpoch: requireCompatibilityEpoch(frame.compatibilityEpoch),
      compositionId: requireHostCompositionId(frame.compositionId),
      compositionRevision: requireCompositionRevision(frame.compositionRevision),
      ...(frame.generation === undefined
        ? {}
        : { generation: requireHostGeneration(frame.generation) }),
      state: requireHostLifecycleState(frame.state),
      replacement: requireReplacement(frame.replacement),
      ...(frame.activity === undefined
        ? {}
        : { activity: decodeHostActivitySnapshot(frame.activity) }),
    } satisfies HostIncompatible;
  }
  if (frame.kind === 'draining') {
    return {
      kind: 'draining',
      hostEpoch: requireId(frame.hostEpoch, 'hostEpoch'),
      compositionId: requireHostCompositionId(frame.compositionId),
      compositionRevision: requireCompositionRevision(frame.compositionRevision),
    };
  }
  if (isSubscriptionFrameKind(frame.kind)) return decodeSubscriptionFrame(frame);
  if (isClientCapabilityHostFrameKind(frame.kind)) {
    return decodeClientCapabilityHostFrame(frame);
  }
  if (frame.kind === 'configuration.changed') return decodeConfigurationChangedFrame(frame);
  if (frame.kind === 'connection.catalog.changed') {
    return decodeConnectionCatalogChangedFrame(frame);
  }
  if (frame.kind === 'project.catalog.changed') return decodeProjectCatalogChangedFrame(frame);
  if (frame.kind === 'plugin.client.changed') return decodePluginClientChangedFrame(frame);
  if (frame.kind === 'plugin.platform.changed') return decodePluginPlatformChangedFrame(frame);
  if (frame.kind === 'plugin.terminal.changed') return decodePluginTerminalChangedFrame(frame);
  if (frame.kind === 'model.provider.catalog.changed')
    return decodeModelProviderCatalogChangedFrame(frame);
  if (frame.kind === 'session.catalog.changed') return decodeSessionCatalogChangedFrame(frame);
  if (frame.kind === 'scheduled-task.changed') return decodeScheduledTaskChangedFrame(frame);
  return decodeResponseFrame(frame);
}

export function decodeHostRegistration(value: unknown): HostRegistration {
  const registration = requireRecord(value, 'host registration');
  if (registration.kind !== 'maka-runtime-host') {
    throw invalidProtocolFrame('Invalid registration kind');
  }
  if (registration.schemaVersion !== RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION) {
    throw invalidProtocolFrame('Unsupported registration schema');
  }
  const protocolMin = requireProtocolVersion(registration.protocolMin, 'protocolMin');
  const protocolMax = requireProtocolVersion(registration.protocolMax, 'protocolMax');
  validateProtocolRange({ min: protocolMin, max: protocolMax });
  const rootId = requireHostRootId(registration.rootId);
  const websocketEndpoints = decodeRegistrationWebSocketEndpoints(registration.websocketEndpoints);
  const pid = requireCount(registration.pid, 'pid');
  if (pid === 0) throw invalidProtocolFrame('Invalid pid');
  return {
    kind: 'maka-runtime-host',
    schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
    rootId,
    hostEpoch: requireId(registration.hostEpoch, 'hostEpoch'),
    endpoint: requireString(registration.endpoint, 'endpoint', 512),
    ...(websocketEndpoints === undefined ? {} : { websocketEndpoints }),
    protocolMin,
    protocolMax,
    compatibilityEpoch: requireCompatibilityEpoch(registration.compatibilityEpoch),
    compositionId: requireHostCompositionId(registration.compositionId),
    compositionRevision: requireCompositionRevision(registration.compositionRevision),
    ...(registration.lifecycleMode === undefined
      ? {}
      : {
          lifecycleMode: requireHostLifecycleMode(registration.lifecycleMode),
        }),
    ...(registration.generation === undefined
      ? {}
      : { generation: requireHostGeneration(registration.generation) }),
    state: requireHostLifecycleState(registration.state),
    pid,
    createdAt: requireString(registration.createdAt, 'createdAt', 64),
  };
}

function decodeRegistrationWebSocketEndpoints(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    throw invalidProtocolFrame('Invalid Runtime Host registration WebSocket endpoints');
  }
  const endpoints = value.map((entry) => {
    const endpoint = requireString(entry, 'Runtime Host WebSocket endpoint', 2_048);
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw invalidProtocolFrame('Invalid Runtime Host registration WebSocket endpoint');
    }
    if (
      url.protocol !== 'ws:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      url.port === '' ||
      url.search ||
      url.hash ||
      !isCanonicalRuntimeHostWebSocketPath(url.pathname)
    ) {
      throw invalidProtocolFrame('Invalid Runtime Host registration WebSocket endpoint');
    }
    return url.toString();
  });
  if (new Set(endpoints).size !== endpoints.length) {
    throw invalidProtocolFrame('Duplicate Runtime Host registration WebSocket endpoint');
  }
  return Object.freeze(endpoints);
}

function requireHostLifecycleMode(value: unknown): 'ephemeral' | 'service' {
  if (value === 'ephemeral' || value === 'service') return value;
  throw invalidProtocolFrame('Invalid Runtime Host lifecycle mode');
}

function decodeTakeover(value: unknown): ClientHello['takeover'] {
  if (value === undefined) return undefined;
  const takeover = requireExactRecord(value, 'Runtime Host takeover', ['expectedHostEpoch']);
  return {
    expectedHostEpoch: requireId(takeover.expectedHostEpoch, 'expectedHostEpoch'),
  };
}

export function encodeProtocolMessage(value: ClientFrame | HostFrame): EncodedProtocolMessage {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8');
  if (encoded.byteLength > RUNTIME_HOST_MAX_MESSAGE_BYTES) {
    throw new RuntimeHostProtocolError(
      'frame_too_large',
      'Runtime Host message exceeds the byte limit',
    );
  }
  return encoded as EncodedProtocolMessage;
}

function requireProtocolVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as number;
}

function requireCompatibilityEpoch(value: unknown): number {
  const epoch = requireProtocolVersion(value, 'compatibilityEpoch');
  if (epoch > 1_000_000) throw invalidProtocolFrame('Invalid compatibilityEpoch');
  return epoch;
}

export function requireHostCompositionId(value: unknown): string {
  const id = requireString(value, 'compositionId', 128);
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id)) {
    throw invalidProtocolFrame('Invalid compositionId');
  }
  return id;
}

export function requireHostRootId(value: unknown): string {
  const rootId = requireString(value, 'rootId', 64);
  if (!/^[a-f0-9]{64}$/.test(rootId)) throw invalidProtocolFrame('Invalid rootId');
  return rootId;
}

function requireCompositionRevision(value: unknown): string {
  const revision = requireString(value, 'compositionRevision', 128);
  if (revision.length === 0 || /[\u0000-\u001f\u007f]/u.test(revision)) {
    throw invalidProtocolFrame('Invalid compositionRevision');
  }
  return revision;
}

function requireAcceptedState(value: unknown): Exclude<HostLifecycleState, 'draining'> {
  const state = requireHostLifecycleState(value);
  if (state === 'draining') throw invalidProtocolFrame('Accepted Host cannot be draining');
  return state;
}

function requireReplacement(value: unknown): HostIncompatible['replacement'] {
  if (value === 'blocked_by_residency' || value === 'wait_for_idle_exit') return value;
  throw invalidProtocolFrame('Invalid replacement disposition');
}
