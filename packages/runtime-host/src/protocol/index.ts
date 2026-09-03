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

export * from './access-authority.js';
export * from './agent-graph.js';
export * from './interaction.js';
export * from './daily-review.js';
export * from './client-capability.js';
export * from './configuration-change.js';
export * from './connection-catalog-change.js';
export * from './goal.js';
export * from './hosted-execution.js';
export * from './plan.js';
export * from './peer-mesh.js';
export * from './project-catalog.js';
export * from './project-catalog-change.js';
export * from './execution-inspect.js';
export * from './external-session.js';
export * from './message.js';
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
export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 107 as const;
// 107: `token_usage` anchors record the model and connection that produced
// them. The record decodes against a closed allowlist, so an older client
// rejects the two new keys and, with them, the Session that carries them.
// 106: Session transcripts gain five `system_note` kinds
// (`context_provider_dropping`, `context_window_suggestion`,
// `context_window_overrun`, `context_reported_window_exceeded`,
// `context_overflow_after_compaction`) and
// `token_usage` records reshape `lastRequestAnchor` to
// `{ inputTokens, outputTokens }`, all behind closed allowlists in
// @maka/core. An older client that handshakes would fail
// `decodeStoredMessage` on the first transcript carrying them, so the pair
// must refuse each other at the handshake instead (#4559).
// 105: Usage summaries may carry the recorded call-time total and per-Session
// tool-invocation totals. Older Clients reject the unknown fields, so a newer
// Host's usage summary is unreadable to them.
// 104: WorkHub Coordination actions add closed direct-stop proposals,
// confirmations, expected-state preconditions, and outcomes. Older peers
// reject these strict shapes.
// 103: `github-copilot` joins `OAUTH_LOGIN_PROVIDERS`, the Host answers the
// closed `oauth.enrollment.query`, and `connection.onboarding.save` admits
// canonical OAuth material with an empty enable-all-discovered selection.
// Older peers reject these wire values, so incompatible pairs must fail the
// handshake. Re-derived from current `main`; epoch 102 is claimed by open PRs.
// 101: Session Turn requests can carry regeneration intents and Guests can
// atomically withdraw pending requests. Older peers do not share this command
// vocabulary or the expanded Guest operation grant.
// 100: `session.branch.create` makes `sourceTurnId` optional, so a side
// conversation can fork with an empty context (no copied messages, no
// fabricated `branchOfTurnId`) instead of requiring a settled turn. An older
// Host's required-field check rejects the request that omits `sourceTurnId`;
// the handshake keeps mixed-version peers apart. `session.revision.create`
// still requires `sourceTurnId`, and its wire shape and fingerprint are
// unchanged.
// 99: ScheduledTask Agent execution templates carry immutable Connection
// identity. Older peers cannot preserve the ID/slug/model binding and could
// silently route a deleted Connection to a same-slug replacement.
// 98: Peer Mesh invitations carry signed reachability leases and member route
// projections use the convergent recovery state machine. Older peers decode a
// different strict wire shape.
// 97: Host status replaces unsigned route arrays with a self-signed, bounded
// reachability lease. Older peers cannot validate the locator revision or its
// target identity before retaining it for reconnect.
// 96: Read image tool results may carry durable `session_context` refs.
// 95: Catalog entries carry `describedByMetadata`, so a client asks the
// Host-resolved entry — not its own bundled table — whether a model needs a
// hand-written capability declaration. The field is required, so a newer Host's
// entry fails an older client's strict decoder, and an older Host's entry
// (lacking it) fails a newer client's.
// 94: A failed Turn snapshot no longer carries contextBudgetExhaustedDetail; the
// retired outcome reads as context_overflow at the ledger boundary, and an older
// Host still sending the field fails a newer client's closed snapshot decode.
// 93: Configuration credential transfer binds proxy destinations and
// Connection credentials to exact Host-owned targets before secret access.
// Proxy policy and credentials commit through one recoverable Host command;
// older peers can split the writes and violate the shared credential basis.
// 92: Owners can query their complete pending Session Turn-request inbox.
// 91: Host status publishes the live Direct peer endpoint so newly issued
// connection invitations do not preserve stale startup routes.
// 90: `session.create.mode` accepts the Bot session mode. A Host that predates
// it rejects the value as an invalid Session start mode.
// 89: The Host refreshes its models.dev catalog at startup and announces the
// swap with a `connection.catalog.changed` frame, which an older client's
// strict frame decoder rejects as an unknown kind.
// 88: Catalog model modalities admit video on either side and pdf as output.
// models.dev declares both, and the modality decoder rejects any value it does
// not name, so a newer Host describing such a model fails an older client's
// catalog decode outright rather than losing one field. The handshake keeps
// that pairing from forming; a newer client simply never sees the new values
// from an older Host.
// 87: The connection catalog projects each model as the Host resolved it —
// a `catalog_entry` item per model, counted by the connection header. Clients
// render those entries instead of merging the stored row against their own
// bundled model metadata, so a Desktop and a TUI attached to one Host cannot
// describe the same model differently. An older client ignores the new items
// but would still resolve locally; an older Host sends none, leaving a newer
// client with an empty catalog. Both are rejected at the handshake.
// 86: Client Capability accepted frames carry typed admission evidence used to
// enforce Session Grant scopes. Older peers cannot preserve that boundary.
// 85: Plugin package and Entry composition operations become Host-owned protocol
// surfaces. Older peers cannot safely exchange these strict operation shapes.
// 84: Message content carries Host-bound directory references. Older peers
// reject this field and cannot preserve its identity through admission/replay.
// 83: WorkHub Coordination actions add linked replacement proposals,
// destructive user confirmation, and replacement results. Older peers reject
// these closed action and result shapes.
// 82: Session removal reports how many linked subtasks it archived, and adds a
// `session.remove.preview` query for that count before the delete. Older peers
// reject the extra removed-result field and the unknown operation.
// 81: SessionTodo replaces the Task Ledger protocol and continuity domain with
// one bounded current-state snapshot. Older peers cannot decode the operation
// or preserve the new invalidation vocabulary.
// 80: Runtime Policy catalog models gained validated user-overridden fact
// provenance. Older peers reject this projected model shape, so they must be
// refused during the handshake before catalog admission.
// 79: Every `turn.message.submit` disposition carries the exact Skill
// invocation outcome. Durable queued replays may omit the previous Host
// Epoch's transient queue revision; older strict peers reject either shape.
// 78: OAuth login targets explicit create/existing Connection entities and
// returns their canonical identity. Older peers reject both closed wire shapes.
// 77: LLM and tool usage-log projections carry an optional `sessionTitle` (the
// Host-resolved session name for the usage Task column). Older Clients reject
// the unknown field, so a newer Host's usage logs are unreadable to them.
// 76: Peer Mesh endpoint and Mesh display names are signed, persisted facts
// managed through Host operations rather than local-only Client labels.
// 75: Peer Mesh routes identify whether a peer is a Client or Runtime Host so
// management surfaces can present the endpoint authority boundary accurately.
// 74: Capability-provider credentials may carry one Host-authenticated owner
// identity. Older peers cannot preserve the association and could select an
// unrelated provider for an interactive Session.
// 73: Transcript pages carry a Host-owned Turn range boundary. Older peers
// cannot preserve both the complete edge Turn and the bounded projection.
// 72: Collaboration Turn request query results require `canRequestTurns`.
// Older peers reject the new closed result shape.
// 71: Session Guests can submit durable exact Turn access requests and Owners
// can decide them. Older peers do not understand this execution-authority flow.
// 70: Session Guest connections receive resource-scoped shared catalog and
// continuity projections. Older peers cannot enforce the Session grant fence.
// 69: Runtime Host access authority recognizes restricted Session Guest
// principals and typed Session collaboration grants. Older Hosts would either
// reject the new operations or misclassify the authenticated principal.
// 68: Connection onboarding replaces nullable canonical-slug targeting with
// explicit create/existing identity and returns the committed Connection.
// Older peers reject the closed target and saved-result shapes.
// 67: Message lifecycle queries expose durable execution ownership and
// cancellation. Older peers cannot decode or provide the closed proof list.
// 66: Peer Mesh queries expose one canonical transit selection and runtime metrics.
// 65: live `tool_start` frames may carry optional `intent` / `argsPreview`
// keys. Older Clients decode the event with a strict allowed-key list and tear
// the connection down on unknown keys, so the pair must be refused up front.
// The strict decoder's allowed-key union also retains `shellRunRef`.
// 64: execution.inspect drops the retired resolve operation. Older peers still
// know execution.inspect.resolve and would send it only to fail mid-connection,
// so removing it needs its own handshake boundary.
// 63: Connection updates accept the full canonical enabled-model limit.
// Older peers reject valid catalogs containing more than 64 enabled models.
// 62: A Direct peer listener can expose owner-only Peer Mesh management
// operations. Older peers do not have this closed operation vocabulary.
// 61: Session explicit model targets carry immutable Connection identity,
// configuration updates are Host-merged patches, and projections expose the
// required nullable binding ID. Older peers cannot preserve these invariants.
// 60: WorkHub stores a canonical delegation assignment record. Older peers
// cannot decode this message during transcript recovery.
// 59: Scheduled Turn provider-retry frames may carry an optional host-clock
// `ts`, letting a mid-wait re-projection recompute the authoritative
// remaining duration. Older peers decode the frame with an exact key list
// and reject the added field, so mixed peers must fail the handshake.
// 58: `runtime.resource.start` accepts an optional one-shot `command`, and the
// durable Shell Run record carries a `visibility` field. An epoch-57 Host
// rejects the widened closed input, while an epoch-57 binary cannot safely
// interpret the widened durable record.
// 57: Parked safe-boundary resume plans preserve feature-disabled, missing
// continuation authority, and unavailable safety-observation reasons.
// Older peers collapse these causes and can misclassify recovery failures.
// 56: Failed Turn snapshots preserve the structured context-budget exhaustion
// detail. Epoch-55 peers reject the optional field on the closed snapshot shape.
// 55: Local owners can atomically revoke every credential for one access
// principal, closing pairing-finalize races that credential-by-ID revocation cannot.
// 54: Client-bound pairing candidates restrict pre-claim authority and bind
// their durable credential to the claiming Client identity; it is also reserved
// by concurrent protocol changes in #3390.
// 53: Message admission answers `turn.message.submit` with an explicit
// disposition, and queued Messages can be proven cancelled. Older peers read the
// answer as a bare acknowledgement and cannot reconcile their own projection.
// 52: Session subscriptions can forward durable steering-message echoes and
// preserve their identity across queue and transcript projection.
// Older peers cannot safely de-duplicate the two authoritative paths.
// 51: WorkHub exposes bounded coordination candidates and admits only typed
// actions through the deterministic Runtime Host Action Gate.
// 50: WorkHub can append durable coordination summaries and admit tool-free
// answers through its reserved Coordination Session authority.
// 49: WorkHub resolves one durable Coordination Session per Runtime Host.
// Older peers do not know the operation or the hidden Session role.
// 48: Session branch creation accepts an explicit Side Conversation intent.
// Older peers reject the strict input shape or cannot apply its snapshot semantics.
// 47: Project registration can carry an explicit location preference. Epoch-46
// hosts reject that optional field on the closed registration input.
// 46: Queued message content can be edited in place (queue.entry.update).
// 45: Connection onboarding inputs require `baseUrl` and `connectionId`, and
// results can carry the `base_url_not_configured` / `connection_not_found`
// rejections. Older peers reject all of these shapes.
// 44: Session continuity and inspection stop carrying the retired Session
// last-used timestamp. Older peers reject those strict projection shapes.
// 43: Session tool-start events correlate hidden shell polls with `shellRunRef`.
// Older peers reject that added closed-union field.
// 42: Turn provider retry progress adds `provider_capacity`. Older peers reject
// that strict retry-reason enum value, so mixed versions must fail handshake.
// 41: Context compaction returns a typed terminal outcome on both Turn
// snapshots and context.compact results. Epoch-40 peers reject these closed
// shapes after admission, so mixed peers must fail during the handshake.
// 40: The message queue gains per-entry mutation operations
// (queue.entry.promote, queue.entry.retract, queue.entries.reorder).
// 39: Client Capability tool descriptors carry trusted activity semantics and
// invocations can stream bounded progress frames.
// 38: `execute` is no longer a permission mode. Frame decoders reject it, so a
// peer that still sends it would fail mid-Session rather than at connect.
// 37: External Session catalog queries carry a search term.
// 36: Session trace inspection no longer transports aggregate TraceTotals.
// 35: Session trace inspection uses cursor pages and Session usage has its own
// invalidation domain. Older peers cannot safely exchange those frames.
// 34: ScheduledTask execution templates no longer emit `backend`. Epoch-33
// Clients require that closed-shape response field, so a newer Host must reject
// them during the handshake instead of failing on the first Automation read.
// 33: Live tool results may carry the bounded sandbox failure reason. Older
// Clients reject that closed-frame addition, so mixed peers must not connect.
// 32: `request_authorization_code` leaves the OAuth presentation wire. An older
// Client still offers it and an older Host still asks for it, and neither side
// can carry the authorization code the other expects.
// 31: `claude-subscription` leaves `OAUTH_LOGIN_PROVIDERS` and the
// `oauth.account.usage.fetch` operation is removed with the provider that
// needed its client identity. An older peer still offers both.
// 30: Access credential pairing adds prepare/finalize operations. Older Hosts
// cannot complete the staged credential handoff used by managed onboarding.
// 29: `goal.arm` is a new wire operation. An older Host decodes it as unknown
// and tears the connection down, so the pair must be refused up front.
// 28: Relay model profiles carry the Fast service-tier declaration. Older
// peers cannot safely preserve that Runtime Policy field.
// 27: Runtime Policy carries the Host-owned shell preference used by tool,
// PTY, and prompt composition. Older peers cannot safely preserve that field.
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
  | ProjectCatalogChangedFrame
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
  if (frame.kind === 'connection.catalog.changed') {
    return decodeConnectionCatalogChangedFrame(frame);
  }
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
    compatibilityEpoch:
      registration.compatibilityEpoch === undefined
        ? 0
        : requireCompatibilityEpoch(registration.compatibilityEpoch),
    compositionId: decodeCompositionId(registration.compositionId),
    compositionRevision: decodeCompositionRevision(registration.compositionRevision),
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
  const takeover = requireRecord(value, 'Runtime Host takeover');
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

function requireAcceptedState(value: unknown): Exclude<HostLifecycleState, 'draining'> {
  const state = requireHostLifecycleState(value);
  if (state === 'draining') throw invalidProtocolFrame('Accepted Host cannot be draining');
  return state;
}

function requireReplacement(value: unknown): HostIncompatible['replacement'] {
  if (value === 'blocked_by_residency' || value === 'wait_for_idle_exit') return value;
  throw invalidProtocolFrame('Invalid replacement disposition');
}
