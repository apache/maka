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

import {
  SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS,
  isSandboxBoundaryRestartClosure,
} from '@maka/core/sandbox-boundary';
import type { AgentRunEvent } from '@maka/core/agent-run';
import type { RuntimeInvocationLineage } from '@maka/core/runtime-event';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import type { SandboxBoundaryRequest } from '@maka/core/sandbox-boundary';

export interface AgentRunRecoveryDecision {
  runId: string;
  turnId: string;
  status: 'failed' | 'completed' | 'cancelled';
  failureClass?: string;
  abortSource?: string;
  diagnostic?: Record<string, unknown>;
  lineage: AgentRunRecoveryLineage;
}

type AgentRunRecoveryLineage = Pick<
  RuntimeInvocationLineage,
  | 'parentRunId'
  | 'parentTurnId'
  | 'retriedFromTurnId'
  | 'regeneratedFromTurnId'
  | 'branchOfTurnId'
  | 'parentSessionId'
>;

/**
 * Why a run the events never closed has to be failed closed.
 *
 * The caller has already established that there is no terminal event, so the
 * outcome is settled before this runs. All that is left is to say what the run
 * was doing when the host went away, and only its own ledger can say that.
 */
export function classifyAgentRunRecovery(
  invocation: RuntimeInvocationRecord,
  events: readonly AgentRunEvent[],
): AgentRunRecoveryDecision {
  const lastEvent = lastNonCorruptEvent(events);
  const hasCorruptEvent = events.some((event) => event.type === 'event_corrupt');
  const lastEventType = lastEvent?.type;

  const reason =
    lastEventType === 'model_stream_completed'
      ? 'model_stream_completed_without_runtime_terminal'
      : lastEventType === 'permission_requested' || lastEventType === 'permission_failed'
        ? 'stale_user_wait'
        : lastEventType === 'tool_started'
          ? 'tool_interrupted'
          : lastEventType === undefined ||
              lastEventType === 'turn_started' ||
              lastEventType === 'model_resolved' ||
              lastEventType === 'model_stream_started'
            ? 'run_interrupted'
            : 'non_terminal_run_recovered';

  return failedDecision(
    invocation,
    'app_restarted',
    diagnostic(reason, lastEventType, hasCorruptEvent),
  );
}

/**
 * Re-attribute a recovered failure to the sandbox boundary requests a host
 * restart closed against this run.
 *
 * `closures` come straight from the durable request rows, which carry their own
 * turn and run provenance. That is the whole point: the row is written before
 * the matching RuntimeEvent (whose append is fail-open), and it stays readable
 * across any number of interrupted recovery attempts, so neither a lost ledger
 * event nor a recovery that died mid-way can break the link.
 *
 * A closure claims a run by `runId` when it has one — a turn can own several
 * runs — and falls back to `turnId` only for rows created before run identity
 * was recorded. A closure with no provenance at all attributes nothing.
 */
export function attributeSandboxBoundaryRestartClosure(
  decision: AgentRunRecoveryDecision,
  closures: readonly SandboxBoundaryRequest[],
): AgentRunRecoveryDecision {
  if (decision.status !== 'failed') return decision;
  const matched = closures.filter(
    (closure) =>
      isSandboxBoundaryRestartClosure(closure) &&
      (closure.runId !== undefined
        ? closure.runId === decision.runId
        : closure.turnId !== undefined && closure.turnId === decision.turnId),
  );
  if (matched.length === 0) return decision;
  return {
    ...decision,
    failureClass: SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS,
    diagnostic: {
      ...decision.diagnostic,
      sandboxBoundaryClosureReason: 'host_restarted',
      sandboxBoundaryRequestIds: matched.map((closure) => closure.requestId),
    },
  };
}

function failedDecision(
  invocation: RuntimeInvocationRecord,
  failureClass: string,
  diagnostic?: Record<string, unknown>,
): AgentRunRecoveryDecision {
  return {
    runId: invocation.runId,
    turnId: invocation.turnId,
    status: 'failed',
    failureClass,
    diagnostic,
    lineage: openingLineage(invocation),
  };
}

function lastNonCorruptEvent(events: readonly AgentRunEvent[]): AgentRunEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type !== 'event_corrupt') return event;
  }
  return undefined;
}

function diagnostic(
  reason: string,
  lastEventType: AgentRunEvent['type'] | undefined,
  hasCorruptEvent: boolean,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    recoveryReason: reason,
    ...(lastEventType ? { lastEventType } : {}),
    ...(hasCorruptEvent ? { eventCorrupt: true } : {}),
    ...extra,
  };
}

function openingLineage(invocation: RuntimeInvocationRecord): AgentRunRecoveryLineage {
  const lineage = invocation.opening.lineage;
  if (!lineage) return {};
  return {
    ...(lineage.parentRunId ? { parentRunId: lineage.parentRunId } : {}),
    ...(lineage.parentTurnId ? { parentTurnId: lineage.parentTurnId } : {}),
    ...(lineage.retriedFromTurnId ? { retriedFromTurnId: lineage.retriedFromTurnId } : {}),
    ...(lineage.regeneratedFromTurnId
      ? { regeneratedFromTurnId: lineage.regeneratedFromTurnId }
      : {}),
    ...(lineage.branchOfTurnId ? { branchOfTurnId: lineage.branchOfTurnId } : {}),
    ...(lineage.parentSessionId ? { parentSessionId: lineage.parentSessionId } : {}),
  };
}
