import { isSessionInlineRun, isTerminalRuntimeEvent } from '@maka/core';
import type { AgentRunHeader, AgentRunStore, RuntimeEvent, RuntimeEventStore } from '@maka/core';
import type { StoredMessage, TurnRecord } from '@maka/core/session';
import type { AgentRunLineage } from './agent-run.js';
import { backfillRuntimeEventsFromStoredMessages } from './runtime-event-backfill.js';
import { projectRuntimeEventUserMessage } from './runtime-event-read-model.js';
import {
  buildRecoveredTerminalRuntimeEvent,
  commitTerminalRunWithRuntimeFact,
} from './terminal-run-commit.js';

export interface RuntimeLedgerRepairDeps {
  runStore: AgentRunStore;
  runtimeEventStore: RuntimeEventStore;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  appendMessage(sessionId: string, message: StoredMessage): Promise<void>;
  appendTurnState(
    sessionId: string,
    turnId: string,
    status: TurnRecord['status'],
    lineage?: AgentRunLineage,
    options?: { ts?: number; errorClass?: string; abortSource?: string },
  ): Promise<void>;
  newId: () => string;
  now: () => number;
}

interface RuntimeEventTranscriptProjectionDeps {
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  appendMessage(sessionId: string, message: StoredMessage): Promise<void>;
}

export async function materializeRuntimeEventTranscriptProjection(
  deps: RuntimeEventTranscriptProjectionDeps,
  sessionId: string,
  event: RuntimeEvent,
  knownMessageIds?: Set<string>,
): Promise<boolean> {
  const message = steeringMessageFromRuntimeEvent(event);
  if (!message) return false;
  const messageIds =
    knownMessageIds ?? new Set((await deps.readMessages(sessionId)).map((item) => item.id));
  if (messageIds.has(message.id)) return false;
  await deps.appendMessage(sessionId, message);
  messageIds.add(message.id);
  return true;
}

