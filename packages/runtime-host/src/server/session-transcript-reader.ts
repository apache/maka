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
import { readRunInvocation } from '@maka/core/runtime-event-store';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import { runtimeHandoffPause } from '@maka/core/runtime-handoff';
import { readLogicalRuntimeExecution } from '@maka/core/runtime-logical-execution';
import { WORKHUB_COORDINATION_SESSION_ID, type StoredMessage } from '@maka/core/session';
import {
  createRuntimeEventStoredMessageProjector,
  projectTranscriptToolResult,
  isHardRuntimeEventReadModelDiagnostic,
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
  RuntimeTranscriptInvocationHeader,
} from '@maka/storage/execution-stores';
import { foldTurnContribution } from '@maka/storage/session-message-projection';
import { SESSION_TRANSCRIPT_OVERLAY_MAX_MESSAGES, type TurnSnapshot } from '../protocol/index.js';

const PERMISSION_OUTCOME_READ_CONCURRENCY = 8;
/** One event can emit content, a permission, usage, and terminal/notice rows. */
const EVENT_SEQUENCE_STRIDE = 8;
export const ACTIVE_TRANSCRIPT_OVERLAY_MAX_MESSAGES = SESSION_TRANSCRIPT_OVERLAY_MAX_MESSAGES;
export const ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES = 16 * 1024 * 1024;
const TRANSCRIPT_SOURCE_MAX_EVENTS = ACTIVE_TRANSCRIPT_OVERLAY_MAX_MESSAGES * 2;
// One RuntimeEvent can carry both the raw Tool Result and its durable model projection.
const TRANSCRIPT_SOURCE_MAX_RECORD_BYTES =
  DURABLE_TOOL_RESULT_PROJECTION_MAX_BYTES * 2 + 256 * 1024;
// The scan releases each decoded record after projection. Its memory budget is
// separate from the bounded amount of immutable input it may visit.
const TRANSCRIPT_SOURCE_MAX_BYTES =
  TRANSCRIPT_SOURCE_MAX_EVENTS * TRANSCRIPT_SOURCE_MAX_RECORD_BYTES;
