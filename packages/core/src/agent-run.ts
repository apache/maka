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
 * The operational ledger one invocation writes beside its canonical events.
 *
 * These records are metering, request attempts, permission decisions and
 * diagnostics: facts with an operational demand of their own. What an
 * invocation *is* — its route, configuration, lineage and outcome — belongs to
 * the event spine in `runtime-invocation.ts`, not here.
 */

import {
  defineObjectShape,
  hasExactShape,
  isFiniteNumber,
  isOptionalString,
  isRecord,
} from './record-schema.js';
import { decodeRunCompositionSnapshot, type RunCompositionSnapshot } from './run-composition.js';

export interface AgentRunInputSummary {
  textLength: number;
  attachmentCount: number;
}

export const AGENT_RUN_EVENT_TYPES = [
  'turn_started',
  'plan_context_resolved',
  'plan_submitted',
  'plan_execution_started',
  'plan_progress_updated',
  'plan_execution_completed',
  'plan_execution_cancelled',
  'plan_execution_interrupted',
  'plan_execution_resumed',
  'plan_transition_failed',
  'graph_supervisor_yielded',
  'model_resolved',
  'model_resolve_failed',
  'model_stream_started',
  'model_stream_completed',
  'model_stream_failed',
  'send_diagnostics_recorded',
  'tool_started',
  'tool_searched',
  'tool_completed',
  'tool_failed',
  'skill_catalog_built',
  'skill_searched',
  'skill_loaded',
  'skill_load_failed',
  'permission_requested',
  'permission_decided',
  'permission_failed',
  'approval_routed',
  'auto_review_started',
  'auto_review_decided',
  'auto_review_failed',
  'sandbox_escalation_requested',
  'sandbox_escalation_granted',
  'sandbox_escalation_denied',
  'sandbox_escalation_applied',
  'sandbox_escalation_failed',
  'sandbox_denial_detected',
  'model_call_attempt_recorded',
  'history_compact_checkpoint_recorded',
  'model_projection_transition_recorded',
  'run_composition_recorded',
  'abort_requested',
  'trace_write_failed',
  'event_corrupt',
] as const;

export type AgentRunEventType = (typeof AGENT_RUN_EVENT_TYPES)[number];

/**
 * Derived state committed with the event that authorises it (#2323).
 *
 * `latestContext` rides the canonical completed-main attempt append so the two
 * cannot disagree: there is one durable commit for the request, and the
 * projection is a product of it rather than a second record racing it. A store
 * without projections ignores this; the projection is rebuildable either way.
 */
export interface AgentRunAppendOptions {
  durable?: boolean;
  latestContext?: LatestContextProjectionInput;
}

/**
 * The projection key. Deliberately NOT an emitted event type: nothing appends
 * a record under this name. It names one derived row per session, written by
 * the transaction that commits the canonical attempt and rebuildable from the
 * ledger at any time.
 */
export const LATEST_CONTEXT_PROJECTION_TYPE = 'latest_context';

/**
 * What a projection may be keyed by: usually an event type, but not always.
 *
 * Named once so every layer that passes a key declares the same thing. A store
 * whose parameter says `AgentRunEventType` while the interface it implements
 * says otherwise only pushes the mismatch out to its callers as a cast.
 */
export type AgentRunProjectionKey = AgentRunEventType | typeof LATEST_CONTEXT_PROJECTION_TYPE;

/**
 * Everything one settled provider request commits, as one value (#2323).
 *
 * Deliberately an object rather than positional arguments: a layer that
 * forwards only the attempt used to be a silent drop — JavaScript discards the
 * extra argument and TypeScript accepts the narrower callback — so the derived
 * row never reached storage in production. Passing one object makes an
 * incomplete forward a type error instead of a missing feature.
 */
export interface ModelCallCommit<TAttempt> {
  attempt: TAttempt;
  latestContext?: LatestContextProjectionInput;
}

/**
 * The facts a latest-context projection freezes, all bound to one request.
 *
 * `orderedAt` is what makes the projection monotonic: overlapping turns append
 * on independent queues, so arrival order is not completion order, and a later
 * arrival must not move the answer backwards.
 */
export interface LatestContextProjectionInput {
  attemptId: string;
  orderedAt: number;
  snapshot: Record<string, unknown>;
}

/** How two candidate latest-context rows compare. */
export interface LatestContextOrder {
  completedAt: number;
  attemptId: string;
}

