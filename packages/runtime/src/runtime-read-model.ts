import type { AgentRunHeader, AgentRunStore } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import type { StoredMessage, TurnRecord } from '@maka/core/session';
import { deriveTurnRecords } from '@maka/core/session';
import { isSessionInlineRun } from '@maka/core/agent-run';
import { isTerminalRuntimeEvent } from '@maka/core/runtime-event';
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
import { backfillRuntimeEventsFromStoredMessages } from './runtime-event-backfill.js';
import {
  effectiveRunHeaderFromTerminalFact,
  terminalRunHeaderMatchesFact,
} from './terminal-run-commit.js';

const CANONICAL_PERMISSION_READ_CONCURRENCY = 8;

export interface RuntimeReadModelProjectionCache {
  readMessages(sessionId: string): Promise<StoredMessage[]>;
}

export interface RuntimeReadModelDeps {
  runStore: AgentRunStore;
  runtimeEventStore: RuntimeEventStore;
  projectionCache?: RuntimeReadModelProjectionCache;
  canonicalPermissionOutcomes?: CanonicalPermissionOutcomeReader;
}

export interface RuntimeReadModelSessionView {
  source: 'runtime_events';
  messages: StoredMessage[];
  turns: TurnRecord[];
  events: RuntimeEvent[];
  runs: AgentRunHeader[];
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
    let runs: AgentRunHeader[];
    try {
      runs = await this.deps.runStore.listSessionRuns(sessionId);
    } catch (error) {
      throw new RuntimeReadModelError('RuntimeReadModel could not list AgentRun headers', [
        readModelDiagnostic('unsupported_event', 'AgentRunStore.listSessionRuns failed', {
          error: errorMessage(error),
        }),
      ]);
    }

    const inlineRuns = runs.filter(isSessionInlineRun);

    if (inlineRuns.length === 0) {
      return this.buildView({ runs: inlineRuns, events: [], diagnostics });
    }

    const ordered: Array<{ event: RuntimeEvent; runIndex: number; eventIndex: number }> = [];
    const terminalFacts: RuntimeEventTerminalFact[] = [];
    for (let runIndex = 0; runIndex < inlineRuns.length; runIndex += 1) {
      const run = inlineRuns[runIndex]!;
      if (!isTerminalRunStatus(run.status)) {
        const activeRunContext = await this.readNonTerminalRunContext(sessionId, run);
        if (activeRunContext?.fact) {
          inlineRuns[runIndex] = effectiveRunHeaderFromTerminalFact(run, activeRunContext.fact);
          terminalFacts.push(activeRunContext.fact);
          diagnostics.push(...activeRunContext.fact.diagnostics);
          for (let eventIndex = 0; eventIndex < activeRunContext.events.length; eventIndex += 1) {
            ordered.push({ event: activeRunContext.events[eventIndex]!, runIndex, eventIndex });
          }
          continue;
        }

        const diagnostic = readModelDiagnostic(
          'incomplete_event',
          'active run is using the in-flight projection cache',
          {
            runId: run.runId,
            turnId: run.turnId,
            status: run.status,
          },
        );
        diagnostics.push(diagnostic);
        inFlightTurnIds.add(run.turnId);
        if (!this.deps.projectionCache) {
          throw new RuntimeReadModelError('RuntimeEvent ledger is incomplete for an active run', [
            readModelDiagnostic(
              'incomplete_event',
              'active run has no stable RuntimeEvent read projection',
              {
                runId: run.runId,
                turnId: run.turnId,
                status: run.status,
              },
            ),
          ]);
        }
        const overlayEvents = activeRunContext?.events.flatMap(activeInteractionOverlayEvent) ?? [];
        for (let eventIndex = 0; eventIndex < overlayEvents.length; eventIndex += 1) {
          ordered.push({ event: overlayEvents[eventIndex]!, runIndex, eventIndex });
        }
        continue;
      }

      let runEvents: RuntimeEvent[];
      try {
        runEvents = await this.deps.runtimeEventStore.readRuntimeEvents(sessionId, run.runId);
      } catch (error) {
        throw new RuntimeReadModelError('RuntimeEvent ledger read failed', [
          readModelDiagnostic('unsupported_event', 'RuntimeEventStore.readRuntimeEvents failed', {
            runId: run.runId,
            error: errorMessage(error),
          }),
        ]);
      }

      if (runEvents.length === 0) {
        const recovered = await this.backfillMissingRuntimeEvents(sessionId, run);
        if (recovered.length === 0 || !recovered.some(isTerminalRuntimeEvent)) {
          throw new RuntimeReadModelError('RuntimeEvent ledger is missing for a terminal run', [
            readModelDiagnostic(
              'incomplete_event',
              'terminal run has no readable RuntimeEvent ledger',
              {
                runId: run.runId,
                turnId: run.turnId,
              },
            ),
          ]);
        }
        diagnostics.push(
          readModelDiagnostic(
            'incomplete_event',
            'terminal run recovered from legacy projection cache',
            {
              runId: run.runId,
              turnId: run.turnId,
            },
          ),
        );
        runEvents = recovered;
      }
      if (!runEvents.some(isTerminalRuntimeEvent)) {
        throw new RuntimeReadModelError(
          'RuntimeEvent ledger has no terminal fact for a terminal run',
          [
            readModelDiagnostic('incomplete_event', 'terminal run has no terminal RuntimeEvent', {
              runId: run.runId,
              turnId: run.turnId,
            }),
          ],
        );
      }

      const terminalFact = classifyRuntimeEventTerminalFact(run, runEvents);
      diagnostics.push(...terminalFact.diagnostics);
      if (!terminalFact.fact) {
        throw new RuntimeReadModelError(
          'RuntimeEvent ledger has no valid terminal fact for a terminal run',
          diagnostics,
        );
      }
      if (!terminalRunHeaderMatchesFact(run, terminalFact.fact)) {
        diagnostics.push(
          readModelDiagnostic(
            'incomplete_event',
            'terminal run header does not match RuntimeEvent terminal fact',
            {
              runId: run.runId,
              turnId: run.turnId,
              headerStatus: run.status,
              factStatus: terminalFact.fact.runStatus,
              headerFailureClass: run.failureClass,
              factFailureClass: terminalFact.fact.failureClass,
              headerAbortSource: run.abortSource,
              factAbortSource: terminalFact.fact.abortSource,
            },
          ),
        );
      }
      inlineRuns[runIndex] = effectiveRunHeaderFromTerminalFact(run, terminalFact.fact);
      terminalFacts.push(terminalFact.fact);

      for (let eventIndex = 0; eventIndex < runEvents.length; eventIndex += 1) {
        ordered.push({ event: runEvents[eventIndex]!, runIndex, eventIndex });
      }
    }

