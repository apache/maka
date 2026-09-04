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

/**
 * One physical execution attempt, as the event spine describes it.
 *
 * An invocation is an opening fact, the events that follow it, and — once it
 * has ended — a terminal event. Everything a reader used to take from a mutable
 * Run header is a projection of those three, so there is nothing here that a
 * writer could set independently of the events.
 */

import type { AgentGraphIntentClaim } from './agent-graph-control.js';
import type {
  RuntimeEvent,
  RuntimeEventInvocationOpenedContent,
  RuntimeInvocationLineage,
} from './runtime-event.js';
import { isTerminalRuntimeEvent } from './runtime-event.js';

export interface RuntimeInvocationRecord {
  sessionId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  /** Timestamp of the opening fact's own event. */
  openedAt: number;
  opening: RuntimeEventInvocationOpenedContent;
  terminalEvent?: RuntimeEvent;
}

/**
 * Rebuild a Session's invocation inventory from its events alone.
 *
 * This is the definition of the inventory, not a cache of it: a store that
 * holds the Session's events can answer `listSessionInvocations` with this and
 * get exactly what an indexed store returns. Events whose invocation never
 * opened are control-plane streams and are absent by construction.
 */
export function runtimeInvocationsFromSessionEvents(
  sessionId: string,
  events: readonly RuntimeEvent[],
): RuntimeInvocationRecord[] {
  const byInvocation = new Map<string, RuntimeInvocationRecord>();
  for (const event of events) {
    if (event.sessionId !== sessionId || event.partial === true) continue;
    if (event.content?.kind === 'invocation_opened') {
      byInvocation.set(event.invocationId, {
        sessionId,
        invocationId: event.invocationId,
        runId: event.runId,
        turnId: event.turnId,
        openedAt: event.ts,
        opening: event.content,
      });
    }
  }
  // An invocation ends at its first terminal event. Sealing makes that the only
  // one for any ledger this codebase wrote; one written before the seal existed
  // can carry a straggler after it, and the ending is still the terminal event.
  // A Session-ordered read may place it anywhere relative to other invocations'
  // events, so this scans rather than looking at the tail.
  for (const event of events) {
    if (event.sessionId !== sessionId || event.partial === true) continue;
    if (!isTerminalRuntimeEvent(event)) continue;
    const record = byInvocation.get(event.invocationId);
    if (record && !record.terminalEvent) record.terminalEvent = event;
  }
  return [...byInvocation.values()].sort(
    (a, b) => a.openedAt - b.openedAt || a.invocationId.localeCompare(b.invocationId),
  );
}

/**
 * Wrap an opening fact in the event that carries it.
 *
 * Every writer that opens an invocation goes through here, so the envelope the
 * inventory reads back is decided once. It is hidden from the model: the
 * opening is a fact about the run, not something the run said.
 */
export function buildInvocationOpenedEvent(input: {
  id: string;
  run: { sessionId: string; invocationId: string; runId: string; turnId: string };
  openedAt: number;
  opening: RuntimeEventInvocationOpenedContent;
}): RuntimeEvent {
  return {
    id: input.id,
    sessionId: input.run.sessionId,
    invocationId: input.run.invocationId,
    runId: input.run.runId,
    turnId: input.run.turnId,
    ts: input.openedAt,
    partial: false,
    role: 'system',
    author: 'system',
    modelVisibility: 'hidden',
    content: input.opening,
  };
}

export interface BuildSyntheticTerminalRuntimeEventInput {
  id: string;
  invocationId: string;
  run: { sessionId: string; runId: string; turnId: string };
  status: RuntimeInvocationOutcome;
  ts: number;
  failureClass?: string;
  abortSource?: string;
  recoveryReason?: string;
  diagnostic?: Record<string, unknown>;
  message?: string;
}

/**
 * The terminal event a writer states on the run's behalf, when the run did not
 * state its own: recovery after a crash, a copy, or the migration of a header
 * whose run never wrote an event. One envelope, decided here.
 */
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

/** One invocation's position in a Session's opening order. */
export interface RuntimeInvocationPageCursor {
  readonly openedAt: number;
  readonly invocationId: string;
}

export interface RuntimeInvocationPageInput {
  readonly before?: RuntimeInvocationPageCursor;
  readonly limit: number;
}

export interface RuntimeInvocationPageResult {
  readonly invocations: readonly RuntimeInvocationRecord[];
  readonly nextCursor: RuntimeInvocationPageCursor | null;
}

export interface RuntimeInvocationSearchResult {
  readonly invocations: readonly RuntimeInvocationRecord[];
  readonly truncated: boolean;
}

export type RuntimeInvocationOutcome = 'completed' | 'failed' | 'cancelled';

/**
 * How the invocation ended, according to the only fact that decides it.
 *
 * `undefined` covers both an invocation still running and one whose terminal
 * event ends the stream without stating an outcome; a caller that needs to tell
 * those apart looks at `terminalEvent` itself.
 */
export function runtimeInvocationOutcome(record: {
  terminalEvent?: RuntimeEvent;
}): RuntimeInvocationOutcome | undefined {
  switch (record.terminalEvent?.status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'aborted':
    case 'cancelled':
      return 'cancelled';
    default:
      return undefined;
  }
}

/**
 * Whether this invocation contributes directly to the owning session's
 * transcript. Top-level continuations carry parent lineage for recovery, but
 * unlike child-agent invocations their output remains part of the parent
 * session conversation. A legacy child retry may also carry continuation
 * authority; its agent identity keeps it outside the owning session transcript.
 */
export function isSessionInlineInvocation(opening: RuntimeEventInvocationOpenedContent): boolean {
  const lineage = opening.lineage;
  return (
    lineage?.parentRunId === undefined ||
    (opening.source.kind === 'continuation' && lineage.agentId === undefined)
  );
}

