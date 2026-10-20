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
  requireCount,
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireId,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES = 16 * 1024;
export const SESSION_TRANSCRIPT_PAGE_MAX_BYTES = 512 * 1024;
export const SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES = 256;
export const SESSION_TRANSCRIPT_PAGE_RESULT_MAX_BYTES = 744 * 1024;
export const SESSION_TRANSCRIPT_CURSOR_MAX_BYTES = 1024;

export type SessionTranscriptPageDirection = 'older' | 'newer';

export interface SessionTranscriptFragment {
  readonly sequence: number;
  readonly byteOffset: number;
  readonly totalBytes: number;
  readonly payloadDigest: `sha256:${string}` | null;
  readonly data: string;
}

export interface SessionTranscriptPage {
  readonly kind: 'page';
  readonly sessionId: string;
  readonly direction: SessionTranscriptPageDirection;
  readonly throughSequence: number | null;
  readonly rawBytes: number;
  readonly fragments: readonly SessionTranscriptFragment[];
  readonly nextCursor: string | null;
  /**
   * Whether every Turn with rows on this page has all of them here. A reader
   * that stops on a page which says so cannot be holding half a Turn — which a
   * change of owner between rows does not tell it, because the Host writes a
   * nested Turn's rows between the rows of the Turn around it.
   */
  readonly endsAtTurnBoundary: boolean;
}

export interface SessionTranscriptBootstrap {
  readonly durable: SessionTranscriptPage;
}

export interface SessionTranscriptPageInput {
  readonly subscriptionId: string;
  readonly direction: SessionTranscriptPageDirection;
  readonly throughSequence: number | null;
  readonly cursor: string | null;
  readonly anchorSequence: number | null;
  readonly maxBytes: number;
}

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'operation_conflict',
  'persistence_failed',
  'internal_failure',
] as const;

export const SESSION_TRANSCRIPT_OPERATION_SPECS = {
  'session.transcript.page': defineOperation({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeSessionTranscriptPageInput,
    decodeOutput: decodeSessionTranscriptPage,
    assertOutputForInput: assertSessionTranscriptPageOutput,
  }),
} as const;

export function decodeSessionTranscriptPageInput(value: unknown): SessionTranscriptPageInput {
  const input = requireExactRecord(value, 'Session transcript page input', [
    'subscriptionId',
    'direction',
    'throughSequence',
    'cursor',
    'anchorSequence',
    'maxBytes',
  ]);
  const cursor =
    input.cursor === null
      ? null
      : requireUtf8String(
          input.cursor,
          'Session transcript cursor',
          SESSION_TRANSCRIPT_CURSOR_MAX_BYTES,
        );
  const anchorSequence =
    input.anchorSequence === null
      ? null
      : requireCount(input.anchorSequence, 'Session transcript anchor sequence');
  if (cursor !== null && anchorSequence !== null) {
    throw invalidProtocolFrame('Session transcript cursor and anchor are mutually exclusive');
  }
  const direction = decodeDirection(input.direction);
  if (anchorSequence !== null && direction !== 'newer') {
    throw invalidProtocolFrame('Session transcript anchor requires a newer read');
  }
  return {
    subscriptionId: requireId(input.subscriptionId, 'subscriptionId'),
    direction,
    throughSequence:
      input.throughSequence === null
        ? null
        : requireCount(input.throughSequence, 'Session transcript watermark'),
    cursor,
    anchorSequence,
    maxBytes: requirePageByteLimit(input.maxBytes),
  };
}

export function decodeSessionTranscriptBootstrap(value: unknown): SessionTranscriptBootstrap {
  const bootstrap = requireExactRecord(value, 'Session transcript bootstrap', ['durable']);
  const durable = decodeSessionTranscriptPage(bootstrap.durable);
  if (durable.direction !== 'older') {
    throw invalidProtocolFrame('Invalid Session transcript bootstrap correlation');
  }
  if (durable.rawBytes > SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES) {
    throw invalidProtocolFrame('Session transcript bootstrap exceeds byte limit');
  }
  return { durable };
}

