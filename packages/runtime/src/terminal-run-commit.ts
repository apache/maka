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

import { isPartialRuntimeEvent, isTerminalRuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import {
  buildSyntheticTerminalRuntimeEvent,
  type RuntimeInvocationOutcome,
} from '@maka/core/runtime-invocation';
import {
  classifyRuntimeEventTerminalFact,
  type RuntimeEventTerminalFact,
} from './runtime-event-read-model.js';

/** The three ids every RuntimeEvent of one run carries. */
export interface RunIdentity {
  sessionId: string;
  runId: string;
  turnId: string;
}

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
      /**
       * More than one terminal event. Nothing ambiguous about it: a store seals
       * a run on its first terminal, so a second one means the ledger was
       * written around that seal and is corrupt.
       */
      kind: 'corrupt';
      terminalEvents: readonly RuntimeEvent[];
    };

export function classifyTerminalRuntimeLedger(
  run: RunIdentity,
  events: readonly RuntimeEvent[],
): TerminalRuntimeLedgerClassification {
  const terminalEvents = matchingTerminalRuntimeEvents(run, events);
  if (terminalEvents.length === 0) {
    return { kind: 'none', terminalEvents };
  }
  if (terminalEvents.length > 1) {
    return { kind: 'corrupt', terminalEvents };
  }

  const fact = classifyRuntimeEventTerminalFact(run, events).fact;
  if (fact) {
    return { kind: 'fact', fact, terminalEvents };
  }
  // The one terminal event carries no terminal status, so it ends the stream
  // without ending the run.
  return { kind: 'none', terminalEvents };
}

export interface CommitTerminalRunWithRuntimeFactInput extends RunIdentity {
  runtimeEventStore: RuntimeEventStore;
  newId: () => string;
  status: RuntimeInvocationOutcome;
  ts: number;
  terminalEvent: RuntimeEvent;
  failureClass?: string;
  failureMessage?: string;
  abortSource?: string;
}

/**
 * Put one run's ending beyond doubt: the terminal RuntimeEvent, on stable
 * storage, and nothing else.
 *
 * There is no projection to commit alongside it any more. The event states the
 * outcome, the failure class and the abort source, so a second record could only
 * ever disagree with it.
 */
export async function commitTerminalRunWithRuntimeFact(
  input: CommitTerminalRunWithRuntimeFactInput,
): Promise<void> {
  assertCommittableTerminalEvent(input.terminalEvent, input, input.status);
  await input.runtimeEventStore.ensureTerminalRuntimeEventDurable(
    input.sessionId,
    input.runId,
    input.terminalEvent,
  );
}

export interface CommitOrCreateTerminalRunFactInput
  extends Omit<CommitTerminalRunWithRuntimeFactInput, 'status' | 'terminalEvent'> {
  /** Runs after the terminal durability barrier. */
  afterTerminalDurable?: () => Promise<void>;
  terminalEvent?: RuntimeEvent;
  fallbackStatus: RuntimeInvocationOutcome;
  fallbackInvocationId: string;
  fallbackFailureClass?: string;
  fallbackFailureMessage?: string;
}

export interface CommitOrCreateTerminalRunFactResult {
  terminalEvent: RuntimeEvent;
  status: RuntimeInvocationOutcome;
  failureClass?: string;
  createdTerminalEvent: boolean;
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
      run: input,
      status: input.fallbackStatus,
      ts: input.ts,
      ...(input.fallbackFailureClass ? { failureClass: input.fallbackFailureClass } : {}),
      ...(effectiveAbortSource ? { abortSource: effectiveAbortSource } : {}),
      ...((input.fallbackFailureMessage ?? input.failureMessage)
        ? { message: input.fallbackFailureMessage ?? input.failureMessage }
        : {}),
    });
  const status = assertCommittableTerminalEvent(terminalEvent, input);
  const failureClass =
    status === 'failed'
      ? (runtimeEventFailureClass(terminalEvent) ?? input.failureClass ?? 'unknown')
      : undefined;
  await input.runtimeEventStore.ensureTerminalRuntimeEventDurable(
    input.sessionId,
    input.runId,
    terminalEvent,
  );
  // The one point where "the terminal fact is durable" is true and nothing has
  // read it yet. Callers that must order a crash boundary against the barrier
  // itself hang it here (#2313 corruption recovery, where the claimed event's
  // own write never ran).
  await input.afterTerminalDurable?.();
  return {
    terminalEvent,
    status,
    ...(failureClass ? { failureClass } : {}),
    createdTerminalEvent,
  };
}

function assertCommittableTerminalEvent(
  event: RuntimeEvent,
  identity: RunIdentity,
  expected?: RuntimeInvocationOutcome,
): RuntimeInvocationOutcome {
  if (isPartialRuntimeEvent(event)) {
    throw new Error('terminal RuntimeEvent must be final before it is committed');
  }
  const status = terminalRunStatusFromRuntimeEvent(event);
  if (!status) {
    throw new Error('terminal RuntimeEvent must carry a terminal status');
  }
  if (expected !== undefined && status !== expected) {
    throw new Error(`terminal RuntimeEvent status ${event.status} cannot commit a ${expected} run`);
  }
  if (
    event.sessionId !== identity.sessionId ||
    event.runId !== identity.runId ||
    event.turnId !== identity.turnId
  ) {
    throw new Error('terminal RuntimeEvent identity does not match the run it ends');
  }
  return status;
}

export interface BuildRecoveredTerminalRuntimeEventInput {
  id: string;
  run: RunIdentity & { invocationId?: string };
  status: RuntimeInvocationOutcome;
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
): RuntimeInvocationOutcome | undefined {
  if (event.status === 'completed') return 'completed';
  if (event.status === 'failed') return 'failed';
  if (event.status === 'aborted' || event.status === 'cancelled') return 'cancelled';
  return undefined;
}

export function matchingTerminalRuntimeEvents(
  run: RunIdentity,
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
