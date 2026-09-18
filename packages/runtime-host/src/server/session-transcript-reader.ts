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
import { DURABLE_TOOL_RESULT_PROJECTION_MAX_BYTES } from '@maka/core/durable-tool-result-projection';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import { WORKHUB_COORDINATION_SESSION_ID, type StoredMessage } from '@maka/core/session';
import {
  createRuntimeEventStoredMessageProjector,
  projectTranscriptToolResult,
  isHardRuntimeEventReadModelDiagnostic,
  projectRuntimeEventUserMessage,
} from '@maka/runtime/runtime-event-read-model';
import {
  type CanonicalPermissionOutcomeReader,
  type CanonicalPermissionOutcomeRecord,
} from '@maka/runtime/interaction-authority';
import type {
  ExecutionStoresWriter,
  SessionTranscriptPageRequest,
  SessionTranscriptRecordScanPage,
  SessionTranscriptRecordScanRequest,
  SessionTranscriptStorageFragment,
  SessionTranscriptStoragePage,
  SessionTurnContribution,
  SessionTurnContributionPage,
  RuntimeTranscriptRun,
} from '@maka/storage/execution-stores';
import { foldTurnContribution } from '@maka/storage/session-message-projection';
import type { SessionTurnLandmark } from '../protocol/index.js';

const PERMISSION_OUTCOME_READ_CONCURRENCY = 8;
/** One event can emit content, a permission, usage, and terminal/notice rows. */
const EVENT_SEQUENCE_STRIDE = 8;
const TRANSCRIPT_TURN_MAX_MESSAGES = 4_096;
export const TRANSCRIPT_TURN_MAX_BYTES = 16 * 1024 * 1024;
const TRANSCRIPT_SOURCE_MAX_EVENTS = TRANSCRIPT_TURN_MAX_MESSAGES * 2;
// One RuntimeEvent can carry both the raw Tool Result and its durable model projection.
const TRANSCRIPT_SOURCE_MAX_RECORD_BYTES =
  DURABLE_TOOL_RESULT_PROJECTION_MAX_BYTES * 2 + 256 * 1024;
// The scan releases each decoded record after projection. Its memory budget is
// separate from the bounded amount of immutable input it may visit.
const TRANSCRIPT_SOURCE_MAX_BYTES =
  TRANSCRIPT_SOURCE_MAX_EVENTS * TRANSCRIPT_SOURCE_MAX_RECORD_BYTES;
/** How much a page may scan past to fill itself when a projection hides rows. */
const PAGE_HIDDEN_SCAN_MAX_BYTES = 16 * 1024 * 1024;

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
  const ledger = createDurableLedgerTranscriptReader(input);
  const prepared = async (sessionId: string): Promise<typeof ledger> => {
    await input.ensureTranscriptLedger?.(sessionId);
    return ledger;
  };
  return {
    readDurableHighWater: async (sessionId) => (await prepared(sessionId)).readHighWater(sessionId),
    readDurablePage: async (sessionId, request, project) =>
      (await prepared(sessionId)).readPage(sessionId, request, project),
    readDurableRecords: async (sessionId, request) =>
      (await prepared(sessionId)).readRecords(sessionId, request),
    readDurableTurnContributions: async (sessionId, throughSequence, position, maxContributions) =>
      (await prepared(sessionId)).readTurnContributions(
        sessionId,
        throughSequence,
        position,
        maxContributions,
      ),
    readDurableTurnLandmarks: async (sessionId, request) =>
      (await prepared(sessionId)).readTurnLandmarks(sessionId, request),
  };
}

export interface SessionTurnLandmarkRequest {
  readonly maxLandmarks: number;
  readonly turnId: string | null;
}

export interface SessionTurnLandmarkSnapshot {
  readonly throughSequence: number | null;
  readonly landmarks: readonly SessionTurnLandmark[];
}

/**
 * Rewrites a row for the audience the page is being read for, or hides it. A
 * page is cut where the rows it carries end, so what a row becomes has to be
 * known while the page is being cut, not after.
 */
export type TranscriptRowProjection = (message: StoredMessage) => StoredMessage | null;

