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
import type { StoredMessage } from '@maka/core/session';
import {
  SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES,
  SESSION_TRANSCRIPT_RANGE_MAX_BYTES,
  SESSION_TRANSCRIPT_RANGE_MAX_MESSAGES,
  type SessionTranscriptBootstrap,
  type SessionTranscriptFragment,
  type SessionTranscriptPage,
  type SessionTranscriptPageDirection,
  type SessionTranscriptPageInput,
} from '../protocol/index.js';
import {
  type SessionTranscriptReader,
  TRANSCRIPT_TURN_MAX_BYTES,
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
  readonly rangeBoundarySequence: number | null;
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
      maxMessages: SESSION_TRANSCRIPT_RANGE_MAX_MESSAGES,
    } as const;
    const durableStorage =
      projection === 'shared'
        ? await readSharedDurablePage(input.reader, input.sessionId, durableRequest)
        : await input.reader.readDurablePage(input.sessionId, durableRequest);
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
    const durableSelection = storageSelection(durableStorage);
    const rangeEdges = await readRangeEdges({
      reader: input.reader,
      state,
      direction: 'older',
      throughSequence: input.throughSequence,
      selected: durableSelection,
    });
    const bootstrap: SessionTranscriptBootstrap = {
      durable: pageFromSelection(
        state,
        'older',
        rangeEdges.selected,
        input.throughSequence,
        rangeEdges.rangeBoundarySequence,
        rangeEdges.protectedTurnSequence,
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
    maxMessages: continuationMessageLimit(position),
  } as const;
  const storage =
    state.projection === 'shared'
      ? await readSharedDurablePage(
          input.reader,
          state.sessionId,
          durableRequest,
          position.rangeBoundarySequence,
        )
      : await input.reader.readDurablePage(state.sessionId, durableRequest);
  const selected = selectionThroughRangeBoundary(
    storageSelection(storage),
    request.direction,
    position.rangeBoundarySequence,
  );
  const rangeEdges = await readRangeEdges({
    reader: input.reader,
    state,
    direction: request.direction,
    throughSequence: request.throughSequence,
    selected,
  });
  return pageFromSelection(
    state,
    request.direction,
    rangeEdges.selected,
    request.throughSequence,
    rangeEdges.rangeBoundarySequence,
    rangeEdges.protectedTurnSequence,
  );
}

