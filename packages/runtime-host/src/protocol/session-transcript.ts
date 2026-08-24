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
  requireRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES = 16 * 1024;
export const SESSION_TRANSCRIPT_PAGE_MAX_BYTES = 512 * 1024;
export const SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES = 256;
export const SESSION_TRANSCRIPT_OVERLAY_MAX_MESSAGES = 4_096;
export const SESSION_TRANSCRIPT_PAGE_RESULT_MAX_BYTES = 744 * 1024;
export const SESSION_TRANSCRIPT_CURSOR_MAX_BYTES = 1024;

export type SessionTranscriptPageSource = 'durable' | 'overlay';
export type SessionTranscriptPageDirection = 'older' | 'newer';

export type SessionTranscriptFragment =
  | {
      readonly kind: 'durable';
      readonly sequence: number;
      readonly byteOffset: number;
      readonly totalBytes: number;
      readonly payloadDigest: `sha256:${string}` | null;
      readonly data: string;
    }
  | {
      readonly kind: 'overlay';
      readonly messageIndex: number;
      readonly byteOffset: number;
      readonly totalBytes: number;
      readonly data: string;
    };

export interface SessionTranscriptPage {
  readonly kind: 'page';
  readonly sessionId: string;
  readonly source: SessionTranscriptPageSource;
  readonly direction: SessionTranscriptPageDirection;
  readonly throughSequence: number | null;
  readonly rawBytes: number;
  readonly fragments: readonly SessionTranscriptFragment[];
  readonly nextCursor: string | null;
}

export interface SessionTranscriptBootstrap {
  readonly throughSequence: number | null;
  readonly overlayMessageCount: number;
  readonly durable: SessionTranscriptPage;
  readonly overlay: SessionTranscriptPage;
}

export interface SessionTranscriptPageInput {
  readonly subscriptionId: string;
  readonly source: SessionTranscriptPageSource;
  readonly direction: SessionTranscriptPageDirection;
  readonly throughSequence: number | null;
  readonly cursor: string | null;
  readonly anchorSequence: number | null;
  readonly maxBytes: number;
}

export interface SessionTranscriptOverlayReleaseInput {
  readonly subscriptionId: string;
}

export interface SessionTranscriptOverlayReleaseResult {
  readonly subscriptionId: string;
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
  'session.transcript.overlay.release': defineOperation({
    mode: 'control',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeSessionTranscriptOverlayReleaseInput,
    decodeOutput: decodeSessionTranscriptOverlayReleaseResult,
    assertOutputForInput: (input, output) => {
      if (input.subscriptionId !== output.subscriptionId) {
        throw invalidProtocolFrame('Session transcript overlay release identity changed');
      }
    },
  }),
} as const;

function decodeSessionTranscriptOverlayReleaseInput(
  value: unknown,
): SessionTranscriptOverlayReleaseInput {
  const input = requireExactRecord(value, 'Session transcript overlay release input', [
    'subscriptionId',
  ]);
  return { subscriptionId: requireId(input.subscriptionId, 'subscriptionId') };
}

function decodeSessionTranscriptOverlayReleaseResult(
  value: unknown,
): SessionTranscriptOverlayReleaseResult {
  const result = requireExactRecord(value, 'Session transcript overlay release result', [
    'subscriptionId',
  ]);
  return { subscriptionId: requireId(result.subscriptionId, 'subscriptionId') };
}

