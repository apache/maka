import { invalidProtocolFrame } from './errors.js';
import {
  assertExactKeys,
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireId,
  requireRecord,
} from './codec.js';
import { defineOperation } from './operation-spec.js';
import {
  decodeMessageContent,
  decodeTurnSnapshot,
  type MessageContent,
  type TurnSnapshot,
} from './turn.js';
import type { MessageQueueMutation } from '@maka/core/events';

export const MESSAGE_QUEUE_MAX_ENTRIES = 64;
export const MESSAGE_QUEUE_PROJECTION_MAX_BYTES = 52 * 1024;
export const MESSAGE_OPERATION_RESULT_MAX_BYTES = 56 * 1024;

export type MessagePlacement = 'current_turn' | 'next_turn';

interface MessageQueueEntrySnapshotBase {
  readonly entryId: string;
  readonly messageId: string;
  readonly content: MessageContent;
  readonly placement: MessagePlacement;
}

export interface QueuedMessageSnapshot extends MessageQueueEntrySnapshotBase {
  readonly state: 'queued';
}

export interface InFlightMessageSnapshot extends MessageQueueEntrySnapshotBase {
  readonly placement: 'current_turn';
  readonly state: 'in_flight';
}

export interface RetractedMessageSnapshot extends MessageQueueEntrySnapshotBase {
  readonly state: 'retracted';
}

export type MessageQueueEntrySnapshot =
  | QueuedMessageSnapshot
  | InFlightMessageSnapshot
  | RetractedMessageSnapshot;

export type SteeringMessageSnapshot =
  | (QueuedMessageSnapshot & { readonly placement: 'current_turn' })
  | InFlightMessageSnapshot;

export interface SessionMessageQueueProjection {
  readonly hostEpoch: string;
  readonly queueRevision: number;
  readonly paused?: boolean;
  readonly steering: readonly SteeringMessageSnapshot[];
  readonly followup: readonly QueuedMessageSnapshot[];
}

export interface TurnMessageSubmitInput {
  readonly originHostEpoch: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly content: MessageContent;
  readonly placement: MessagePlacement;
}

export type TurnMessageSubmitResult =
  | { readonly disposition: 'steering'; readonly queueRevision: number }
  | { readonly disposition: 'followup'; readonly queueRevision: number }
  | { readonly disposition: 'turn_started'; readonly turnId: string };

export interface QueueRetractInput {
  readonly originHostEpoch: string;
  readonly sessionId: string;
  readonly retractId: string;
}

export interface QueueRetractResult {
  readonly queueRevision: number;
  readonly retracted: readonly RetractedMessageSnapshot[];
}

export type QueueMutation = MessageQueueMutation;

export interface QueueMutateInput {
  readonly originHostEpoch: string;
  readonly sessionId: string;
  readonly mutationId: string;
  readonly expectedQueueRevision: number;
  readonly mutation: QueueMutation;
}

export interface QueueMutateResult {
  readonly queueRevision: number;
  readonly disposition: 'updated' | 'removed' | 'reordered' | 'promoted' | 'resumed';
}

export interface TurnInterruptInput {
  readonly originHostEpoch: string;
  readonly sessionId: string;
  readonly interruptId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly preserveQueuedMessages?: boolean;
}

export interface TurnInterruptResult {
  readonly queueRevision: number;
  readonly retracted: readonly RetractedMessageSnapshot[];
  readonly turn: TurnSnapshot;
}

const MESSAGE_OPERATION_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'session_archived',
  'session_busy',
  'operation_conflict',
  'outcome_unknown',
  'internal_failure',
] as const;