async function readRangeEdges(input: {
  reader: SessionTranscriptReader;
  state: SubscriberTranscriptState;
  direction: SessionTranscriptPageDirection;
  throughSequence: number | null;
  selected: SelectedFragments;
}): Promise<{
  readonly selected: SelectedFragments;
  readonly rangeBoundarySequence: number | null;
  readonly protectedTurnSequence: number | null;
}> {
  if (input.throughSequence === null) {
    return {
      selected: input.selected,
      rangeBoundarySequence: null,
      protectedTurnSequence: null,
    };
  }
  const selectedSequences = input.selected.fragments.map((fragment) => fragment.sequence);
  if (selectedSequences.length === 0) {
    return {
      selected: input.selected,
      rangeBoundarySequence: null,
      protectedTurnSequence: null,
    };
  }
  const boundaryCandidate =
    input.direction === 'older' ? Math.min(...selectedSequences) : Math.max(...selectedSequences);
  const scanPosition =
    input.direction === 'older' ? Math.max(...selectedSequences) : Math.min(...selectedSequences);
  const rangeRecords: Array<{
    readonly sequence: number;
    readonly turnId: string | undefined;
    readonly bytes: number;
  }> = [];
  let targetTurnId: string | undefined;
  let targetStart: number | null = null;
  let candidateReached = false;
  let hiddenBytes = 0;
  let reachedFarEdge = false;
  let position: number | null = scanPosition;
  while (position !== null && !reachedFarEdge) {
    const scanned = await input.reader.readDurableRecords(input.state.sessionId, {
      direction: input.direction,
      throughSequence: input.throughSequence,
      position,
      maxStoredBytes: SESSION_TRANSCRIPT_RANGE_MAX_BYTES,
      maxMessages: SESSION_TRANSCRIPT_RANGE_MAX_MESSAGES,
    });
    for (const record of scanned.records) {
      const message =
        input.state.projection === 'shared'
          ? projectSharedSessionTranscriptMessage(record.message, input.state.sessionId)
          : record.message;
      if (!message) {
        hiddenBytes += Buffer.byteLength(JSON.stringify(record.message), 'utf8');
        if (hiddenBytes > SESSION_TRANSCRIPT_RANGE_MAX_BYTES) {
          throw new RangeError('Session transcript projection scan exceeds its capacity limit');
        }
        continue;
      }
      const turnId = messageTurnId(message);
      if (targetStart !== null && turnId !== targetTurnId) {
        reachedFarEdge = true;
        break;
      }
      rangeRecords.push({
        sequence: record.sequence,
        turnId,
        bytes: Buffer.byteLength(JSON.stringify(message), 'utf8'),
      });
      if (!candidateReached && record.sequence === boundaryCandidate) {
        candidateReached = true;
        if (turnId === undefined) {
          reachedFarEdge = true;
          break;
        }
        targetTurnId = turnId;
        targetStart = rangeRecords.length - 1;
        while (targetStart > 0 && rangeRecords[targetStart - 1]?.turnId === targetTurnId) {
          targetStart -= 1;
        }
      }
      if (targetStart !== null) {
        const targetRecords = rangeRecords.slice(targetStart);
        const targetBytes = targetRecords.reduce((sum, target) => sum + target.bytes, 0);
        if (
          targetRecords.length > SESSION_TRANSCRIPT_RANGE_MAX_MESSAGES ||
          targetBytes > SESSION_TRANSCRIPT_RANGE_MAX_BYTES
        ) {
          if (targetStart === 0) {
            return {
              selected: input.selected,
              rangeBoundarySequence: null,
              protectedTurnSequence: null,
            };
          }
          reachedFarEdge = true;
          break;
        }
      }
    }
    if (reachedFarEdge || scanned.nextPosition === null) {
      position = scanned.nextPosition;
      break;
    }
    if (scanned.nextPosition === position) {
      throw new Error('Session transcript projection scan did not advance');
    }
    position = scanned.nextPosition;
  }
  if (!candidateReached || rangeRecords.length === 0) {
    throw new Error('Session transcript range did not reach its authoritative Turn');
  }
  let retainedEnd = 0;
  let retainedMessages = 0;
  let retainedBytes = 0;
  while (retainedEnd < rangeRecords.length) {
    const groupStart = retainedEnd;
    const groupTurnId = rangeRecords[groupStart]!.turnId;
    let groupEnd = groupStart + 1;
    if (groupTurnId !== undefined) {
      while (groupEnd < rangeRecords.length && rangeRecords[groupEnd]?.turnId === groupTurnId) {
        groupEnd += 1;
      }
    }
    const group = rangeRecords.slice(groupStart, groupEnd);
    const groupBytes = group.reduce((sum, record) => sum + record.bytes, 0);
    if (
      group.length > SESSION_TRANSCRIPT_RANGE_MAX_MESSAGES ||
      groupBytes > SESSION_TRANSCRIPT_RANGE_MAX_BYTES
    ) {
      if (groupStart > 0) break;
      return {
        selected: input.selected,
        rangeBoundarySequence: null,
        protectedTurnSequence: null,
      };
    }
    if (
      retainedMessages + group.length > SESSION_TRANSCRIPT_RANGE_MAX_MESSAGES ||
      retainedBytes + groupBytes > SESSION_TRANSCRIPT_RANGE_MAX_BYTES
    ) {
      break;
    }
    retainedMessages += group.length;
    retainedBytes += groupBytes;
    retainedEnd = groupEnd;
  }
  const retainedRecords = rangeRecords.slice(0, retainedEnd);
  const boundary = retainedRecords.at(-1)?.sequence;
  if (boundary === undefined) {
    throw new RangeError('Session transcript Turn range exceeds its capacity limit');
  }
  const selected =
    retainedEnd === rangeRecords.length
      ? input.selected
      : (() => {
          const retainedSequences = new Set(retainedRecords.map((record) => record.sequence));
          const fragments = input.selected.fragments.filter((fragment) =>
            retainedSequences.has(fragment.sequence),
          );
          return {
            fragments,
            rawBytes: fragments.reduce(
              (sum, fragment) => sum + Buffer.byteLength(fragment.data, 'base64'),
              0,
            ),
            next: { position: rangeRecords[retainedEnd]!.sequence, byteOffset: null },
          };
        })();
  const turnRecords = retainedRecords.filter((record) => record.turnId !== undefined);
  const protectedTurnSequence =
    input.direction === 'older' ? turnRecords[0]?.sequence : turnRecords.at(-1)?.sequence;
  return {
    selected,
    rangeBoundarySequence: boundary,
    protectedTurnSequence: protectedTurnSequence ?? boundary,
  };
}

