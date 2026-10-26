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

import {
  CHECKIN_INSTRUCTION_MAX_CHARS,
  CHECKIN_MAX_CARDS,
  CHECKIN_QUOTE_MAX_CHARS,
  CHECKIN_TITLE_MAX_CHARS,
  isCheckinCardAction,
  isCheckinEvidenceSource,
  type CheckinCard,
} from '@maka/core/session-checkin';
import {
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireShapedRecord,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

const SESSION_NAME_MAX_BYTES = 1024;

export type SessionCheckinFailureClass =
  | 'aborted'
  | 'timeout'
  | 'configuration'
  | 'provider'
  | 'invalid_response'
  | 'unknown';

const SESSION_CHECKIN_FAILURE_CLASSES: readonly SessionCheckinFailureClass[] = [
  'aborted',
  'timeout',
  'configuration',
  'provider',
  'invalid_response',
  'unknown',
];

export interface SessionCheckinGenerateInput {
  /** Stable identity a Client reuses when it retries the same check-in. */
  readonly effectId: string;
  /** When this Client's previous check-in ran; null for its first one. */
  readonly since: number | null;
}

export type SessionCheckinGenerateResult =
  /** No Session qualified; no model call was made. */
  | { readonly kind: 'empty'; readonly effectId: string }
  | {
      readonly kind: 'generated';
      readonly effectId: string;
      readonly cards: readonly CheckinCard[];
      /** Cards the model proposed that validation removed. */
      readonly dropped: number;
    }
  | {
      readonly kind: 'failed';
      readonly effectId: string;
      readonly errorClass: SessionCheckinFailureClass;
    };

export const SESSION_CHECKIN_OPERATION_SPECS = {
  'session.checkin.generate': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'operation_conflict',
      'internal_failure',
    ],
    decodeInput: decodeSessionCheckinGenerateInput,
    decodeOutput: decodeSessionCheckinGenerateResult,
    assertOutputForInput: (input, output) => {
      if (input.effectId !== output.effectId) {
        throw invalidProtocolFrame('Session check-in changed effect identity');
      }
    },
  }),
} as const;

export function decodeSessionCheckinGenerateInput(value: unknown): SessionCheckinGenerateInput {
  const input = requireExactRecord(value, 'Session check-in input', ['effectId', 'since']);
  return {
    effectId: requireEntityId(input.effectId, 'effectId'),
    since: input.since === null ? null : requireCount(input.since, 'Session check-in since'),
  };
}

export function decodeSessionCheckinGenerateResult(value: unknown): SessionCheckinGenerateResult {
  const result = requireRecord(value, 'Session check-in result');
  if (result.kind === 'empty') {
    const empty = requireExactRecord(result, 'Empty Session check-in', ['kind', 'effectId']);
    return { kind: 'empty', effectId: requireEntityId(empty.effectId, 'effectId') };
  }
  if (result.kind === 'failed') {
    const failed = requireExactRecord(result, 'Failed Session check-in', [
      'kind',
      'effectId',
      'errorClass',
    ]);
    if (!(SESSION_CHECKIN_FAILURE_CLASSES as readonly unknown[]).includes(failed.errorClass)) {
      throw invalidProtocolFrame('Invalid Session check-in failure class');
    }
    return {
      kind: 'failed',
      effectId: requireEntityId(failed.effectId, 'effectId'),
      errorClass: failed.errorClass as SessionCheckinFailureClass,
    };
  }
  const generated = requireExactRecord(result, 'Generated Session check-in', [
    'kind',
    'effectId',
    'cards',
    'dropped',
  ]);
  if (generated.kind !== 'generated') throw invalidProtocolFrame('Invalid Session check-in kind');
  if (!Array.isArray(generated.cards) || generated.cards.length > CHECKIN_MAX_CARDS) {
    throw invalidProtocolFrame('Invalid Session check-in cards');
  }
  return {
    kind: 'generated',
    effectId: requireEntityId(generated.effectId, 'effectId'),
    cards: generated.cards.map(decodeCheckinCard),
    dropped: requireCount(generated.dropped, 'Session check-in dropped count'),
  };
}

function decodeCheckinCard(value: unknown): CheckinCard {
  const card = requireShapedRecord(
    value,
    'Session check-in card',
    ['sessionId', 'sessionRevision', 'sessionName', 'title', 'evidence', 'action'],
    ['instruction'],
  );
  const evidence = requireExactRecord(card.evidence, 'Session check-in evidence', [
    'source',
    'quote',
  ]);
  if (!isCheckinCardAction(card.action) || !isCheckinEvidenceSource(evidence.source)) {
    throw invalidProtocolFrame('Invalid Session check-in card');
  }
  if (
    typeof card.sessionName !== 'string' ||
    Buffer.byteLength(card.sessionName) > SESSION_NAME_MAX_BYTES
  ) {
    throw invalidProtocolFrame('Invalid Session check-in Session name');
  }
  return {
    sessionId: requireEntityId(card.sessionId, 'sessionId'),
    sessionRevision: requireCount(card.sessionRevision, 'Session check-in revision'),
    sessionName: card.sessionName,
    title: requireChars(card.title, 'Session check-in title', CHECKIN_TITLE_MAX_CHARS),
    evidence: {
      source: evidence.source,
      quote: requireChars(evidence.quote, 'Session check-in quote', CHECKIN_QUOTE_MAX_CHARS),
    },
    action: card.action,
    ...(card.instruction !== undefined
      ? {
          instruction: requireChars(
            card.instruction,
            'Session check-in instruction',
            CHECKIN_INSTRUCTION_MAX_CHARS,
          ),
        }
      : {}),
  };
}

function requireChars(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > maxChars) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}
