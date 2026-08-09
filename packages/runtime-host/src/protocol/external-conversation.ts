import {
  decodeSessionCatalogItem,
  decodeSessionCreateInput,
  type SessionCatalogItem,
  type SessionCreateInput,
} from './session-catalog.js';
import { requireEntityId, requireExactRecord, requireRecord, requireUtf8String } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const EXTERNAL_CONVERSATION_ID_MAX_BYTES = 4 * 1024;

const SESSION_ID_PLACEHOLDER = 'external-conversation-session';
const RECONCILE_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'operation_conflict',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

export type ExternalConversationSessionCreate = Omit<SessionCreateInput, 'sessionId'>;

export type ExternalConversationReconcileInput =
  | {
      readonly kind: 'resolve';
      readonly conversationId: string;
      readonly session: ExternalConversationSessionCreate;
    }
  | {
      readonly kind: 'release';
      readonly conversationId: string;
      readonly operationId: string;
    };

export type ExternalConversationReconcileResult =
  | { readonly kind: 'resolved'; readonly session: SessionCatalogItem }
  | { readonly kind: 'released'; readonly hadBinding: boolean };

export const EXTERNAL_CONVERSATION_OPERATION_SPECS = {
  'external-conversation.reconcile': defineOperation<
    ExternalConversationReconcileInput,
    ExternalConversationReconcileResult,
    (typeof RECONCILE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: RECONCILE_ERRORS,
    decodeInput: decodeExternalConversationReconcileInput,
    decodeOutput: decodeExternalConversationReconcileResult,
  }),
} as const;

export function decodeExternalConversationReconcileInput(
  value: unknown,
): ExternalConversationReconcileInput {
  const input = requireRecord(value, 'external-conversation reconcile input');
  if (input.kind === 'resolve') {
    const exact = requireExactRecord(input, 'external-conversation resolve input', [
      'kind',
      'conversationId',
      'session',
    ]);
    return {
      kind: 'resolve',
      conversationId: conversationId(exact.conversationId),
      session: decodeSessionCreate(exact.session),
    };
  }
  if (input.kind === 'release') {
    const exact = requireExactRecord(input, 'external-conversation release input', [
      'kind',
      'conversationId',
      'operationId',
    ]);
    return {
      kind: 'release',
      conversationId: conversationId(exact.conversationId),
      operationId: requireEntityId(exact.operationId, 'external-conversation operationId'),
    };
  }
  throw invalidProtocolFrame('Invalid external-conversation reconcile kind');
}

export function decodeExternalConversationReconcileResult(
  value: unknown,
): ExternalConversationReconcileResult {
  const result = requireRecord(value, 'external-conversation reconcile result');
  if (result.kind === 'resolved') {
    const exact = requireExactRecord(result, 'external-conversation resolved result', [
      'kind',
      'session',
    ]);
    return { kind: 'resolved', session: decodeSessionCatalogItem(exact.session) };
  }
  if (result.kind === 'released') {
    const exact = requireExactRecord(result, 'external-conversation released result', [
      'kind',
      'hadBinding',
    ]);
    if (typeof exact.hadBinding !== 'boolean') {
      throw invalidProtocolFrame('Invalid external-conversation release disposition');
    }
    return { kind: 'released', hadBinding: exact.hadBinding };
  }
  throw invalidProtocolFrame('Invalid external-conversation reconcile result kind');
}

function decodeSessionCreate(value: unknown): ExternalConversationSessionCreate {
  const record = requireRecord(value, 'external-conversation Session create input');
  if (Object.hasOwn(record, 'sessionId')) {
    throw invalidProtocolFrame('External-conversation Session identity is Host-owned');
  }
  const decoded = decodeSessionCreateInput({ sessionId: SESSION_ID_PLACEHOLDER, ...record });
  const { sessionId: _sessionId, ...session } = decoded;
  return session;
}

function conversationId(value: unknown): string {
  return requireUtf8String(
    value,
    'external-conversation identity',
    EXTERNAL_CONVERSATION_ID_MAX_BYTES,
  );
}
