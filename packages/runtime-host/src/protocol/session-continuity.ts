import { TOOL_ACTIVITY_KINDS, TOOL_OUTPUT_DELTA_MAX_CHARS } from '@maka/core/events';
import type { ToolResultPreviewContent } from '@maka/core/events';
import { decodeToolResultPreviewContent } from '@maka/core/tool-result-preview';
import type { ToolActivityKind } from '@maka/core/events';
import type { SessionStatus } from '@maka/core/session';
import {
  assertExactKeys,
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireId,
  requireRecord,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { decodeSessionStatus } from './session-status.js';
import {
  decodeSessionInteractionProjection,
  type SessionInteractionProjection,
} from './interaction.js';
import {
  decodeSessionMessageQueueProjection,
  type SessionMessageQueueProjection,
} from './message.js';
import { defineOperation } from './operation-spec.js';
import { decodeTurnSnapshot, type TurnSnapshot } from './turn.js';
import { decodeGoalProjection, type GoalProjection } from './goal.js';
import { decodeRuntimeResourceRef } from './runtime-resource.js';
import {
  decodeSessionTranscriptBootstrap,
  SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  type SessionTranscriptBootstrap,
} from './session-transcript.js';

export const SESSION_CONTINUITY_SCHEMA_VERSION = 4 as const;
export const SESSION_CONTINUITY_SNAPSHOT_MAX_BYTES = 56 * 1024;
// Leave transport headroom for the response envelope and request correlation.
export const SUBSCRIPTION_OPEN_RESULT_MAX_BYTES = 92 * 1024;
export const SESSION_LIVE_DELTA_MAX_BYTES = 16 * 1024;
// Core emits at most 8,192 UTF-16 code units per tool output event. A code unit
// needs at most three UTF-8 bytes (an astral pair needs four bytes total).
export const SESSION_TOOL_OUTPUT_DELTA_MAX_BYTES = 3 * TOOL_OUTPUT_DELTA_MAX_CHARS;
export const SESSION_TOOL_NAME_MAX_BYTES = 256;
export const SESSION_SUBSCRIPTION_FRAME_MAX_BYTES = 64 * 1024 - 1;
export const SESSION_RUNTIME_RESOURCE_PTY_DATA_MAX_BYTES = 48 * 1024;

/**
 * The wire status is core's `SessionStatus`, not a restatement of it. It used to
 * be a hand-written union here plus a hand-written validator below — three
 * copies of one enum, which is how `review` and `done` survived in two of them
 * after the last writer went away. `session-catalog.ts` already validates the
 * same field with core's `isSessionStatus`.
 */
export type SessionLifecycleStatus = SessionStatus;

export interface SessionContinuityIdentity {
  sessionId: string;
  metadataRevision: number;
  status: SessionLifecycleStatus;
  createdAt: number;
  lastUsedAt: number;
  isArchived: boolean;
}

export interface SessionContinuitySnapshot {
  schemaVersion: typeof SESSION_CONTINUITY_SCHEMA_VERSION;
  session: SessionContinuityIdentity;
  projectionRevision: number;
  rootTurn: TurnSnapshot | null;
  goal: GoalProjection | null;
  queue: SessionMessageQueueProjection;
  interactions: SessionInteractionProjection;
}

export interface SubscriptionOpenInput {
  sessionId: string;
  transcript: { kind: 'none' } | { kind: 'tail'; maxBytes: number };
}

export interface SubscriptionOpenResult {
  hostEpoch: string;
  subscriptionId: string;
  nextSequence: number;
  snapshot: SessionContinuitySnapshot;
  activeAssistantStreams: SessionAssistantStreamIdentity[];
  transcript: SessionTranscriptBootstrap | null;
}

export interface SessionAssistantStreamIdentity {
  kind: 'text' | 'thinking';
  turnId: string;
  messageId: string;
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
  startOffset: number;
  text: string;
  reset?: true;
  complete?: true;
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
      // From the one list, not a fourth copy of it. This was written out by
      // hand and drifted the moment a kind was added — the wire then rejected
      // an event the rest of the system considered valid.
      activityKind?: ToolActivityKind;
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
    })
  | (SessionToolEventIdentity & {
      type: 'tool_result_preview';
      isError: boolean;
      content: ToolResultPreviewContent;
    });