function messageTurnId(message: StoredMessage): string | undefined {
  const turnId = 'turnId' in message ? message.turnId : undefined;
  return typeof turnId === 'string' ? turnId : undefined;
}

async function readSharedDurablePage(
  reader: SessionTranscriptReader,
  sessionId: string,
  request: Parameters<SessionTranscriptReader['readDurablePage']>[1],
  rangeBoundarySequence: number | null = null,
): ReturnType<SessionTranscriptReader['readDurablePage']> {
  const position =
    request.position ??
    (request.direction === 'older' ? (request.throughSequence ?? undefined) : 0);
  const fragments: Awaited<
    ReturnType<SessionTranscriptReader['readDurablePage']>
  >['fragments'][number][] = [];
  let rawBytes = 0;
  let hiddenBytes = 0;
  let next: { position: number; byteOffset: number | null } | null = null;
  let scanPosition = position;
  let throughSequence = request.throughSequence ?? null;
  while (scanPosition !== undefined && next === null) {
    const scanned = await reader.readDurableRecords(sessionId, {
      direction: request.direction,
      ...(request.throughSequence === undefined
        ? {}
        : { throughSequence: request.throughSequence }),
      position: scanPosition,
      maxStoredBytes: TRANSCRIPT_TURN_MAX_BYTES,
      maxMessages: SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES,
    });
    throughSequence = scanned.throughSequence;
    let recordIndex = 0;
    for (; recordIndex < scanned.records.length; recordIndex += 1) {
      const record = scanned.records[recordIndex]!;
      const projected = projectSharedSessionTranscriptMessage(record.message, sessionId);
      if (!projected) {
        hiddenBytes += Buffer.byteLength(JSON.stringify(record.message), 'utf8');
        if (hiddenBytes > SESSION_TRANSCRIPT_RANGE_MAX_BYTES) {
          throw new RangeError('Session transcript projection scan exceeds its capacity limit');
        }
        continue;
      }
      const bytes = Buffer.from(JSON.stringify(projected), 'utf8');
      const continuationOffset =
        record.sequence === position && request.byteOffset !== undefined
          ? request.byteOffset
          : null;
      const selected = selectBuffer(
        bytes,
        request.direction,
        continuationOffset,
        request.maxBytes - rawBytes,
      );
      if (!selected) {
        next = { position: record.sequence, byteOffset: null };
        break;
      }
      fragments.push({
        sequence: record.sequence,
        byteOffset: selected.byteOffset,
        totalBytes: bytes.byteLength,
        payloadDigest: null,
        data: selected.data,
      });
      rawBytes += selected.data.byteLength;
      if (!selected.complete) {
        next = { position: record.sequence, byteOffset: selected.nextOffset };
        break;
      }
      if (record.sequence === rangeBoundarySequence) {
        const following = scanned.records[recordIndex + 1]?.sequence ?? scanned.nextPosition;
        next = following === null ? null : { position: following, byteOffset: null };
        break;
      }
      if (fragments.length === request.maxMessages || rawBytes === request.maxBytes) {
        const following = scanned.records[recordIndex + 1]?.sequence ?? scanned.nextPosition;
        next = following === null ? null : { position: following, byteOffset: null };
        break;
      }
    }
    if (next !== null) break;
    if (scanned.nextPosition === null) break;
    if (scanned.nextPosition === scanPosition) {
      throw new Error('Session transcript projection scan did not advance');
    }
    scanPosition = scanned.nextPosition;
  }
  return {
    throughSequence,
    fragments,
    rawBytes,
    next,
  };
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
): {
  position: number;
  byteOffset: number | null;
  rangeBoundarySequence: number | null;
} | null {
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
    return {
      position: cursor.position,
      byteOffset: cursor.byteOffset,
      rangeBoundarySequence: cursor.rangeBoundarySequence,
    };
  }
  if (request.throughSequence === null) return null;
  const position =
    request.direction === 'older'
      ? (request.anchorSequence ?? request.throughSequence + 1) - 1
      : (request.anchorSequence ?? -1) + 1;
  return position < 0 || position > request.throughSequence
    ? null
    : { position, byteOffset: null, rangeBoundarySequence: null };
}

