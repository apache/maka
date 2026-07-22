import {
  assertExactKeys,
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireId,
  requireRecord,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import {
  decodeSessionMessageQueueProjection,
  type SessionMessageQueueProjection,
} from './message.js';
import { defineOperation } from './operation-spec.js';
import { decodeTurnSnapshot, type TurnSnapshot } from './turn.js';

export const SESSION_CONTINUITY_SCHEMA_VERSION = 1 as const;
export const SESSION_CONTINUITY_SNAPSHOT_MAX_BYTES = 56 * 1024;
export const SESSION_LIVE_DELTA_MAX_BYTES = 16 * 1024;
export const SESSION_TOOL_NAME_MAX_BYTES = 256;
export const SESSION_SUBSCRIPTION_FRAME_MAX_BYTES = 64 * 1024 - 1;

export type SessionLifecycleStatus =
  | 'active'
  | 'running'
  | 'waiting_for_user'
  | 'blocked'
  | 'review'
  | 'done'
  | 'archived'
  | 'aborted';

export interface SessionContinuityIdentity {
  sessionId: string;
  status: SessionLifecycleStatus;
  createdAt: number;
  lastUsedAt: number;
  isArchived: boolean;
  archivedAt?: number;
}

export interface SessionContinuitySnapshot {
  schemaVersion: typeof SESSION_CONTINUITY_SCHEMA_VERSION;
  session: SessionContinuityIdentity;
  projectionRevision: number;
  rootTurn: TurnSnapshot | null;
  queue: SessionMessageQueueProjection;
}

export interface SubscriptionOpenInput {
  sessionId: string;
}

export interface SubscriptionOpenResult {
  hostEpoch: string;
  subscriptionId: string;
  nextSequence: number;
  snapshot: SessionContinuitySnapshot;
}

export interface SubscriptionCloseInput {
  subscriptionId: string;
}

export interface SubscriptionCloseResult {
  subscriptionId: string;
}

interface SubscriptionEnvelope {
  hostEpoch: string;
  subscriptionId: string;
  sequence: number;
}

export interface SessionProjectionFrame extends SubscriptionEnvelope {
  kind: 'subscription.session_projection';
  snapshot: SessionContinuitySnapshot;
}

export interface SessionAssistantDelta {
  kind: 'text' | 'thinking';
  turnId: string;
  runId: string;
  messageId: string;
  text: string;
}

export interface SessionDeltaFrame extends SubscriptionEnvelope {
  kind: 'subscription.session_delta';
  sessionId: string;
  delta: SessionAssistantDelta;
}

interface SessionToolEventIdentity {
  id: string;
  turnId: string;
  ts: number;
  toolUseId: string;
}

export type SessionToolEvent =
  | (SessionToolEventIdentity & {
      type: 'tool_start';
      toolName: string;
      operationId?: string;
      activityKind?:
        | 'read'
        | 'search'
        | 'websearch'
        | 'webfetch'
        | 'edit'
        | 'command'
        | 'explore'
        | 'browser'
        | 'tool';
      displayName?: string;
      stepId?: string;
    })
  | (SessionToolEventIdentity & {
      type: 'tool_output_delta';
      seq: number;
      stream: 'stdout' | 'stderr';
      chunk: string;
      redacted: boolean;
      createdAt: number;
    })
  | (SessionToolEventIdentity & {
      type: 'tool_progress';
      chunk: string;
    })
  | (SessionToolEventIdentity & {
      type: 'tool_result';
      operationId?: string;
      status: 'completed' | 'errored';
      durationMs?: number;
    });

export interface SessionEventFrame extends SubscriptionEnvelope {
  kind: 'subscription.session_event';
  sessionId: string;
  runId: string;
  event: SessionToolEvent;
}

export interface SubscriptionClosedFrame extends SubscriptionEnvelope {
  kind: 'subscription.closed';
  reason: 'slow_consumer' | 'session_removed';
}

export type SubscriptionFrame =
  | SessionProjectionFrame
  | SessionDeltaFrame
  | SessionEventFrame
  | SubscriptionClosedFrame;

const SUBSCRIPTION_OPEN_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'operation_conflict',
  'internal_failure',
] as const;

const SUBSCRIPTION_CLOSE_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'internal_failure',
] as const;

