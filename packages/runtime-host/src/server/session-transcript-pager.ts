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

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES,
  type SessionTranscriptBootstrap,
  type SessionTranscriptFragment,
  type SessionTranscriptPage,
  type SessionTranscriptPageDirection,
  type SessionTranscriptPageInput,
} from '../protocol/index.js';
import {
  type SessionTranscriptReader,
  type TranscriptRowProjection,
} from './session-transcript-reader.js';
import { projectSharedSessionTranscriptMessage } from './shared-session-transcript.js';

type SessionTranscriptProjection = 'owner' | 'shared';

interface TranscriptCursorState {
  readonly version: 1;
  readonly subscriptionId: string;
  readonly sessionId: string;
  readonly direction: SessionTranscriptPageDirection;
  readonly throughSequence: number | null;
  readonly position: number;
  readonly byteOffset: number | null;
}

export interface SubscriberTranscriptState {
  readonly sessionId: string;
  readonly subscriptionId: string;
  readonly cursorSecret: Buffer;
  durableThroughSequence: number | null;
  readonly projection: SessionTranscriptProjection;
}

interface SelectedFragments {
  readonly fragments: readonly SessionTranscriptFragment[];
  readonly rawBytes: number;
  readonly next: { position: number; byteOffset: number | null } | null;
  readonly endsAtTurnBoundary: boolean;
}

export async function createSessionTranscriptBootstrap(input: {
  reader: SessionTranscriptReader;
  sessionId: string;
  subscriptionId: string;
  throughSequence: number | null;
  maxBytes: number;
  maxEncodedBytes?: number;
  projection: SessionTranscriptProjection;
}): Promise<{ bootstrap: SessionTranscriptBootstrap; state: SubscriberTranscriptState }> {
  const projection = input.projection;
  const cursorSecret = randomBytes(32);
  let rawBudget = input.maxBytes;
  for (;;) {
    const durableRequest = {
      direction: 'older',
      throughSequence: input.throughSequence,
      maxBytes: rawBudget,
      maxMessages: SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES,
    } as const;
    const durableStorage = await input.reader.readDurablePage(
      input.sessionId,
      durableRequest,
      projection === 'shared' ? sharedRowProjection(input.sessionId) : undefined,
    );
    if (durableStorage.throughSequence !== input.throughSequence) {
      throw new Error('Session transcript durable watermark changed during bootstrap');
    }
    const state: SubscriberTranscriptState = {
      sessionId: input.sessionId,
      subscriptionId: input.subscriptionId,
      durableThroughSequence: input.throughSequence,
      cursorSecret,
      projection,
    };
    const bootstrap: SessionTranscriptBootstrap = {
      durable: pageFromSelection(
        state,
        'older',
        storageSelection(durableStorage),
        input.throughSequence,
      ),
    };
    const encodedBytes = Buffer.byteLength(JSON.stringify(bootstrap), 'utf8');
    if (input.maxEncodedBytes === undefined || encodedBytes <= input.maxEncodedBytes) {
      return { state, bootstrap };
    }
    if (rawBudget <= 2) {
      throw new Error('Session transcript bootstrap cannot fit the subscription open result');
    }
    const excess = encodedBytes - input.maxEncodedBytes;
    rawBudget = Math.max(2, rawBudget - Math.max(1, Math.ceil((excess * 3) / 4)));
  }
}

export async function readSessionTranscriptPage(input: {
  reader: SessionTranscriptReader;
  state: SubscriberTranscriptState;
  request: SessionTranscriptPageInput;
}): Promise<SessionTranscriptPage> {
  const { state, request } = input;
  if (
    request.throughSequence !== null &&
    (state.durableThroughSequence === null ||
      request.throughSequence > state.durableThroughSequence)
  ) {
    throw new TranscriptPageRequestError('Transcript watermark is not known to this subscription');
  }
  const position = resolvePosition(state, request);
  if (position === null) return emptyPage(state, request);
  const durableRequest = {
    direction: request.direction,
    throughSequence: request.throughSequence,
    position: position.position,
    ...(position.byteOffset === null ? {} : { byteOffset: position.byteOffset }),
    maxBytes: request.maxBytes,
    maxMessages: SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES,
  } as const;
  const storage = await input.reader.readDurablePage(
    state.sessionId,
    durableRequest,
    state.projection === 'shared' ? sharedRowProjection(state.sessionId) : undefined,
  );
  return pageFromSelection(
    state,
    request.direction,
    storageSelection(storage),
    request.throughSequence,
  );
}

/**
 * How a guest's rows are rewritten. Handed to the reader rather than applied
 * after it: a page is cut where the rows it carries end, so a row that the
 * guest never sees must not take up room on their page either.
 */
function sharedRowProjection(sessionId: string): TranscriptRowProjection {
  return (message) => projectSharedSessionTranscriptMessage(message, sessionId);
}