export interface SessionTranscriptReader {
  readDurableHighWater(sessionId: string): Promise<number | null>;
  readDurablePage(
    sessionId: string,
    request: SessionTranscriptPageRequest,
    project?: TranscriptRowProjection,
  ): Promise<SessionTranscriptStoragePage>;
  readDurableRecords(
    sessionId: string,
    request: SessionTranscriptRecordScanRequest,
  ): Promise<SessionTranscriptRecordScanPage>;
  readDurableTurnContributions(
    sessionId: string,
    throughSequence: number | null,
    position: number,
    maxContributions: number,
  ): Promise<SessionTurnContributionPage>;
  readDurableTurnLandmarks(
    sessionId: string,
    request: SessionTurnLandmarkRequest,
  ): Promise<SessionTurnLandmarkSnapshot>;
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
    turn: PendingTranscriptRun,
  ): Promise<{ sequence: number; message: StoredMessage }[]> => {
    const projected = await turn.projection.finish(input.canonicalPermissionOutcomes);
    if (projected.diagnostics.some(isHardRuntimeEventReadModelDiagnostic)) {
      throw new Error('Durable RuntimeEvent transcript projection is incomplete');
    }
    const admission =
      turn.invocation.sessionId === WORKHUB_COORDINATION_SESSION_ID
        ? await input.stores.agentRunStore.readRootTurnAdmission(
            turn.invocation.sessionId,
            turn.invocation.turnId,
          )
        : undefined;
    const actionId =
      admission?.execution.kind === 'workhub_coordination'
        ? admission.execution.actionId
        : undefined;
    const ordinals = turn.ordinals;
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
      return {
        sequence: ordinal * EVENT_SEQUENCE_STRIDE + offset,
        message:
          message.type === 'user' && actionId
            ? { ...message, coordinationActionId: actionId }
            : message,
      };
    });
  };

  const readRun = async (
    sessionId: string,
    request: { direction: 'older' | 'newer'; throughOrdinal: number; position: number },
  ): Promise<PendingTranscriptRun | undefined> =>
    store.readTranscriptRun(
      sessionId,
      {
        ...request,
        maxEvents: TRANSCRIPT_SOURCE_MAX_EVENTS,
        maxBytes: TRANSCRIPT_SOURCE_MAX_BYTES,
        maxRecordBytes: TRANSCRIPT_SOURCE_MAX_RECORD_BYTES,
      },
      (turn, events) => {
        const projection = createTranscriptProjection([turn.invocation]);
        const ordinals = new Map<string, number>();
        for (const { event, ordinal } of events) {
          ordinals.set(event.id, ordinal);
          projection.push(event);
        }
        return { ...turn, projection, ordinals };
      },
    );

  const scan = async function* (
    sessionId: string,
    request: {
      direction: 'older' | 'newer';
      throughSequence?: number | null;
      position?: number;
    },
  ): AsyncGenerator<TranscriptRecord> {
    const throughSequence =
      request.throughSequence === undefined ? await highWater(sessionId) : request.throughSequence;
    if (throughSequence === null) return;
    const position = request.position ?? (request.direction === 'older' ? throughSequence : 0);
    const throughOrdinal = ordinalOf(throughSequence);
    const older = request.direction === 'older';
    let ordinal = ordinalOf(position);
    while (ordinal >= 0 && ordinal <= throughOrdinal) {
      // A page resumes from one record's sequence and drops everything the other
      // side of it, so what this yields has to be monotone in sequence. Storage
      // answers with a stretch of ordinals one invocation owns outright, so the
      // rows yielded here are the only ones the Session has in that stretch —
      // whatever the Turn is interleaved with outside it.
      const run = await readRun(sessionId, {
        direction: request.direction,
        throughOrdinal,
        position: ordinal,
      });
      if (!run) return;
      const from = run.firstOrdinal * EVENT_SEQUENCE_STRIDE;
      const to = run.lastOrdinal * EVENT_SEQUENCE_STRIDE + EVENT_SEQUENCE_STRIDE - 1;
      const records = (await projectTurn(run))
        .filter(
          ({ sequence }) =>
            sequence >= from &&
            sequence <= to &&
            sequence <= throughSequence &&
            (older ? sequence <= position : sequence >= position),
        )
        .sort((a, b) => (older ? b.sequence - a.sequence : a.sequence - b.sequence));
      for (const [index, record] of records.entries()) {
        const between =
          index === 0 &&
          !(await store.readTranscriptTurnCrossing(
            sessionId,
            older ? run.lastOrdinal + 1 : run.firstOrdinal,
          ));
        yield { ...record, between };
      }
      ordinal = older ? run.firstOrdinal - 1 : run.lastOrdinal + 1;
    }
  };

  const source: TranscriptRecordSource = { readHighWater: highWater, scan };
  return {
    source,
    readHighWater: highWater,

    ...pagedTranscriptReads(source),

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
      const throughOrdinal = ordinalOf(watermark);
      // A Turn interleaved with another owns several stretches of the Session,
      // and this walk meets each one. Folding by Turn keeps that one summary.
      const contributions = new Map<string, SessionTurnContribution>();
      let nextPosition: number | null = null;
      for (let ordinal = ordinalOf(position); ordinal <= throughOrdinal; ) {
        const run = await readRun(sessionId, {
          direction: 'newer',
          throughOrdinal,
          position: ordinal,
        });
        if (!run) break;
        const turnId = run.invocation.turnId;
        if (!contributions.has(turnId) && contributions.size >= maxContributions) {
          nextPosition = run.firstOrdinal * EVENT_SEQUENCE_STRIDE;
          break;
        }
        // Folded from the Turn's own rows, so `firstSequence` lands on its first
        // row rather than on the opening fact, which has no row at all.
        for (const { sequence, message } of await projectTurn(run)) {
          if (sequence < position || sequence > watermark) continue;
          contributions.set(
            turnId,
            foldTurnContribution(contributions.get(turnId), turnId, sequence, message),
          );
        }
        ordinal = run.lastOrdinal + 1;
      }
      return {
        throughSequence: watermark,
        contributions: [...contributions.values()],
        nextPosition,
      };
    },

    async readTurnLandmarks(
      sessionId: string,
      request: SessionTurnLandmarkRequest,
    ): Promise<SessionTurnLandmarkSnapshot> {
      const throughSequence = await highWater(sessionId);
      if (throughSequence === null) return { throughSequence: null, landmarks: [] };
      const turns = await store.readTranscriptTurns(
        sessionId,
        request.turnId === null
          ? { throughOrdinal: ordinalOf(throughSequence), limit: request.maxLandmarks }
          : { turnId: request.turnId },
      );
      const landmarks: SessionTurnLandmark[] = [];
      for (const turn of turns) {
        const message = turn.prompt
          ? projectRuntimeEventUserMessage(turn.prompt.event, turn.prompt.event.id)
          : undefined;
        const label = (message?.displayText ?? message?.text ?? '').trim();
        // A sampled tick needs something to show; a looked-up Turn only needs a place.
        if (!label && request.turnId === null) continue;
        landmarks.push({
          turnId: turn.turnId,
          sequence: turn.firstOrdinal * EVENT_SEQUENCE_STRIDE,
          lastSequence: turn.lastOrdinal * EVENT_SEQUENCE_STRIDE + EVENT_SEQUENCE_STRIDE - 1,
          label,
        });
      }
      return { throughSequence, landmarks };
    },
  };
}