export const MESSAGE_OPERATION_SPECS = {
  'turn.message.submit': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: MESSAGE_OPERATION_ERRORS,
    decodeInput: decodeTurnMessageSubmitInput,
    decodeOutput: decodeTurnMessageSubmitResult,
  }),
  'queue.retract': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: MESSAGE_OPERATION_ERRORS,
    decodeInput: decodeQueueRetractInput,
    decodeOutput: decodeQueueRetractResult,
  }),
  'queue.mutate': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: MESSAGE_OPERATION_ERRORS,
    decodeInput: decodeQueueMutateInput,
    decodeOutput: decodeQueueMutateResult,
  }),
  'turn.interrupt': defineOperation({
    mode: 'control',
    availability: 'ready',
    errors: MESSAGE_OPERATION_ERRORS,
    decodeInput: decodeTurnInterruptInput,
    decodeOutput: decodeTurnInterruptResult,
  }),
} as const;

export function decodeSessionMessageQueueProjection(value: unknown): SessionMessageQueueProjection {
  const record = requireRecord(value, 'Session message queue projection');
  assertExactKeys(
    record,
    'Session message queue projection',
    record.paused === undefined
      ? ['hostEpoch', 'queueRevision', 'steering', 'followup']
      : ['hostEpoch', 'queueRevision', 'paused', 'steering', 'followup'],
  );
  if (record.paused !== undefined && typeof record.paused !== 'boolean') {
    throw invalidProtocolFrame('Invalid queue paused state');
  }
  const steering = decodeSteeringMessages(record.steering);
  const followup = decodeFollowupMessages(record.followup);
  if (steering.length + followup.length > MESSAGE_QUEUE_MAX_ENTRIES) {
    throw invalidProtocolFrame('Invalid Session message queue projection');
  }
  assertUniqueQueueEntries([...steering, ...followup], 'Session message queue projection');
  const projection = {
    hostEpoch: requireId(record.hostEpoch, 'queue hostEpoch'),
    queueRevision: requireCount(record.queueRevision, 'queueRevision'),
    ...(record.paused === true ? { paused: true } : {}),
    steering,
    followup,
  };
  requireEncodedByteLimit(
    projection,
    'Session message queue projection',
    MESSAGE_QUEUE_PROJECTION_MAX_BYTES,
  );
  return projection;
}

function decodeTurnMessageSubmitInput(value: unknown): TurnMessageSubmitInput {
  const record = requireExactRecord(value, 'turn.message.submit input', [
    'originHostEpoch',
    'sessionId',
    'messageId',
    'content',
    'placement',
  ]);
  return {
    originHostEpoch: requireId(record.originHostEpoch, 'originHostEpoch'),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    messageId: requireEntityId(record.messageId, 'messageId'),
    content: decodeMessageContent(record.content),
    placement: requireMessagePlacement(record.placement),
  };
}

function decodeTurnMessageSubmitResult(value: unknown): TurnMessageSubmitResult {
  const record = requireRecord(value, 'turn.message.submit result');
  if (record.disposition === 'turn_started') {
    assertExactKeys(record, 'turn.message.submit turn_started result', ['disposition', 'turnId']);
    return { disposition: record.disposition, turnId: requireEntityId(record.turnId, 'turnId') };
  }
  if (record.disposition === 'steering' || record.disposition === 'followup') {
    assertExactKeys(record, 'turn.message.submit queued result', ['disposition', 'queueRevision']);
    return {
      disposition: record.disposition,
      queueRevision: requireCount(record.queueRevision, 'queueRevision'),
    };
  }
  throw invalidProtocolFrame('Invalid turn.message.submit disposition');
}

function decodeQueueRetractInput(value: unknown): QueueRetractInput {
  const record = requireExactRecord(value, 'queue.retract input', [
    'originHostEpoch',
    'sessionId',
    'retractId',
  ]);
  return {
    originHostEpoch: requireId(record.originHostEpoch, 'originHostEpoch'),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    retractId: requireEntityId(record.retractId, 'retractId'),
  };
}