export function updateSubscriberTranscriptHighWater(
  state: SubscriberTranscriptState,
  throughSequence: number | null,
): boolean {
  if (throughSequence === null || throughSequence === state.durableThroughSequence) return false;
  if (state.durableThroughSequence !== null && throughSequence < state.durableThroughSequence) {
    throw new Error('Session transcript durable watermark moved backwards');
  }
  state.durableThroughSequence = throughSequence;
  return true;
}

export class TranscriptPageRequestError extends Error {
  readonly name = 'TranscriptPageRequestError';
}

function resolvePosition(
  state: SubscriberTranscriptState,
  request: SessionTranscriptPageInput,
): { position: number; byteOffset: number | null } | null {
  if (request.cursor !== null) {
    const cursor = decodeCursor(request.cursor, state.cursorSecret);
    if (
      cursor.subscriptionId !== state.subscriptionId ||
      cursor.sessionId !== state.sessionId ||
      cursor.direction !== request.direction ||
      cursor.throughSequence !== request.throughSequence
    ) {
      throw new TranscriptPageRequestError('Transcript cursor does not match request');
    }
    return { position: cursor.position, byteOffset: cursor.byteOffset };
  }
  if (request.throughSequence === null) return null;
  const position =
    request.direction === 'older' ? request.throughSequence : (request.anchorSequence ?? -1) + 1;
  return position < 0 || position > request.throughSequence ? null : { position, byteOffset: null };
}

function storageSelection(
  storage: Awaited<ReturnType<SessionTranscriptReader['readDurablePage']>>,
): SelectedFragments {
  return {
    fragments: storage.fragments.map((fragment) => ({
      sequence: fragment.sequence,
      byteOffset: fragment.byteOffset,
      totalBytes: fragment.totalBytes,
      payloadDigest: fragment.payloadDigest,
      data: fragment.data.toString('base64'),
    })),
    rawBytes: storage.rawBytes,
    next: storage.next,
    endsAtTurnBoundary: storage.endsAtTurnBoundary,
  };
}

function pageFromSelection(
  state: SubscriberTranscriptState,
  direction: SessionTranscriptPageDirection,
  selected: SelectedFragments,
  throughSequence: number | null,
): SessionTranscriptPage {
  return {
    kind: 'page',
    sessionId: state.sessionId,
    direction,
    throughSequence,
    rawBytes: selected.rawBytes,
    fragments: selected.fragments,
    endsAtTurnBoundary: selected.endsAtTurnBoundary,
    nextCursor: selected.next
      ? encodeCursor(
          {
            version: 1,
            subscriptionId: state.subscriptionId,
            sessionId: state.sessionId,
            direction,
            throughSequence,
            ...selected.next,
          },
          state.cursorSecret,
        )
      : null,
  };
}

function emptyPage(
  state: SubscriberTranscriptState,
  request: SessionTranscriptPageInput,
): SessionTranscriptPage {
  return {
    kind: 'page',
    sessionId: state.sessionId,
    direction: request.direction,
    throughSequence: request.throughSequence,
    rawBytes: 0,
    fragments: [],
    nextCursor: null,
    endsAtTurnBoundary: true,
  };
}

function encodeCursor(cursor: TranscriptCursorState, secret: Buffer): string {
  const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  return `${payload}.${signCursor(payload, secret).toString('base64url')}`;
}

function decodeCursor(value: string, secret: Buffer): TranscriptCursorState {
  let decoded: unknown;
  try {
    const parts = value.split('.');
    if (parts.length !== 2) throw new Error('invalid cursor envelope');
    const [payload, signatureValue] = parts as [string, string];
    const bytes = Buffer.from(payload, 'base64url');
    const signature = Buffer.from(signatureValue, 'base64url');
    const expected = signCursor(payload, secret);
    if (
      bytes.toString('base64url') !== payload ||
      signature.toString('base64url') !== signatureValue ||
      signature.byteLength !== expected.byteLength ||
      !timingSafeEqual(signature, expected)
    ) {
      throw new Error('invalid cursor signature');
    }
    decoded = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (cause) {
    throw new TranscriptPageRequestError('Invalid transcript cursor', { cause });
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new TranscriptPageRequestError('Invalid transcript cursor');
  }
  const cursor = decoded as Record<string, unknown>;
  const keys = [
    'version',
    'subscriptionId',
    'sessionId',
    'direction',
    'throughSequence',
    'position',
    'byteOffset',
  ];
  if (
    Object.keys(cursor).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(cursor, key))
  ) {
    throw new TranscriptPageRequestError('Invalid transcript cursor fields');
  }
  if (
    cursor.version !== 1 ||
    typeof cursor.subscriptionId !== 'string' ||
    typeof cursor.sessionId !== 'string' ||
    (cursor.direction !== 'older' && cursor.direction !== 'newer') ||
    (cursor.throughSequence !== null && !isCount(cursor.throughSequence)) ||
    !isCount(cursor.position) ||
    (cursor.byteOffset !== null && !isCount(cursor.byteOffset))
  ) {
    throw new TranscriptPageRequestError('Invalid transcript cursor values');
  }
  return cursor as unknown as TranscriptCursorState;
}

function signCursor(payload: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(payload, 'utf8').digest();
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
