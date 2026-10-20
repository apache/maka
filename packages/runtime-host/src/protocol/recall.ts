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

/**
 * `recall.query` — the retrieval surface a Client can ask for directly.
 *
 * Recall runs inside the Host because that is where the corpus lives: the
 * Session manager, the distilled-fact store, and the material fetch are all
 * Host-owned. A Client cannot perform it itself without pulling every
 * transcript across the boundary, which is exactly the arrangement this
 * operation replaces.
 *
 * The wire shape mirrors what the model's `Recall` tool already returns
 * (`@maka/runtime/recall-tools`), with this protocol's camelCase field naming.
 * That is deliberate: one recall answer, two presentations. A UI renders
 * passages as navigable results and a model reads them as context, and neither
 * gets a second implementation to drift from.
 */

import {
  RECALL_MAX_LIMIT,
  RECALL_MAX_TERMS,
  RECALL_TOTAL_PAYLOAD_CAP_BYTES,
  type RecallFailureReason,
} from '@maka/core/recall';
import { SEARCH_QUERY_MAX_CHARS } from '@maka/core/search';
import {
  requireCount,
  requireEncodedByteLimit,
  requireEntityId,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const RECALL_QUERY_TERM_MAX_CHARS = SEARCH_QUERY_MAX_CHARS;

/**
 * Byte ceiling for one term. Core measures a term in code points
 * (`Array.from(term).length`), so the wire bound is that count times the
 * widest UTF-8 encoding of one code point. A term that passes here can still
 * be rejected by core on the character count; this only stops a frame that
 * could not represent a legal term at all.
 */
const RECALL_QUERY_TERM_MAX_BYTES = RECALL_QUERY_TERM_MAX_CHARS * 4;

export const RECALL_QUERY_QUESTION_MAX_BYTES = 2 * 1024;
export const RECALL_QUERY_TEXT_MAX_BYTES = 32 * 1024;
export const RECALL_QUERY_MATERIAL_NAME_MAX_BYTES = 1024;
export const RECALL_QUERY_RESOURCE_MAX_BYTES = 1024;

/**
 * Encoded ceiling for one envelope. Recall caps its own payload at
 * `RECALL_TOTAL_PAYLOAD_CAP_BYTES`, but that counts passage text only; the
 * envelope adds field names, message ids, timestamps and materials on top.
 * This bound is that cap plus generous structural headroom, so it rejects a
 * frame that no honest Host could have produced without constraining one that
 * did.
 */
export const RECALL_QUERY_RESULT_MAX_BYTES = RECALL_TOTAL_PAYLOAD_CAP_BYTES + 64 * 1024;

const RECALL_FAILURE_REASONS: readonly RecallFailureReason[] = [
  'invalid_query',
  'incognito_active',
  'not_found',
  'aborted',
];

const RECALL_ROLES = ['user', 'assistant', 'tool'] as const;
const RECALL_MATERIAL_KINDS = ['image', 'pdf', 'doc', 'code', 'other'] as const;

const ERROR_CODES = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'internal_failure',
] as const;

export interface RecallQueryInput {
  /** Literal terms, matched case-insensitively as substrings and OR-combined. */
  readonly terms: readonly string[];
  readonly question?: string;
  readonly limit?: number;
  /** Restrict recall to one Session. */
  readonly sessionId?: string;
  readonly since?: number;
  readonly until?: number;
}

export interface RecallQueryFact {
  readonly content: string;
  readonly kind: string;
  readonly observedAt: number;
}

export interface RecallQueryMaterial {
  readonly name: string;
  readonly kind: (typeof RECALL_MATERIAL_KINDS)[number];
  readonly mimeType: string;
  readonly bytes: number;
  /** Address `Read` accepts; present only when `Read` would answer it here. */
  readonly resource?: string;
  /** Present instead of `resource`: ask for the file by this pair. */
  readonly sourceSessionId?: string;
  readonly materialId?: string;
}