export function decodeSessionTranscriptPageInput(value: unknown): SessionTranscriptPageInput {
  const input = requireExactRecord(value, 'Session transcript page input', [
    'subscriptionId',
    'source',
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
  return {
    subscriptionId: requireId(input.subscriptionId, 'subscriptionId'),
    source: decodeSource(input.source),
    direction: decodeDirection(input.direction),
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
  const bootstrap = requireExactRecord(value, 'Session transcript bootstrap', [
    'throughSequence',
    'overlayMessageCount',
    'durable',
    'overlay',
  ]);
  const throughSequence =
    bootstrap.throughSequence === null
      ? null
      : requireCount(bootstrap.throughSequence, 'Session transcript watermark');
  const overlayMessageCount = requireCount(
    bootstrap.overlayMessageCount,
    'Session transcript overlay message count',
  );
  if (overlayMessageCount > SESSION_TRANSCRIPT_OVERLAY_MAX_MESSAGES) {
    throw invalidProtocolFrame('Session transcript overlay exceeds its message limit');
  }
  const durable = decodeSessionTranscriptPage(bootstrap.durable);
  const overlay = decodeSessionTranscriptPage(bootstrap.overlay);
  if (
    durable.source !== 'durable' ||
    durable.direction !== 'older' ||
    overlay.source !== 'overlay' ||
    overlay.direction !== 'older' ||
    durable.throughSequence !== throughSequence ||
    overlay.throughSequence !== throughSequence
  ) {
    throw invalidProtocolFrame('Invalid Session transcript bootstrap correlation');
  }
  if (durable.rawBytes + overlay.rawBytes > SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES) {
    throw invalidProtocolFrame('Session transcript bootstrap exceeds byte limit');
  }
  return { throughSequence, overlayMessageCount, durable, overlay };
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
    'source',
    'direction',
    'throughSequence',
    'rawBytes',
    'fragments',
    'nextCursor',
  ]);
  if (result.kind !== 'page') throw invalidProtocolFrame('Invalid Session transcript page kind');
  const source = decodeSource(result.source);
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
    decodeSessionTranscriptFragment(fragment, source, throughSequence),
  );
  assertFragmentOrder(fragments, direction);
  const rawBytes = requireCount(result.rawBytes, 'Session transcript page bytes');
  if (
    rawBytes > SESSION_TRANSCRIPT_PAGE_MAX_BYTES ||
    fragments.reduce(
      (total, fragment) => total + Buffer.from(fragment.data, 'base64').byteLength,
      0,
    ) !== rawBytes
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
    source,
    direction,
    throughSequence,
    rawBytes,
    fragments,
    nextCursor,
  };
}

function assertFragmentOrder(
  fragments: readonly SessionTranscriptFragment[],
  direction: SessionTranscriptPageDirection,
): void {
  let previous: number | undefined;
  for (const fragment of fragments) {
    const identity = fragment.kind === 'durable' ? fragment.sequence : fragment.messageIndex;
    if (
      previous !== undefined &&
      (direction === 'older' ? identity >= previous : identity <= previous)
    ) {
      throw invalidProtocolFrame('Session transcript page fragment order changed');
    }
    previous = identity;
  }
}

function decodeSessionTranscriptFragment(
  value: unknown,
  source: SessionTranscriptPageSource,
  throughSequence: number | null,
): SessionTranscriptFragment {
  const fragment = requireRecord(value, 'Session transcript fragment');
  const identityKey = source === 'durable' ? 'sequence' : 'messageIndex';
  const exact = requireExactRecord(fragment, 'Session transcript fragment', [
    'kind',
    identityKey,
    'byteOffset',
    'totalBytes',
    ...(source === 'durable' ? ['payloadDigest'] : []),
    'data',
  ]);
  if (exact.kind !== source) {
    throw invalidProtocolFrame('Session transcript fragment source changed');
  }
  const byteOffset = requireCount(exact.byteOffset, 'Session transcript fragment byte offset');
  const totalBytes = requireCount(exact.totalBytes, 'Session transcript fragment total bytes');
  const data = requireBase64Fragment(exact.data);
  const dataBytes = Buffer.from(data, 'base64').byteLength;
  if (
    totalBytes === 0 ||
    dataBytes === 0 ||
    byteOffset >= totalBytes ||
    byteOffset + dataBytes > totalBytes
  ) {
    throw invalidProtocolFrame('Invalid Session transcript fragment bounds');
  }
  if (source === 'durable') {
    const sequence = requireCount(exact.sequence, 'Session transcript message sequence');
    if (throughSequence === null || sequence > throughSequence) {
      throw invalidProtocolFrame('Session transcript fragment exceeds watermark');
    }
    const payloadDigest =
      exact.payloadDigest === null
        ? null
        : requirePayloadDigest(exact.payloadDigest, 'Session transcript payload digest');
    return { kind: 'durable', sequence, byteOffset, totalBytes, payloadDigest, data };
  }
  return {
    kind: 'overlay',
    messageIndex: requireCount(exact.messageIndex, 'Session transcript overlay index'),
    byteOffset,
    totalBytes,
    data,
  };
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
    output.source !== input.source ||
    output.direction !== input.direction ||
    output.throughSequence !== input.throughSequence ||
    output.rawBytes > input.maxBytes
  ) {
    throw invalidProtocolFrame('Session transcript page does not match request');
  }
}

function decodeSource(value: unknown): SessionTranscriptPageSource {
  if (value !== 'durable' && value !== 'overlay') {
    throw invalidProtocolFrame('Invalid Session transcript page source');
  }
  return value;
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
