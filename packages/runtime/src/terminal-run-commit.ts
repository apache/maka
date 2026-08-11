import { isPartialRuntimeEvent, isTerminalRuntimeEvent } from '@maka/core/runtime-event';
import type {
  AgentRunEvent,
  AgentRunHeader,
  AgentRunEventType,
  AgentRunStore,
} from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import {
  classifyRuntimeEventTerminalFact,
  type RuntimeEventTerminalFact,
} from './runtime-event-read-model.js';

export type TerminalAgentRunStatus = Extract<
  AgentRunHeader['status'],
  'completed' | 'failed' | 'cancelled'
>;

export type TerminalRuntimeLedgerClassification =
  | {
      kind: 'fact';
      fact: RuntimeEventTerminalFact;
      terminalEvents: readonly RuntimeEvent[];
    }
  | {
      kind: 'none';
      terminalEvents: readonly RuntimeEvent[];
    }
  | {
      kind: 'incomplete_single_terminal';
      terminalEvent: RuntimeEvent;
      terminalEvents: readonly RuntimeEvent[];
    }
  | {
      kind: 'ambiguous';
      terminalEvents: readonly RuntimeEvent[];
    };

export function classifyTerminalRuntimeLedger(
  run: AgentRunHeader,
  events: readonly RuntimeEvent[],
): TerminalRuntimeLedgerClassification {
  const terminalEvents = matchingTerminalRuntimeEvents(run, events);
  if (terminalEvents.length === 0) {
    return { kind: 'none', terminalEvents };
  }
  if (terminalEvents.length > 1) {
    return { kind: 'ambiguous', terminalEvents };
  }

  const fact = classifyRuntimeEventTerminalFact(run, events).fact;
  if (fact) {
    return { kind: 'fact', fact, terminalEvents };
  }
  return {
    kind: 'incomplete_single_terminal',
    terminalEvent: terminalEvents[0]!,
    terminalEvents,
  };
}

export interface CommitTerminalRunWithRuntimeFactInput {
  runStore: AgentRunStore;
  runtimeEventStore: RuntimeEventStore;
  newId: () => string;
  sessionId: string;
  runId: string;
  turnId: string;
  status: TerminalAgentRunStatus;
  ts: number;
  terminalEvent: RuntimeEvent;
  failureClass?: string;
  failureMessage?: string;
  traceWriteError?: string;
  abortSource?: string;
  runEventData?: Record<string, unknown>;
  runEventMessage?: string;
  existingEvents?: readonly Pick<AgentRunEvent, 'type'>[];
}

export async function commitTerminalRunWithRuntimeFact(
  input: CommitTerminalRunWithRuntimeFactInput,
): Promise<void> {
  if (isPartialRuntimeEvent(input.terminalEvent)) {
    throw new Error('terminal RuntimeEvent must be final before terminal run header');
  }
  const terminalStatus = terminalRunStatusFromRuntimeEvent(input.terminalEvent);
  if (!terminalStatus) {
    throw new Error('terminal RuntimeEvent must carry a terminal status');
  }
  if (terminalStatus !== input.status) {
    throw new Error(
      `terminal RuntimeEvent status ${input.terminalEvent.status} cannot commit ${input.status} run header`,
    );
  }
  if (
    input.terminalEvent.sessionId !== input.sessionId ||
    input.terminalEvent.runId !== input.runId ||
    input.terminalEvent.turnId !== input.turnId
  ) {
    throw new Error('terminal RuntimeEvent identity does not match run header commit');
  }
  await input.runtimeEventStore.ensureTerminalRuntimeEventDurable(
    input.sessionId,
    input.runId,
    input.terminalEvent,
  );

  await commitTerminalRunProjection(input);
}

async function commitTerminalRunProjection(
  input: CommitTerminalRunWithRuntimeFactInput,
): Promise<void> {
  const failureClass = input.status === 'failed' ? (input.failureClass ?? 'unknown') : undefined;
  const abortSource = input.status === 'cancelled' ? input.abortSource : undefined;
  await input.runStore.updateRun(
    input.sessionId,
    input.runId,
    {
      status: input.status,
      updatedAt: input.ts,
      completedAt: input.ts,
      ...(failureClass ? { failureClass } : {}),
      ...(input.failureMessage ? { failureMessage: input.failureMessage } : {}),
      ...(input.traceWriteError ? { traceWriteError: input.traceWriteError } : {}),
      ...(abortSource ? { abortSource } : {}),
    },
    { durable: true },
  );

  if (hasTerminalAgentRunEvent(input.existingEvents ?? [])) return;
  const data = terminalRunEventData(input.status, failureClass, input.runEventData);
  await input.runStore.appendEvent(
    input.sessionId,
    input.runId,
    {
      type: terminalAgentRunEventType(input.status),
      id: input.newId(),
      runId: input.runId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      ts: input.ts,
      ...(input.runEventMessage ? { message: input.runEventMessage } : {}),
      ...(Object.keys(data).length > 0 ? { data } : {}),
    },
    { durable: true },
  );
}

