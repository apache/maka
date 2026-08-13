import { decodeStoredMessage, type TurnRecord, type TurnStateMessage } from '@maka/core/session';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import {
  requireCount,
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const SESSION_TURN_QUERY_MAX_CONTRIBUTIONS = 128;
export const SESSION_TURN_QUERY_RESULT_MAX_BYTES = 192 * 1024;
export const SESSION_TURN_DIAGNOSTIC_MAX_BYTES = 128;
export const SESSION_TURN_PROMPT_PREVIEW_MAX_BYTES = 256;

export interface SessionTurnContribution {
  readonly turnId: string;
  readonly firstSequence: number;
  readonly latestState: {
    readonly sequence: number;
    readonly message: TurnStateMessage;
  } | null;
  readonly userPromptPreview: string | null;
  readonly hasAssistantMessage: boolean;
  readonly hasAssistantOutput: boolean;
  readonly hasToolResult: boolean;
  readonly hasFailedToolResult: boolean;
  readonly hasAbortNote: boolean;
}

export interface SessionTurnsQueryInput {
  readonly sessionId: string;
  readonly throughSequence: number | null;
  readonly position: number;
  readonly maxContributions: number;
}

export interface SessionTurnsQueryResult {
  readonly sessionId: string;
  readonly throughSequence: number | null;
  readonly contributions: readonly SessionTurnContribution[];
  readonly nextPosition: number | null;
}

export function mergeSessionTurnContributions(
  current: SessionTurnContribution,
  next: SessionTurnContribution,
): SessionTurnContribution {
  if (current.turnId !== next.turnId) {
    throw new Error('Cannot merge contributions from different Turns');
  }
  return {
    turnId: current.turnId,
    firstSequence: Math.min(current.firstSequence, next.firstSequence),
    latestState:
      current.latestState === null ||
      (next.latestState !== null && next.latestState.sequence > current.latestState.sequence)
        ? next.latestState
        : current.latestState,
    userPromptPreview: current.userPromptPreview ?? next.userPromptPreview,
    hasAssistantMessage: current.hasAssistantMessage || next.hasAssistantMessage,
    hasAssistantOutput: current.hasAssistantOutput || next.hasAssistantOutput,
    hasToolResult: current.hasToolResult || next.hasToolResult,
    hasFailedToolResult: current.hasFailedToolResult || next.hasFailedToolResult,
    hasAbortNote: current.hasAbortNote || next.hasAbortNote,
  };
}

export function projectSessionTurnContributionForWire(
  contribution: SessionTurnContribution,
): SessionTurnContribution {
  const latestState = contribution.latestState;
  const projectedLatestState = latestState
    ? (() => {
        const { abortSource, errorClass, ...message } = latestState.message;
        return {
          ...latestState,
          message: {
            ...message,
            ...(abortSource
              ? { abortSource: truncateUtf8(abortSource, SESSION_TURN_DIAGNOSTIC_MAX_BYTES) }
              : {}),
            ...(errorClass
              ? { errorClass: truncateUtf8(errorClass, SESSION_TURN_DIAGNOSTIC_MAX_BYTES) }
              : {}),
          },
        };
      })()
    : null;
  return {
    ...contribution,
    latestState: projectedLatestState,
    userPromptPreview:
      contribution.userPromptPreview === null
        ? null
        : truncateUtf8(contribution.userPromptPreview, SESSION_TURN_PROMPT_PREVIEW_MAX_BYTES),
  };
}

export function projectSessionTurnContribution(contribution: SessionTurnContribution): TurnRecord {
  const state = contribution.latestState?.message;
  const partialOutputRetained = contribution.hasAssistantOutput || contribution.hasToolResult;
  if (state) {
    return {
      turnId: contribution.turnId,
      firstSequence: contribution.firstSequence,
      ...(contribution.userPromptPreview
        ? { userPromptPreview: contribution.userPromptPreview }
        : {}),
      status: state.status,
      statusSource: 'recorded',
      ...(state.parentTurnId ? { parentTurnId: state.parentTurnId } : {}),
      ...(state.retriedFromTurnId ? { retriedFromTurnId: state.retriedFromTurnId } : {}),
      ...(state.regeneratedFromTurnId
        ? { regeneratedFromTurnId: state.regeneratedFromTurnId }
        : {}),
      ...(state.branchOfTurnId ? { branchOfTurnId: state.branchOfTurnId } : {}),
      ...(state.parentSessionId ? { parentSessionId: state.parentSessionId } : {}),
      ...(state.abortedAt !== undefined ? { abortedAt: state.abortedAt } : {}),
      ...(state.abortSource ? { abortSource: state.abortSource } : {}),
      ...(state.errorClass ? { errorClass: state.errorClass } : {}),
      partialOutputRetained: state.partialOutputRetained || partialOutputRetained,
    };
  }
  return {
    turnId: contribution.turnId,
    firstSequence: contribution.firstSequence,
    ...(contribution.userPromptPreview
      ? { userPromptPreview: contribution.userPromptPreview }
      : {}),
    status: contribution.hasAbortNote
      ? 'aborted'
      : contribution.hasAssistantMessage
        ? 'completed'
        : contribution.hasFailedToolResult
          ? 'failed'
          : 'completed',
    statusSource: 'inferred',
    partialOutputRetained,
  };
}

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'persistence_failed',
  'internal_failure',
] as const;