export interface RecallQueryPassageMessage {
  readonly messageId: string;
  readonly role: (typeof RECALL_ROLES)[number];
  readonly matchKind: string;
  readonly text: string;
  readonly timestamp: number;
  readonly isAnchor: boolean;
  readonly materials?: readonly RecallQueryMaterial[];
}

export interface RecallQueryPassage {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly turnId?: string;
  readonly anchorMessageId: string;
  /**
   * The anchor's index in its Session transcript — the coordinate a Client
   * scrolls to. See `RecallPassage.sequence` in `@maka/core/recall`.
   */
  readonly sequence: number;
  readonly messages: readonly RecallQueryPassageMessage[];
  readonly matchedTerms: readonly string[];
  readonly score: number;
  readonly lastMessageAt?: number;
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  readonly truncated?: boolean;
}

export type RecallQueryResult =
  | {
      readonly ok: true;
      readonly facts: readonly RecallQueryFact[];
      readonly passages: readonly RecallQueryPassage[];
      readonly gaps: string;
      readonly searchedEverySession: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: RecallFailureReason;
      readonly message: string;
    };

export const RECALL_OPERATION_SPECS = {
  'recall.query': defineOperation<
    RecallQueryInput,
    RecallQueryResult,
    (typeof ERROR_CODES)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: ERROR_CODES,
    decodeInput: decodeRecallQueryInput,
    decodeOutput: decodeRecallQueryResult,
  }),
} as const;

function decodeRecallQueryInput(value: unknown): RecallQueryInput {
  const record = requireShapedRecord(
    value,
    'Recall query input',
    ['terms'],
    ['question', 'limit', 'sessionId', 'since', 'until'],
  );
  if (!Array.isArray(record.terms) || record.terms.length === 0) {
    throw invalidProtocolFrame('Invalid Recall terms');
  }
  if (record.terms.length > RECALL_MAX_TERMS) {
    throw invalidProtocolFrame('Too many Recall terms');
  }
  const terms = record.terms.map((term) =>
    requireUtf8String(term, 'Recall term', RECALL_QUERY_TERM_MAX_BYTES),
  );
  const limit = record.limit === undefined ? undefined : requireCount(record.limit, 'Recall limit');
  if (limit !== undefined && (limit < 1 || limit > RECALL_MAX_LIMIT)) {
    throw invalidProtocolFrame('Invalid Recall limit');
  }
  return {
    terms,
    ...(record.question === undefined
      ? {}
      : {
          question: requireUtf8String(
            record.question,
            'Recall question',
            RECALL_QUERY_QUESTION_MAX_BYTES,
          ),
        }),
    ...(limit === undefined ? {} : { limit }),
    ...(record.sessionId === undefined
      ? {}
      : { sessionId: requireEntityId(record.sessionId, 'Recall sessionId') }),
    ...(record.since === undefined ? {} : { since: requireCount(record.since, 'Recall since') }),
    ...(record.until === undefined ? {} : { until: requireCount(record.until, 'Recall until') }),
  };
}

/**
 * Bounded text that may be empty. Transcript text is legitimately empty when a
 * message carried only files, and a Session title is empty for an unnamed
 * Session; both are legal answers, so they must not be rejected as malformed.
 */
function requireBoundedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function decodeRecallQueryResult(value: unknown): RecallQueryResult {
  requireEncodedByteLimit(value, 'Recall query result', RECALL_QUERY_RESULT_MAX_BYTES);
  const record = requireShapedRecord(
    value,
    'Recall query result',
    ['ok'],
    ['facts', 'passages', 'gaps', 'searchedEverySession', 'reason', 'message'],
  );
  if (record.ok === false) {
    const exact = requireShapedRecord(
      record,
      'Recall error result',
      ['ok', 'reason', 'message'],
      [],
    );
    if (
      typeof exact.reason !== 'string' ||
      !RECALL_FAILURE_REASONS.includes(exact.reason as RecallFailureReason)
    ) {
      throw invalidProtocolFrame('Invalid Recall failure reason');
    }
    return {
      ok: false,
      reason: exact.reason as RecallFailureReason,
      message: requireUtf8String(
        exact.message,
        'Recall failure message',
        RECALL_QUERY_TEXT_MAX_BYTES,
      ),
    };
  }
  if (record.ok !== true) throw invalidProtocolFrame('Invalid Recall query result kind');
  const exact = requireShapedRecord(
    record,
    'Recall success result',
    ['ok', 'facts', 'passages', 'gaps', 'searchedEverySession'],
    [],
  );
  if (!Array.isArray(exact.facts) || !Array.isArray(exact.passages)) {
    throw invalidProtocolFrame('Invalid Recall success result');
  }
  if (typeof exact.searchedEverySession !== 'boolean') {
    throw invalidProtocolFrame('Invalid Recall searchedEverySession');
  }
  return {
    ok: true,
    facts: exact.facts.map((fact) => decodeFact(fact)),
    passages: exact.passages.map((passage) => decodePassage(passage)),
    gaps: requireUtf8String(exact.gaps, 'Recall gaps', RECALL_QUERY_TEXT_MAX_BYTES),
    searchedEverySession: exact.searchedEverySession,
  };
}

function decodeFact(value: unknown): RecallQueryFact {
  const record = requireShapedRecord(value, 'Recall fact', ['content', 'kind', 'observedAt'], []);
  return {
    content: requireUtf8String(record.content, 'Recall fact content', RECALL_QUERY_TEXT_MAX_BYTES),
    kind: requireUtf8String(record.kind, 'Recall fact kind', RECALL_QUERY_MATERIAL_NAME_MAX_BYTES),
    observedAt: requireCount(record.observedAt, 'Recall fact observedAt'),
  };
}

function decodePassage(value: unknown): RecallQueryPassage {
  const record = requireShapedRecord(
    value,
    'Recall passage',
    [
      'sessionId',
      'sessionTitle',
      'anchorMessageId',
      'sequence',
      'messages',
      'matchedTerms',
      'score',
      'hasMoreBefore',
      'hasMoreAfter',
    ],
    ['turnId', 'lastMessageAt', 'truncated'],
  );
  if (!Array.isArray(record.messages) || !Array.isArray(record.matchedTerms)) {
    throw invalidProtocolFrame('Invalid Recall passage messages');
  }
  if (typeof record.score !== 'number' || !Number.isFinite(record.score)) {
    throw invalidProtocolFrame('Invalid Recall passage score');
  }
  if (typeof record.hasMoreBefore !== 'boolean' || typeof record.hasMoreAfter !== 'boolean') {
    throw invalidProtocolFrame('Invalid Recall passage continuation flags');
  }
  return {
    sessionId: requireEntityId(record.sessionId, 'Recall passage sessionId'),
    sessionTitle: requireBoundedText(
      record.sessionTitle,
      'Recall passage sessionTitle',
      RECALL_QUERY_TEXT_MAX_BYTES,
    ),
    ...(record.turnId === undefined
      ? {}
      : { turnId: requireEntityId(record.turnId, 'Recall passage turnId') }),
    anchorMessageId: requireEntityId(record.anchorMessageId, 'Recall passage anchorMessageId'),
    sequence: requireCount(record.sequence, 'Recall passage sequence'),
    messages: record.messages.map((message) => decodePassageMessage(message)),
    matchedTerms: record.matchedTerms.map((term) =>
      requireUtf8String(term, 'Recall matched term', RECALL_QUERY_TERM_MAX_BYTES),
    ),
    score: record.score,
    ...(record.lastMessageAt === undefined
      ? {}
      : { lastMessageAt: requireCount(record.lastMessageAt, 'Recall passage lastMessageAt') }),
    hasMoreBefore: record.hasMoreBefore,
    hasMoreAfter: record.hasMoreAfter,
    ...(record.truncated === undefined
      ? {}
      : record.truncated === true
        ? { truncated: true as const }
        : (() => {
            throw invalidProtocolFrame('Invalid Recall passage truncated flag');
          })()),
  };
}