export interface SessionEventFrame extends SubscriptionEnvelope {
  kind: 'subscription.session_event';
  sessionId: string;
  runId: string;
  event: SessionToolEvent;
}

export interface SessionTranscriptAdvancedFrame extends SubscriptionEnvelope {
  kind: 'subscription.transcript_advanced';
  sessionId: string;
  throughSequence: number;
}

export const SESSION_DOMAINS = ['task', 'plan', 'deep_research', 'runtime_resource'] as const;
export type SessionDomain = (typeof SESSION_DOMAINS)[number];
export const SESSION_RUNTIME_RESOURCE_CHANGES_MAX = 64;

export interface SessionRuntimeResourceChange {
  sourceSessionId: string;
  ref: string;
}

export type SessionDomainChange =
  | {
      sessionId: string;
      domain: Exclude<SessionDomain, 'runtime_resource'>;
    }
  | {
      sessionId: string;
      domain: 'runtime_resource';
      resources: readonly SessionRuntimeResourceChange[];
    };

export type SessionDomainChangedFrame = SubscriptionEnvelope &
  SessionDomainChange & {
    kind: 'subscription.session_domain_changed';
  };

export interface SessionRuntimeResourcePtyDataFrame extends SubscriptionEnvelope {
  kind: 'subscription.runtime_resource_pty_data';
  sessionId: string;
  ref: string;
  ptySequence: number;
  data: string;
}

export type AgentGraphChangedReason = 'observation' | 'runtime_activity' | 'reconciled' | 'stopped';

export interface AgentGraphChangedFrame extends SubscriptionEnvelope {
  kind: 'subscription.agent_graph_changed';
  rootSessionId: string;
  graphId: string;
  reason: AgentGraphChangedReason;
}

export interface SubscriptionClosedFrame extends SubscriptionEnvelope {
  kind: 'subscription.closed';
  reason: 'slow_consumer' | 'session_removed';
}

export type SubscriptionFrame =
  | SessionProjectionFrame
  | SessionDeltaFrame
  | SessionEventFrame
  | SessionTranscriptAdvancedFrame
  | SessionDomainChangedFrame
  | SessionRuntimeResourcePtyDataFrame
  | AgentGraphChangedFrame
  | SubscriptionClosedFrame;