function continuationMessageLimit(position: {
  position: number;
  rangeBoundarySequence: number | null;
}): number {
  return position.rangeBoundarySequence === null
    ? SESSION_TRANSCRIPT_RANGE_MAX_MESSAGES
    : Math.min(
        SESSION_TRANSCRIPT_RANGE_MAX_MESSAGES,
        Math.abs(position.position - position.rangeBoundarySequence) + 1,
      );
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
  };
}

function selectionThroughRangeBoundary(
  selected: SelectedFragments,
  direction: SessionTranscriptPageDirection,
  rangeBoundarySequence: number | null,
): SelectedFragments {
  if (rangeBoundarySequence === null) return selected;
  // RuntimeEvent-backed message sequences are sparse, so a continuation's
  // message limit cannot infer how many records remain from sequence distance.
  const firstOmittedIndex = selected.fragments.findIndex((fragment) =>
    direction === 'older'
      ? fragment.sequence < rangeBoundarySequence
      : fragment.sequence > rangeBoundarySequence,
  );
  if (firstOmittedIndex === -1) return selected;
  const firstOmitted = selected.fragments[firstOmittedIndex]!;
  const fragments = selected.fragments.slice(0, firstOmittedIndex);
  return {
    fragments,
    rawBytes: fragments.reduce(
      (sum, fragment) => sum + Buffer.from(fragment.data, 'base64').byteLength,
      0,
    ),
    next: { position: firstOmitted.sequence, byteOffset: null },
  };
}

function selectBuffer(
  bytes: Buffer,
  direction: SessionTranscriptPageDirection,
  byteOffset: number | null,
  budget: number,
): {
  byteOffset: number;
  data: Buffer;
  complete: boolean;
  nextOffset: number;
} | null {
  if (budget < 1) return null;
  if (direction === 'older') {
    const end = byteOffset ?? bytes.byteLength;
    if (end < 1 || end > bytes.byteLength)
      throw new TranscriptPageRequestError('Invalid cursor byte offset');
    const start = Math.max(0, end - budget);
    return {
      byteOffset: start,
      data: bytes.subarray(start, end),
      complete: start === 0,
      nextOffset: start,
    };
  }
  const start = byteOffset ?? 0;
  if (start < 0 || start >= bytes.byteLength) {
    throw new TranscriptPageRequestError('Invalid cursor byte offset');
  }
  const end = Math.min(bytes.byteLength, start + budget);
  return {
    byteOffset: start,
    data: bytes.subarray(start, end),
    complete: end === bytes.byteLength,
    nextOffset: end,
  };
}

function pageFromSelection(
  state: SubscriberTranscriptState,
  direction: SessionTranscriptPageDirection,
  selected: SelectedFragments,
  throughSequence: number | null,
  rangeBoundarySequence: number | null,
  protectedTurnSequence: number | null,
): SessionTranscriptPage {
  const cursorRangeBoundarySequence =
    selected.next !== null &&
    rangeBoundarySequence !== null &&
    (direction === 'older'
      ? selected.next.position < rangeBoundarySequence
      : selected.next.position > rangeBoundarySequence)
      ? null
      : rangeBoundarySequence;
  return {
    kind: 'page',
    sessionId: state.sessionId,
    direction,
    throughSequence,
    rawBytes: selected.rawBytes,
    fragments: selected.fragments,
    rangeBoundarySequence,
    protectedTurnSequence,
    nextCursor: selected.next
      ? encodeCursor(
          {
            version: 1,
            subscriptionId: state.subscriptionId,
            sessionId: state.sessionId,
            direction,
            throughSequence,
            rangeBoundarySequence: cursorRangeBoundarySequence,
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
    rangeBoundarySequence: null,
    protectedTurnSequence: null,
    nextCursor: null,
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
    'rangeBoundarySequence',
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
    (cursor.byteOffset !== null && !isCount(cursor.byteOffset)) ||
    (cursor.rangeBoundarySequence !== null && !isCount(cursor.rangeBoundarySequence))
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