interface TranscriptRecord {
  readonly sequence: number;
  readonly message: StoredMessage;
  /** Whether a page may end just before this row without splitting a Turn. */
  readonly between: boolean;
}

/** An ordered, bounded walk over one Session's transcript records. */
interface TranscriptRecordSource {
  readHighWater(sessionId: string): Promise<number | null>;
  scan(
    sessionId: string,
    request: {
      direction: 'older' | 'newer';
      throughSequence?: number | null;
      position?: number;
    },
  ): AsyncGenerator<TranscriptRecord>;
}

/**
 * The reads that are the same whatever produces the records: a byte-bounded
 * page and a record scan. Each walks one source's
 * ordered records and never asks where they came from.
 */
function pagedTranscriptReads(source: TranscriptRecordSource) {
  return {
    async readPage(
      sessionId: string,
      request: SessionTranscriptPageRequest,
      project?: TranscriptRowProjection,
    ): Promise<SessionTranscriptStoragePage> {
      const throughSequence =
        request.throughSequence === undefined
          ? await source.readHighWater(sessionId)
          : request.throughSequence;
      if (throughSequence === null) {
        return {
          throughSequence: null,
          fragments: [],
          rawBytes: 0,
          next: null,
          endsAtTurnBoundary: true,
        };
      }
      const fragments: SessionTranscriptStorageFragment[] = [];
      let rawBytes = 0;
      let next: SessionTranscriptStoragePage['next'] = null;
      let truncated = false;
      let endsAtTurnBoundary = true;
      /** The last point the page was between Turns, so it can be cut back there. */
      let between: { index: number; bytes: number; sequence: number } | undefined;
      let hiddenBytes = 0;
      for await (const record of source.scan(sessionId, { ...request, throughSequence })) {
        if (fragments.length >= request.maxMessages || rawBytes >= request.maxBytes) {
          truncated = true;
          endsAtTurnBoundary = record.between;
          next = { position: record.sequence, byteOffset: null };
          break;
        }
        if (record.between) {
          between = { index: fragments.length, bytes: rawBytes, sequence: record.sequence };
        }
        const projected = project ? project(record.message) : record.message;
        if (projected === null) {
          hiddenBytes += Buffer.byteLength(JSON.stringify(record.message), 'utf8');
          if (hiddenBytes > PAGE_HIDDEN_SCAN_MAX_BYTES) {
            throw new RangeError('Session transcript projection scan exceeds its capacity limit');
          }
          continue;
        }
        const data = Buffer.from(JSON.stringify(projected), 'utf8');
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
          // The record itself is unfinished, so its Turn is too.
          endsAtTurnBoundary = false;
          next = {
            position: record.sequence,
            byteOffset: request.direction === 'older' ? byteOffset : end,
          };
          break;
        }
      }
      if (!endsAtTurnBoundary && between !== undefined && between.index > 0) {
        // Only a Turn that reaches the start of the page is served in slices.
        rawBytes = between.bytes;
        fragments.length = between.index;
        next = { position: between.sequence, byteOffset: null };
        endsAtTurnBoundary = true;
      }
      if (!truncated) next = null;
      return { throughSequence, fragments, rawBytes, next, endsAtTurnBoundary };
    },

    async readRecords(
      sessionId: string,
      request: SessionTranscriptRecordScanRequest,
    ): Promise<SessionTranscriptRecordScanPage> {
      const throughSequence =
        request.throughSequence === undefined
          ? await source.readHighWater(sessionId)
          : request.throughSequence;
      if (throughSequence === null) {
        return { throughSequence: null, records: [], nextPosition: null };
      }
      const records: Array<{ sequence: number; message: StoredMessage }> = [];
      let storedBytes = 0;
      let nextPosition: number | null = null;
      for await (const { sequence, message } of source.scan(sessionId, {
        ...request,
        throughSequence,
      })) {
        if (records.length >= request.maxMessages || storedBytes >= request.maxStoredBytes) {
          nextPosition = sequence;
          break;
        }
        const record = { sequence, message };
        records.push(record);
        storedBytes += Buffer.byteLength(JSON.stringify(record.message), 'utf8');
      }
      return { throughSequence, records, nextPosition };
    },
  };
}

