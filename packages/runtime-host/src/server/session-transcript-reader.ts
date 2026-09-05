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
import type { StoredMessage } from '@maka/core/session';
import {
  activePresentationRuntimeEvents,
  affectsRuntimeEventStoredMessageProjection,
  isHardRuntimeEventReadModelDiagnostic,
  projectRuntimeEventsToStoredMessages,
} from '@maka/runtime/runtime-event-read-model';
import {
  type CanonicalPermissionOutcomeReader,
  type CanonicalPermissionOutcomeRecord,
} from '@maka/runtime/interaction-authority';
import {
  isSessionInlineInvocation,
  type RuntimeInvocationRecord,
} from '@maka/core/runtime-invocation';
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
} from '@maka/storage/execution-stores';
import { foldTurnContribution } from '@maka/storage/session-message-projection';
import { SESSION_TRANSCRIPT_OVERLAY_MAX_MESSAGES, type TurnSnapshot } from '../protocol/index.js';

const PERMISSION_OUTCOME_READ_CONCURRENCY = 8;
/** Sequence room reserved for one invocation's projected transcript rows. */
const RUN_SEQUENCE_STRIDE = 1 << 20;
export const ACTIVE_TRANSCRIPT_OVERLAY_MAX_MESSAGES = SESSION_TRANSCRIPT_OVERLAY_MAX_MESSAGES;
export const ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES = 16 * 1024 * 1024;
const ACTIVE_TRANSCRIPT_SOURCE_MAX_EVENTS = ACTIVE_TRANSCRIPT_OVERLAY_MAX_MESSAGES * 2;
const ACTIVE_TRANSCRIPT_SCAN_BATCH_MAX_BYTES = 256 * 1024;

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

      const invocations = await input.stores.runtimeEventStore.listSessionInvocations(sessionId);
      const events = await readActiveProjectionEvents(input.stores, sessionId, rootTurn.runId);
      const canonicalPermissionOutcomes = await readCanonicalPermissionOutcomes(
        events,
        input.canonicalPermissionOutcomes,
      );
      const projected = projectRuntimeEventsToStoredMessages(
        activePresentationRuntimeEvents(events),
        {
          invocations: invocations.filter((invocation) => invocation.runId === rootTurn.runId),
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
 * The settled part of a Session's transcript, read off the RuntimeEvent ledger.
 *
 * A page is bounded by reading one ended invocation at a time: a Session with a
 * thousand Turns costs the same per page as one with three. Sequences are
 * `runIndex * RUN_SEQUENCE_STRIDE + indexWithinRun`, which is monotone in the
 * order the read model presents runs and derivable from the invocation list
 * alone — so locating a page never has to project the Turns before it. They are
 * stable for as long as a subscription lives, which is exactly as long as the
 * signed cursors that carry them.
 */
function createDurableLedgerTranscriptReader(input: {
  stores: ExecutionStoresWriter<'interactive'>;
  canonicalPermissionOutcomes: CanonicalPermissionOutcomeReader;
}) {
  const endedInvocations = async (sessionId: string): Promise<RuntimeInvocationRecord[]> =>
    (await input.stores.runtimeEventStore.listSessionInvocations(sessionId)).filter(
      (invocation) => isSessionInlineInvocation(invocation.opening) && invocation.terminalEvent,
    );

  const projectRun = async (
    sessionId: string,
    invocation: RuntimeInvocationRecord,
  ): Promise<readonly StoredMessage[]> => {
    const events = await input.stores.runtimeEventStore.readRuntimeEvents(
      sessionId,
      invocation.runId,
    );
    const projected = projectRuntimeEventsToStoredMessages(events, {
      invocations: [invocation],
      canonicalPermissionOutcomes: await readCanonicalPermissionOutcomes(
        events,
        input.canonicalPermissionOutcomes,
      ),
    });
    if (projected.diagnostics.some(isHardRuntimeEventReadModelDiagnostic)) {
      throw new Error('Durable RuntimeEvent transcript projection is incomplete');
    }
    if (projected.messages.length > RUN_SEQUENCE_STRIDE) {
      throw new Error('Durable Session Turn exceeds its transcript sequence stride');
    }
    return projected.messages;
  };

  /**
   * The runs a page must visit, in traversal order, already clipped to the
   * watermark and the caller's position.
   */
  const traversal = (
    invocations: readonly RuntimeInvocationRecord[],
    direction: 'older' | 'newer',
    throughSequence: number,
    position: number,
  ): Array<{ runIndex: number; invocation: RuntimeInvocationRecord }> => {
    const highestRunIndex = Math.min(runIndexOf(throughSequence), invocations.length - 1);
    const startRunIndex = Math.min(runIndexOf(position), highestRunIndex);
    const runs: Array<{ runIndex: number; invocation: RuntimeInvocationRecord }> = [];
    if (direction === 'older') {
      for (let index = startRunIndex; index >= 0; index -= 1) {
        const invocation = invocations[index];
        if (invocation) runs.push({ runIndex: index, invocation });
      }
      return runs;
    }
    for (let index = Math.max(0, startRunIndex); index <= highestRunIndex; index += 1) {
      const invocation = invocations[index];
      if (invocation) runs.push({ runIndex: index, invocation });
    }
    return runs;
  };

  const highWaterOf = async (
    sessionId: string,
    invocations: readonly RuntimeInvocationRecord[],
  ): Promise<number | null> => {
    for (let index = invocations.length - 1; index >= 0; index -= 1) {
      const invocation = invocations[index]!;
      const messages = await projectRun(sessionId, invocation);
      if (messages.length > 0) return index * RUN_SEQUENCE_STRIDE + messages.length - 1;
    }
    return null;
  };

  /** Every projected record of the requested page, ordered for its direction. */
  const scan = async function* (
    sessionId: string,
    request: {
      direction: 'older' | 'newer';
      throughSequence?: number | null;
      position?: number;
    },
  ): AsyncGenerator<{ sequence: number; message: StoredMessage }> {
    const invocations = await endedInvocations(sessionId);
    const throughSequence =
      request.throughSequence === undefined
        ? await highWaterOf(sessionId, invocations)
        : request.throughSequence;
    if (throughSequence === null) return;
    const position = request.position ?? (request.direction === 'older' ? throughSequence : 0);
    for (const { runIndex, invocation } of traversal(
      invocations,
      request.direction,
      throughSequence,
      position,
    )) {
      const messages = await projectRun(sessionId, invocation);
      const indexed = messages.map((message, index) => ({
        sequence: runIndex * RUN_SEQUENCE_STRIDE + index,
        message,
      }));
      const selected = indexed.filter(
        ({ sequence }) =>
          sequence <= throughSequence &&
          (request.direction === 'older' ? sequence <= position : sequence >= position),
      );
      if (request.direction === 'older') selected.reverse();
      yield* selected;
    }
  };

  return {
    async readHighWater(sessionId: string): Promise<number | null> {
      return highWaterOf(sessionId, await endedInvocations(sessionId));
    },

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

    /**
     * What each Turn contributed, one ended invocation at a time.
     *
     * An invocation is a Turn, so the run listing is the index: a page costs the
     * runs it actually summarizes, never a scan of the Turns before them.
     */
    async readTurnContributions(
      sessionId: string,
      throughSequence: number | null,
      position: number,
      maxContributions: number,
    ): Promise<SessionTurnContributionPage> {
      const invocations = await endedInvocations(sessionId);
      const watermark = throughSequence ?? (await highWaterOf(sessionId, invocations));
      if (watermark === null) {
        return { throughSequence: null, contributions: [], nextPosition: null };
      }
      const contributions: SessionTurnContribution[] = [];
      const lastRunIndex = Math.min(runIndexOf(watermark), invocations.length - 1);
      let runIndex = Math.max(0, runIndexOf(position));
      for (; runIndex <= lastRunIndex; runIndex += 1) {
        if (contributions.length >= maxContributions) {
          return {
            throughSequence: watermark,
            contributions,
            nextPosition: runIndex * RUN_SEQUENCE_STRIDE,
          };
        }
        const invocation = invocations[runIndex];
        if (!invocation) continue;
        const messages = await projectRun(sessionId, invocation);
        let contribution: SessionTurnContribution | undefined;
        for (const [index, message] of messages.entries()) {
          const sequence = runIndex * RUN_SEQUENCE_STRIDE + index;
          if (sequence > watermark || sequence < position) continue;
          contribution = foldTurnContribution(contribution, invocation.turnId, sequence, message);
        }
        if (contribution) contributions.push(contribution);
      }
      return { throughSequence: watermark, contributions, nextPosition: null };
    },

    /** Evenly spaced Turn starts, sampled from the run listing itself. */
    async readTurnLandmarks(
      sessionId: string,
      maxLandmarks: number,
    ): Promise<SessionTurnLandmarkSnapshot> {
      const invocations = await endedInvocations(sessionId);
      const throughSequence = await highWaterOf(sessionId, invocations);
      if (throughSequence === null) return { throughSequence: null, landmarks: [] };
      const lastRunIndex = Math.min(runIndexOf(throughSequence), invocations.length - 1);
      const count = Math.min(maxLandmarks, lastRunIndex + 1);
      const sampled =
        count <= 0
          ? []
          : Array.from({ length: count }, (_, index) =>
              count === 1 ? lastRunIndex : Math.floor((lastRunIndex * index) / (count - 1)),
            );
      const landmarks: SessionTurnLandmark[] = [];
      for (const runIndex of [...new Set(sampled)]) {
        const invocation = invocations[runIndex];
        if (!invocation) continue;
        const messages = await projectRun(sessionId, invocation);
        const index = messages.findIndex((message) => message.type === 'user');
        const message = index < 0 ? undefined : messages[index];
        if (message?.type !== 'user') continue;
        const label = (message.displayText ?? message.text).trim();
        if (!label) continue;
        landmarks.push({
          turnId: invocation.turnId,
          sequence: runIndex * RUN_SEQUENCE_STRIDE + index,
          label,
        });
      }
      return { throughSequence, landmarks };
    },

    async readMessagesById(
      sessionId: string,
      request: SessionTranscriptMessageLookupRequest,
    ): Promise<StoredMessage[]> {
      if (request.throughSequence === null || request.messageIds.length === 0) return [];
      const wanted = new Set(request.messageIds);
      const found: StoredMessage[] = [];
      let bytes = 0;
      // Callers look up streams that were active a moment ago, so a durable copy
      // can only be in the run that just sealed. Without this bound the ordinary
      // miss — the run is still open — reprojects every Turn in the Session.
      let newestRunIndex: number | undefined;
      for await (const record of scan(sessionId, {
        direction: 'older',
        throughSequence: request.throughSequence,
      })) {
        newestRunIndex ??= runIndexOf(record.sequence);
        if (runIndexOf(record.sequence) < newestRunIndex) break;
        if (!wanted.delete(record.message.id)) continue;
        bytes += Buffer.byteLength(JSON.stringify(record.message), 'utf8');
        if (found.length >= request.maxMessages || bytes > request.maxBytes) break;
        found.push(record.message);
        if (wanted.size === 0) break;
      }
      // Restore transcript order: the scan walked backwards to find them.
      return found.reverse();
    },
  };
}

function runIndexOf(sequence: number): number {
  return Math.floor(sequence / RUN_SEQUENCE_STRIDE);
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
