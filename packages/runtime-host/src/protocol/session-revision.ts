import { requireCount, requireEntityId, requireExactRecord, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';
import { decodeSessionCatalogItem, type SessionCatalogItem } from './session-catalog.js';

const SESSION_COPY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'session_busy',
  'operation_conflict',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

export interface SessionConversationCopyInput {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly sourceTurnId: string;
  readonly expectedSourceRevision: number;
}

export type SessionConversationCopyResult =
  | {
      readonly kind: 'committed';
      readonly session: SessionCatalogItem;
    }
  | {
      readonly kind: 'source_revision_conflict';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    };

export const SESSION_REVISION_OPERATION_SPECS = {
  'session.branch.create': defineOperation<
    SessionConversationCopyInput,
    SessionConversationCopyResult,
    (typeof SESSION_COPY_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: SESSION_COPY_ERRORS,
    decodeInput: decodeSessionConversationCopyInput,
    decodeOutput: decodeSessionConversationCopyResult,
    assertOutputForInput: assertConversationCopyOutput,
  }),
  'session.revision.create': defineOperation<
    SessionConversationCopyInput,
    SessionConversationCopyResult,
    (typeof SESSION_COPY_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: SESSION_COPY_ERRORS,
    decodeInput: decodeSessionConversationCopyInput,
    decodeOutput: decodeSessionConversationCopyResult,
    assertOutputForInput: assertConversationCopyOutput,
  }),
} as const;

export function decodeSessionConversationCopyInput(value: unknown): SessionConversationCopyInput {
  const input = requireExactRecord(value, 'Session conversation-copy input', [
    'sourceSessionId',
    'targetSessionId',
    'sourceTurnId',
    'expectedSourceRevision',
  ]);
  const sourceSessionId = requireEntityId(input.sourceSessionId, 'sourceSessionId');
  const targetSessionId = requireEntityId(input.targetSessionId, 'targetSessionId');
  if (sourceSessionId === targetSessionId) {
    throw invalidProtocolFrame('Session conversation copy requires distinct Sessions');
  }
  return {
    sourceSessionId,
    targetSessionId,
    sourceTurnId: requireEntityId(input.sourceTurnId, 'sourceTurnId'),
    expectedSourceRevision: positiveRevision(
      input.expectedSourceRevision,
      'expected source Session revision',
    ),
  };
}

export function decodeSessionConversationCopyResult(value: unknown): SessionConversationCopyResult {
  const result = requireRecord(value, 'Session conversation-copy result');
  if (result.kind === 'committed') {
    const exact = requireExactRecord(result, 'committed Session conversation-copy result', [
      'kind',
      'session',
    ]);
    return {
      kind: 'committed',
      session: decodeSessionCatalogItem(exact.session),
    };
  }
  if (result.kind === 'source_revision_conflict') {
    const exact = requireExactRecord(result, 'Session source revision conflict result', [
      'kind',
      'expectedRevision',
      'actualRevision',
    ]);
    return {
      kind: 'source_revision_conflict',
      expectedRevision: positiveRevision(exact.expectedRevision, 'expected Session revision'),
      actualRevision: positiveRevision(exact.actualRevision, 'actual Session revision'),
    };
  }
  throw invalidProtocolFrame('Invalid Session conversation-copy result kind');
}

function assertConversationCopyOutput(
  input: SessionConversationCopyInput,
  output: SessionConversationCopyResult,
): void {
  if (output.kind === 'committed' && output.session.id !== input.targetSessionId) {
    throw invalidProtocolFrame('Session conversation-copy result identity does not match request');
  }
  if (
    output.kind === 'source_revision_conflict' &&
    output.expectedRevision !== input.expectedSourceRevision
  ) {
    throw invalidProtocolFrame('Session source revision conflict does not match request');
  }
}

function positiveRevision(value: unknown, label: string): number {
  const revision = requireCount(value, label);
  if (revision < 1) throw invalidProtocolFrame(`Invalid ${label}`);
  return revision;
}