const SUBSCRIPTION_OPEN_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'operation_conflict',
  'persistence_failed',
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
    assertOutputForInput: (input, output) => {
      if (output.snapshot.session.sessionId !== input.sessionId) {
        throw invalidProtocolFrame('Session subscription opened for a different Session');
      }
      if (
        input.transcript.kind === 'none' ? output.transcript !== null : output.transcript === null
      ) {
        throw invalidProtocolFrame('Session subscription transcript policy changed');
      }
      if (
        input.transcript.kind === 'tail' &&
        output.transcript &&
        output.transcript.durable.rawBytes + output.transcript.overlay.rawBytes >
          input.transcript.maxBytes
      ) {
        throw invalidProtocolFrame('Session transcript bootstrap exceeds requested byte limit');
      }
    },
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
  } else if (record.kind === 'subscription.transcript_advanced') {
    assertExactKeys(record, 'Session transcript advanced frame', [
      'kind',
      'hostEpoch',
      'subscriptionId',
      'sequence',
      'sessionId',
      'throughSequence',
    ]);
    frame = {
      kind: record.kind,
      ...envelope,
      sessionId: requireEntityId(record.sessionId, 'sessionId'),
      throughSequence: requireCount(record.throughSequence, 'Session transcript watermark'),
    };
  } else if (record.kind === 'subscription.agent_graph_changed') {
    assertExactKeys(record, 'Agent graph changed frame', [
      'kind',
      'hostEpoch',
      'subscriptionId',
      'sequence',
      'rootSessionId',
      'graphId',
      'reason',
    ]);
    frame = {
      kind: record.kind,
      ...envelope,
      rootSessionId: requireEntityId(record.rootSessionId, 'rootSessionId'),
      graphId: requireEntityId(record.graphId, 'graphId'),
      reason: requireAgentGraphChangedReason(record.reason),
    };
  } else if (record.kind === 'subscription.session_domain_changed') {
    const domain = requireSessionDomain(record.domain);
    assertExactKeys(record, 'Session domain changed frame', [
      'kind',
      'hostEpoch',
      'subscriptionId',
      'sequence',
      'sessionId',
      'domain',
      ...(domain === 'runtime_resource' ? ['resources'] : []),
    ]);
    const sessionId = requireEntityId(record.sessionId, 'sessionId');
    frame =
      domain === 'runtime_resource'
        ? {
            kind: record.kind,
            ...envelope,
            sessionId,
            domain,
            resources: decodeSessionRuntimeResourceChanges(record.resources),
          }
        : { kind: record.kind, ...envelope, sessionId, domain };
  } else if (record.kind === 'subscription.runtime_resource_pty_data') {
    assertExactKeys(record, 'Runtime Resource PTY data frame', [
      'kind',
      'hostEpoch',
      'subscriptionId',
      'sequence',
      'sessionId',
      'ref',
      'ptySequence',
      'data',
    ]);
    frame = {
      kind: record.kind,
      ...envelope,
      sessionId: requireEntityId(record.sessionId, 'sessionId'),
      ref: decodeRuntimeResourceRef(record.ref),
      ptySequence: requirePositiveCount(record.ptySequence, 'PTY sequence'),
      data: requireUtf8BoundedString(
        record.data,
        'Runtime Resource PTY data',
        SESSION_RUNTIME_RESOURCE_PTY_DATA_MAX_BYTES,
      ),
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

function decodeSessionRuntimeResourceChanges(value: unknown): SessionRuntimeResourceChange[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > SESSION_RUNTIME_RESOURCE_CHANGES_MAX
  ) {
    throw invalidProtocolFrame('Invalid Session Runtime Resource changes');
  }
  const seen = new Set<string>();
  return value.map((candidate) => {
    const record = requireExactRecord(candidate, 'Session Runtime Resource change', [
      'sourceSessionId',
      'ref',
    ]);
    const change = {
      sourceSessionId: requireEntityId(record.sourceSessionId, 'sourceSessionId'),
      ref: decodeRuntimeResourceRef(record.ref),
    };
    const identity = JSON.stringify([change.sourceSessionId, change.ref]);
    if (seen.has(identity)) {
      throw invalidProtocolFrame('Duplicate Session Runtime Resource change');
    }
    seen.add(identity);
    return change;
  });
}

export function isSubscriptionFrameKind(value: unknown): value is SubscriptionFrame['kind'] {
  return (
    value === 'subscription.session_projection' ||
    value === 'subscription.session_delta' ||
    value === 'subscription.session_event' ||
    value === 'subscription.transcript_advanced' ||
    value === 'subscription.session_domain_changed' ||
    value === 'subscription.runtime_resource_pty_data' ||
    value === 'subscription.agent_graph_changed' ||
    value === 'subscription.closed'
  );
}

function requireSessionDomain(value: unknown): SessionDomain {
  if (typeof value !== 'string' || !(SESSION_DOMAINS as readonly string[]).includes(value)) {
    throw invalidProtocolFrame('Invalid Session domain');
  }
  return value as SessionDomain;
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
    'goal',
    'queue',
    'interactions',
  ]);
  if (record.schemaVersion !== SESSION_CONTINUITY_SCHEMA_VERSION) {
    throw invalidProtocolFrame('Unsupported Session continuity snapshot schema');
  }
  const session = decodeSessionContinuityIdentity(record.session);
  const rootTurn = record.rootTurn === null ? null : decodeTurnSnapshot(record.rootTurn);
  if (rootTurn !== null && rootTurn.sessionId !== session.sessionId) {
    throw invalidProtocolFrame('Session continuity root Turn belongs to a different Session');
  }
  const interactions = decodeSessionInteractionProjection(record.interactions, session.sessionId);
  const goal = record.goal === null ? null : decodeGoalProjection(record.goal);
  if (goal !== null && goal.sessionId !== session.sessionId) {
    throw invalidProtocolFrame('Session continuity Goal belongs to a different Session');
  }
  return {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session,
    projectionRevision: requirePositiveCount(record.projectionRevision, 'projectionRevision'),
    rootTurn,
    goal,
    queue: decodeSessionMessageQueueProjection(record.queue),
    interactions,
  };
}

