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

import { createHash } from 'node:crypto';
import { deriveTurnRecords } from '@maka/core/session';
import { DEFAULT_TOOL_MODE } from '@maka/core/tool-mode';
import type { RuntimeEvent, RuntimeEventInvocationOpenedContent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import {
  buildInvocationOpenedEvent,
  isSessionInlineInvocation,
} from '@maka/core/runtime-invocation';
import type {
  RuntimeInvocationOutcome,
  RuntimeInvocationRecord,
} from '@maka/core/runtime-invocation';
import type { SessionHeader } from '@maka/core/session';
import type { StoredMessage, TurnRecord } from '@maka/core/session';
import { backfillRuntimeEventsFromStoredMessages } from './runtime-event-backfill.js';
import type { RuntimeEventBackfillOutcome } from './runtime-event-backfill.js';

export interface RuntimeLedgerRepairDeps {
  runtimeEventStore: RuntimeEventStore;
  /**
   * One forward page of the legacy transcript this converter reads; nothing
   * writes back to it. It is read a page at a time because a Session cannot
   * serve its first transcript page until this finishes, and a Session's
   * history is not a bound.
   */
  readMessagesAfter(
    sessionId: string,
    request: { afterSequence?: number; maxMessages: number; maxStoredBytes: number },
  ): Promise<{
    records: readonly { sequence: number; message: StoredMessage }[];
    highWaterSequence: number | null;
  }>;
}

/** How much of a legacy transcript one conversion page holds. */
const TRANSCRIPT_CONVERSION_PAGE_MAX_MESSAGES = 256;
const TRANSCRIPT_CONVERSION_PAGE_MAX_BYTES = 4 * 1024 * 1024;

export class RuntimeLedgerRepair {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: RuntimeLedgerRepairDeps) {}

  /**
   * Give a transcript a runtime spine: one invocation per turn, opened by its
   * own opening fact and closed by its own terminal event.
   *
   * Every event id is derived from the run it belongs to and its position in
   * that run, so importing the same transcript twice writes the same events and
   * the store dedupes them. That is what makes an interrupted import resumable:
   * a turn is skipped once its invocation has ended, and re-derived until then.
   */
  async materializeTranscriptLedger(header: SessionHeader): Promise<void> {
    const sessionId = header.id;
    return this.withRepairQueue(sessionId, async () => {
      // A turn the ledger already owns is not converted again. Its own run is
      // the authority even when it never ended — a crashed turn is settled by
      // recovery on that run, and a second, transcript-derived invocation for
      // the same turn would make the Session read as two. The one exception is
      // this converter's own run: an interrupted import re-derives it, and the
      // deterministic ids let the store dedupe what already landed.
      const { ownedTurnIds, startedRunIds } = await this.readLedgerOwnership(sessionId);

      for await (const scanned of this.readTurnsInPages(sessionId)) {
        const turnMessages = scanned.messages;
        // A turn whose only user row was steering is not a turn of its own: the
        // steering was said into a Turn some durable Root already owns, so
        // converting it would stand a second, synthetic run beside that one.
        if (!turnMessages.some((message) => message.type === 'user')) continue;
        const [turn] = deriveTurnRecords(turnMessages);
        if (!turn) continue;
        if (ownedTurnIds.has(turn.turnId)) continue;
        const runId = transcriptRunId(sessionId, turn.turnId);
        // Ordered by where the turn starts in the transcript rather than by its
        // index among all turns: a paged conversion never holds that count, and
        // both keep every imported opening ahead of the Session's own runs.
        const openedAt = Math.max(
          0,
          header.createdAt - 1 - (scanned.highWater - scanned.firstSequence),
        );
        const run = { sessionId, runId, turnId: turn.turnId, invocationId: runId };
        // A build before the ids were derived converted under random ones, so
        // an interrupted run of its can hold events this build cannot rederive.
        // What it can read is which legacy row each of them came from, and that
        // is the identity the conversion resumes on.
        const started = startedRunIds.has(runId)
          ? await this.deps.runtimeEventStore.readRuntimeEvents(sessionId, runId)
          : [];
        const converted = new Map<string, number>();
        for (const event of started) {
          const rowId = event.refs?.storedMessageId;
          if (rowId) converted.set(rowId, (converted.get(rowId) ?? 0) + 1);
        }
        const hasOpening = started.some((event) => event.content?.kind === 'invocation_opened');
        const derived = [
          ...(hasOpening ? [] : [transcriptOpeningEvent({ header, run, openedAt })]),
          ...backfillRuntimeEventsFromStoredMessages({
            run,
            outcome: transcriptOutcome(turn, turnMessages, openedAt),
            messages: turnMessages,
            // Another runtime's tool calls belong to its protocol, not to the
            // provider this Session will talk to next, so a foreign transcript
            // converts as the conversation it is. Maka's own history converts
            // whole: its tool calls are the ones it would replay.
            modelHistory: header.externalOrigin ? 'conversation_text' : 'full',
            newId: transcriptEventIds(runId),
            // The payload must be as repeatable as its id: SQLite dedupes
            // complete events, including the backfill provenance timestamps.
            now: () => openedAt,
          }).events,
        ];
        // The whole turn is derived either way, so the ids stay the ones a
        // fresh conversion would mint; only the events whose row already has
        // that many on the run are dropped. A row half-converted by a crash
        // between two of its events keeps the rest.
        const seen = new Map<string, number>();
        for (const event of derived) {
          const rowId = event.refs?.storedMessageId;
          if (rowId !== undefined) {
            const index = seen.get(rowId) ?? 0;
            seen.set(rowId, index + 1);
            if (index < (converted.get(rowId) ?? 0)) continue;
          }
          await this.deps.runtimeEventStore.appendRuntimeEvent(sessionId, runId, event);
        }
      }
      // Appending gave every converted event an ordinal above the Session's
      // existing runs, which is the wrong order whenever the transcript holds a
      // turn older than a run already on the ledger. A released build could
      // leave exactly that: it sent on an imported Session without converting
      // first. `openedAt` above already says where each imported turn belongs;
      // this is what makes the reader agree.
      await this.deps.runtimeEventStore.resequenceSessionEventOrdinals(sessionId);
    });
  }

  /**
   * The Session's legacy rows, one turn at a time, read a page at a time.
   *
   * A turn is only complete once a row of another turn follows it, so the rows
   * of the page's last turn are carried into the next page rather than
   * converted early. Peak memory is therefore one page plus one turn — the same
   * bound the transcript reader keeps, and not the Session's whole history.
   */
  private async *readTurnsInPages(
    sessionId: string,
  ): AsyncGenerator<{ messages: StoredMessage[]; firstSequence: number; highWater: number }> {
    let carried: { messages: StoredMessage[]; firstSequence: number } | undefined;
    let afterSequence: number | undefined;
    while (true) {
      const page = await this.deps.readMessagesAfter(sessionId, {
        ...(afterSequence === undefined ? {} : { afterSequence }),
        maxMessages: TRANSCRIPT_CONVERSION_PAGE_MAX_MESSAGES,
        maxStoredBytes: TRANSCRIPT_CONVERSION_PAGE_MAX_BYTES,
      });
      const highWater = page.highWaterSequence;
      if (highWater === null) return;
      const scanned = page.records.filter(
        ({ message }) => message.type !== 'user' || message.steeringEventId === undefined,
      );
      const grouped = new Map<string, { messages: StoredMessage[]; firstSequence: number }>();
      if (carried) grouped.set(turnIdOf(carried.messages[0]) ?? '', carried);
      for (const { sequence, message } of scanned) {
        const turnId = turnIdOf(message);
        if (!turnId) continue;
        const bucket = grouped.get(turnId);
        if (bucket) bucket.messages.push(message);
        else grouped.set(turnId, { messages: [message], firstSequence: sequence });
      }
      const turns = [...grouped.values()];
      const lastSequence = page.records.at(-1)?.sequence;
      // The last turn of a page may continue into the next one, so it is held
      // back rather than converted from a prefix of its own rows. A page with
      // nothing left to read ends the scan, and what was held back is whole.
      carried = lastSequence === undefined ? undefined : turns.pop();
      for (const turn of turns) yield { ...turn, highWater };
      if (lastSequence === undefined) return;
      afterSequence = lastSequence;
    }
  }

  /**
   * Which turns the ledger already owns and which runs it has started, as ids
   * rather than records: the inventory is one row per invocation and the scan
   * that follows outlives it, so nothing keeps the records themselves.
   */
  private async readLedgerOwnership(
    sessionId: string,
  ): Promise<{ ownedTurnIds: Set<string>; startedRunIds: Set<string> }> {
    const ownedTurnIds = new Set<string>();
    const startedRunIds = new Set<string>();
    for (const invocation of await this.deps.runtimeEventStore.listSessionInvocations(sessionId)) {
      if (!isSessionInlineInvocation(invocation.opening)) continue;
      startedRunIds.add(invocation.runId);
      if (
        invocation.terminalEvent ||
        invocation.runId !== transcriptRunId(sessionId, invocation.turnId)
      ) {
        ownedTurnIds.add(invocation.turnId);
      }
    }
    return { ownedTurnIds, startedRunIds };
  }

  private async withRepairQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const cleanup = current.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, cleanup);
    try {
      return await current;
    } finally {
      if (this.queues.get(key) === cleanup) {
        this.queues.delete(key);
      }
    }
  }
}