/**
 * The one ordering rule for the latest-context row.
 *
 * Lives here because two independent writers must agree on it: the storage
 * transaction deciding whether an arriving commit supersedes the stored row,
 * and the cold rebuild deciding which record of a whole ledger is the newest.
 * A warm read and a rebuild of the same session that disagreed about which
 * request is "latest" would be indistinguishable from data loss.
 *
 * Completion time, never arrival — overlapping turns append on independent
 * queues. Ties break on `attemptId` rather than on arrival, so the answer does
 * not depend on which writer got there first.
 */
export function supersedesLatestContext(
  candidate: LatestContextOrder,
  incumbent: LatestContextOrder | undefined,
): boolean {
  if (!incumbent) return true;
  if (candidate.completedAt !== incumbent.completedAt) {
    return candidate.completedAt > incumbent.completedAt;
  }
  return candidate.attemptId > incumbent.attemptId;
}

/**
 * A decoded ledger record. The ledger is append-only and outlives any single build, so `type` is
 * an open string: a reader must accept a type another version wrote, whether that version retired
 * the writer or has not shipped yet (#1942). The envelope around `type` is still validated, so
 * this tolerance does not extend to a record that gained or lost a field.
 */
export interface AgentRunEvent {
  type: string;
  id: string;
  runId: string;
  sessionId: string;
  turnId: string;
  ts: number;
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * What this build may append. `AGENT_RUN_EVENT_TYPES` is the emitted catalogue, not the readable
 * one, so it stays free to shrink when a writer retires while a misspelled or retired type fails
 * to compile at the append that would persist it.
 */
export interface EmittedAgentRunEvent extends AgentRunEvent {
  type: AgentRunEventType;
}

const EMITTED_AGENT_RUN_EVENT_TYPES: ReadonlySet<string> = new Set(AGENT_RUN_EVENT_TYPES);

/** Whether this build emits `type`, and so knows what its record means. */
export function isEmittedAgentRunEventType(type: string): type is AgentRunEventType {
  return EMITTED_AGENT_RUN_EVENT_TYPES.has(type);
}

const AGENT_RUN_EVENT_SHAPE = defineObjectShape<AgentRunEvent>()(
  ['type', 'id', 'runId', 'sessionId', 'turnId', 'ts'],
  ['message', 'data'],
);

export const RUN_COMPOSITION_RECORDED_EVENT_TYPE = 'run_composition_recorded' as const;

/**
 * Read a run's composer snapshot back out of its ledger.
 *
 * The composition is written once, before provider dispatch, and the store
 * refuses a second append that disagrees with the first. So the earliest
 * matching row is the whole answer, and a reader never has to reduce a stream.
 */
export function agentRunCompositionFromEvents(
  events: readonly AgentRunEvent[],
): RunCompositionSnapshot | undefined {
  for (const event of events) {
    if (event.type !== RUN_COMPOSITION_RECORDED_EVENT_TYPE) continue;
    return decodeRunCompositionSnapshot(event.data?.runComposition);
  }
  return undefined;
}

export function decodeAgentRunEvent(value: unknown): AgentRunEvent {
  if (
    !isRecord(value) ||
    !hasExactShape(value, AGENT_RUN_EVENT_SHAPE) ||
    typeof value.type !== 'string' ||
    value.type.trim().length === 0 ||
    typeof value.id !== 'string' ||
    typeof value.runId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.turnId !== 'string' ||
    !isFiniteNumber(value.ts) ||
    !isOptionalString(value.message) ||
    (value.data !== undefined && !isRecord(value.data))
  ) {
    throw new Error('Invalid AgentRun event schema');
  }
  return value as unknown as AgentRunEvent;
}

export interface AgentRunStore {
  appendEvent(
    sessionId: string,
    runId: string,
    event: EmittedAgentRunEvent,
    options?: AgentRunAppendOptions,
  ): Promise<void>;
  readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]>;
  /**
   * `undefined` means uninitialized; `null` is an initialized empty projection.
   *
   * The key is a projection name, which is usually an event type but need not
   * be: `latest_context` names a derived row nothing appends under (#2323).
   */
  readEventProjection?(
    sessionId: string,
    type: AgentRunProjectionKey,
  ): Promise<AgentRunEvent | null | undefined>;
  /** Opaque revision of the canonical event ledger used to guard a derived repair. */
  readEventLedgerRevision?(sessionId: string): Promise<string>;
  /** Rewrites derived state after the canonical event ledger repairs an absent or damaged projection. */
  repairEventProjection?(
    sessionId: string,
    type: AgentRunProjectionKey,
    event: AgentRunEvent | null,
    options: { ifLedgerRevision: string; replaceEventId?: string },
  ): Promise<void>;
}
