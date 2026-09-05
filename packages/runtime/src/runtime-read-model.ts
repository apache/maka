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
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import type { StoredMessage, TurnRecord } from '@maka/core/session';
import { deriveTurnRecords } from '@maka/core/session';
import { isSessionInlineInvocation } from '@maka/core/runtime-invocation';
import type {
  CanonicalPermissionOutcomeReader,
  CanonicalPermissionOutcomeRecord,
} from './interaction-authority.js';
import {
  activePresentationRuntimeEvents,
  classifyRuntimeEventTerminalFact,
  compareRuntimeReadModelMessages,
  isHardRuntimeEventReadModelDiagnostic,
  projectRuntimeEventsToStoredMessages,
  type RuntimeEventReadModelDiagnostic,
  type RuntimeEventTerminalFact,
} from './runtime-event-read-model.js';
import {
  buildRuntimeEventModelReplayPlan,
  type RuntimeEventModelReplayPlan,
} from './model-history.js';

const CANONICAL_PERMISSION_READ_CONCURRENCY = 8;

export interface RuntimeReadModelDeps {
  runtimeEventStore: RuntimeEventStore;
  canonicalPermissionOutcomes?: CanonicalPermissionOutcomeReader;
}

export interface RuntimeReadModelSessionView {
  source: 'runtime_events';
  messages: StoredMessage[];
  turns: TurnRecord[];
  events: RuntimeEvent[];
  invocations: RuntimeInvocationRecord[];
  diagnostics: RuntimeEventReadModelDiagnostic[];
  terminalFacts: RuntimeEventTerminalFact[];
  replayPlan: RuntimeEventModelReplayPlan;
}

export class RuntimeReadModelError extends Error {
  readonly diagnostics: RuntimeEventReadModelDiagnostic[];

  constructor(message: string, diagnostics: RuntimeEventReadModelDiagnostic[]) {
    super(message);
    this.name = 'RuntimeReadModelError';
    this.diagnostics = diagnostics;
  }
}

export class RuntimeReadModel {
  constructor(private readonly deps: RuntimeReadModelDeps) {}

  async getSessionMessages(sessionId: string): Promise<StoredMessage[]> {
    return (await this.getSessionView(sessionId)).messages;
  }

  async getSessionTurns(sessionId: string): Promise<TurnRecord[]> {
    return (await this.getSessionView(sessionId)).turns;
  }

  async getSessionView(sessionId: string): Promise<RuntimeReadModelSessionView> {
    const diagnostics: RuntimeEventReadModelDiagnostic[] = [];
    const inFlightTurnIds = new Set<string>();
    let invocations: RuntimeInvocationRecord[];
    try {
      invocations = (await this.deps.runtimeEventStore.listSessionInvocations(sessionId)).filter(
        (invocation) => isSessionInlineInvocation(invocation.opening),
      );
    } catch (error) {
      throw new RuntimeReadModelError('RuntimeReadModel could not list Session invocations', [
        readModelDiagnostic(
          'unsupported_event',
          'RuntimeEventStore.listSessionInvocations failed',
          {
            error: errorMessage(error),
          },
        ),
      ]);
    }

    if (invocations.length === 0) {
      return this.buildView({ invocations, events: [], diagnostics });
    }

    const durableEventOrdinals = await this.readSessionRuntimeEventOrdinals(sessionId);
    const durableEventOrdinalById = new Map(
      durableEventOrdinals.map(({ event, ordinal }) => [event.id, ordinal]),
    );
    const ordered: OrderedRuntimeEvent[] = [];
    const terminalFacts: RuntimeEventTerminalFact[] = [];
    for (let runIndex = 0; runIndex < invocations.length; runIndex += 1) {
      const invocation = invocations[runIndex]!;
      let runEvents: RuntimeEvent[];
      try {
        runEvents = await this.deps.runtimeEventStore.readRuntimeEvents(
          sessionId,
          invocation.runId,
        );
      } catch (error) {
        throw new RuntimeReadModelError('RuntimeEvent ledger read failed', [
          readModelDiagnostic('unsupported_event', 'RuntimeEventStore.readRuntimeEvents failed', {
            runId: invocation.runId,
            error: errorMessage(error),
          }),
        ]);
      }

      // No terminal event yet: the invocation is still open, or the process died
      // holding it. Either way its own events are the whole truth about it, read
      // as a running turn reads — the arriving text presented as settled. No
      // durable ordinals exist for them yet, so they keep ledger order.
      if (!invocation.terminalEvent) {
        inFlightTurnIds.add(invocation.turnId);
        appendOrderedEvents(ordered, activePresentationRuntimeEvents(runEvents), runIndex);
        continue;
      }

      const terminalFact = classifyRuntimeEventTerminalFact(invocation, runEvents);
      diagnostics.push(...terminalFact.diagnostics);
      if (!terminalFact.fact) {
        throw new RuntimeReadModelError(
          'RuntimeEvent ledger has no valid terminal fact for a terminal run',
          diagnostics,
        );
      }
      terminalFacts.push(terminalFact.fact);

      appendOrderedEvents(ordered, runEvents, runIndex, durableEventOrdinalById);
    }

    ordered.sort(compareOrderedRuntimeEvents);

    return this.buildView({
      invocations,
      events: ordered.map((item) => item.event),
      diagnostics,
      terminalFacts,
      inFlightTurnIds,
    });
  }