function decodeSubscriptionOpenInput(value: unknown): SubscriptionOpenInput {
  const record = requireExactRecord(value, 'subscription.open input', ['sessionId', 'transcript']);
  const transcript = requireRecord(record.transcript, 'subscription transcript policy');
  if (transcript.kind === 'none') {
    requireExactRecord(transcript, 'subscription transcript policy', ['kind']);
    return {
      sessionId: requireEntityId(record.sessionId, 'sessionId'),
      transcript: { kind: 'none' },
    };
  }
  const tail = requireExactRecord(transcript, 'subscription transcript policy', [
    'kind',
    'maxBytes',
  ]);
  if (tail.kind !== 'tail') throw invalidProtocolFrame('Invalid subscription transcript policy');
  const maxBytes = requireCount(tail.maxBytes, 'Session transcript bootstrap byte limit');
  if (maxBytes < 2 || maxBytes > SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES) {
    throw invalidProtocolFrame('Invalid Session transcript bootstrap byte limit');
  }
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    transcript: { kind: 'tail', maxBytes },
  };
}

function decodeSubscriptionOpenResult(value: unknown): SubscriptionOpenResult {
  requireEncodedByteLimit(value, 'subscription.open result', SUBSCRIPTION_OPEN_RESULT_MAX_BYTES);
  const record = requireExactRecord(value, 'subscription.open result', [
    'hostEpoch',
    'subscriptionId',
    'nextSequence',
    'snapshot',
    'activeAssistantStreams',
    'transcript',
  ]);
  const hostEpoch = requireId(record.hostEpoch, 'hostEpoch');
  const snapshot = decodeSessionContinuitySnapshot(record.snapshot);
  assertQueueEpoch(snapshot, hostEpoch);
  return {
    hostEpoch,
    subscriptionId: requireId(record.subscriptionId, 'subscriptionId'),
    nextSequence: requirePositiveCount(record.nextSequence, 'nextSequence'),
    snapshot,
    activeAssistantStreams: decodeActiveAssistantStreams(record.activeAssistantStreams, snapshot),
    transcript:
      record.transcript === null ? null : decodeSessionTranscriptBootstrap(record.transcript),
  };
}

