import { decodeSessionCatalogItem, type SessionCatalogItem } from './session-catalog.js';
import { requireEntityId, requireExactRecord, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

const LIFECYCLE_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'session_busy',
  'operation_conflict',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

export type SessionLifecycleState = 'active' | 'archived';

export interface SessionLifecycleSetInput {
  readonly sessionId: string;
  readonly state: SessionLifecycleState;
}

export interface SessionRemoveInput {
  readonly sessionId: string;
  readonly expectedRevision: number;
}

export type SessionRemoveResult =
  | { readonly kind: 'removed'; readonly sessionId: string }
  | {
      readonly kind: 'revision_conflict';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    };

export const SESSION_RETIREMENT_OPERATION_SPECS = {
  'session.lifecycle.set': defineOperation<
    SessionLifecycleSetInput,
    SessionCatalogItem,
    (typeof LIFECYCLE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: LIFECYCLE_ERRORS,
    decodeInput: decodeSessionLifecycleSetInput,
    decodeOutput: decodeSessionCatalogItem,
    assertOutputForInput: (input, output) => {
      if (output.id !== input.sessionId) {
        throw invalidProtocolFrame('Session lifecycle result belongs to another Session');
      }
      if ('kind' in output) return;
      const archived = input.state === 'archived';
      if (output.isArchived !== archived) {
        throw invalidProtocolFrame('Session lifecycle result does not match the requested state');
      }
    },
  }),
  'session.remove': defineOperation<
    SessionRemoveInput,
    SessionRemoveResult,
    (typeof LIFECYCLE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: LIFECYCLE_ERRORS,
    decodeInput: decodeSessionRemoveInput,
    decodeOutput: decodeSessionRemoveResult,
    assertOutputForInput: (input, output) => {
      if (output.kind === 'removed' && output.sessionId !== input.sessionId) {
        throw invalidProtocolFrame('Session remove result belongs to another Session');
      }
      if (
        output.kind === 'revision_conflict' &&
        output.expectedRevision !== input.expectedRevision
      ) {
        throw invalidProtocolFrame('Session remove conflict changed the expected revision');
      }
    },
  }),
} as const;

export function decodeSessionLifecycleSetInput(value: unknown): SessionLifecycleSetInput {
  const input = requireExactRecord(value, 'Session lifecycle input', ['sessionId', 'state']);
  if (input.state !== 'active' && input.state !== 'archived') {
    throw invalidProtocolFrame('Invalid Session lifecycle state');
  }
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    state: input.state,
  };
}

export function decodeSessionRemoveInput(value: unknown): SessionRemoveInput {
  const input = requireExactRecord(value, 'Session remove input', [
    'sessionId',
    'expectedRevision',
  ]);
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    expectedRevision: positiveRevision(input.expectedRevision),
  };
}

export function decodeSessionRemoveResult(value: unknown): SessionRemoveResult {
  const result = requireRecord(value, 'Session remove result');
  if (result.kind === 'removed') {
    const exact = requireExactRecord(result, 'Removed Session result', ['kind', 'sessionId']);
    return { kind: 'removed', sessionId: requireEntityId(exact.sessionId, 'sessionId') };
  }
  if (result.kind !== 'revision_conflict') {
    throw invalidProtocolFrame('Invalid Session remove result kind');
  }
  const exact = requireExactRecord(result, 'Session remove revision conflict', [
    'kind',
    'expectedRevision',
    'actualRevision',
  ]);
  return {
    kind: 'revision_conflict',
    expectedRevision: positiveRevision(exact.expectedRevision),
    actualRevision: positiveRevision(exact.actualRevision),
  };
}

function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalidProtocolFrame('Session revision must be a positive safe integer');
  }
  return value as number;
}