  private async readSessionRuntimeEventOrdinals(
    sessionId: string,
  ): Promise<ReadonlyArray<{ ordinal: number; event: RuntimeEvent }>> {
    try {
      return await this.deps.runtimeEventStore.readSessionRuntimeEventEntries(sessionId);
    } catch (error) {
      throw new RuntimeReadModelError('RuntimeEvent session order read failed', [
        readModelDiagnostic(
          'unsupported_event',
          'RuntimeEventStore.readSessionRuntimeEventEntries failed',
          { error: errorMessage(error) },
        ),
      ]);
    }
  }

  private async buildView(input: {
    invocations: RuntimeInvocationRecord[];
    events: RuntimeEvent[];
    diagnostics: RuntimeEventReadModelDiagnostic[];
    terminalFacts?: RuntimeEventTerminalFact[];
    inFlightTurnIds?: ReadonlySet<string>;
  }): Promise<RuntimeReadModelSessionView> {
    const canonicalPermissionRead = await this.readCanonicalPermissionOutcomes(input.events);
    const projected = projectRuntimeEventsToStoredMessages(input.events, {
      invocations: input.invocations,
      canonicalPermissionOutcomes: canonicalPermissionRead.outcomes,
    });
    const diagnostics = [
      ...input.diagnostics,
      ...canonicalPermissionRead.diagnostics,
      ...projected.diagnostics,
    ];
    if (canonicalPermissionRead.diagnostics.length > 0) {
      throw new RuntimeReadModelError('Canonical permission outcome read failed', diagnostics);
    }
    if (projected.diagnostics.some(isHardRuntimeEventReadModelDiagnostic)) {
      throw new RuntimeReadModelError('RuntimeEvent read projection is incomplete', diagnostics);
    }

    const messages = projected.messages;

    return {
      source: 'runtime_events',
      messages,
      turns: runningTurnRecords(deriveTurnRecords(messages), input.inFlightTurnIds),
      events: input.events,
      invocations: input.invocations,
      diagnostics,
      terminalFacts: input.terminalFacts ?? [],
      replayPlan: buildRuntimeEventModelReplayPlan(input.events),
    };
  }