export interface CommitOrCreateTerminalRunFactInput
  extends Omit<CommitTerminalRunWithRuntimeFactInput, 'status' | 'terminalEvent'> {
  /** Runs after the terminal durability barrier, before the header commit. */
  afterTerminalDurable?: () => Promise<void>;
  terminalEvent?: RuntimeEvent;
  allowHeaderCommitFailure?: boolean;
  fallbackStatus: TerminalAgentRunStatus;
  fallbackInvocationId: string;
  fallbackFailureClass?: string;
  fallbackFailureMessage?: string;
}

export interface CommitOrCreateTerminalRunFactResult {
  terminalEvent: RuntimeEvent;
  status: TerminalAgentRunStatus;
  failureClass?: string;
  createdTerminalEvent: boolean;
  headerCommitted: boolean;
  headerCommitError?: unknown;
}

export async function commitOrCreateTerminalRunFact(
  input: CommitOrCreateTerminalRunFactInput,
): Promise<CommitOrCreateTerminalRunFactResult> {
  const createdTerminalEvent = !input.terminalEvent;
  const effectiveAbortSource =
    input.fallbackStatus === 'cancelled' ? (input.abortSource ?? 'user_stop') : input.abortSource;
  const terminalEvent =
    input.terminalEvent ??
    buildSyntheticTerminalRuntimeEvent({
      id: input.newId(),
      invocationId: input.fallbackInvocationId,
      run: {
        sessionId: input.sessionId,
        runId: input.runId,
        turnId: input.turnId,
      },
      status: input.fallbackStatus,
      ts: input.ts,
      ...(input.fallbackFailureClass ? { failureClass: input.fallbackFailureClass } : {}),
      ...(effectiveAbortSource ? { abortSource: effectiveAbortSource } : {}),
      ...((input.fallbackFailureMessage ?? input.failureMessage)
        ? { message: input.fallbackFailureMessage ?? input.failureMessage }
        : {}),
    });
  const status = terminalRunStatusFromRuntimeEvent(terminalEvent);
  if (!status) {
    throw new Error('terminal RuntimeEvent must carry a terminal status');
  }
  if (isPartialRuntimeEvent(terminalEvent)) {
    throw new Error('terminal RuntimeEvent must be final before terminal run header');
  }
  if (
    terminalEvent.sessionId !== input.sessionId ||
    terminalEvent.runId !== input.runId ||
    terminalEvent.turnId !== input.turnId
  ) {
    throw new Error('terminal RuntimeEvent identity does not match run header commit');
  }
  const failureClass =
    status === 'failed'
      ? (runtimeEventFailureClass(terminalEvent) ?? input.failureClass ?? 'unknown')
      : undefined;
  await input.runtimeEventStore.ensureTerminalRuntimeEventDurable(
    input.sessionId,
    input.runId,
    terminalEvent,
  );
  // Between the terminal durability barrier and the header commit: the one
  // point where "the terminal fact is durable" is true and nothing else has
  // been projected yet. Callers that must order a crash boundary against
  // the barrier itself hang it here (#2313 corruption recovery, where the
  // claimed event's own write never ran).
  await input.afterTerminalDurable?.();
  let headerCommitted = false;
  let headerCommitError: unknown;
  try {
    await commitTerminalRunProjection({
      ...input,
      terminalEvent,
      status,
      ...(failureClass ? { failureClass } : {}),
      ...(effectiveAbortSource ? { abortSource: effectiveAbortSource } : {}),
    });
    headerCommitted = true;
  } catch (error) {
    if (!input.allowHeaderCommitFailure) throw error;
    headerCommitError = error;
  }
  return {
    terminalEvent,
    status,
    ...(failureClass ? { failureClass } : {}),
    createdTerminalEvent,
    headerCommitted,
    ...(headerCommitError !== undefined ? { headerCommitError } : {}),
  };
}

export interface BuildSyntheticTerminalRuntimeEventInput {
  id: string;
  invocationId: string;
  run: Pick<AgentRunHeader, 'runId' | 'sessionId' | 'turnId'>;
  status: TerminalAgentRunStatus;
  ts: number;
  failureClass?: string;
  abortSource?: string;
  recoveryReason?: string;
  diagnostic?: Record<string, unknown>;
  message?: string;
}

