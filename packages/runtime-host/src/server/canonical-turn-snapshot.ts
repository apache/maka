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

import { type ContextCompactionOutcome } from '@maka/core/events';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { redactSecrets } from '@maka/core/redaction';
import { readRunInvocation } from '@maka/core/runtime-event-store';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import { classifyTerminalRuntimeLedger } from '@maka/runtime/terminal-run-commit';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import { TURN_FAILURE_MESSAGE_MAX_BYTES, type TurnSnapshot } from '../protocol/index.js';

type CanonicalTurnStores = Pick<
  ExecutionStoresWriter<'interactive'>,
  'runtimeEventStore' | 'interactionStore' | 'sessionStore'
>;

export interface CanonicalTurnIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
}

export async function readCanonicalTurnSnapshot(
  stores: CanonicalTurnStores,
  identity: CanonicalTurnIdentity,
  knownRun?: RuntimeInvocationRecord,
): Promise<TurnSnapshot> {
  const { sessionId, turnId, runId } = identity;
  const run = knownRun ?? (await readInvocationIfPresent(stores, sessionId, runId));
  if (!run) return { sessionId, turnId, runId, status: 'admitted' };
  if (run.turnId !== turnId) {
    throw new Error('Admitted Turn identity does not match its invocation');
  }

  const runtimeEvents = await stores.runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId);
  const terminal = classifyTerminalRuntimeLedger(run, runtimeEvents);
  if (terminal.kind === 'fact') {
    const fact = terminal.fact;
    if (fact.runStatus === 'completed') {
      const contextCompactionOutcome = readContextCompactionOutcome(
        fact.terminalEvent.actions?.stateDelta?.contextCompactionOutcome,
      );
      return {
        sessionId,
        turnId,
        runId,
        status: 'completed',
        terminalEventId: fact.terminalEvent.id,
        ...(contextCompactionOutcome ? { contextCompactionOutcome } : {}),
      };
    }
    if (fact.runStatus === 'failed') {
      if (!fact.failureClass) throw new Error('Failed terminal fact has no failure class');
      const failureMessage =
        fact.terminalEvent.content?.kind === 'error'
          ? truncateUtf8(
              redactSecrets(fact.terminalEvent.content.message),
              TURN_FAILURE_MESSAGE_MAX_BYTES,
              '…',
            )
          : undefined;
      return {
        sessionId,
        turnId,
        runId,
        status: 'failed',
        terminalEventId: fact.terminalEvent.id,
        failureClass: fact.failureClass,
        ...(failureMessage ? { failureMessage } : {}),
      };
    }
    if (!fact.abortSource) throw new Error('Cancelled terminal fact has no abort source');
    return {
      sessionId,
      turnId,
      runId,
      status: 'cancelled',
      terminalEventId: fact.terminalEvent.id,
      abortSource: fact.abortSource,
    };
  }
  if (terminal.kind !== 'none') {
    throw new Error('Runtime ledger does not contain one canonical terminal fact');
  }
  // No terminal event means the run is still open. Whether it is parked is the
  // pending-interaction store's answer, not something the run restates.
  const parked = await hasPendingInteraction(stores, sessionId, runId);
  return { sessionId, turnId, runId, status: parked ? 'waiting_for_user' : 'running' };
}

/** Is this run waiting on a request the user has not answered? */
async function hasPendingInteraction(
  stores: CanonicalTurnStores,
  sessionId: string,
  runId: string,
): Promise<boolean> {
  const [interactions, boundaries] = await Promise.all([
    stores.interactionStore.listSessionPending(sessionId),
    stores.sessionStore.listPendingSandboxBoundaryRequests(sessionId),
  ]);
  return (
    interactions.some((request) => request.runId === runId) ||
    boundaries.some((request) => request.runId === runId)
  );
}

function readContextCompactionOutcome(value: unknown): ContextCompactionOutcome | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const outcome = value as Record<string, unknown>;
  if (outcome.kind === 'compacted' && typeof outcome.checkpointId === 'string') {
    return { kind: 'compacted', checkpointId: outcome.checkpointId };
  }
  if (
    (outcome.kind === 'unchanged' || outcome.kind === 'failed') &&
    typeof outcome.reason === 'string'
  ) {
    return { kind: outcome.kind, reason: outcome.reason };
  }
  return undefined;
}

/** Maximizes the encoded size of a protocol-valid failed Turn snapshot. */
export function worstCaseFailedTurnSnapshot(identity: CanonicalTurnIdentity): TurnSnapshot {
  return {
    ...identity,
    status: 'failed',
    terminalEventId: 'x'.repeat(128),
    failureClass: '\0'.repeat(128),
    failureMessage: '\0'.repeat(TURN_FAILURE_MESSAGE_MAX_BYTES),
  };
}

async function readInvocationIfPresent(
  stores: CanonicalTurnStores,
  sessionId: string,
  runId: string,
): Promise<RuntimeInvocationRecord | undefined> {
  try {
    return await readRunInvocation(stores.runtimeEventStore, sessionId, runId);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