export const SESSION_CONTINUITY_OPERATION_SPECS = {
  'subscription.open': defineOperation({
    mode: 'control',
    availability: 'ready',
    errors: SUBSCRIPTION_OPEN_ERRORS,
    decodeInput: decodeSubscriptionOpenInput,
    decodeOutput: decodeSubscriptionOpenResult,
  }),
  'subscription.close': defineOperation({
    mode: 'control',
    availability: 'ready',
    errors: SUBSCRIPTION_CLOSE_ERRORS,
    decodeInput: decodeSubscriptionCloseInput,
    decodeOutput: decodeSubscriptionCloseResult,
  }),
} as const;

export function decodeSubscriptionFrame(value: unknown): SubscriptionFrame {
  requireEncodedByteLimit(value, 'subscription frame', SESSION_SUBSCRIPTION_FRAME_MAX_BYTES);
  const record = requireRecord(value, 'subscription frame');
  const envelope = decodeEnvelope(record);
  let frame: SubscriptionFrame;
  if (record.kind === 'subscription.session_projection') {
    assertExactKeys(record, 'Session projection frame', [
      'kind',
      'hostEpoch',
      'subscriptionId',
      'sequence',
      'snapshot',
    ]);
    const snapshot = decodeSessionContinuitySnapshot(record.snapshot);
    assertQueueEpoch(snapshot, envelope.hostEpoch);
    frame = { kind: record.kind, ...envelope, snapshot };
  } else if (record.kind === 'subscription.session_delta') {
    assertExactKeys(record, 'Session delta frame', [
      'kind',
      'hostEpoch',
      'subscriptionId',
      'sequence',
      'sessionId',
      'delta',
    ]);
    frame = {
      kind: record.kind,
      ...envelope,
      sessionId: requireEntityId(record.sessionId, 'sessionId'),
      delta: decodeAssistantDelta(record.delta),
    };
  } else if (record.kind === 'subscription.session_event') {
    assertExactKeys(record, 'Session event frame', [
      'kind',
      'hostEpoch',
      'subscriptionId',
      'sequence',
      'sessionId',
      'runId',
      'event',
    ]);
    frame = {
      kind: record.kind,
      ...envelope,
      sessionId: requireEntityId(record.sessionId, 'sessionId'),
      runId: requireEntityId(record.runId, 'runId'),
      event: decodeSessionToolEvent(record.event),
    };
  } else if (record.kind === 'subscription.closed') {
    assertExactKeys(record, 'subscription closed frame', [
      'kind',
      'hostEpoch',
      'subscriptionId',
      'sequence',
      'reason',
    ]);
    if (record.reason !== 'slow_consumer' && record.reason !== 'session_removed') {
      throw invalidProtocolFrame('Invalid subscription close reason');
    }
    frame = { kind: record.kind, ...envelope, reason: record.reason };
  } else {
    throw invalidProtocolFrame('Unknown subscription frame kind');
  }
  return frame;
}

export function isSubscriptionFrameKind(value: unknown): value is SubscriptionFrame['kind'] {
  return (
    value === 'subscription.session_projection' ||
    value === 'subscription.session_delta' ||
    value === 'subscription.session_event' ||
    value === 'subscription.closed'
  );
}

export function decodeSessionContinuitySnapshot(value: unknown): SessionContinuitySnapshot {
  requireEncodedByteLimit(
    value,
    'Session continuity snapshot',
    SESSION_CONTINUITY_SNAPSHOT_MAX_BYTES,
  );
  const record = requireExactRecord(value, 'Session continuity snapshot', [
    'schemaVersion',
    'session',
    'projectionRevision',
    'rootTurn',
    'queue',
  ]);
  if (record.schemaVersion !== SESSION_CONTINUITY_SCHEMA_VERSION) {
    throw invalidProtocolFrame('Unsupported Session continuity snapshot schema');
  }
  const session = decodeSessionContinuityIdentity(record.session);
  const rootTurn = record.rootTurn === null ? null : decodeTurnSnapshot(record.rootTurn);
  if (rootTurn !== null && rootTurn.sessionId !== session.sessionId) {
    throw invalidProtocolFrame('Session continuity root Turn belongs to a different Session');
  }
  return {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session,
    projectionRevision: requirePositiveCount(record.projectionRevision, 'projectionRevision'),
    rootTurn,
    queue: decodeSessionMessageQueueProjection(record.queue),
  };
}

function decodeSubscriptionOpenInput(value: unknown): SubscriptionOpenInput {
  const record = requireExactRecord(value, 'subscription.open input', ['sessionId']);
  return { sessionId: requireEntityId(record.sessionId, 'sessionId') };
}

