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

export interface RuntimeReadModelProjectionCache {
  readMessages(sessionId: string): Promise<StoredMessage[]>;
}

export interface RuntimeReadModelDeps {
  runtimeEventStore: RuntimeEventStore;
  projectionCache?: RuntimeReadModelProjectionCache;
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
      // holding it. Either way the ledger is the whole truth about it, so the
      // in-flight projection cache supplies the rows a live turn has not
      // committed instead of a status field claiming otherwise.
      if (!invocation.terminalEvent) {
        diagnostics.push(
          readModelDiagnostic(
            'incomplete_event',
            'active run is using the in-flight projection cache',
            { runId: invocation.runId, turnId: invocation.turnId },
          ),
        );
        inFlightTurnIds.add(invocation.turnId);
        if (!this.deps.projectionCache) {
          throw new RuntimeReadModelError('RuntimeEvent ledger is incomplete for an active run', [
            readModelDiagnostic(
              'incomplete_event',
              'active run has no stable RuntimeEvent read projection',
              { runId: invocation.runId, turnId: invocation.turnId },
            ),
          ]);
        }
        const overlayEvents = runEvents.flatMap(activeInteractionOverlayEvent);
        appendOrderedEvents(ordered, overlayEvents, runIndex);
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

    const sessionId = input.invocations[0]?.sessionId;
    let cachedMessages: StoredMessage[] | undefined;
    if (sessionId && this.deps.projectionCache) {
      try {
        cachedMessages = await this.deps.projectionCache.readMessages(sessionId);
      } catch (error) {
        const diagnostic = readModelDiagnostic(
          'unsupported_event',
          'SessionProjectionCache.readMessages failed',
          {
            error: errorMessage(error),
          },
        );
        diagnostics.push(diagnostic);
        if (input.inFlightTurnIds && input.inFlightTurnIds.size > 0) {
          throw new RuntimeReadModelError(
            'RuntimeEvent active projection cache read failed',
            diagnostics,
          );
        }
      }
    }

    const messages =
      input.inFlightTurnIds && input.inFlightTurnIds.size > 0
        ? mergeInFlightProjectionCache(
            projected.messages,
            cachedMessages ?? [],
            input.inFlightTurnIds,
          )
        : projected.messages;

    diagnostics.push(
      ...this.compareProjectionCache(messages, cachedMessages, canonicalPermissionRead.outcomes),
    );

    return {
      source: 'runtime_events',
      messages,
      turns: deriveTurnRecords(messages),
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

  private compareProjectionCache(
    messages: readonly StoredMessage[],
    cached: readonly StoredMessage[] | undefined,
    canonicalPermissionOutcomes: ReadonlyMap<string, CanonicalPermissionOutcomeRecord>,
  ): RuntimeEventReadModelDiagnostic[] {
    if (!cached) return [];
    const canonicalRequestIds = new Set(canonicalPermissionOutcomes.keys());
    const excludesCanonicalPermission = (message: StoredMessage): boolean =>
      message.type === 'permission_decision' && canonicalRequestIds.has(message.id);
    return compareRuntimeReadModelMessages(
      messages.filter((message) => !excludesCanonicalPermission(message)),
      cached.filter((message) => !excludesCanonicalPermission(message)),
    ).diagnostics;
  }
}

/**
 * The interaction facts an active run must keep even while its messages come
 * from the in-flight projection cache. Permission prompts were always carried
 * here; sandbox boundary requests and decisions belong for the same reason
 * (#1612): they are the only durable record that a prompt was raised and how
 * it settled, so dropping them makes a pending request invisible to anything
 * reading the view instead of the live backend.
 */
function activeInteractionOverlayEvent(event: RuntimeEvent): RuntimeEvent[] {
  const permissionRequest = event.actions?.permissionRequest;
  const permissionAnswerAccepted = event.actions?.permissionAnswerAccepted;
  const permissionClosureAccepted = event.actions?.permissionClosureAccepted;
  const sandboxBoundaryRequest = event.actions?.stateDelta?.sandboxBoundaryRequest;
  const sandboxBoundaryDecision = event.actions?.stateDelta?.sandboxBoundaryDecision;
  if (
    !permissionRequest &&
    !permissionAnswerAccepted &&
    !permissionClosureAccepted &&
    sandboxBoundaryRequest === undefined &&
    sandboxBoundaryDecision === undefined
  ) {
    return [];
  }
  const overlay = { ...event };
  delete overlay.content;
  delete overlay.status;
  const stateDelta = {
    ...(sandboxBoundaryRequest !== undefined ? { sandboxBoundaryRequest } : {}),
    ...(sandboxBoundaryDecision !== undefined ? { sandboxBoundaryDecision } : {}),
  };
  overlay.actions = {
    ...(permissionRequest ? { permissionRequest } : {}),
    ...(permissionAnswerAccepted ? { permissionAnswerAccepted } : {}),
    ...(permissionClosureAccepted ? { permissionClosureAccepted } : {}),
    ...(Object.keys(stateDelta).length > 0 ? { stateDelta } : {}),
  };
  return [overlay];
}

function mergeInFlightProjectionCache(
  runtimeMessages: readonly StoredMessage[],
  cachedMessages: readonly StoredMessage[],
  inFlightTurnIds: ReadonlySet<string>,
): StoredMessage[] {
  const merged = runtimeMessages.map((message, index) => ({ message, index }));
  const seenIds = new Set(runtimeMessages.map((message) => message.id));
  for (const cached of cachedMessages) {
    const turnId = messageTurnId(cached);
    if (!turnId || !inFlightTurnIds.has(turnId) || seenIds.has(cached.id)) continue;
    seenIds.add(cached.id);
    merged.push({ message: cached, index: merged.length });
  }
  return merged
    .sort((a, b) => a.message.ts - b.message.ts || a.index - b.index)
    .map((entry) => entry.message);
}

function messageTurnId(message: StoredMessage): string | undefined {
  return 'turnId' in message && typeof message.turnId === 'string' ? message.turnId : undefined;
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