function decodePassageMessage(value: unknown): RecallQueryPassageMessage {
  const record = requireShapedRecord(
    value,
    'Recall passage message',
    ['messageId', 'role', 'matchKind', 'text', 'timestamp', 'isAnchor'],
    ['materials'],
  );
  if (
    typeof record.role !== 'string' ||
    !RECALL_ROLES.includes(record.role as (typeof RECALL_ROLES)[number])
  ) {
    throw invalidProtocolFrame('Invalid Recall passage message role');
  }
  if (typeof record.isAnchor !== 'boolean') {
    throw invalidProtocolFrame('Invalid Recall passage message anchor flag');
  }
  if (record.materials !== undefined && !Array.isArray(record.materials)) {
    throw invalidProtocolFrame('Invalid Recall passage message materials');
  }
  return {
    messageId: requireEntityId(record.messageId, 'Recall passage messageId'),
    role: record.role as (typeof RECALL_ROLES)[number],
    matchKind: requireUtf8String(
      record.matchKind,
      'Recall passage message matchKind',
      RECALL_QUERY_MATERIAL_NAME_MAX_BYTES,
    ),
    // A message whose whole content was a pasted file carries no text of its
    // own; the material beside it is the point. Empty is legal here, unlike
    // the identifiers around it.
    text: requireBoundedText(
      record.text,
      'Recall passage message text',
      RECALL_QUERY_TEXT_MAX_BYTES,
    ),
    timestamp: requireCount(record.timestamp, 'Recall passage message timestamp'),
    isAnchor: record.isAnchor,
    ...(record.materials === undefined
      ? {}
      : { materials: record.materials.map((material) => decodeMaterial(material)) }),
  };
}

function decodeMaterial(value: unknown): RecallQueryMaterial {
  const record = requireShapedRecord(
    value,
    'Recall material',
    ['name', 'kind', 'mimeType', 'bytes'],
    ['resource', 'sourceSessionId', 'materialId'],
  );
  if (
    typeof record.kind !== 'string' ||
    !RECALL_MATERIAL_KINDS.includes(record.kind as (typeof RECALL_MATERIAL_KINDS)[number])
  ) {
    throw invalidProtocolFrame('Invalid Recall material kind');
  }
  const resource =
    record.resource === undefined
      ? undefined
      : requireUtf8String(
          record.resource,
          'Recall material resource',
          RECALL_QUERY_RESOURCE_MAX_BYTES,
        );
  const sourceSessionId =
    record.sourceSessionId === undefined
      ? undefined
      : requireEntityId(record.sourceSessionId, 'Recall material sourceSessionId');
  const materialId =
    record.materialId === undefined
      ? undefined
      : requireEntityId(record.materialId, 'Recall material materialId');
  // An address says "read this now"; a location says "ask for it". Carrying
  // both would offer a caller two answers to one question, so recall never
  // emits both and the decoder refuses the shape rather than picking a winner.
  if (resource !== undefined && (sourceSessionId !== undefined || materialId !== undefined)) {
    throw invalidProtocolFrame('Invalid Recall material location');
  }
  if ((sourceSessionId === undefined) !== (materialId === undefined)) {
    throw invalidProtocolFrame('Incomplete Recall material location');
  }
  return {
    name: requireUtf8String(
      record.name,
      'Recall material name',
      RECALL_QUERY_MATERIAL_NAME_MAX_BYTES,
    ),
    kind: record.kind as (typeof RECALL_MATERIAL_KINDS)[number],
    mimeType: requireUtf8String(
      record.mimeType,
      'Recall material mimeType',
      RECALL_QUERY_MATERIAL_NAME_MAX_BYTES,
    ),
    bytes: requireCount(record.bytes, 'Recall material bytes'),
    ...(resource === undefined ? {} : { resource }),
    ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
    ...(materialId === undefined ? {} : { materialId }),
  };
}
