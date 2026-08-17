import { requireCount, requireId, requireRecord, requireString } from './codec.js';
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
import {
  decodeProjectCatalogChangedFrame,
  type ProjectCatalogChangedFrame,
} from './project-catalog-change.js';
import {
  decodeRequestFrame,
  decodeResponseFrame,
  type HostLifecycleState,
  type RequestFrame,
  type ResponseFrame,
} from './operations.js';

export * from './access-authority.js';
export * from './agent-graph.js';
export * from './interaction.js';
export * from './daily-review.js';
export * from './client-capability.js';
export * from './configuration-change.js';
export * from './goal.js';
export * from './hosted-execution.js';
export * from './plan.js';
export * from './project-catalog.js';
export * from './project-catalog-change.js';
export * from './execution-inspect.js';
export * from './external-session.js';
export * from './message.js';
export * from './operations.js';
export * from './runtime-resource.js';
export * from './session-continuity.js';
export * from './session-catalog-change.js';
export * from './scheduled-task-change.js';
export * from './session-retirement.js';
export * from './session-transcript.js';
export * from './session-turns.js';
export * from './task-ledger.js';
export * from './workspace.js';

export const RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION = 1 as const;
export const RUNTIME_HOST_PROTOCOL_VERSION = 0 as const;
// Increment when the same protocol version no longer guarantees safe Client-Host
// interoperability. Mismatches are rejected before domain commands are admitted.
export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 24 as const;
// Transcript pages amortize storage and network round trips with a 512 KiB raw
// payload. Base64 expansion plus the bounded fragment envelope must still fit in
// one transport message; narrower domains retain their own encoded limits.
export const RUNTIME_HOST_MAX_MESSAGE_BYTES = 768 * 1024;
export const RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS = 64;
export const INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID = 'maka.interactive' as const;

declare const encodedProtocolMessageBrand: unique symbol;

export type EncodedProtocolMessage = Buffer & {
  readonly [encodedProtocolMessageBrand]: true;
};

export type ClientSurface =
  | 'desktop'
  | 'tui'
  | 'run'
  | 'activation'
  | 'bot'
  | 'inspect'
  | 'capability-provider';

export interface ProtocolRange {
  min: number;
  max: number;
}

export interface ClientHello {
  kind: 'hello';
  clientInstanceId: string;
  surface: ClientSurface;
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
  | ProjectCatalogChangedFrame
  | SessionCatalogChangedFrame
  | ScheduledTaskChangedFrame;

export interface HostRegistration {
  kind: 'maka-runtime-host';
  schemaVersion: typeof RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION;
  rootId: string;
  hostEpoch: string;
  endpoint: string;
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
      surface: requireSurface(frame.surface),
      protocolMin,
      protocolMax,
      compatibilityEpoch: decodeCompatibilityEpoch(frame.compatibilityEpoch),
      compositionId: decodeCompositionId(frame.compositionId),
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
    return {
      kind: 'accepted',
      rootId: requireHostRootId(frame.rootId),
      hostEpoch: requireId(frame.hostEpoch, 'hostEpoch'),
      connectionId: requireId(frame.connectionId, 'connectionId'),
      selectedProtocol: requireProtocolVersion(frame.selectedProtocol, 'selectedProtocol'),
      compatibilityEpoch: decodeCompatibilityEpoch(frame.compatibilityEpoch),
      compositionId: decodeCompositionId(frame.compositionId),
      compositionRevision: decodeCompositionRevision(frame.compositionRevision),
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
      compatibilityEpoch: decodeCompatibilityEpoch(frame.compatibilityEpoch),
      compositionId: decodeCompositionId(frame.compositionId),
      compositionRevision: decodeCompositionRevision(frame.compositionRevision),
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
      compositionId: decodeCompositionId(frame.compositionId),
      compositionRevision: decodeCompositionRevision(frame.compositionRevision),
    };
  }
  if (isSubscriptionFrameKind(frame.kind)) return decodeSubscriptionFrame(frame);
  if (isClientCapabilityHostFrameKind(frame.kind)) {
    return decodeClientCapabilityHostFrame(frame);
  }
  if (frame.kind === 'configuration.changed') return decodeConfigurationChangedFrame(frame);
  if (frame.kind === 'project.catalog.changed') return decodeProjectCatalogChangedFrame(frame);
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
  const pid = requireCount(registration.pid, 'pid');
  if (pid === 0) throw invalidProtocolFrame('Invalid pid');
  return {
    kind: 'maka-runtime-host',
    schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
    rootId,
    hostEpoch: requireId(registration.hostEpoch, 'hostEpoch'),
    endpoint: requireString(registration.endpoint, 'endpoint', 512),
    protocolMin,
    protocolMax,
    compatibilityEpoch:
      registration.compatibilityEpoch === undefined
        ? 0
        : requireCompatibilityEpoch(registration.compatibilityEpoch),
    compositionId: decodeCompositionId(registration.compositionId),
    compositionRevision: decodeCompositionRevision(registration.compositionRevision),
    ...(registration.lifecycleMode === undefined
      ? {}
      : { lifecycleMode: requireHostLifecycleMode(registration.lifecycleMode) }),
    ...(registration.generation === undefined
      ? {}
      : { generation: requireHostGeneration(registration.generation) }),
    state: requireHostLifecycleState(registration.state),
    pid,
    createdAt: requireString(registration.createdAt, 'createdAt', 64),
  };
}

function requireHostLifecycleMode(value: unknown): 'ephemeral' | 'service' {
  if (value === 'ephemeral' || value === 'service') return value;
  throw invalidProtocolFrame('Invalid Runtime Host lifecycle mode');
}

function decodeTakeover(value: unknown): ClientHello['takeover'] {
  if (value === undefined) return undefined;
  const takeover = requireRecord(value, 'Runtime Host takeover');
  return { expectedHostEpoch: requireId(takeover.expectedHostEpoch, 'expectedHostEpoch') };
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

function decodeCompositionId(value: unknown): string {
  return value === undefined
    ? INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID
    : requireHostCompositionId(value);
}

function decodeCompositionRevision(value: unknown): string {
  return value === undefined ? 'legacy' : requireCompositionRevision(value);
}

function decodeCompatibilityEpoch(value: unknown): number {
  // Epoch 0 represents peers and registrations that do not publish this field.
  return value === undefined ? 0 : requireCompatibilityEpoch(value);
}

function requireSurface(value: unknown): ClientSurface {
  if (
    value === 'desktop' ||
    value === 'tui' ||
    value === 'run' ||
    value === 'activation' ||
    value === 'bot' ||
    value === 'inspect' ||
    value === 'capability-provider'
  )
    return value;
  throw invalidProtocolFrame('Invalid surface');
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
