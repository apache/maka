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
  /** The legacy transcript this converter reads; nothing writes back to it. */
  readMessages(sessionId: string): Promise<StoredMessage[]>;
}

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
      const messages = await this.deps.readMessages(sessionId);
      const ledgerMessages = messages.filter(
        (message) => message.type !== 'user' || message.steeringEventId === undefined,
      );
      // A turn the ledger already owns is not converted again. Its own run is
      // the authority even when it never ended — a crashed turn is settled by
      // recovery on that run, and a second, transcript-derived invocation for
      // the same turn would make the Session read as two. The one exception is
      // this converter's own run: an interrupted import re-derives it, and the
      // deterministic ids let the store dedupe what already landed.
      const inlineInvocations = await this.listInlineInvocations(sessionId);
      const ownedTurnIds = new Set(
        inlineInvocations
          .filter(
            (invocation) =>
              invocation.terminalEvent ||
              invocation.runId !== transcriptRunId(sessionId, invocation.turnId),
          )
          .map((invocation) => invocation.turnId),
      );
      const startedRunIds = new Set(inlineInvocations.map((invocation) => invocation.runId));
      const messagesByTurn = groupMessagesByTurn(ledgerMessages);
      // A turn whose only user row was steering is not a turn of its own: the
      // steering was said into a Turn some durable Root already owns, so
      // converting it would stand a second, synthetic run beside that one.
      const turns = deriveTurnRecords(ledgerMessages).filter((turn) =>
        (messagesByTurn.get(turn.turnId) ?? []).some((message) => message.type === 'user'),
      );
      if (turns.length === 0) return;

      const firstOpenedAt = Math.max(0, header.createdAt - turns.length);

      for (const [index, turn] of turns.entries()) {
        if (ownedTurnIds.has(turn.turnId)) continue;
        const turnMessages = messagesByTurn.get(turn.turnId) ?? [];
        const runId = transcriptRunId(sessionId, turn.turnId);
        const openedAt = firstOpenedAt + index;
        const run = { sessionId, runId, turnId: turn.turnId, invocationId: runId };
        // A build before the ids were derived converted under random ones, so
        // an interrupted run of its can hold events this build cannot rederive.
        const started = startedRunIds.has(runId)
          ? await this.deps.runtimeEventStore.readRuntimeEvents(sessionId, runId)
          : [];
        const undeducible = started.filter((event) => !isDerivedTranscriptEventId(runId, event.id));
        // Its opening is the one such event that can be adopted: the run needs
        // exactly one, `runtime_events_one_opening_per_invocation` refuses a
        // second, and which id it landed under changes nothing a reader sees.
        const adoptedOpening =
          undeducible.length === 1 && undeducible[0]?.content?.kind === 'invocation_opened';
        if (undeducible.length > 0 && !adoptedOpening) {
          // Its converted messages cannot be adopted the same way: rederiving
          // them would stand a second, deterministic copy of each beside the
          // one already there, and a Session that disagrees with itself is the
          // failure this ledger exists to remove. The conversion can neither be
          // finished nor withdrawn, so it is sealed as the unfinished thing it
          // is — the legacy rows stay, and no one reads this turn as converted.
          await this.deps.runtimeEventStore.appendRuntimeEvent(
            sessionId,
            runId,
            abandonedTranscriptTerminalEvent({ run, openedAt }),
          );
          continue;
        }
        const events = [
          ...(adoptedOpening ? [] : [transcriptOpeningEvent({ header, run, openedAt })]),
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
        for (const event of events) {
          await this.deps.runtimeEventStore.appendRuntimeEvent(sessionId, runId, event);
        }
      }
    });
  }

  private async listInlineInvocations(sessionId: string): Promise<RuntimeInvocationRecord[]> {
    return (await this.deps.runtimeEventStore.listSessionInvocations(sessionId)).filter(
      (invocation) => isSessionInlineInvocation(invocation.opening),
    );
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
/** Whether this build's converter is the one that could have written that id. */
function isDerivedTranscriptEventId(runId: string, eventId: string): boolean {
  return eventId === `${runId}-opened` || new RegExp(`^${runId}-e\\d+$`).test(eventId);
}

/**
 * The terminal fact of a conversion that a released build left part-written.
 * Its id sits outside the derived sequence so it cannot collide with an event
 * that prefix already holds.
 */
function abandonedTranscriptTerminalEvent(input: {
  run: { sessionId: string; runId: string; turnId: string; invocationId: string };
  openedAt: number;
}): RuntimeEvent {
  return backfillRuntimeEventsFromStoredMessages({
    run: input.run,
    outcome: {
      status: 'failed',
      ts: input.openedAt,
      failureClass: 'missing_terminal_event',
    },
    messages: [],
    modelHistory: 'conversation_text',
    newId: () => `${input.run.runId}-abandoned`,
    now: () => input.openedAt,
  }).events[0] as RuntimeEvent;
}

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

function groupMessagesByTurn(messages: readonly StoredMessage[]): Map<string, StoredMessage[]> {
  const grouped = new Map<string, StoredMessage[]>();
  for (const message of messages) {
    const turnId = 'turnId' in message ? message.turnId : undefined;
    if (!turnId) continue;
    const bucket = grouped.get(turnId) ?? [];
    bucket.push(message);
    grouped.set(turnId, bucket);
  }
  return grouped;
}