    ordered.sort(
      (a, b) =>
        a.event.ts - b.event.ts ||
        a.runIndex - b.runIndex ||
        a.eventIndex - b.eventIndex ||
        a.event.id.localeCompare(b.event.id),
    );

    return this.buildView({
      runs: inlineRuns,
      events: ordered.map((item) => item.event),
      diagnostics,
      terminalFacts,
      inFlightTurnIds,
    });
  }

  private async readNonTerminalRunContext(
    sessionId: string,
    run: AgentRunHeader,
  ): Promise<{ events: RuntimeEvent[]; fact?: RuntimeEventTerminalFact } | undefined> {
    let runEvents: RuntimeEvent[];
    try {
      runEvents = await this.deps.runtimeEventStore.readRuntimeEvents(sessionId, run.runId);
    } catch {
      return undefined;
    }
    const fact = classifyRuntimeEventTerminalFact(run, runEvents).fact;
    return {
      events: runEvents,
      ...(fact ? { fact } : {}),
    };
  }

  private async backfillMissingRuntimeEvents(
    sessionId: string,
    run: AgentRunHeader,
  ): Promise<RuntimeEvent[]> {
    if (!this.deps.projectionCache) return [];
    let messages: StoredMessage[];
    try {
      messages = await this.deps.projectionCache.readMessages(sessionId);
    } catch {
      return [];
    }
    return backfillRuntimeEventsFromStoredMessages({ run, messages }).events;
  }

  private async buildView(input: {
    runs: AgentRunHeader[];
    events: RuntimeEvent[];
    diagnostics: RuntimeEventReadModelDiagnostic[];
    terminalFacts?: RuntimeEventTerminalFact[];
    inFlightTurnIds?: ReadonlySet<string>;
  }): Promise<RuntimeReadModelSessionView> {
    const canonicalPermissionRead = await this.readCanonicalPermissionOutcomes(input.events);
    const projected = projectRuntimeEventsToStoredMessages(input.events, {
      runHeaders: input.runs,
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

    const sessionId = input.runs[0]?.sessionId;
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
      runs: input.runs,
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

function isTerminalRunStatus(status: AgentRunHeader['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