export function buildSyntheticTerminalRuntimeEvent(
  input: BuildSyntheticTerminalRuntimeEventInput,
): RuntimeEvent {
  const failureClass = input.status === 'failed' ? (input.failureClass ?? 'unknown') : undefined;
  const abortSource = input.status === 'cancelled' ? input.abortSource : undefined;
  return {
    id: input.id,
    invocationId: input.invocationId,
    runId: input.run.runId,
    sessionId: input.run.sessionId,
    turnId: input.run.turnId,
    ts: input.ts,
    partial: false,
    role: 'system',
    author: 'system',
    status: input.status === 'cancelled' ? 'aborted' : input.status,
    ...(failureClass
      ? {
          content: {
            kind: 'error',
            code: failureClass,
            reason: failureClass,
            message: input.message ?? failureClass,
          },
        }
      : {}),
    actions: {
      endInvocation: true,
      stateDelta: {
        ...(input.recoveryReason ? { recovered: true, recoveryReason: input.recoveryReason } : {}),
        ...(input.diagnostic ?? {}),
        ...(failureClass ? { failureClass } : {}),
        ...(abortSource ? { abortSource } : {}),
      },
    },
  };
}

export interface BuildRecoveredTerminalRuntimeEventInput {
  id: string;
  run: Pick<AgentRunHeader, 'runId' | 'sessionId' | 'turnId' | 'invocationId'>;
  status: TerminalAgentRunStatus;
  ts: number;
  invocationId?: string;
  failureClass?: string;
  abortSource?: string;
  recoveryReason: string;
  diagnostic?: Record<string, unknown>;
  message?: string;
}

export function buildRecoveredTerminalRuntimeEvent(
  input: BuildRecoveredTerminalRuntimeEventInput,
): RuntimeEvent {
  return buildSyntheticTerminalRuntimeEvent({
    id: input.id,
    invocationId: input.run.invocationId ?? input.invocationId ?? `recovery-${input.run.runId}`,
    run: input.run,
    ts: input.ts,
    status: input.status,
    ...(input.failureClass ? { failureClass: input.failureClass } : {}),
    ...(input.status === 'cancelled' ? { abortSource: input.abortSource ?? 'unknown' } : {}),
    recoveryReason: input.recoveryReason,
    ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
    ...(input.message ? { message: input.message } : {}),
  });
}

export function hasTerminalAgentRunEvent(events: readonly Pick<AgentRunEvent, 'type'>[]): boolean {
  return events.some(
    (event) =>
      event.type === 'run_completed' ||
      event.type === 'run_failed' ||
      event.type === 'run_cancelled',
  );
}

function terminalAgentRunEventType(status: TerminalAgentRunStatus): AgentRunEventType {
  if (status === 'cancelled') return 'run_cancelled';
  if (status === 'failed') return 'run_failed';
  return 'run_completed';
}

function terminalRunEventData(
  status: TerminalAgentRunStatus,
  failureClass: string | undefined,
  runEventData: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...(status === 'failed' && failureClass ? { failureClass } : {}),
    ...(runEventData ?? {}),
  };
}

function runtimeEventFailureClass(event: RuntimeEvent): string | undefined {
  const stateDelta = event.actions?.stateDelta;
  if (typeof stateDelta?.failureClass === 'string' && stateDelta.failureClass.length > 0) {
    return stateDelta.failureClass;
  }
  if (event.content?.kind === 'error') {
    return event.content.code ?? event.content.reason;
  }
  return undefined;
}

export function terminalRunStatusFromRuntimeEvent(
  event: RuntimeEvent,
): TerminalAgentRunStatus | undefined {
  if (event.status === 'completed') return 'completed';
  if (event.status === 'failed') return 'failed';
  if (event.status === 'aborted' || event.status === 'cancelled') return 'cancelled';
  return undefined;
}

export function effectiveRunHeaderFromTerminalFact(
  run: AgentRunHeader,
  fact: RuntimeEventTerminalFact,
): AgentRunHeader {
  const completedAt = run.completedAt ?? fact.terminalEvent.ts;
  const base = { ...run };
  delete base.failureClass;
  delete base.failureMessage;
  delete base.abortSource;
  return {
    ...base,
    status: fact.runStatus,
    updatedAt: Math.max(run.updatedAt, completedAt),
    completedAt,
    ...(fact.runStatus === 'failed' && fact.failureClass
      ? { failureClass: fact.failureClass }
      : {}),
    ...(fact.runStatus === 'failed' && run.failureMessage
      ? { failureMessage: run.failureMessage }
      : {}),
    ...(fact.runStatus === 'cancelled' && fact.abortSource
      ? { abortSource: fact.abortSource }
      : {}),
  };
}

export function terminalRunHeaderMatchesFact(
  run: AgentRunHeader,
  fact: RuntimeEventTerminalFact,
): boolean {
  if (run.status !== fact.runStatus) return false;
  if (fact.runStatus === 'failed' && run.failureClass !== fact.failureClass) return false;
  if (fact.runStatus === 'cancelled' && run.abortSource !== fact.abortSource) return false;
  return true;
}

export function matchingTerminalRuntimeEvents(
  run: AgentRunHeader,
  events: readonly RuntimeEvent[],
): RuntimeEvent[] {
  return events.filter(
    (event) =>
      !isPartialRuntimeEvent(event) &&
      event.sessionId === run.sessionId &&
      event.runId === run.runId &&
      event.turnId === run.turnId &&
      isTerminalRuntimeEvent(event),
  );
}
