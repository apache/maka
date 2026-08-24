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
import type { AgentRunEvent, AgentRunHeader } from '@maka/core/agent-run';
import type { SandboxBoundaryRequest } from '@maka/core/sandbox-boundary';
import type { UserMessageInput } from '@maka/core/runtime-inputs';

export interface AgentRunRecoveryDecision {
  runId: string;
  turnId: string;
  status: 'failed' | 'completed' | 'cancelled';
  failureClass?: string;
  abortSource?: string;
  diagnostic?: Record<string, unknown>;
  lineage: Partial<
    Pick<
      UserMessageInput,
      | 'parentRunId'
      | 'parentTurnId'
      | 'retriedFromTurnId'
      | 'regeneratedFromTurnId'
      | 'branchOfTurnId'
      | 'parentSessionId'
    >
  >;
}

export function classifyAgentRunRecovery(
  header: AgentRunHeader,
  events: readonly AgentRunEvent[],
): AgentRunRecoveryDecision | undefined {
  if (isTerminalRunStatus(header.status)) return undefined;

  const lastEvent = lastNonCorruptEvent(events);
  const hasCorruptEvent = events.some((event) => event.type === 'event_corrupt');
  const lastEventType = lastEvent?.type;

  if (lastEventType === 'model_stream_completed' && !hasTerminalRunEvent(events)) {
    return failedDecision(
      header,
      'app_restarted',
      diagnostic('model_stream_completed_without_runtime_terminal', lastEventType, hasCorruptEvent),
    );
  }

  if (
    header.status === 'waiting_for_user' ||
    lastEventType === 'permission_requested' ||
    lastEventType === 'permission_failed'
  ) {
    return failedDecision(
      header,
      'app_restarted',
      diagnostic('stale_user_wait', lastEventType, hasCorruptEvent),
    );
  }

  if (lastEventType === 'tool_started') {
    return failedDecision(
      header,
      'app_restarted',
      diagnostic('tool_interrupted', lastEventType, hasCorruptEvent),
    );
  }

  if (
    header.status === 'created' ||
    header.status === 'running' ||
    lastEventType === undefined ||
    lastEventType === 'run_created' ||
    lastEventType === 'run_started' ||
    lastEventType === 'turn_started' ||
    lastEventType === 'model_resolved' ||
    lastEventType === 'model_stream_started' ||
    lastEventType === 'run_status_changed'
  ) {
    return failedDecision(
      header,
      'app_restarted',
      diagnostic('run_interrupted', lastEventType, hasCorruptEvent),
    );
  }

  return failedDecision(
    header,
    'app_restarted',
    diagnostic('non_terminal_run_recovered', lastEventType, hasCorruptEvent),
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
  header: AgentRunHeader,
  failureClass: string,
  diagnostic?: Record<string, unknown>,
): AgentRunRecoveryDecision {
  return {
    runId: header.runId,
    turnId: header.turnId,
    status: 'failed',
    failureClass,
    diagnostic,
    lineage: headerLineage(header),
  };
}

function isTerminalRunStatus(status: AgentRunHeader['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function hasTerminalRunEvent(events: readonly AgentRunEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === 'run_completed' ||
      event.type === 'run_failed' ||
      event.type === 'run_cancelled',
  );
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

function headerLineage(
  header: AgentRunHeader,
): Partial<
  Pick<
    UserMessageInput,
    | 'parentRunId'
    | 'parentTurnId'
    | 'retriedFromTurnId'
    | 'regeneratedFromTurnId'
    | 'branchOfTurnId'
    | 'parentSessionId'
  >
> {
  return {
    ...(header.parentRunId ? { parentRunId: header.parentRunId } : {}),
    ...(header.parentTurnId ? { parentTurnId: header.parentTurnId } : {}),
    ...(header.retriedFromTurnId ? { retriedFromTurnId: header.retriedFromTurnId } : {}),
    ...(header.regeneratedFromTurnId
      ? { regeneratedFromTurnId: header.regeneratedFromTurnId }
      : {}),
    ...(header.branchOfTurnId ? { branchOfTurnId: header.branchOfTurnId } : {}),
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
  };
}