export class RuntimeLedgerRepair {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: RuntimeLedgerRepairDeps) {}

  async repairMissingTerminalFactOnce(sessionId: string, runId: string): Promise<boolean> {
    const run = await this.deps.runStore.readRun(sessionId, runId).catch(() => undefined);
    if (!run) return false;
    return this.repairRunTerminalFact(sessionId, run);
  }

  async repairSteeringMessagesOnce(sessionId: string): Promise<number> {
    return this.withRepairQueue(sessionId, 'steering-transcript', async () => {
      const messages = await this.deps.readMessages(sessionId);
      const messageIds = new Set(messages.map((message) => message.id));
      const inlineRunIds = new Set(
        (await this.deps.runStore.listSessionRuns(sessionId))
          .filter(isSessionInlineRun)
          .map((run) => run.runId),
      );
      let repaired = 0;
      for (const event of await this.deps.runtimeEventStore.readSessionRuntimeEvents(sessionId)) {
        if (!inlineRunIds.has(event.runId)) continue;
        if (
          await materializeRuntimeEventTranscriptProjection(this.deps, sessionId, event, messageIds)
        ) {
          repaired += 1;
        }
      }
      return repaired;
    });
  }

  private async repairRunTerminalFact(
    sessionId: string,
    staleRun: AgentRunHeader,
  ): Promise<boolean> {
    return this.withRepairQueue(sessionId, staleRun.runId, async () => {
      const run = await this.deps.runStore.readRun(sessionId, staleRun.runId).catch(() => staleRun);
      if (!isTerminalRunStatus(run.status)) return false;
      let runtimeEvents: RuntimeEvent[];
      try {
        runtimeEvents = await this.deps.runtimeEventStore.readRuntimeEvents(sessionId, run.runId);
      } catch {
        return false;
      }

      let messages: StoredMessage[];
      try {
        messages = await this.deps.readMessages(sessionId);
      } catch {
        return false;
      }
      const recovered = backfillRuntimeEventsFromStoredMessages({
        run,
        messages,
        invocationId: runtimeEvents[0]?.invocationId,
        newId: this.deps.newId,
        now: this.deps.now,
      }).events;
      const recoveredTerminal = recovered.find((event) =>
        isMatchingTerminalRuntimeEvent(run, event),
      );
      const legacyTerminal = latestTurnState(messages, run.turnId);
      const canTrustRecoveredTerminal = recoveredTerminal
        ? isTrustworthyRecoveredTerminal(run, legacyTerminal, recoveredTerminal)
        : false;
      const recoveredEventsToPersist = canTrustRecoveredTerminal
        ? recovered
        : recovered.filter((event) => !isMatchingTerminalRuntimeEvent(run, event));
      const eventsToAppend = missingRecoveredRuntimeEvents(
        run,
        runtimeEvents,
        recoveredEventsToPersist,
      );
      for (const event of eventsToAppend) {
        await this.deps.runtimeEventStore.appendRuntimeEvent(sessionId, run.runId, event);
      }

      const existingTerminal = [...runtimeEvents, ...eventsToAppend].find((event) =>
        isMatchingTerminalRuntimeEvent(run, event),
      );
      if (existingTerminal) {
        return (
          (await this.repairRunHeaderFromExistingTerminal(
            sessionId,
            run,
            messages,
            legacyTerminal,
            existingTerminal,
          )) || eventsToAppend.length > 0
        );
      }

      await this.repairMissingTerminalAsFailed(sessionId, run, messages, [
        ...runtimeEvents,
        ...eventsToAppend,
      ]);
      return true;
    });
  }

  private async repairRunHeaderFromExistingTerminal(
    sessionId: string,
    run: AgentRunHeader,
    messages: readonly StoredMessage[],
    turnState: Extract<StoredMessage, { type: 'turn_state' }> | undefined,
    terminal: RuntimeEvent,
  ): Promise<boolean> {
    const status = terminalRunStatusFromEvent(run, terminal);
    if (!status) return false;
    const ts = run.completedAt ?? terminal.ts ?? run.updatedAt ?? this.deps.now();
    const failureClass =
      status === 'failed'
        ? (failureClassFromExistingTerminal(terminal) ??
          (turnState?.status === 'failed' ? turnState.errorClass : undefined) ??
          'missing_terminal_event')
        : undefined;
    const abortSource =
      status === 'cancelled'
        ? (abortSourceFromExistingTerminal(terminal) ??
          (turnState?.status === 'aborted' ? turnState.abortSource : undefined) ??
          'unknown')
        : undefined;
    const existingEvents = await this.deps.runStore
      .readEvents(sessionId, run.runId)
      .catch(() => []);
    await commitTerminalRunWithRuntimeFact({
      runStore: this.deps.runStore,
      runtimeEventStore: this.deps.runtimeEventStore,
      newId: this.deps.newId,
      sessionId,
      runId: run.runId,
      turnId: run.turnId,
      status,
      ts,
      terminalEvent: terminal,
      ...(failureClass ? { failureClass } : {}),
      ...(abortSource ? { abortSource } : {}),
      runEventData: {
        recovered: true,
        recoveryReason: 'runtime_event_terminal_fact',
        runtimeEventId: terminal.id,
        runtimeEventStatus: terminal.status,
      },
      existingEvents,
    });
    await this.appendTerminalTurnStateIfNeeded(
      sessionId,
      messages,
      run,
      {
        runId: run.runId,
        turnId: run.turnId,
        status,
        ...(failureClass ? { failureClass } : {}),
        diagnostic: { recoveryReason: 'runtime_event_terminal_fact', runtimeEventId: terminal.id },
        lineage: headerLineage(run),
      },
      terminalTurnStatus(status),
      {
        ts,
        ...(failureClass ? { errorClass: failureClass } : {}),
        ...(abortSource ? { abortSource } : {}),
      },
    ).catch(() => {});
    return true;
  }

  private async withRepairQueue<T>(
    sessionId: string,
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${sessionId}:${runId}`;
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

  private async repairMissingTerminalAsFailed(
    sessionId: string,
    run: AgentRunHeader,
    messages: readonly StoredMessage[],
    runtimeEvents: readonly RuntimeEvent[],
  ): Promise<void> {
    const ts = run.completedAt ?? run.updatedAt ?? this.deps.now();
    const failureClass = 'missing_terminal_event';
    const terminalEvent = buildRecoveredTerminalRuntimeEvent({
      id: this.deps.newId(),
      run,
      status: 'failed',
      ts,
      invocationId: runtimeEvents[0]?.invocationId ?? `recovery-${run.runId}`,
      failureClass,
      recoveryReason: failureClass,
      message: 'terminal run header had no terminal RuntimeEvent',
    });
    const existingEvents = await this.deps.runStore
      .readEvents(sessionId, run.runId)
      .catch(() => []);
    await commitTerminalRunWithRuntimeFact({
      runStore: this.deps.runStore,
      runtimeEventStore: this.deps.runtimeEventStore,
      newId: this.deps.newId,
      sessionId,
      runId: run.runId,
      turnId: run.turnId,
      status: 'failed',
      ts,
      terminalEvent,
      failureClass,
      runEventData: { recovered: true, recoveryReason: failureClass },
      existingEvents,
    });
    await this.appendTerminalTurnStateIfNeeded(
      sessionId,
      messages,
      run,
      {
        runId: run.runId,
        turnId: run.turnId,
        status: 'failed',
        failureClass,
        diagnostic: { recoveryReason: failureClass },
        lineage: headerLineage(run),
      },
      'failed',
      { ts, errorClass: failureClass },
    ).catch(() => {});
  }

  private async appendTerminalTurnStateIfNeeded(
    sessionId: string,
    messages: readonly StoredMessage[],
    run: AgentRunHeader,
    decision: RuntimeLedgerRepairDecision,
    status: TurnRecord['status'],
    options: { ts: number; errorClass?: string; abortSource?: string },
  ): Promise<void> {
    if (!isSessionInlineRun(run)) return;
    const latest = latestTurnState(messages, decision.turnId);
    if (latest && isTerminalTurnStatus(latest.status) && latest.status === status) return;
    await this.deps.appendTurnState(sessionId, decision.turnId, status, decision.lineage, options);
  }
}

interface RuntimeLedgerRepairDecision {
  runId: string;
  turnId: string;
  status: AgentRunHeader['status'];
  failureClass?: string;
  diagnostic: Record<string, unknown>;
  lineage: AgentRunLineage;
}

export function firstRuntimeRepairRunId(
  diagnostics: readonly { code: string; message: string; runId?: string; detail?: unknown }[],
  alreadyRepaired: ReadonlySet<string> = new Set(),
): string | undefined {
  for (const diagnostic of diagnostics) {
    const runId = diagnostic.runId ?? diagnosticDetailRunId(diagnostic.detail);
    if (!runId || alreadyRepaired.has(runId)) continue;
    if (diagnostic.code !== 'incomplete_event') continue;
    if (
      diagnostic.message === 'terminal run recovered from legacy projection cache' ||
      diagnostic.message === 'terminal run has no readable RuntimeEvent ledger' ||
      diagnostic.message === 'terminal run has no terminal RuntimeEvent' ||
      diagnostic.message === 'terminal run header does not match RuntimeEvent terminal fact' ||
      diagnostic.message === 'failed terminal RuntimeEvent requires a stable failure class' ||
      diagnostic.message ===
        'failed terminal event did not carry an exact AgentRunHeader.failureClass' ||
      diagnostic.message === 'aborted terminal RuntimeEvent requires an abort source' ||
      diagnostic.message === 'abortSource is not present in RuntimeEvent or AgentRunHeader metadata'
    ) {
      return runId;
    }
  }
  return undefined;
}

function diagnosticDetailRunId(detail: unknown): string | undefined {
  if (!detail || typeof detail !== 'object') return undefined;
  const runId = (detail as { runId?: unknown }).runId;
  return typeof runId === 'string' && runId.length > 0 ? runId : undefined;
}

function isTerminalRunStatus(status: AgentRunHeader['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function steeringMessageFromRuntimeEvent(event: RuntimeEvent): StoredMessage | undefined {
  const messageId = event.refs?.providerEventId;
  if (
    event.role !== 'user' ||
    event.content?.kind !== 'text' ||
    event.content.steering !== true ||
    typeof messageId !== 'string' ||
    messageId.length === 0
  ) {
    return undefined;
  }
  return projectRuntimeEventUserMessage(event, messageId);
}

function isTerminalTurnStatus(status: TurnRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted';
}

function terminalRunStatusFromEvent(
  run: AgentRunHeader,
  event: RuntimeEvent,
): 'completed' | 'failed' | 'cancelled' | undefined {
  if (event.status === 'completed') return 'completed';
  if (event.status === 'failed') return 'failed';
  if (event.status === 'aborted' || event.status === 'cancelled') return 'cancelled';
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled')
    return run.status;
  return undefined;
}

function terminalTurnStatus(status: 'completed' | 'failed' | 'cancelled'): TurnRecord['status'] {
  if (status === 'cancelled') return 'aborted';
  return status;
}

function isMatchingTerminalRuntimeEvent(run: AgentRunHeader, event: RuntimeEvent): boolean {
  return (
    !event.partial &&
    event.sessionId === run.sessionId &&
    event.runId === run.runId &&
    event.turnId === run.turnId &&
    (run.invocationId === undefined || event.invocationId === run.invocationId) &&
    isTerminalRuntimeEvent(event)
  );
}

function missingRecoveredRuntimeEvents(
  run: AgentRunHeader,
  existing: readonly RuntimeEvent[],
  recovered: readonly RuntimeEvent[],
): RuntimeEvent[] {
  const recoveredEventKeys = new Set(
    existing.map(recoveredEventKey).filter((key): key is string => key !== undefined),
  );
  const hasTerminal = existing.some((event) => isMatchingTerminalRuntimeEvent(run, event));
  const matchedExistingEventIndexes = new Set<number>();
  const missing: RuntimeEvent[] = [];
  for (const event of recovered) {
    if (isMatchingTerminalRuntimeEvent(run, event)) {
      if (!hasTerminal) missing.push(event);
      continue;
    }
    const eventKey = recoveredEventKey(event);
    if (!eventKey) continue;
    if (recoveredEventKeys.has(eventKey)) continue;
    recoveredEventKeys.add(eventKey);
    const existingIndex = existing.findIndex(
      (candidate, index) =>
        !matchedExistingEventIndexes.has(index) && isSameRecoveredRuntimeEvent(candidate, event),
    );
    if (existingIndex >= 0) {
      matchedExistingEventIndexes.add(existingIndex);
    } else {
      missing.push(event);
    }
  }
  return missing;
}

function recoveredEventKey(event: RuntimeEvent): string | undefined {
  const storedMessageId = event.refs?.storedMessageId;
  if (typeof storedMessageId !== 'string' || storedMessageId.length === 0) return undefined;
  return JSON.stringify({
    storedMessageId,
    role: event.role,
    author: event.author,
    status: event.status,
    content: event.content,
    toolCallId: event.refs?.toolCallId,
    tokenUsage: event.actions?.tokenUsage,
    permissionDecision: event.actions?.permissionDecision,
  });
}

function failureClassFromExistingTerminal(event: RuntimeEvent): string | undefined {
  return (
    stringStateDelta(event, 'failureClass') ??
    stringStateDelta(event, 'errorClass') ??
    stringStateDelta(event, 'reason') ??
    stringStateDelta(event, 'code') ??
    (event.content?.kind === 'error' ? nonEmptyString(event.content.reason) : undefined) ??
    (event.content?.kind === 'error' ? nonEmptyString(event.content.code) : undefined)
  );
}

function abortSourceFromExistingTerminal(event: RuntimeEvent): string | undefined {
  return (
    stringStateDelta(event, 'abortSource') ??
    stringStateDelta(event, 'source') ??
    stringRecordValue(event.refs, 'abortSource') ??
    stringRecordValue(event.refs, 'source')
  );
}

function stringStateDelta(event: RuntimeEvent, key: string): string | undefined {
  const value = event.actions?.stateDelta?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringRecordValue(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result = (value as Record<string, unknown>)[key];
  return typeof result === 'string' && result.length > 0 ? result : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isSameRecoveredRuntimeEvent(existing: RuntimeEvent, recovered: RuntimeEvent): boolean {
  return (
    !existing.partial &&
    existing.sessionId === recovered.sessionId &&
    existing.runId === recovered.runId &&
    existing.turnId === recovered.turnId &&
    existing.role === recovered.role &&
    existing.author === recovered.author &&
    existing.status === recovered.status &&
    JSON.stringify(existing.content) === JSON.stringify(recovered.content) &&
    JSON.stringify(existing.actions?.tokenUsage) ===
      JSON.stringify(recovered.actions?.tokenUsage) &&
    JSON.stringify(existing.actions?.permissionDecision) ===
      JSON.stringify(recovered.actions?.permissionDecision)
  );
}

function isTrustworthyRecoveredTerminal(
  run: AgentRunHeader,
  turnState: Extract<StoredMessage, { type: 'turn_state' }> | undefined,
  terminal: RuntimeEvent,
): boolean {
  if (!turnState || !isTerminalTurnStatus(turnState.status)) return false;
  if (terminal.status === 'completed') {
    return run.status === 'completed' && turnState.status === 'completed';
  }
  if (terminal.status === 'failed') {
    return (
      run.status === 'failed' &&
      turnState.status === 'failed' &&
      (!run.failureClass || !turnState.errorClass || turnState.errorClass === run.failureClass)
    );
  }
  if (terminal.status === 'aborted' || terminal.status === 'cancelled') {
    return run.status === 'cancelled' && turnState.status === 'aborted';
  }
  return false;
}

function latestTurnState(
  messages: readonly StoredMessage[],
  turnId: string,
): Extract<StoredMessage, { type: 'turn_state' }> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'turn_state' && message.turnId === turnId) return message;
  }
  return undefined;
}

function headerLineage(header: AgentRunHeader): AgentRunLineage {
  return {
    ...(header.parentRunId ? { parentRunId: header.parentRunId } : {}),
    ...(header.resumedFromRunId ? { resumedFromRunId: header.resumedFromRunId } : {}),
    ...(header.retriedFromRunId ? { retriedFromRunId: header.retriedFromRunId } : {}),
    ...(header.parentTurnId ? { parentTurnId: header.parentTurnId } : {}),
    ...(header.retriedFromTurnId ? { retriedFromTurnId: header.retriedFromTurnId } : {}),
    ...(header.regeneratedFromTurnId
      ? { regeneratedFromTurnId: header.regeneratedFromTurnId }
      : {}),
    ...(header.branchOfTurnId ? { branchOfTurnId: header.branchOfTurnId } : {}),
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
  };
}