/** Synthetic conversion runs belong to the importer, never execution recovery. */
export function isTranscriptLedgerInvocation(
  invocation: Pick<RuntimeInvocationRecord, 'sessionId' | 'turnId' | 'runId'>,
): boolean {
  return invocation.runId === transcriptRunId(invocation.sessionId, invocation.turnId);
}

function transcriptRunId(sessionId: string, turnId: string): string {
  const digest = createHash('sha256').update(sessionId).update('\0').update(turnId).digest('hex');
  return `transcript-${digest.slice(0, 48)}`;
}

/**
 * Ids for one run's converted events, numbered in the order the converter
 * emits them. The run id is already derived from the Session and turn, so the
 * same transcript always produces the same ids and a re-run appends nothing.
 */
function transcriptEventIds(runId: string): () => string {
  let seq = 0;
  return () => {
    seq += 1;
    return `${runId}-e${seq}`;
  };
}

/**
 * The opening fact of an imported turn.
 *
 * Its route is `unknown` on purpose: an external transcript records which model
 * produced the text, never which credential the host would have used, so the
 * import must not let anything treat the route as authenticated.
 */
function transcriptOpeningEvent(input: {
  header: SessionHeader;
  run: { sessionId: string; runId: string; turnId: string; invocationId: string };
  openedAt: number;
}): RuntimeEvent {
  const opening: RuntimeEventInvocationOpenedContent = {
    kind: 'invocation_opened',
    protocol: 'invocation_opened_v1',
    route: {
      provenance: 'unknown',
      backendKind: input.header.backend,
      llmConnectionSlug: input.header.llmConnectionSlug,
      modelId: input.header.model,
    },
    configuration: {
      cwd: input.header.cwd,
      permissionMode: input.header.permissionMode,
      collaborationMode: input.header.collaborationMode ?? 'agent',
      orchestrationMode: input.header.orchestrationMode ?? 'default',
      orchestrationSource: 'session',
      toolMode: DEFAULT_TOOL_MODE,
    },
    root: { kind: 'user' },
    source: { kind: 'fresh' },
  };
  return buildInvocationOpenedEvent({
    id: `${input.run.runId}-opened`,
    run: input.run,
    openedAt: input.openedAt,
    opening,
  });
}