function decodeQueueRetractResult(value: unknown): QueueRetractResult {
  const record = requireExactRecord(value, 'queue.retract result', ['queueRevision', 'retracted']);
  const result = {
    queueRevision: requireCount(record.queueRevision, 'queueRevision'),
    retracted: decodeRetractedMessages(record.retracted),
  };
  requireEncodedByteLimit(result, 'queue.retract result', MESSAGE_OPERATION_RESULT_MAX_BYTES);
  return result;
}

function decodeQueueMutateInput(value: unknown): QueueMutateInput {
  const record = requireExactRecord(value, 'queue.mutate input', [
    'originHostEpoch',
    'sessionId',
    'mutationId',
    'expectedQueueRevision',
    'mutation',
  ]);
  return {
    originHostEpoch: requireId(record.originHostEpoch, 'originHostEpoch'),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    mutationId: requireEntityId(record.mutationId, 'mutationId'),
    expectedQueueRevision: requireCount(record.expectedQueueRevision, 'expectedQueueRevision'),
    mutation: decodeQueueMutation(record.mutation),
  };
}

function decodeQueueMutation(value: unknown): QueueMutation {
  const record = requireRecord(value, 'queue mutation');
  if (record.kind === 'update') {
    assertExactKeys(record, 'queue update mutation', ['kind', 'entryId', 'text']);
    if (typeof record.text !== 'string' || record.text.trim().length === 0) {
      throw invalidProtocolFrame('Invalid queued message text');
    }
    return {
      kind: record.kind,
      entryId: requireEntityId(record.entryId, 'entryId'),
      text: record.text,
    };
  }
  if (record.kind === 'remove' || record.kind === 'promote') {
    assertExactKeys(record, `queue ${record.kind} mutation`, ['kind', 'entryId']);
    return {
      kind: record.kind,
      entryId: requireEntityId(record.entryId, 'entryId'),
    };
  }
  if (record.kind === 'resume') {
    assertExactKeys(record, 'queue resume mutation', ['kind']);
    return { kind: record.kind };
  }
  if (record.kind === 'reorder') {
    assertExactKeys(record, 'queue reorder mutation', ['kind', 'placement', 'entryIds']);
    const entryIds = requireBoundedArray(record.entryIds, 'queue reorder entry ids').map(
      (entryId) => requireEntityId(entryId, 'entryId'),
    );
    if (new Set(entryIds).size !== entryIds.length) {
      throw invalidProtocolFrame('Queue reorder repeats an entry identity');
    }
    return {
      kind: record.kind,
      placement: requireMessagePlacement(record.placement),
      entryIds,
    };
  }
  throw invalidProtocolFrame('Invalid queue mutation');
}

function decodeQueueMutateResult(value: unknown): QueueMutateResult {
  const record = requireExactRecord(value, 'queue.mutate result', ['queueRevision', 'disposition']);
  if (
    record.disposition !== 'updated' &&
    record.disposition !== 'removed' &&
    record.disposition !== 'reordered' &&
    record.disposition !== 'promoted' &&
    record.disposition !== 'resumed'
  ) {
    throw invalidProtocolFrame('Invalid queue mutation disposition');
  }
  return {
    queueRevision: requireCount(record.queueRevision, 'queueRevision'),
    disposition: record.disposition,
  };
}