export const SESSION_TURNS_OPERATION_SPECS = {
  'session.turns.query': defineOperation<
    SessionTurnsQueryInput,
    SessionTurnsQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeSessionTurnsQueryInput,
    decodeOutput: decodeSessionTurnsQueryResult,
    assertOutputForInput: (input, output) => {
      if (
        input.sessionId !== output.sessionId ||
        (input.throughSequence !== null && input.throughSequence !== output.throughSequence)
      ) {
        throw invalidProtocolFrame('Session turn query identity changed');
      }
    },
  }),
} as const;

export function decodeSessionTurnsQueryInput(value: unknown): SessionTurnsQueryInput {
  const input = requireExactRecord(value, 'Session turn query input', [
    'sessionId',
    'throughSequence',
    'position',
    'maxContributions',
  ]);
  const maxContributions = requireCount(
    input.maxContributions,
    'Session turn query contribution limit',
  );
  if (maxContributions < 1 || maxContributions > SESSION_TURN_QUERY_MAX_CONTRIBUTIONS) {
    throw invalidProtocolFrame('Invalid Session turn query contribution limit');
  }
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    throughSequence:
      input.throughSequence === null
        ? null
        : requireCount(input.throughSequence, 'Session turn query watermark'),
    position: requireCount(input.position, 'Session turn query position'),
    maxContributions,
  };
}

export function decodeSessionTurnsQueryResult(value: unknown): SessionTurnsQueryResult {
  requireEncodedByteLimit(value, 'Session turn query result', SESSION_TURN_QUERY_RESULT_MAX_BYTES);
  const result = requireExactRecord(value, 'Session turn query result', [
    'sessionId',
    'throughSequence',
    'contributions',
    'nextPosition',
  ]);
  if (
    !Array.isArray(result.contributions) ||
    result.contributions.length > SESSION_TURN_QUERY_MAX_CONTRIBUTIONS
  ) {
    throw invalidProtocolFrame('Invalid Session turn query contributions');
  }
  return {
    sessionId: requireEntityId(result.sessionId, 'sessionId'),
    throughSequence:
      result.throughSequence === null
        ? null
        : requireCount(result.throughSequence, 'Session turn query watermark'),
    contributions: result.contributions.map(decodeSessionTurnContribution),
    nextPosition:
      result.nextPosition === null
        ? null
        : requireCount(result.nextPosition, 'Session turn query next position'),
  };
}

function decodeSessionTurnContribution(value: unknown): SessionTurnContribution {
  const contribution = requireExactRecord(value, 'Session turn contribution', [
    'turnId',
    'firstSequence',
    'latestState',
    'userPromptPreview',
    'hasAssistantMessage',
    'hasAssistantOutput',
    'hasToolResult',
    'hasFailedToolResult',
    'hasAbortNote',
  ]);
  let latestState: SessionTurnContribution['latestState'] = null;
  if (contribution.latestState !== null) {
    const state = requireExactRecord(contribution.latestState, 'Session turn state contribution', [
      'sequence',
      'message',
    ]);
    const message = decodeStoredMessage(state.message);
    if (message.type !== 'turn_state') {
      throw invalidProtocolFrame('Invalid Session turn state contribution');
    }
    if (message.abortSource !== undefined) {
      requireUtf8String(
        message.abortSource,
        'Session turn abort source',
        SESSION_TURN_DIAGNOSTIC_MAX_BYTES,
      );
    }
    if (message.errorClass !== undefined) {
      requireUtf8String(
        message.errorClass,
        'Session turn error class',
        SESSION_TURN_DIAGNOSTIC_MAX_BYTES,
      );
    }
    latestState = {
      sequence: requireCount(state.sequence, 'Session turn state sequence'),
      message,
    };
  }
  return {
    turnId: requireEntityId(contribution.turnId, 'turnId'),
    firstSequence: requireCount(contribution.firstSequence, 'Session turn first sequence'),
    latestState,
    userPromptPreview:
      contribution.userPromptPreview === null
        ? null
        : requireUtf8String(
            contribution.userPromptPreview,
            'Session turn prompt preview',
            SESSION_TURN_PROMPT_PREVIEW_MAX_BYTES,
          ),
    hasAssistantMessage: requireBoolean(contribution.hasAssistantMessage),
    hasAssistantOutput: requireBoolean(contribution.hasAssistantOutput),
    hasToolResult: requireBoolean(contribution.hasToolResult),
    hasFailedToolResult: requireBoolean(contribution.hasFailedToolResult),
    hasAbortNote: requireBoolean(contribution.hasAbortNote),
  };
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame('Invalid Session turn contribution');
  return value;
}
