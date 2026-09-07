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

import type { RuntimeEvent } from '@maka/core/runtime-event';
import { readRunInvocation } from '@maka/core/runtime-event-store';
import type { StoredMessage } from '@maka/core/session';
import {
  activePresentationRuntimeEvents,
  affectsRuntimeEventStoredMessageProjection,
  isHardRuntimeEventReadModelDiagnostic,
  projectRuntimeEventsToStoredMessages,
  projectRuntimeEventUserMessage,
} from '@maka/runtime/runtime-event-read-model';
import {
  type CanonicalPermissionOutcomeReader,
  type CanonicalPermissionOutcomeRecord,
} from '@maka/runtime/interaction-authority';
import type {
  ExecutionStoresWriter,
  SessionTranscriptMessageLookupRequest,
  SessionTranscriptPageRequest,
  SessionTranscriptRecordScanPage,
  SessionTranscriptRecordScanRequest,
  SessionTranscriptStorageFragment,
  SessionTranscriptStoragePage,
  SessionTurnContribution,
  SessionTurnContributionPage,
  SessionTurnLandmark,
  SessionTurnLandmarkSnapshot,
  RuntimeTranscriptInvocation,
} from '@maka/storage/execution-stores';
import { foldTurnContribution } from '@maka/storage/session-message-projection';
import { SESSION_TRANSCRIPT_OVERLAY_MAX_MESSAGES, type TurnSnapshot } from '../protocol/index.js';

const PERMISSION_OUTCOME_READ_CONCURRENCY = 8;
/** One event can emit content, a permission, usage, and terminal/notice rows. */
const EVENT_SEQUENCE_STRIDE = 8;
export const ACTIVE_TRANSCRIPT_OVERLAY_MAX_MESSAGES = SESSION_TRANSCRIPT_OVERLAY_MAX_MESSAGES;
export const ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES = 16 * 1024 * 1024;
const ACTIVE_TRANSCRIPT_SOURCE_MAX_EVENTS = ACTIVE_TRANSCRIPT_OVERLAY_MAX_MESSAGES * 2;
const ACTIVE_TRANSCRIPT_SCAN_BATCH_MAX_BYTES = 256 * 1024;
/**
 * What one durable page may read of a Turn, matching the bound the live
 * overlay already holds for a run. A Turn past it is refused rather than
 * half-projected: a prefix of a Turn is not a smaller transcript of it.
 */
const DURABLE_TRANSCRIPT_TURN_MAX_EVENTS = ACTIVE_TRANSCRIPT_SOURCE_MAX_EVENTS;
const DURABLE_TRANSCRIPT_TURN_MAX_BYTES = ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES;
/** Turns per storage round trip: one, so a page loads no Turn it cannot use. */
const TRANSCRIPT_TURN_SCAN_LIMIT = 1;
/**
 * How far back the live-to-durable handoff looks for a message id. The ids come
 * from assistant streams the subscriber is still watching, so they are in the
 * newest Turn or the one it continued from; an id that is in neither is treated
 * as absent rather than searched for down the Session.
 */
const TRANSCRIPT_LOOKUP_MAX_TURNS = 2;

