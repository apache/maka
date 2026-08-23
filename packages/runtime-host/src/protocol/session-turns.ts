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
export const SESSION_TURN_LANDMARK_MAX_ITEMS = 64;
export const SESSION_TURN_LANDMARK_LABEL_MAX_BYTES = 96;
export const SESSION_TURN_LANDMARK_RESULT_MAX_BYTES = 64 * 1024;

export interface SessionTurnLandmark {
  readonly turnId: string;
  readonly sequence: number;
  readonly label: string;
}

export interface SessionTurnLandmarksQueryInput {
  readonly sessionId: string;
  readonly maxLandmarks: number;
}

export interface SessionTurnLandmarksQueryResult {
  readonly sessionId: string;
  readonly throughSequence: number | null;
  readonly landmarks: readonly SessionTurnLandmark[];
}

export function projectSessionTurnLandmarkForWire(
  landmark: SessionTurnLandmark,
): SessionTurnLandmark {
  return {
    turnId: requireEntityId(landmark.turnId, 'turnId'),
    sequence: requireCount(landmark.sequence, 'Session turn landmark sequence'),
    label: truncateUtf8(landmark.label, SESSION_TURN_LANDMARK_LABEL_MAX_BYTES),
  };
}

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
    ? {
        sequence: latestState.sequence,
        message: projectTurnStateMessageForWire(latestState.message),
      }
    : null;
  return {
    turnId: requireEntityId(contribution.turnId, 'turnId'),
    firstSequence: contribution.firstSequence,
    latestState: projectedLatestState,
    userPromptPreview:
      contribution.userPromptPreview === null
        ? null
        : truncateUtf8(contribution.userPromptPreview, SESSION_TURN_PROMPT_PREVIEW_MAX_BYTES),
    hasAssistantMessage: contribution.hasAssistantMessage,
    hasAssistantOutput: contribution.hasAssistantOutput,
    hasToolResult: contribution.hasToolResult,
    hasFailedToolResult: contribution.hasFailedToolResult,
    hasAbortNote: contribution.hasAbortNote,
  };
}

function projectTurnStateMessageForWire(message: TurnStateMessage): TurnStateMessage {
  return {
    type: 'turn_state',
    id: requireEntityId(message.id, 'messageId'),
    turnId: requireEntityId(message.turnId, 'turnId'),
    ts: message.ts,
    status: message.status,
    ...(message.parentTurnId === undefined
      ? {}
      : { parentTurnId: requireEntityId(message.parentTurnId, 'parentTurnId') }),
    ...(message.retriedFromTurnId === undefined
      ? {}
      : { retriedFromTurnId: requireEntityId(message.retriedFromTurnId, 'retriedFromTurnId') }),
    ...(message.regeneratedFromTurnId === undefined
      ? {}
      : {
          regeneratedFromTurnId: requireEntityId(
            message.regeneratedFromTurnId,
            'regeneratedFromTurnId',
          ),
        }),
    ...(message.branchOfTurnId === undefined
      ? {}
      : { branchOfTurnId: requireEntityId(message.branchOfTurnId, 'branchOfTurnId') }),
    ...(message.parentSessionId === undefined
      ? {}
      : { parentSessionId: requireEntityId(message.parentSessionId, 'parentSessionId') }),
    ...(message.abortedAt === undefined ? {} : { abortedAt: message.abortedAt }),
    ...(message.abortSource
      ? {
          abortSource: truncateUtf8(message.abortSource, SESSION_TURN_DIAGNOSTIC_MAX_BYTES),
        }
      : {}),
    ...(message.errorClass
      ? { errorClass: truncateUtf8(message.errorClass, SESSION_TURN_DIAGNOSTIC_MAX_BYTES) }
      : {}),
    partialOutputRetained: message.partialOutputRetained,
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
  'session.turn_landmarks.query': defineOperation<
    SessionTurnLandmarksQueryInput,
    SessionTurnLandmarksQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeSessionTurnLandmarksQueryInput,
    decodeOutput: decodeSessionTurnLandmarksQueryResult,
    assertOutputForInput: (input, output) => {
      if (input.sessionId !== output.sessionId) {
        throw invalidProtocolFrame('Session turn landmark query identity changed');
      }
    },
  }),
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

export function decodeSessionTurnLandmarksQueryInput(
  value: unknown,
): SessionTurnLandmarksQueryInput {
  const input = requireExactRecord(value, 'Session turn landmark query input', [
    'sessionId',
    'maxLandmarks',
  ]);
  const maxLandmarks = requireCount(input.maxLandmarks, 'Session turn landmark limit');
  if (maxLandmarks < 1 || maxLandmarks > SESSION_TURN_LANDMARK_MAX_ITEMS) {
    throw invalidProtocolFrame('Invalid Session turn landmark limit');
  }
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    maxLandmarks,
  };
}

export function decodeSessionTurnLandmarksQueryResult(
  value: unknown,
): SessionTurnLandmarksQueryResult {
  requireEncodedByteLimit(
    value,
    'Session turn landmark query result',
    SESSION_TURN_LANDMARK_RESULT_MAX_BYTES,
  );
  const result = requireExactRecord(value, 'Session turn landmark query result', [
    'sessionId',
    'throughSequence',
    'landmarks',
  ]);
  if (
    !Array.isArray(result.landmarks) ||
    result.landmarks.length > SESSION_TURN_LANDMARK_MAX_ITEMS
  ) {
    throw invalidProtocolFrame('Invalid Session turn landmarks');
  }
  return {
    sessionId: requireEntityId(result.sessionId, 'sessionId'),
    throughSequence:
      result.throughSequence === null
        ? null
        : requireCount(result.throughSequence, 'Session turn landmark watermark'),
    landmarks: result.landmarks.map((value) => {
      const landmark = requireExactRecord(value, 'Session turn landmark', [
        'turnId',
        'sequence',
        'label',
      ]);
      return {
        turnId: requireEntityId(landmark.turnId, 'turnId'),
        sequence: requireCount(landmark.sequence, 'Session turn landmark sequence'),
        label: requireUtf8String(
          landmark.label,
          'Session turn landmark label',
          SESSION_TURN_LANDMARK_LABEL_MAX_BYTES,
        ),
      };
    }),
  };
}

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