export type RootExecutionDescriptor =
  | {
      kind: 'external_message';
      inputDigest?: `sha256:${string}`;
      maxSteps?: number;
    }
  | {
      /** Tool-free conversational execution admitted only by WorkHub authority. */
      kind: 'workhub_coordination';
      inputDigest: `sha256:${string}`;
    }
  | { kind: 'regenerate'; sourceTurnId: string }
  | { kind: 'context_compact' }
  | {
      kind: 'scheduled_task';
      scheduledTaskId: string;
      /** Includes the immutable Connection target for Agent ScheduledTasks. */
      executionFingerprint?: `sha256:${string}`;
    }
  | { kind: 'legacy_automation'; automationId: string }
  | { kind: 'goal'; goalId: string }
  | {
      kind: 'agent_graph_supervisor_wake';
      graphId: string;
      wakeId: string;
      attemptId: string;
    }
  | {
      kind: 'safe_boundary_continuation';
      sourceInvocationId: string;
      sourceRunId: string;
      sourceTurnId: string;
      sourceRuntimeEventHighWater: number;
      claimId: string;
      boundaryDigest: `sha256:${string}`;
      providerReplayDigest: `sha256:${string}`;
      safetyDigest: `sha256:${string}`;
      targetInvocationId: string;
    }
  | {
      kind: 'linked_child_initial';
      agentId: string;
      agentName: string;
    }
  | {
      kind: 'linked_child_resume';
      agentId: string;
      agentName: string;
      sourceRunId: string;
    }
  | {
      kind: 'linked_child_provider_retry';
      agentId: string;
      agentName: string;
      sourceRunId: string;
    }
  | {
      kind: 'claimed_agent_graph_intent';
      claim: AgentGraphIntentClaim;
      agentId: string;
      agentName: string;
    };

type HostedRootExecutionDescriptor = Extract<
  RootExecutionDescriptor,
  {
    kind:
      | 'regenerate'
      | 'context_compact'
      | 'scheduled_task'
      | 'legacy_automation'
      | 'goal'
      | 'agent_graph_supervisor_wake'
      | 'safe_boundary_continuation';
  }
>;

/**
 * Is this invocation the one the Host admitted for that root execution?
 *
 * The opening fact names its root as a closed union, so each arm names the root
 * it wants instead of asserting that every other root marker is absent. What
 * remains is lineage, and the rule there is exactness: an admitted root has the
 * lineage its kind implies and no other, so one comparison replaces a list of
 * per-field negatives that had to be extended every time a lineage field was
 * added.
 */
export function invocationMatchesHostedRootExecution(
  invocation: { invocationId: string; opening: RuntimeEventInvocationOpenedContent },
  execution: HostedRootExecutionDescriptor,
): boolean {
  const { root, source, configuration, lineage } = invocation.opening;
  switch (execution.kind) {
    case 'regenerate':
      return (
        root.kind === 'user' &&
        source.kind === 'fresh' &&
        lineageIsExactly(lineage, {
          parentTurnId: execution.sourceTurnId,
          regeneratedFromTurnId: execution.sourceTurnId,
        })
      );
    case 'context_compact':
      return (
        root.kind === 'context_compact' && source.kind === 'fresh' && lineageIsExactly(lineage, {})
      );
    case 'safe_boundary_continuation':
      return (
        root.kind === 'user' &&
        source.kind === 'continuation' &&
        invocation.invocationId === execution.targetInvocationId &&
        source.sourceInvocationId === execution.sourceInvocationId &&
        source.sourceRunId === execution.sourceRunId &&
        source.sourceTurnId === execution.sourceTurnId &&
        source.sourceRuntimeEventHighWater === execution.sourceRuntimeEventHighWater &&
        source.claimId === execution.claimId &&
        source.boundaryDigest === execution.boundaryDigest &&
        lineageIsExactly(lineage, {
          parentRunId: execution.sourceRunId,
          parentTurnId: execution.sourceTurnId,
        })
      );
    case 'scheduled_task':
      return (
        root.kind === 'scheduled_task' &&
        root.scheduledTaskId === execution.scheduledTaskId &&
        source.kind === 'fresh' &&
        lineageIsExactly(lineage, {})
      );
    case 'legacy_automation':
      return (
        root.kind === 'legacy_automation' &&
        root.legacyAutomationId === execution.automationId &&
        source.kind === 'fresh' &&
        lineageIsExactly(lineage, {})
      );
    case 'goal':
      return (
        root.kind === 'goal' &&
        root.goalId === execution.goalId &&
        source.kind === 'fresh' &&
        lineageIsExactly(lineage, {})
      );
    case 'agent_graph_supervisor_wake':
      return (
        root.kind === 'agent_graph_supervisor_wake' &&
        execution.wakeId.startsWith(`${execution.graphId}:`) &&
        root.wakeId === execution.wakeId &&
        root.attemptId === execution.attemptId &&
        configuration.orchestrationMode === 'graph' &&
        configuration.orchestrationSource === 'turn_override' &&
        configuration.agentSwarmAuthorization === 'none' &&
        source.kind === 'fresh' &&
        lineageIsExactly(lineage, {})
      );
  }
}

/** An admitted root has the lineage its kind implies, and no other edge. */
function lineageIsExactly(
  lineage: RuntimeInvocationLineage | undefined,
  expected: RuntimeInvocationLineage,
): boolean {
  const actual = (lineage ?? {}) as Record<string, string | undefined>;
  const wanted = expected as Record<string, string | undefined>;
  const keys = Object.keys(wanted);
  return (
    Object.keys(actual).length === keys.length && keys.every((key) => actual[key] === wanted[key])
  );
}