export function createSessionTranscriptReader(input: {
  stores: ExecutionStoresWriter<'interactive'>;
  canonicalPermissionOutcomes: CanonicalPermissionOutcomeReader;
  /**
   * Converts a Session whose transcript predates the ledger, before this reader
   * looks for invocations that only the conversion can create. Omitted only by
   * tests that seed the ledger themselves.
   */
  ensureTranscriptLedger?: (sessionId: string) => Promise<void>;
}): SessionTranscriptReader {
  const durable = createDurableLedgerTranscriptReader(input);
  const prepared = async (sessionId: string): Promise<void> => {
    await input.ensureTranscriptLedger?.(sessionId);
  };
  return {
    readDurableHighWater: async (sessionId) => {
      await prepared(sessionId);
      return durable.readHighWater(sessionId);
    },
    readDurablePage: async (sessionId, request) => {
      await prepared(sessionId);
      return durable.readPage(sessionId, request);
    },
    readDurableRecords: async (sessionId, request) => {
      await prepared(sessionId);
      return durable.readRecords(sessionId, request);
    },
    readDurableMessagesById: async (sessionId, request) => {
      await prepared(sessionId);
      return durable.readMessagesById(sessionId, request);
    },
    readDurableTurnContributions: async (
      sessionId,
      throughSequence,
      position,
      maxContributions,
    ) => {
      await prepared(sessionId);
      return durable.readTurnContributions(sessionId, throughSequence, position, maxContributions);
    },
    readDurableTurnLandmarks: async (sessionId, maxLandmarks) => {
      await prepared(sessionId);
      return durable.readTurnLandmarks(sessionId, maxLandmarks);
    },
    readActiveOverlay: async (sessionId, rootTurn) => {
      if (!rootTurn || isTerminalTurn(rootTurn)) return [];

      const invocation = await readRunInvocation(
        input.stores.runtimeEventStore,
        sessionId,
        rootTurn.runId,
      );
      const events = await readActiveProjectionEvents(input.stores, sessionId, rootTurn.runId);
      const canonicalPermissionOutcomes = await readCanonicalPermissionOutcomes(
        events,
        input.canonicalPermissionOutcomes,
      );
      const projected = projectRuntimeEventsToStoredMessages(
        activePresentationRuntimeEvents(events),
        {
          invocations: invocation ? [invocation] : [],
          canonicalPermissionOutcomes,
        },
      );
      if (projected.diagnostics.some(isHardRuntimeEventReadModelDiagnostic)) {
        throw new Error('Active RuntimeEvent transcript projection is incomplete');
      }
      assertActiveOverlayBounded(projected.messages);
      return projected.messages;
    },
  };
}

export interface SessionTranscriptReader {
  readDurableHighWater(sessionId: string): Promise<number | null>;
  readDurablePage(
    sessionId: string,
    request: SessionTranscriptPageRequest,
  ): Promise<SessionTranscriptStoragePage>;
  readDurableRecords(
    sessionId: string,
    request: SessionTranscriptRecordScanRequest,
  ): Promise<SessionTranscriptRecordScanPage>;
  readDurableMessagesById(
    sessionId: string,
    request: SessionTranscriptMessageLookupRequest,
  ): Promise<readonly StoredMessage[]>;
  readDurableTurnContributions(
    sessionId: string,
    throughSequence: number | null,
    position: number,
    maxContributions: number,
  ): Promise<SessionTurnContributionPage>;
  readDurableTurnLandmarks(
    sessionId: string,
    maxLandmarks: number,
  ): Promise<SessionTurnLandmarkSnapshot>;
  readActiveOverlay(
    sessionId: string,
    rootTurn: TurnSnapshot | null,
  ): Promise<readonly StoredMessage[]>;
}

/**
 * Pages seek immutable Session event ordinals before decoding payloads. One
 * Turn is projected at a time, so a page costs one Turn rather than the
 * Session. The low sequence bits distinguish the few rows one event emits.
 *
 * What an event becomes is asked only of the read model. Storage selects Turns
 * by ordinal and hands over their events; it never classifies one.
 */