function decodeSubscriptionOpenResult(value: unknown): SubscriptionOpenResult {
  const record = requireExactRecord(value, 'subscription.open result', [
    'hostEpoch',
    'subscriptionId',
    'nextSequence',
    'snapshot',
  ]);
  const hostEpoch = requireId(record.hostEpoch, 'hostEpoch');
  const snapshot = decodeSessionContinuitySnapshot(record.snapshot);
  assertQueueEpoch(snapshot, hostEpoch);
  return {
    hostEpoch,
    subscriptionId: requireId(record.subscriptionId, 'subscriptionId'),
    nextSequence: requirePositiveCount(record.nextSequence, 'nextSequence'),
    snapshot,
  };
}

function decodeSubscriptionCloseInput(value: unknown): SubscriptionCloseInput {
  const record = requireExactRecord(value, 'subscription.close input', ['subscriptionId']);
  return { subscriptionId: requireId(record.subscriptionId, 'subscriptionId') };
}

function decodeSubscriptionCloseResult(value: unknown): SubscriptionCloseResult {
  const record = requireExactRecord(value, 'subscription.close result', ['subscriptionId']);
  return { subscriptionId: requireId(record.subscriptionId, 'subscriptionId') };
}

function decodeEnvelope(record: Record<string, unknown>): SubscriptionEnvelope {
  return {
    hostEpoch: requireId(record.hostEpoch, 'hostEpoch'),
    subscriptionId: requireId(record.subscriptionId, 'subscriptionId'),
    sequence: requirePositiveCount(record.sequence, 'sequence'),
  };
}

function decodeAssistantDelta(value: unknown): SessionAssistantDelta {
  const record = requireExactRecord(value, 'Session assistant delta', [
    'kind',
    'turnId',
    'runId',
    'messageId',
    'text',
  ]);
  if (record.kind !== 'text' && record.kind !== 'thinking') {
    throw invalidProtocolFrame('Invalid Session assistant delta kind');
  }
  return {
    kind: record.kind,
    turnId: requireEntityId(record.turnId, 'turnId'),
    runId: requireEntityId(record.runId, 'runId'),
    messageId: requireEntityId(record.messageId, 'messageId'),
    text: requireUtf8BoundedString(
      record.text,
      'Session assistant delta text',
      SESSION_LIVE_DELTA_MAX_BYTES,
    ),
  };
}