  private async readCanonicalPermissionOutcomes(events: readonly RuntimeEvent[]): Promise<{
    outcomes: Map<string, CanonicalPermissionOutcomeRecord>;
    diagnostics: RuntimeEventReadModelDiagnostic[];
  }> {
    const requestIds = [
      ...new Set(
        events.flatMap((event) =>
          event.actions?.permissionAnswerAccepted
            ? [event.actions.permissionAnswerAccepted.requestId]
            : [],
        ),
      ),
    ];
    const outcomes = new Map<string, CanonicalPermissionOutcomeRecord>();
    const diagnostics: RuntimeEventReadModelDiagnostic[] = [];
    const reader = this.deps.canonicalPermissionOutcomes;
    if (!reader) return { outcomes, diagnostics };

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < requestIds.length) {
        const requestId = requestIds[nextIndex]!;
        nextIndex += 1;
        try {
          const outcome = await reader.readPermissionOutcome(requestId);
          if (outcome) outcomes.set(requestId, outcome);
        } catch (error) {
          diagnostics.push(
            readModelDiagnostic(
              'incomplete_event',
              'CanonicalPermissionOutcomeReader.readPermissionOutcome failed',
              { requestId, error: errorMessage(error) },
            ),
          );
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(CANONICAL_PERMISSION_READ_CONCURRENCY, requestIds.length) },
        worker,
      ),
    );
    return { outcomes, diagnostics };
  }
}

/**
 * A turn whose invocation has not ended is running.
 *
 * The transcript has no row that says so, and it should not: "still running" is
 * the absence of the terminal event, read off the invocation itself. Rows are
 * what the turn produced, and a turn that has produced an answer but not ended
 * would otherwise read as finished.
 */
function runningTurnRecords(
  turns: readonly TurnRecord[],
  inFlightTurnIds: ReadonlySet<string> | undefined,
): TurnRecord[] {
  if (!inFlightTurnIds || inFlightTurnIds.size === 0) return [...turns];
  const running = new Set(inFlightTurnIds);
  const marked = turns.map((turn) => {
    if (!running.delete(turn.turnId)) return turn;
    return { ...turn, status: 'running' as const, statusSource: 'recorded' as const };
  });
  // An invocation that has opened but produced nothing yet still has a turn.
  for (const turnId of running) {
    marked.push({
      turnId,
      status: 'running',
      statusSource: 'recorded',
      partialOutputRetained: false,
    });
  }
  return marked;
}

function readModelDiagnostic(
  code: RuntimeEventReadModelDiagnostic['code'],
  message: string,
  detail?: unknown,
): RuntimeEventReadModelDiagnostic {
  return {
    code,
    message,
    ...(detail !== undefined ? { detail } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface OrderedRuntimeEvent {
  event: RuntimeEvent;
  runIndex: number;
  eventIndex: number;
  ordinal?: number;
}

function appendOrderedEvents(
  ordered: OrderedRuntimeEvent[],
  events: readonly RuntimeEvent[],
  runIndex: number,
  ordinals?: ReadonlyMap<string, number>,
): void {
  const nextOrdinals: Array<number | undefined> = new Array(events.length);
  let nextOrdinal: number | undefined;
  for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
    nextOrdinal = ordinals?.get(events[eventIndex]!.id) ?? nextOrdinal;
    nextOrdinals[eventIndex] = nextOrdinal;
  }
  let previousOrdinal: number | undefined;
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]!;
    const durableOrdinal = ordinals?.get(event.id);
    if (durableOrdinal !== undefined) previousOrdinal = durableOrdinal;
    const ordinal = durableOrdinal ?? previousOrdinal ?? nextOrdinals[eventIndex];
    ordered.push({
      event,
      runIndex,
      eventIndex,
      ...(ordinal !== undefined ? { ordinal } : {}),
    });
  }
}

function compareOrderedRuntimeEvents(a: OrderedRuntimeEvent, b: OrderedRuntimeEvent): number {
  if (a.ordinal !== undefined || b.ordinal !== undefined) {
    if (a.ordinal === undefined) return 1;
    if (b.ordinal === undefined) return -1;
    return (
      a.ordinal - b.ordinal || a.eventIndex - b.eventIndex || a.event.id.localeCompare(b.event.id)
    );
  }
  return (
    a.event.ts - b.event.ts ||
    a.runIndex - b.runIndex ||
    a.eventIndex - b.eventIndex ||
    a.event.id.localeCompare(b.event.id)
  );
}