function createDurableLedgerTranscriptReader(input: {
  stores: ExecutionStoresWriter<'interactive'>;
  canonicalPermissionOutcomes: CanonicalPermissionOutcomeReader;
}) {
  const store = input.stores.runtimeEventStore;
  const highWater = async (sessionId: string): Promise<number | null> => {
    const ordinal = await store.readTranscriptHighWater(sessionId);
    return ordinal === null ? null : ordinal * EVENT_SEQUENCE_STRIDE + EVENT_SEQUENCE_STRIDE - 1;
  };

  /** One Turn's rows, each at the sequence its own event sits at. */
  const projectTurn = async (
    turn: RuntimeTranscriptInvocation,
  ): Promise<{ sequence: number; message: StoredMessage }[]> => {
    const events = turn.events.map((entry) => entry.event);
    const projected = projectRuntimeEventsToStoredMessages(events, {
      invocations: [turn.invocation],
      canonicalPermissionOutcomes: await readCanonicalPermissionOutcomes(
        events,
        input.canonicalPermissionOutcomes,
      ),
    });
    if (projected.diagnostics.some(isHardRuntimeEventReadModelDiagnostic)) {
      throw new Error('Durable RuntimeEvent transcript projection is incomplete');
    }
    const ordinals = new Map(turn.events.map((entry) => [entry.event.id, entry.ordinal]));
    const emitted = new Map<number, number>();
    return projected.messages.map((message, index) => {
      const ordinal = ordinals.get(projected.sourceEventIds[index]!);
      if (ordinal === undefined) {
        throw new Error('Durable transcript message has no source RuntimeEvent');
      }
      const offset = emitted.get(ordinal) ?? 0;
      if (offset >= EVENT_SEQUENCE_STRIDE) {
        throw new Error('RuntimeEvent exceeds its transcript sequence stride');
      }
      emitted.set(ordinal, offset + 1);
      return { sequence: ordinal * EVENT_SEQUENCE_STRIDE + offset, message };
    });
  };

  const readTurns = async (
    sessionId: string,
    request: { direction: 'older' | 'newer'; throughOrdinal: number; position: number },
  ): Promise<RuntimeTranscriptInvocation[]> =>
    store.readTranscriptInvocations(sessionId, {
      ...request,
      limit: TRANSCRIPT_TURN_SCAN_LIMIT,
      maxEvents: DURABLE_TRANSCRIPT_TURN_MAX_EVENTS,
      maxBytes: DURABLE_TRANSCRIPT_TURN_MAX_BYTES,
    });

  const scan = async function* (
    sessionId: string,
    request: {
      direction: 'older' | 'newer';
      throughSequence?: number | null;
      position?: number;
      /** Stops the walk after this many Turns, for a read that may find nothing. */
      maxTurns?: number;
    },
  ): AsyncGenerator<{ sequence: number; message: StoredMessage }> {
    const throughSequence =
      request.throughSequence === undefined ? await highWater(sessionId) : request.throughSequence;
    if (throughSequence === null) return;
    const position = request.position ?? (request.direction === 'older' ? throughSequence : 0);
    const throughOrdinal = ordinalOf(throughSequence);
    let ordinal = ordinalOf(position);
    let walked = 0;
    while (ordinal >= 0 && ordinal <= throughOrdinal) {
      const turns = await readTurns(sessionId, {
        direction: request.direction,
        throughOrdinal,
        position: ordinal,
      });
      if (turns.length === 0) return;
      for (const turn of turns) {
        if (request.maxTurns !== undefined && walked >= request.maxTurns) return;
        walked += 1;
        const records = (await projectTurn(turn)).filter(
          ({ sequence }) =>
            sequence <= throughSequence &&
            (request.direction === 'older' ? sequence <= position : sequence >= position),
        );
        if (request.direction === 'older') records.reverse();
        yield* records;
      }
      const edge = turns.at(-1)!;
      ordinal = request.direction === 'older' ? edge.firstOrdinal - 1 : edge.lastOrdinal + 1;
    }
  };

  return {
    readHighWater: highWater,

    async readPage(
      sessionId: string,
      request: SessionTranscriptPageRequest,
    ): Promise<SessionTranscriptStoragePage> {
      const throughSequence =
        request.throughSequence === undefined
          ? await this.readHighWater(sessionId)
          : request.throughSequence;
      if (throughSequence === null) {
        return { throughSequence: null, fragments: [], rawBytes: 0, next: null };
      }
      const fragments: SessionTranscriptStorageFragment[] = [];
      let rawBytes = 0;
      let next: SessionTranscriptStoragePage['next'] = null;
      let truncated = false;
      for await (const record of scan(sessionId, { ...request, throughSequence })) {
        if (fragments.length >= request.maxMessages || rawBytes >= request.maxBytes) {
          truncated = true;
          next = { position: record.sequence, byteOffset: null };
          break;
        }
        const data = Buffer.from(JSON.stringify(record.message), 'utf8');
        // A message larger than the remaining budget is served in byte slices,
        // from the edge the traversal is moving away from, so the next page
        // resumes inside the same record instead of skipping it.
        const continued = record.sequence === request.position && request.byteOffset !== undefined;
        const edge = continued
          ? request.byteOffset!
          : request.direction === 'older'
            ? data.byteLength
            : 0;
        const available = request.maxBytes - rawBytes;
        const byteOffset = request.direction === 'older' ? Math.max(0, edge - available) : edge;
        const end =
          request.direction === 'older' ? edge : Math.min(data.byteLength, edge + available);
        fragments.push({
          sequence: record.sequence,
          byteOffset,
          totalBytes: data.byteLength,
          payloadDigest: null,
          data: data.subarray(byteOffset, end),
        });
        rawBytes += end - byteOffset;
        const complete = request.direction === 'older' ? byteOffset === 0 : end === data.byteLength;
        if (!complete) {
          truncated = true;
          next = {
            position: record.sequence,
            byteOffset: request.direction === 'older' ? byteOffset : end,
          };
          break;
        }
      }
      if (!truncated) next = null;
      return { throughSequence, fragments, rawBytes, next };
    },

    async readRecords(
      sessionId: string,
      request: SessionTranscriptRecordScanRequest,
    ): Promise<SessionTranscriptRecordScanPage> {
      const throughSequence =
        request.throughSequence === undefined
          ? await this.readHighWater(sessionId)
          : request.throughSequence;
      if (throughSequence === null) {
        return { throughSequence: null, records: [], nextPosition: null };
      }
      const records: Array<{ sequence: number; message: StoredMessage }> = [];
      let storedBytes = 0;
      let nextPosition: number | null = null;
      for await (const record of scan(sessionId, { ...request, throughSequence })) {
        if (records.length >= request.maxMessages || storedBytes >= request.maxStoredBytes) {
          nextPosition = record.sequence;
          break;
        }
        records.push(record);
        storedBytes += Buffer.byteLength(JSON.stringify(record.message), 'utf8');
      }
      return { throughSequence, records, nextPosition };
    },

    /** One row per Turn, folded from the Turn's own projected messages. */
    async readTurnContributions(
      sessionId: string,
      throughSequence: number | null,
      position: number,
      maxContributions: number,
    ): Promise<SessionTurnContributionPage> {
      const watermark = throughSequence ?? (await highWater(sessionId));
      if (watermark === null) {
        return { throughSequence: null, contributions: [], nextPosition: null };
      }
      const turns = await store.readTranscriptInvocations(sessionId, {
        direction: 'newer',
        throughOrdinal: ordinalOf(watermark),
        position: ordinalOf(position),
        limit: maxContributions + 1,
        maxEvents: DURABLE_TRANSCRIPT_TURN_MAX_EVENTS,
        maxBytes: DURABLE_TRANSCRIPT_TURN_MAX_BYTES,
      });
      const contributions: SessionTurnContribution[] = [];
      for (const turn of turns.slice(0, maxContributions)) {
        // Folded from the Turn's own rows, so `firstSequence` lands on its first
        // row rather than on the opening fact, which has no row at all.
        let contribution: SessionTurnContribution | undefined;
        for (const { sequence, message } of await projectTurn(turn)) {
          if (sequence < position || sequence > watermark) continue;
          contribution = foldTurnContribution(
            contribution,
            turn.invocation.turnId,
            sequence,
            message,
          );
        }
        if (contribution) contributions.push(contribution);
      }
      const next = turns[maxContributions];
      return {
        throughSequence: watermark,
        contributions,
        nextPosition: next ? next.firstOrdinal * EVENT_SEQUENCE_STRIDE : null,
      };
    },

    /** Evenly spaced Turn starts, selected in SQL before loading their prompts. */
    async readTurnLandmarks(
      sessionId: string,
      maxLandmarks: number,
    ): Promise<SessionTurnLandmarkSnapshot> {
      const throughSequence = await highWater(sessionId);
      if (throughSequence === null) return { throughSequence: null, landmarks: [] };
      const turns = await store.readTranscriptLandmarks(
        sessionId,
        ordinalOf(throughSequence),
        maxLandmarks,
      );
      const landmarks: SessionTurnLandmark[] = [];
      for (const turn of turns) {
        if (!turn.prompt) continue;
        const message = projectRuntimeEventUserMessage(turn.prompt.event, turn.prompt.event.id);
        const label = (message?.displayText ?? message?.text ?? '').trim();
        if (!label) continue;
        landmarks.push({
          turnId: turn.invocation.turnId,
          sequence: turn.prompt.ordinal * EVENT_SEQUENCE_STRIDE,
          label,
        });
      }
      return { throughSequence, landmarks };
    },

    /**
     * The durable rows behind a set of message ids.
     *
     * The ids come from the assistant streams a subscriber is still watching,
     * so they belong to the Session's newest Turns. The scan walks back from
     * the watermark a Turn at a time and stops as soon as every id is found,
     * rather than keeping an index from message id to event. An id that is not
     * there stops the walk after the newest Turns instead of reading the
     * Session: the handoff shows what the tail holds, not everything it could.
     */
    async readMessagesById(
      sessionId: string,
      request: SessionTranscriptMessageLookupRequest,
    ): Promise<StoredMessage[]> {
      if (request.throughSequence === null || request.messageIds.length === 0) return [];
      const wanted = new Set(request.messageIds);
      const found: Array<{ sequence: number; message: StoredMessage }> = [];
      let bytes = 0;
      for await (const record of scan(sessionId, {
        direction: 'older',
        throughSequence: request.throughSequence,
        maxTurns: TRANSCRIPT_LOOKUP_MAX_TURNS,
      })) {
        if (!wanted.delete(record.message.id)) continue;
        bytes += Buffer.byteLength(JSON.stringify(record.message), 'utf8');
        if (found.length >= request.maxMessages || bytes > request.maxBytes) break;
        found.push(record);
        if (wanted.size === 0) break;
      }
      return found.sort((a, b) => a.sequence - b.sequence).map((record) => record.message);
    },
  };
}