/** How the imported turn ended, read off the transcript's own turn record. */
function transcriptOutcome(
  turn: TurnRecord,
  turnMessages: readonly StoredMessage[],
  openedAt: number,
): RuntimeEventBackfillOutcome {
  const ts = Math.max(openedAt, ...turnMessages.map((message) => message.ts));
  // A transcript that never stated how a turn ended does not get to claim it
  // completed. The terminal event is written once and cannot be corrected later,
  // so an inferred status is recorded as the failure it actually is — which is
  // also the reason an adapter emits a cutoff of its own.
  if (turn.statusSource !== 'recorded') {
    return { status: 'failed', ts, failureClass: 'missing_terminal_event' };
  }
  const status = transcriptOutcomeStatus(turn.status);
  return {
    status,
    ts,
    ...(status === 'failed'
      ? { failureClass: turn.errorClass ?? 'external_transcript_failed' }
      : {}),
    ...(status === 'cancelled'
      ? { abortSource: turn.abortSource ?? 'external_session_snapshot' }
      : {}),
  };
}

function transcriptOutcomeStatus(status: TurnRecord['status']): RuntimeInvocationOutcome {
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'completed';
  return 'cancelled';
}

function turnIdOf(message: StoredMessage | undefined): string | undefined {
  if (!message) return undefined;
  return 'turnId' in message ? message.turnId : undefined;
}