const ACTIVE_TRANSCRIPT_SCAN_BATCH_MAX_BYTES = 256 * 1024;
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
  const ledger = createDurableLedgerTranscriptReader(input);
  const prepared = async (sessionId: string): Promise<typeof ledger> => {
    await input.ensureTranscriptLedger?.(sessionId);
    return ledger;
  };
  return {
    readDurableHighWater: async (sessionId) => (await prepared(sessionId)).readHighWater(sessionId),
    readDurablePage: async (sessionId, request) =>
      (await prepared(sessionId)).readPage(sessionId, request),
    readDurableRecords: async (sessionId, request) =>
      (await prepared(sessionId)).readRecords(sessionId, request),
    readDurableMessagesById: async (sessionId, request) =>
      (await prepared(sessionId)).readMessagesById(sessionId, request),
    readDurableTurnContributions: async (sessionId, throughSequence, position, maxContributions) =>
      (await prepared(sessionId)).readTurnContributions(
        sessionId,
        throughSequence,
        position,
        maxContributions,
      ),
    readActiveOverlay: async (sessionId, rootTurn) => {
      if (!rootTurn || isTerminalTurn(rootTurn)) return [];

      const store = input.stores.runtimeEventStore;
      const root = await readRunInvocation(store, sessionId, rootTurn.runId);
      if (!root) return [];
      const invocations = new Map<string, RuntimeInvocationRecord>([[root.runId, root]]);
      let runIds: readonly string[] = [root.runId];
      if (root.terminalEvent && runtimeHandoffPause(root.terminalEvent)) {
        const logical = await readLogicalRuntimeExecution(
          {
            ...store,
            readRunInvocation: async (id, runId) => {
              const run = await readRunInvocation(store, id, runId);
              if (run) invocations.set(runId, run);
              return run;
            },
            readImmutableRuntimePrefixProof: (prefix) =>
              store.readImmutableRuntimePrefixProof(prefix, {
                maxEvents: TRANSCRIPT_SOURCE_MAX_EVENTS,
                maxBytes: TRANSCRIPT_SOURCE_MAX_BYTES,
                maxRecordBytes: TRANSCRIPT_SOURCE_MAX_RECORD_BYTES,
              }),
          },
          { sessionId, turnId: rootTurn.turnId, runId: rootTurn.runId },
          root,
          { mode: 'membership' },
        );
        if (!logical) return [];
        runIds = logical.runIds;
      }
      const pending = createTranscriptProjection(
        runIds.map((runId) => invocations.get(runId)!),
        true,
      );
      for (const runId of runIds)
        await scanActiveRuntimeEvents(input.stores, sessionId, runId, pending.push);
      const projected = await pending.finish(input.canonicalPermissionOutcomes);
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
    turn: PendingTranscriptTurn,
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

  const readTurns = async (
    sessionId: string,
    request: { direction: 'older' | 'newer'; throughOrdinal: number; position: number },
    limit = TRANSCRIPT_TURN_SCAN_LIMIT,
  ): Promise<PendingTranscriptTurn[]> =>
    store.readTranscriptInvocations(
      sessionId,
      {
        ...request,
        limit,
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
      /** Stops the walk after this many Turns, for a read that may find nothing. */
      maxTurns?: number;
    },
  ): AsyncGenerator<TranscriptRecord> {
    const throughSequence =
      request.throughSequence === undefined ? await highWater(sessionId) : request.throughSequence;
    if (throughSequence === null) return;
    const position = request.position ?? (request.direction === 'older' ? throughSequence : 0);
    const throughOrdinal = ordinalOf(throughSequence);
    const older = request.direction === 'older';
    const readTurnAt = async (at: number): Promise<PendingTranscriptTurn | undefined> =>
      at < 0 || at > throughOrdinal
        ? undefined
        : (
            await readTurns(sessionId, {
              direction: request.direction,
              throughOrdinal,
              position: at,
            })
          )[0];
    let ordinal = ordinalOf(position);
    let walked = 0;
    let cluster = 0;
    let carried: PendingTranscriptTurn | undefined;
    while (ordinal >= 0 && ordinal <= throughOrdinal) {
      const first = carried ?? (await readTurnAt(ordinal));
      carried = undefined;
      if (first === undefined) return;
      if (request.maxTurns !== undefined && walked >= request.maxTurns) return;
      // A page resumes from one record's sequence and drops everything the other
      // side of it, so what this yields has to be monotone in sequence. Turns
      // whose ordinal ranges overlap — a nested run inside its parent — are
      // therefore drained together instead of one after the other. Each such
      // group is numbered: nothing of it can arrive once the number changes,
      // which is what lets a reader cut without splitting a Turn.
      const overlapping = [first];
      let low = first.firstOrdinal;
      let high = first.lastOrdinal;
      for (;;) {
        const next = await readTurnAt(older ? low - 1 : high + 1);
        if (next === undefined) break;
        if (older ? next.lastOrdinal < low : next.firstOrdinal > high) {
          carried = next;
          break;
        }
        overlapping.push(next);
        low = Math.min(low, next.firstOrdinal);
        high = Math.max(high, next.lastOrdinal);
      }
      walked += overlapping.length;
      cluster += 1;
      const records = (await Promise.all(overlapping.map(projectTurn)))
        .flat()
        .filter(
          ({ sequence }) =>
            sequence <= throughSequence && (older ? sequence <= position : sequence >= position),
        )
        .sort((a, b) => (older ? b.sequence - a.sequence : a.sequence - b.sequence));
      for (const record of records) yield { ...record, cluster };
      ordinal = older ? low - 1 : high + 1;
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
      const turns = await readTurns(
        sessionId,
        {
          direction: 'newer',
          throughOrdinal: ordinalOf(watermark),
          position: ordinalOf(position),
        },
        maxContributions + 1,
      );
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
  };
}

interface TranscriptRecord {
  readonly sequence: number;
  readonly message: StoredMessage;
  /**
   * Which group of mutually overlapping Turns this record came from. Records of
   * one group arrive together, so a cut between two groups cannot land inside a
   * Turn — including a Turn whose rows a nested one is written between.
   */
  readonly cluster: number;
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
      /** Stops the walk after this many Turns, for a read that may find nothing. */
      maxTurns?: number;
    },
  ): AsyncGenerator<TranscriptRecord>;
}

/**
 * The reads that are the same whatever produces the records: a byte-bounded
 * page, a record scan, and a lookup by message id. Each walks one source's
 * ordered records and never asks where they came from.
 */