function ordinalOf(sequence: number): number {
  return Math.floor(sequence / EVENT_SEQUENCE_STRIDE);
}

function assertActiveOverlayBounded(messages: readonly StoredMessage[]): void {
  if (messages.length > ACTIVE_TRANSCRIPT_OVERLAY_MAX_MESSAGES) {
    throw new Error('Active Session transcript overlay exceeds its message limit');
  }
  let encodedBytes = 0;
  for (const message of messages) {
    encodedBytes += Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (encodedBytes > ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES) {
      throw new Error('Active Session transcript overlay exceeds its byte limit');
    }
  }
}

async function readCanonicalPermissionOutcomes(
  events: readonly RuntimeEvent[],
  reader: CanonicalPermissionOutcomeReader,
): Promise<ReadonlyMap<string, CanonicalPermissionOutcomeRecord>> {
  const requestIds = new Set(
    events.flatMap((event) => {
      const requestId = event.actions?.permissionAnswerAccepted?.requestId;
      return requestId ? [requestId] : [];
    }),
  );
  const outcomes = new Map<string, CanonicalPermissionOutcomeRecord>();
  const ids = [...requestIds];
  let encodedBytes = 0;
  for (let index = 0; index < ids.length; index += PERMISSION_OUTCOME_READ_CONCURRENCY) {
    const batch = await Promise.all(
      ids.slice(index, index + PERMISSION_OUTCOME_READ_CONCURRENCY).map(async (requestId) => ({
        requestId,
        outcome: await reader.readPermissionOutcome(requestId),
      })),
    );
    for (const item of batch) {
      if (!item.outcome) continue;
      encodedBytes += Buffer.byteLength(JSON.stringify(item.outcome), 'utf8');
      if (encodedBytes > ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES) {
        throw new Error('Active Session permission outcomes exceed the transcript byte limit');
      }
      outcomes.set(item.requestId, item.outcome);
    }
  }
  return outcomes;
}