function decodeTurnInterruptInput(value: unknown): TurnInterruptInput {
  const record = requireRecord(value, 'turn.interrupt input');
  assertExactKeys(
    record,
    'turn.interrupt input',
    record.preserveQueuedMessages === undefined
      ? ['originHostEpoch', 'sessionId', 'interruptId', 'turnId', 'runId']
      : [
          'originHostEpoch',
          'sessionId',
          'interruptId',
          'turnId',
          'runId',
          'preserveQueuedMessages',
        ],
  );
  if (
    record.preserveQueuedMessages !== undefined &&
    typeof record.preserveQueuedMessages !== 'boolean'
  ) {
    throw invalidProtocolFrame('Invalid preserve queued messages flag');
  }
  return {
    originHostEpoch: requireId(record.originHostEpoch, 'originHostEpoch'),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    interruptId: requireEntityId(record.interruptId, 'interruptId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    runId: requireEntityId(record.runId, 'runId'),
    ...(record.preserveQueuedMessages === true ? { preserveQueuedMessages: true } : {}),
  };
}

function decodeTurnInterruptResult(value: unknown): TurnInterruptResult {
  const record = requireExactRecord(value, 'turn.interrupt result', [
    'queueRevision',
    'retracted',
    'turn',
  ]);
  const result = {
    queueRevision: requireCount(record.queueRevision, 'queueRevision'),
    retracted: decodeRetractedMessages(record.retracted),
    turn: decodeTurnSnapshot(record.turn),
  };
  requireEncodedByteLimit(result, 'turn.interrupt result', MESSAGE_OPERATION_RESULT_MAX_BYTES);
  return result;
}

function decodeSteeringMessages(value: unknown): SteeringMessageSnapshot[] {
  return requireBoundedArray(value, 'steering queue').map((entry) => {
    const decoded = decodeMessageQueueEntrySnapshot(entry);
    if (decoded.placement !== 'current_turn') {
      throw invalidProtocolFrame('Invalid steering queue entry');
    }
    if (decoded.state === 'queued') return { ...decoded, placement: 'current_turn' };
    if (decoded.state === 'in_flight') return decoded;
    throw invalidProtocolFrame('Invalid steering queue entry');
  });
}

function decodeFollowupMessages(value: unknown): QueuedMessageSnapshot[] {
  return requireBoundedArray(value, 'followup queue').map((entry) => {
    const decoded = decodeMessageQueueEntrySnapshot(entry);
    if (decoded.state !== 'queued' || decoded.placement !== 'next_turn') {
      throw invalidProtocolFrame('Invalid followup queue entry');
    }
    return { ...decoded, placement: 'next_turn' };
  });
}

function decodeRetractedMessages(value: unknown): RetractedMessageSnapshot[] {
  const entries = requireBoundedArray(value, 'retracted messages').map((entry) => {
    const decoded = decodeMessageQueueEntrySnapshot(entry);
    if (decoded.state !== 'retracted') {
      throw invalidProtocolFrame('Invalid retracted message state');
    }
    return decoded;
  });
  assertUniqueQueueEntries(entries, 'retracted messages');
  return entries;
}

function decodeMessageQueueEntrySnapshot(value: unknown): MessageQueueEntrySnapshot {
  const record = requireExactRecord(value, 'message queue entry snapshot', [
    'entryId',
    'messageId',
    'content',
    'placement',
    'state',
  ]);
  const base = {
    entryId: requireEntityId(record.entryId, 'entryId'),
    messageId: requireEntityId(record.messageId, 'messageId'),
    content: decodeMessageContent(record.content),
    placement: requireMessagePlacement(record.placement),
  };
  if (record.state === 'queued' || record.state === 'retracted') {
    return { ...base, state: record.state };
  }
  if (record.state === 'in_flight' && base.placement === 'current_turn') {
    return { ...base, placement: 'current_turn', state: record.state };
  }
  throw invalidProtocolFrame('Invalid message queue entry state');
}

function requireMessagePlacement(value: unknown): MessagePlacement {
  if (value === 'current_turn' || value === 'next_turn') return value;
  throw invalidProtocolFrame('Invalid message placement');
}

function requireBoundedArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > MESSAGE_QUEUE_MAX_ENTRIES) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function assertUniqueQueueEntries(
  entries: readonly MessageQueueEntrySnapshot[],
  label: string,
): void {
  const entryIds = new Set<string>();
  const messageIds = new Set<string>();
  for (const entry of entries) {
    if (entryIds.has(entry.entryId) || messageIds.has(entry.messageId)) {
      throw invalidProtocolFrame(`${label} repeats a message identity`);
    }
    entryIds.add(entry.entryId);
    messageIds.add(entry.messageId);
  }
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