export function decodeSessionTranscriptPage(value: unknown): SessionTranscriptPage {
  requireEncodedByteLimit(
    value,
    'Session transcript page result',
    SESSION_TRANSCRIPT_PAGE_RESULT_MAX_BYTES,
  );
  const result = requireExactRecord(value, 'Session transcript page result', [
    'kind',
    'sessionId',
    'direction',
    'throughSequence',
    'rawBytes',
    'fragments',
    'nextCursor',
    'endsAtTurnBoundary',
  ]);
  if (typeof result.endsAtTurnBoundary !== 'boolean') {
    throw invalidProtocolFrame('Invalid Session transcript page Turn boundary');
  }
  if (result.kind !== 'page') throw invalidProtocolFrame('Invalid Session transcript page kind');
  const direction = decodeDirection(result.direction);
  const throughSequence =
    result.throughSequence === null
      ? null
      : requireCount(result.throughSequence, 'Session transcript watermark');
  if (
    !Array.isArray(result.fragments) ||
    result.fragments.length > SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES
  ) {
    throw invalidProtocolFrame('Invalid Session transcript page fragments');
  }
  const fragments = result.fragments.map((fragment) =>
    decodeSessionTranscriptFragment(fragment, throughSequence),
  );
  assertFragmentOrder(fragments, direction);
  const rawBytes = requireCount(result.rawBytes, 'Session transcript page bytes');
  if (
    rawBytes > SESSION_TRANSCRIPT_PAGE_MAX_BYTES ||
    fragments.reduce((total, fragment) => total + Buffer.byteLength(fragment.data, 'base64'), 0) !==
      rawBytes
  ) {
    throw invalidProtocolFrame('Invalid Session transcript page byte count');
  }
  const nextCursor =
    result.nextCursor === null
      ? null
      : requireUtf8String(
          result.nextCursor,
          'Session transcript cursor',
          SESSION_TRANSCRIPT_CURSOR_MAX_BYTES,
        );
  if (fragments.length === 0 && (rawBytes !== 0 || nextCursor !== null)) {
    throw invalidProtocolFrame('Invalid empty Session transcript page');
  }
  return {
    kind: 'page',
    sessionId: requireEntityId(result.sessionId, 'sessionId'),
    direction,
    throughSequence,
    rawBytes,
    fragments,
    nextCursor,
    endsAtTurnBoundary: result.endsAtTurnBoundary,
  };
}

function assertFragmentOrder(
  fragments: readonly SessionTranscriptFragment[],
  direction: SessionTranscriptPageDirection,
): void {
  let previous: number | undefined;
  for (const { sequence } of fragments) {
    if (
      previous !== undefined &&
      (direction === 'older' ? sequence >= previous : sequence <= previous)
    ) {
      throw invalidProtocolFrame('Session transcript page fragment order changed');
    }
    previous = sequence;
  }
}

function decodeSessionTranscriptFragment(
  value: unknown,
  throughSequence: number | null,
): SessionTranscriptFragment {
  const exact = requireExactRecord(value, 'Session transcript fragment', [
    'sequence',
    'byteOffset',
    'totalBytes',
    'payloadDigest',
    'data',
  ]);
  const byteOffset = requireCount(exact.byteOffset, 'Session transcript fragment byte offset');
  const totalBytes = requireCount(exact.totalBytes, 'Session transcript fragment total bytes');
  const data = requireBase64Fragment(exact.data);
  const dataBytes = Buffer.byteLength(data, 'base64');
  if (
    totalBytes === 0 ||
    dataBytes === 0 ||
    byteOffset >= totalBytes ||
    byteOffset + dataBytes > totalBytes
  ) {
    throw invalidProtocolFrame('Invalid Session transcript fragment bounds');
  }
  const sequence = requireCount(exact.sequence, 'Session transcript message sequence');
  if (throughSequence === null || sequence > throughSequence) {
    throw invalidProtocolFrame('Session transcript fragment exceeds watermark');
  }
  const payloadDigest =
    exact.payloadDigest === null
      ? null
      : requirePayloadDigest(exact.payloadDigest, 'Session transcript payload digest');
  return { sequence, byteOffset, totalBytes, payloadDigest, data };
}

function requirePayloadDigest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as `sha256:${string}`;
}

function requireBase64Fragment(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw invalidProtocolFrame('Invalid Session transcript fragment data');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength > SESSION_TRANSCRIPT_PAGE_MAX_BYTES || bytes.toString('base64') !== value) {
    throw invalidProtocolFrame('Invalid Session transcript fragment data');
  }
  return value;
}

function assertSessionTranscriptPageOutput(
  input: SessionTranscriptPageInput,
  output: SessionTranscriptPage,
): void {
  if (
    output.direction !== input.direction ||
    output.throughSequence !== input.throughSequence ||
    output.rawBytes > input.maxBytes
  ) {
    throw invalidProtocolFrame('Session transcript page does not match request');
  }
}

function decodeDirection(value: unknown): SessionTranscriptPageDirection {
  if (value !== 'older' && value !== 'newer') {
    throw invalidProtocolFrame('Invalid Session transcript page direction');
  }
  return value;
}

function requirePageByteLimit(value: unknown): number {
  const limit = requireCount(value, 'Session transcript page byte limit');
  if (limit < 1 || limit > SESSION_TRANSCRIPT_PAGE_MAX_BYTES) {
    throw invalidProtocolFrame('Invalid Session transcript page byte limit');
  }
  return limit;
}