async function readActiveProjectionEvents(
  stores: ExecutionStoresWriter<'interactive'>,
  sessionId: string,
  runId: string,
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  let retainedEvents = 0;
  let retainedBytes = 0;
  const result = await stores.runtimeEventStore.scanRuntimeEvents(
    sessionId,
    runId,
    {
      maxBatchBytes: ACTIVE_TRANSCRIPT_SCAN_BATCH_MAX_BYTES,
      maxRecordBytes: ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES,
      maxImmutableRecords: ACTIVE_TRANSCRIPT_SOURCE_MAX_EVENTS,
      maxImmutableBytes: ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES,
      maxPartialRecords: ACTIVE_TRANSCRIPT_SOURCE_MAX_EVENTS,
      maxPartialBytes: ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES,
    },
    (batch) => {
      const relevant = batch.filter(affectsRuntimeEventStoredMessageProjection);
      for (const event of relevant) {
        retainedEvents += 1;
        retainedBytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
        if (retainedEvents > ACTIVE_TRANSCRIPT_SOURCE_MAX_EVENTS) {
          throw new Error('Active RuntimeEvent transcript exceeds its event limit');
        }
        if (retainedBytes > ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES) {
          throw new Error('Active RuntimeEvent transcript exceeds its byte limit');
        }
      }
      events.push(...relevant);
    },
  );
  if (result.status === 'limit_exceeded') {
    throw new Error('Active RuntimeEvent transcript exceeds its storage scan limit');
  }
  return events;
}

function isTerminalTurn(turn: TurnSnapshot): boolean {
  return turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled';
}