function decodeSessionToolEvent(value: unknown): SessionToolEvent {
  const record = requireRecord(value, 'Session tool event');
  const identity = {
    id: requireId(record.id, 'Session tool event id'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    ts: requireCount(record.ts, 'Session tool event timestamp'),
    toolUseId: requireId(record.toolUseId, 'toolUseId'),
  };
  if (record.type === 'tool_start') {
    const allowed = [
      'type',
      'id',
      'turnId',
      'ts',
      'toolUseId',
      'toolName',
      'operationId',
      'activityKind',
      'displayName',
      'stepId',
    ];
    assertAllowedKeys(record, 'Session tool start event', allowed);
    assertRequiredKeys(record, 'Session tool start event', [
      'type',
      'id',
      'turnId',
      'ts',
      'toolUseId',
      'toolName',
    ]);
    return {
      type: record.type,
      ...identity,
      toolName: requireUtf8BoundedString(
        record.toolName,
        'Session tool name',
        SESSION_TOOL_NAME_MAX_BYTES,
      ),
      ...(record.operationId === undefined
        ? {}
        : { operationId: requireEntityId(record.operationId, 'operationId') }),
      ...(record.activityKind === undefined
        ? {}
        : { activityKind: requireToolActivityKind(record.activityKind) }),
      ...(record.displayName === undefined
        ? {}
        : {
            displayName: requireUtf8BoundedString(
              record.displayName,
              'Session tool display name',
              SESSION_TOOL_NAME_MAX_BYTES,
            ),
          }),
      ...(record.stepId === undefined ? {} : { stepId: requireEntityId(record.stepId, 'stepId') }),
    };
  }
  if (record.type === 'tool_output_delta') {
    assertExactKeys(record, 'Session tool output delta event', [
      'type',
      'id',
      'turnId',
      'ts',
      'toolUseId',
      'seq',
      'stream',
      'chunk',
      'redacted',
      'createdAt',
    ]);
    if (record.stream !== 'stdout' && record.stream !== 'stderr') {
      throw invalidProtocolFrame('Invalid Session tool output stream');
    }
    if (typeof record.redacted !== 'boolean') {
      throw invalidProtocolFrame('Invalid Session tool output redaction');
    }
    return {
      type: record.type,
      ...identity,
      seq: requireCount(record.seq, 'Session tool output sequence'),
      stream: record.stream,
      chunk: requireUtf8BoundedString(
        record.chunk,
        'Session tool output chunk',
        SESSION_LIVE_DELTA_MAX_BYTES,
      ),
      redacted: record.redacted,
      createdAt: requireCount(record.createdAt, 'Session tool output timestamp'),
    };
  }
  if (record.type === 'tool_progress') {
    assertExactKeys(record, 'Session tool progress event', [
      'type',
      'id',
      'turnId',
      'ts',
      'toolUseId',
      'chunk',
    ]);
    return {
      type: record.type,
      ...identity,
      chunk: requireUtf8BoundedString(
        record.chunk,
        'Session tool progress chunk',
        SESSION_LIVE_DELTA_MAX_BYTES,
      ),
    };
  }
  if (record.type === 'tool_result') {
    const allowed = [
      'type',
      'id',
      'turnId',
      'ts',
      'toolUseId',
      'operationId',
      'status',
      'durationMs',
    ];
    assertAllowedKeys(record, 'Session tool result event', allowed);
    assertRequiredKeys(record, 'Session tool result event', [
      'type',
      'id',
      'turnId',
      'ts',
      'toolUseId',
      'status',
    ]);
    if (record.status !== 'completed' && record.status !== 'errored') {
      throw invalidProtocolFrame('Invalid Session tool result status');
    }
    return {
      type: record.type,
      ...identity,
      ...(record.operationId === undefined
        ? {}
        : { operationId: requireEntityId(record.operationId, 'operationId') }),
      status: record.status,
      ...(record.durationMs === undefined
        ? {}
        : {
            durationMs: requireCount(record.durationMs, 'Session tool result duration'),
          }),
    };
  }
  throw invalidProtocolFrame('Invalid Session tool event type');
}

function decodeSessionContinuityIdentity(value: unknown): SessionContinuityIdentity {
  const record = requireRecord(value, 'Session continuity identity');
  assertAllowedKeys(record, 'Session continuity identity', [
    'sessionId',
    'status',
    'createdAt',
    'lastUsedAt',
    'isArchived',
    'archivedAt',
  ]);
  assertRequiredKeys(record, 'Session continuity identity', [
    'sessionId',
    'status',
    'createdAt',
    'lastUsedAt',
    'isArchived',
  ]);
  if (typeof record.isArchived !== 'boolean') {
    throw invalidProtocolFrame('Invalid Session archived state');
  }
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    status: requireSessionLifecycleStatus(record.status),
    createdAt: requireCount(record.createdAt, 'createdAt'),
    lastUsedAt: requireCount(record.lastUsedAt, 'lastUsedAt'),
    isArchived: record.isArchived,
    ...(record.archivedAt === undefined
      ? {}
      : { archivedAt: requireCount(record.archivedAt, 'archivedAt') }),
  };
}

function assertQueueEpoch(snapshot: SessionContinuitySnapshot, hostEpoch: string): void {
  if (snapshot.queue.hostEpoch !== hostEpoch) {
    throw invalidProtocolFrame('Session queue projection belongs to a different Host Epoch');
  }
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  label: string,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw invalidProtocolFrame(`Unknown ${label} field`);
  }
}

function assertRequiredKeys(
  record: Record<string, unknown>,
  label: string,
  keys: readonly string[],
): void {
  if (keys.some((key) => !Object.hasOwn(record, key))) {
    throw invalidProtocolFrame(`Invalid ${label} fields`);
  }
}

function requirePositiveCount(value: unknown, label: string): number {
  const count = requireCount(value, label);
  if (count === 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return count;
}

function requireUtf8BoundedString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function requireEncodedByteLimit(value: unknown, label: string, maxBytes: number): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
}

function requireToolActivityKind(
  value: unknown,
): Extract<SessionToolEvent, { type: 'tool_start' }>['activityKind'] {
  if (
    value === 'read' ||
    value === 'search' ||
    value === 'websearch' ||
    value === 'webfetch' ||
    value === 'edit' ||
    value === 'command' ||
    value === 'explore' ||
    value === 'browser' ||
    value === 'tool'
  )
    return value;
  throw invalidProtocolFrame('Invalid Session tool activity kind');
}

function requireSessionLifecycleStatus(value: unknown): SessionLifecycleStatus {
  if (
    value === 'active' ||
    value === 'running' ||
    value === 'waiting_for_user' ||
    value === 'blocked' ||
    value === 'review' ||
    value === 'done' ||
    value === 'archived' ||
    value === 'aborted'
  )
    return value;
  throw invalidProtocolFrame('Invalid Session lifecycle status');
}