function pagedTranscriptReads(source: TranscriptRecordSource) {
  return {
    async readPage(
      sessionId: string,
      request: SessionTranscriptPageRequest,
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
      // Whether the Turns on this page are whole: false only while a group the
      // page already carries rows of continues past where it stopped.
      let endsAtTurnBoundary = true;
      let cluster: number | undefined;
      for await (const record of source.scan(sessionId, { ...request, throughSequence })) {
        if (fragments.length >= request.maxMessages || rawBytes >= request.maxBytes) {
          truncated = true;
          endsAtTurnBoundary = record.cluster !== cluster;
          next = { position: record.sequence, byteOffset: null };
          break;
        }
        cluster = record.cluster;
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
          // The record itself is unfinished, so its Turn is too.
          endsAtTurnBoundary = false;
          next = {
            position: record.sequence,
            byteOffset: request.direction === 'older' ? byteOffset : end,
          };
          break;
        }
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
      const records: TranscriptRecord[] = [];
      let storedBytes = 0;
      let nextPosition: number | null = null;
      for await (const record of source.scan(sessionId, { ...request, throughSequence })) {
        if (records.length >= request.maxMessages || storedBytes >= request.maxStoredBytes) {
          nextPosition = record.sequence;
          break;
        }
        records.push(record);
        storedBytes += Buffer.byteLength(JSON.stringify(record.message), 'utf8');
      }
      return { throughSequence, records, nextPosition };
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
      for await (const record of source.scan(sessionId, {
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
      if (encodedBytes > ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES) {
        throw new Error('Active Session permission outcomes exceed the transcript byte limit');
      }
      outcomes.set(item.requestId, item.outcome);
    }
  }
  return outcomes;
}

async function scanActiveRuntimeEvents(
  stores: ExecutionStoresWriter<'interactive'>,
  sessionId: string,
  runId: string,
  visit: (event: RuntimeEvent) => void,
): Promise<void> {
  const result = await stores.runtimeEventStore.scanRuntimeEvents(
    sessionId,
    runId,
    {
      maxBatchBytes: ACTIVE_TRANSCRIPT_SCAN_BATCH_MAX_BYTES,
      maxRecordBytes: TRANSCRIPT_SOURCE_MAX_RECORD_BYTES,
      maxImmutableRecords: TRANSCRIPT_SOURCE_MAX_EVENTS,
      maxImmutableBytes: TRANSCRIPT_SOURCE_MAX_BYTES,
      maxPartialRecords: TRANSCRIPT_SOURCE_MAX_EVENTS,
      maxPartialBytes: ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES,
    },
    (batch) => {
      for (const event of batch) visit(event);
    },
  );
  if (result.status === 'limit_exceeded') {
    throw new Error('Active RuntimeEvent transcript exceeds its storage scan limit');
  }
}

interface PendingTranscriptTurn extends RuntimeTranscriptInvocationHeader {
  projection: ReturnType<typeof createTranscriptProjection>;
  ordinals: Map<string, number>;
}

/** Keep only presentation state while the storage snapshot visits complete facts. */
function createTranscriptProjection(
  invocations: readonly RuntimeInvocationRecord[],
  active = false,
) {
  const canonicalPermissionOutcomes = new Map<string, CanonicalPermissionOutcomeRecord>();
  let messageCount = 0;
  let messageBytes = 0;
  let eventCount = 0;
  let sourceBytes = 0;
  const projector = createRuntimeEventStoredMessageProjector({
    invocations,
    active,
    canonicalPermissionOutcomes,
    projectToolResult: projectTranscriptToolResult,
    onMessage: (message) => {
      messageCount += 1;
      messageBytes += Buffer.byteLength(JSON.stringify(message));
      if (
        messageCount > ACTIVE_TRANSCRIPT_OVERLAY_MAX_MESSAGES ||
        messageBytes > ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES
      )
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
        throw new Error('Active RuntimeEvent transcript exceeds its event limit');
      if (sourceBytes > ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES)
        throw new Error('Active RuntimeEvent transcript exceeds its byte limit');
      projector.push(event);
    },
    async finish(reader: CanonicalPermissionOutcomeReader) {
      const outcomes = await readCanonicalPermissionOutcomes(
        projector.permissionRequestIds,
        reader,
      );
      for (const [id, outcome] of outcomes) canonicalPermissionOutcomes.set(id, outcome);
      const projected = projector.finish();
      assertActiveOverlayBounded(projected.messages);
      return projected;
    },
  };
}

function isTerminalTurn(turn: TurnSnapshot): boolean {
  return turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled';
}