function decodeActiveAssistantStreams(
  value: unknown,
  snapshot: SessionContinuitySnapshot,
): SessionAssistantStreamIdentity[] {
  if (!Array.isArray(value)) {
    throw invalidProtocolFrame('Invalid active Session assistant streams');
  }
  const root = snapshot.rootTurn;
  const identities = value.map((candidate): SessionAssistantStreamIdentity => {
    const record = requireExactRecord(candidate, 'active Session assistant stream', [
      'kind',
      'turnId',
      'messageId',
    ]);
    if (record.kind !== 'text' && record.kind !== 'thinking') {
      throw invalidProtocolFrame('Invalid active Session assistant stream kind');
    }
    const kind = record.kind;
    const identity: SessionAssistantStreamIdentity = {
      kind,
      turnId: requireEntityId(record.turnId, 'turnId'),
      messageId: requireEntityId(record.messageId, 'messageId'),
    };
    if (
      !root ||
      root.status === 'completed' ||
      root.status === 'failed' ||
      root.status === 'cancelled' ||
      identity.turnId !== root.turnId
    ) {
      throw invalidProtocolFrame('Active Session assistant stream has no active root Turn');
    }
    return identity;
  });
  const keys = identities.map(({ kind, messageId }) => `${kind}\0${messageId}`);
  if (new Set(keys).size !== keys.length) {
    throw invalidProtocolFrame('Duplicate active Session assistant stream');
  }
  return identities;
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
  const record = requireRecord(value, 'Session assistant delta');
  assertAllowedKeys(record, 'Session assistant delta', [
    'kind',
    'turnId',
    'runId',
    'messageId',
    'startOffset',
    'text',
    'reset',
    'complete',
  ]);
  assertRequiredKeys(record, 'Session assistant delta', [
    'kind',
    'turnId',
    'runId',
    'messageId',
    'startOffset',
    'text',
  ]);
  if (record.kind !== 'text' && record.kind !== 'thinking') {
    throw invalidProtocolFrame('Invalid Session assistant delta kind');
  }
  if (record.complete !== undefined && record.complete !== true) {
    throw invalidProtocolFrame('Invalid Session assistant delta completion');
  }
  if (record.reset !== undefined && record.reset !== true) {
    throw invalidProtocolFrame('Invalid Session assistant delta reset');
  }
  const startOffset = requireCount(record.startOffset, 'Session assistant delta start offset');
  if (record.reset === true && startOffset !== 0) {
    throw invalidProtocolFrame('Session assistant delta reset must start at offset zero');
  }
  return {
    kind: record.kind,
    turnId: requireEntityId(record.turnId, 'turnId'),
    runId: requireEntityId(record.runId, 'runId'),
    messageId: requireEntityId(record.messageId, 'messageId'),
    startOffset,
    // A completion may have no unseen suffix. Its empty frame closes the
    // already accumulated content without resending the full assistant text.
    text:
      record.complete === true && record.text === ''
        ? ''
        : requireUtf8BoundedString(
            record.text,
            'Session assistant delta text',
            SESSION_LIVE_DELTA_MAX_BYTES,
          ),
    ...(record.reset === true ? { reset: true as const } : {}),
    ...(record.complete === true ? { complete: true as const } : {}),
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
        SESSION_TOOL_OUTPUT_DELTA_MAX_BYTES,
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
  if (record.type === 'tool_result_preview') {
    assertExactKeys(record, 'Session tool result preview event', [
      'type',
      'id',
      'turnId',
      'ts',
      'toolUseId',
      'isError',
      'content',
    ]);
    if (typeof record.isError !== 'boolean') {
      throw invalidProtocolFrame('Invalid Session tool result preview isError');
    }
    let content: ToolResultPreviewContent;
    try {
      content = decodeToolResultPreviewContent(record.content);
    } catch {
      throw invalidProtocolFrame('Invalid Session tool result preview content');
    }
    return {
      type: record.type,
      ...identity,
      isError: record.isError,
      content,
    };
  }
  throw invalidProtocolFrame('Invalid Session tool event type');
}

function decodeSessionContinuityIdentity(value: unknown): SessionContinuityIdentity {
  const record = requireRecord(value, 'Session continuity identity');
  assertAllowedKeys(record, 'Session continuity identity', [
    'sessionId',
    'metadataRevision',
    'status',
    'createdAt',
    'lastUsedAt',
    'isArchived',
  ]);
  assertRequiredKeys(record, 'Session continuity identity', [
    'sessionId',
    'metadataRevision',
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
    metadataRevision: requirePositiveCount(record.metadataRevision, 'metadataRevision'),
    status: decodeSessionStatus(record.status),
    createdAt: requireCount(record.createdAt, 'createdAt'),
    lastUsedAt: requireCount(record.lastUsedAt, 'lastUsedAt'),
    isArchived: record.isArchived,
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

/**
 * Read against the one list rather than a copy of it.
 *
 * This was a hand-written chain, and a decoder is the worst place for a copy:
 * a kind added anywhere else made this reject the whole frame, so the failure
 * arrives as a protocol violation rather than as anything naming the field.
 */
function requireToolActivityKind(value: unknown): ToolActivityKind {
  if (typeof value === 'string' && (TOOL_ACTIVITY_KINDS as readonly string[]).includes(value)) {
    return value as ToolActivityKind;
  }
  throw invalidProtocolFrame('Invalid Session tool activity kind');
}

function requireAgentGraphChangedReason(value: unknown): AgentGraphChangedReason {
  if (
    value === 'observation' ||
    value === 'runtime_activity' ||
    value === 'reconciled' ||
    value === 'stopped'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid Agent graph changed reason');
}