function ordinalOf(sequence: number): number {
  return Math.floor(sequence / EVENT_SEQUENCE_STRIDE);
}

function assertTurnPresentationBounded(messages: readonly StoredMessage[]): void {
  if (messages.length > TRANSCRIPT_TURN_MAX_MESSAGES) {
    throw new Error('Session transcript Turn exceeds its message limit');
  }
  let encodedBytes = 0;
  for (const message of messages) {
    encodedBytes += Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (encodedBytes > TRANSCRIPT_TURN_MAX_BYTES) {
      throw new Error('Session transcript Turn exceeds its byte limit');
    }
  }
}

async function readCanonicalPermissionOutcomes(
  requestIds: readonly string[],
  reader: CanonicalPermissionOutcomeReader,
): Promise<ReadonlyMap<string, CanonicalPermissionOutcomeRecord>> {
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
      if (encodedBytes > TRANSCRIPT_TURN_MAX_BYTES) {
        throw new Error('Session permission outcomes exceed the transcript byte limit');
      }
      outcomes.set(item.requestId, item.outcome);
    }
  }
  return outcomes;
}

interface PendingTranscriptRun extends RuntimeTranscriptRun {
  projection: ReturnType<typeof createTranscriptProjection>;
  ordinals: Map<string, number>;
}

/** Keep only presentation state while the storage snapshot visits complete facts. */
function createTranscriptProjection(invocations: readonly RuntimeInvocationRecord[]) {
  const canonicalPermissionOutcomes = new Map<string, CanonicalPermissionOutcomeRecord>();
  let messageCount = 0;
  let messageBytes = 0;
  let eventCount = 0;
  let sourceBytes = 0;
  const projector = createRuntimeEventStoredMessageProjector({
    invocations,
    canonicalPermissionOutcomes,
    projectToolResult: projectTranscriptToolResult,
    onMessage: (message) => {
      messageCount += 1;
      messageBytes += Buffer.byteLength(JSON.stringify(message));
      if (messageCount > TRANSCRIPT_TURN_MAX_MESSAGES || messageBytes > TRANSCRIPT_TURN_MAX_BYTES)
        throw new Error('Session transcript projection exceeds its presentation limit');
    },
  });
  return {
    push(event: RuntimeEvent) {
      eventCount += 1;
      const content = event.content;
      // The durable model projection is never a transcript input. Large Bash
      // streams are consumed into a bounded terminal preview by the read model.
      const measured =
        content?.kind === 'function_response'
          ? { ...event, content: { ...content, modelProjection: undefined, result: undefined } }
          : event;
      sourceBytes += Buffer.byteLength(JSON.stringify(measured));
      if (eventCount > TRANSCRIPT_SOURCE_MAX_EVENTS)
        throw new Error('RuntimeEvent transcript exceeds its event limit');
      if (sourceBytes > TRANSCRIPT_TURN_MAX_BYTES)
        throw new Error('RuntimeEvent transcript exceeds its byte limit');
      projector.push(event);
    },
    async finish(reader: CanonicalPermissionOutcomeReader) {
      const outcomes = await readCanonicalPermissionOutcomes(
        projector.permissionRequestIds,
        reader,
      );
      for (const [id, outcome] of outcomes) canonicalPermissionOutcomes.set(id, outcome);
      const projected = projector.finish();
      assertTurnPresentationBounded(projected.messages);
      return projected;
    },
  };
}
