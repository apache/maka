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

import { Buffer } from 'node:buffer';
import type {
  AgentGraphIntentAdmissionState,
  AgentGraphScheduleUpdateSource,
} from '@maka/core/agent-graph-schedule';
import type { AgentGraphSupervisorWakeStatus } from '@maka/core/agent-graph-supervisor-wake';
import type {
  AgentGraphTimelineMetadataSnapshot,
  AgentGraphTimelineMetadataStore,
} from '@maka/core/agent-graph-timeline';
import type { AgentRunHeader, AgentRunStore } from '@maka/core/agent-run';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import { stableHash } from './request-shape.js';
import {
  readCommittedAgentGraphProjectionWithRuns,
  type AgentGraphActivationStatus,
  type AgentGraphOperatorBinding,
  type AgentGraphProjection,
  type AgentGraphRecord,
  type AgentGraphRecordFacet,
} from './stream-graph-projection.js';

export const AGENT_GRAPH_TIMELINE_SCHEMA_VERSION = 1 as const;
export const AGENT_GRAPH_TIMELINE_DEFAULT_PAGE_SIZE = 100;
export const AGENT_GRAPH_TIMELINE_MAX_PAGE_SIZE = 256;

export type AgentGraphTimelineCoverageLimitation =
  | 'admission_transition_history_not_persisted'
  | 'supervisor_wake_transition_history_not_persisted'
  | 'reconcile_history_not_persisted';

export interface AgentGraphTimelineRunRef {
  sessionId: string;
  runId: string;
  turnId: string;
}

interface AgentGraphTimelineEventBase {
  schemaVersion: typeof AGENT_GRAPH_TIMELINE_SCHEMA_VERSION;
  eventId: string;
  graphId: string;
  eventTime: number;
  /** Deterministic reconstruction order; it is not a cross-ledger commit sequence. */
  sequence: number;
}

export type AgentGraphTimelineEvent =
  | (AgentGraphTimelineEventBase & {
      kind: 'supervisor_turn_started';
      run: AgentGraphTimelineRunRef;
      wake?: { wakeId: string; attemptId: string };
    })
  | (AgentGraphTimelineEventBase & {
      kind: 'supervisor_turn_terminal';
      run: AgentGraphTimelineRunRef;
      status: Extract<AgentRunHeader['status'], 'completed' | 'failed' | 'cancelled'>;
      wake?: { wakeId: string; attemptId: string };
    })
  | (AgentGraphTimelineEventBase & {
      kind: 'schedule_committed';
      updateId: string;
      revision: number;
      source: AgentGraphScheduleUpdateSource;
      workIds: string[];
      stoppedTargetIds: string[];
      closesGraph: boolean;
    })
  | (AgentGraphTimelineEventBase & {
      kind: 'schedule_finished';
      updateId: string;
      revision: number;
      source: AgentGraphScheduleUpdateSource;
      resultIds: string[];
    })
  | (AgentGraphTimelineEventBase & {
      kind: 'operator_provisioned';
      provisionId: string;
      workId: string;
      agentId: string;
      operatorId: string;
      targetSessionId: string;
      initialTurnId: string;
      initialRunId: string;
      edgeIds: string[];
    })
  | (AgentGraphTimelineEventBase & {
      kind: 'intent_claimed';
      claimId: string;
      intentId: string;
      operatorId: string;
      activation: AgentGraphTimelineRunRef;
    })
  | (AgentGraphTimelineEventBase & {
      kind: 'activation_started';
      operatorId: string;
      activation: AgentGraphTimelineRunRef;
    })
  | (AgentGraphTimelineEventBase & {
      kind: 'record_committed';
      recordId: string;
      operatorId: string;
      activation: AgentGraphTimelineRunRef;
      facets: AgentGraphRecordFacet[];
      sourceRuntimeEventId: string;
    })
  | (AgentGraphTimelineEventBase & {
      kind: 'activation_terminal';
      operatorId: string;
      activation: AgentGraphTimelineRunRef;
      status: Extract<AgentGraphActivationStatus, 'completed' | 'failed' | 'aborted' | 'cancelled'>;
      terminalRecordId: string;
    })
  | (AgentGraphTimelineEventBase & {
      kind: 'supervisor_wake_claimed';
      wakeId: string;
      snapshotVersion: string;
      rootSessionId: string;
    })
  | (AgentGraphTimelineEventBase & {
      kind: 'supervisor_wake_attempted';
      wakeId: string;
      attemptId: string;
      turnId: string;
    })
  | (AgentGraphTimelineEventBase & {
      kind: 'supervisor_wake_settled';
      wakeId: string;
      attemptId: string;
      turnId: string;
      status: 'delivered' | 'superseded' | 'retryable_failed';
    });

export interface AgentGraphTimelineCurrentAdmission {
  intentId: string;
  state: AgentGraphIntentAdmissionState;
  updatedAt: number;
}

export interface AgentGraphTimelineCurrentSupervisorWake {
  wakeId: string;
  status: AgentGraphSupervisorWakeStatus;
  attemptCount: number;
  updatedAt: number;
  currentAttemptId?: string;
  currentTurnId?: string;
}

/**
 * Mutable control-plane state observed while reconstructing this page.
 *
 * It intentionally lives outside the pageable immutable event stream so a
 * state transition cannot invalidate an already-issued historical cursor.
 */
export interface AgentGraphTimelineCurrentState {
  admissions: AgentGraphTimelineCurrentAdmission[];
  supervisorWakes: AgentGraphTimelineCurrentSupervisorWake[];
}

export interface AgentGraphTimelinePage {
  schemaVersion: typeof AGENT_GRAPH_TIMELINE_SCHEMA_VERSION;
  graphId: string;
  rootSessionId: string;
  events: AgentGraphTimelineEvent[];
  totalEvents: number;
  omittedBefore: number;
  omittedAfter: number;
  nextCursor?: string;
  currentState: AgentGraphTimelineCurrentState;
  coverage: {
    runtimeRecords: 'complete';
    limitations: AgentGraphTimelineCoverageLimitation[];
  };
}

export interface AgentGraphTimelinePageOptions {
  cursor?: string;
  limit?: number;
}

export interface ReadAgentGraphTimelinePageInput {
  rootSessionId: string;
  graphId: string;
  controlStore: AgentGraphTimelineMetadataStore;
  runStore: Pick<AgentRunStore, 'listSessionRuns'>;
  runtimeEventStore: Pick<RuntimeEventStore, 'readImmutableRuntimeEvents'>;
  options?: AgentGraphTimelinePageOptions;
}

export interface BuildAgentGraphTimelineInput {
  rootSessionId: string;
  graphId: string;
  metadata: AgentGraphTimelineMetadataSnapshot;
  rootRuns: readonly AgentRunHeader[];
  childRuns: readonly AgentRunHeader[];
  projection: AgentGraphProjection;
}

type WithoutSequence<T> = T extends unknown ? Omit<T, 'sequence'> : never;
type AgentGraphTimelineEventWithoutSequence = WithoutSequence<AgentGraphTimelineEvent>;

interface PendingTimelineEvent {
  event: AgentGraphTimelineEventWithoutSequence;
  rank: number;
  tieBreak: string;
}

const EVENT_RANK = {
  supervisor_turn_started: 10,
  schedule_committed: 20,
  schedule_finished: 21,
  operator_provisioned: 30,
  intent_claimed: 40,
  activation_started: 50,
  record_committed: 60,
  activation_terminal: 61,
  supervisor_turn_terminal: 70,
  supervisor_wake_claimed: 80,
  supervisor_wake_attempted: 81,
  supervisor_wake_settled: 82,
} as const satisfies Record<AgentGraphTimelineEvent['kind'], number>;

export async function readAgentGraphTimelinePage(
  input: ReadAgentGraphTimelinePageInput,
): Promise<AgentGraphTimelinePage> {
  assertIdentity(input.rootSessionId, 'root Session id');
  assertIdentity(input.graphId, 'graph id');
  const metadata = await input.controlStore.readAgentGraphTimelineMetadata(input.graphId);
  if (metadata.graphId !== input.graphId) {
    throw new Error(`Agent graph timeline metadata belongs to ${metadata.graphId}`);
  }
  for (const update of metadata.scheduleUpdates) {
    if (update.source.sessionId !== input.rootSessionId) {
      throw new Error(
        `Agent graph schedule ${update.updateId} is not owned by root Session ${input.rootSessionId}`,
      );
    }
  }
  const operators: AgentGraphOperatorBinding[] = metadata.operatorProvisions.map((provision) => ({
    operatorId: provision.operatorId,
    sessionId: provision.targetSessionId,
  }));
  const [rootRuns, projected] = await Promise.all([
    input.runStore.listSessionRuns(input.rootSessionId),
    readCommittedAgentGraphProjectionWithRuns({
      graphId: input.graphId,
      operators,
      runStore: input.runStore,
      runtimeEventStore: input.runtimeEventStore,
    }),
  ]);
  return paginateAgentGraphTimeline(
    buildAgentGraphTimeline({
      rootSessionId: input.rootSessionId,
      graphId: input.graphId,
      metadata,
      rootRuns,
      childRuns: projected.runs,
      projection: projected.projection,
    }),
    input.rootSessionId,
    input.graphId,
    buildAgentGraphTimelineCurrentState(metadata, input.rootSessionId, input.graphId),
    input.options,
  );
}

export function buildAgentGraphTimeline(
  input: BuildAgentGraphTimelineInput,
): AgentGraphTimelineEvent[] {
  if (input.metadata.graphId !== input.graphId || input.projection.graphId !== input.graphId) {
    throw new Error('Agent graph timeline sources belong to different graphs');
  }
  const pending: PendingTimelineEvent[] = [];
  const push = (event: AgentGraphTimelineEventWithoutSequence, tieBreak = event.eventId): void => {
    pending.push({ event, rank: EVENT_RANK[event.kind], tieBreak });
  };

  const relevantRootRunIds = new Set(
    input.metadata.scheduleUpdates.map((update) => update.source.runId),
  );
  const wakeAttemptIds = new Set(
    input.metadata.supervisorWakes.flatMap(({ attempts }) =>
      attempts.map((attempt) => attempt.attemptId),
    ),
  );
  for (const run of input.rootRuns) {
    const wake =
      run.agentGraphWakeId && run.agentGraphWakeAttemptId
        ? { wakeId: run.agentGraphWakeId, attemptId: run.agentGraphWakeAttemptId }
        : undefined;
    if (!relevantRootRunIds.has(run.runId) && !wakeAttemptIds.has(wake?.attemptId ?? '')) {
      continue;
    }
    assertRunRef(run, input.rootSessionId);
    const runRef = timelineRunRef(run);
    push({
      ...eventBase(
        input.graphId,
        'supervisor_turn_started',
        {
          sessionId: run.sessionId,
          runId: run.runId,
        },
        run.createdAt,
      ),
      kind: 'supervisor_turn_started',
      run: runRef,
      ...(wake ? { wake } : {}),
    });
    if (
      run.completedAt !== undefined &&
      (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled')
    ) {
      push({
        ...eventBase(
          input.graphId,
          'supervisor_turn_terminal',
          {
            sessionId: run.sessionId,
            runId: run.runId,
            status: run.status,
          },
          run.completedAt,
        ),
        kind: 'supervisor_turn_terminal',
        run: runRef,
        status: run.status,
        ...(wake ? { wake } : {}),
      });
    }
  }

  for (const update of input.metadata.scheduleUpdates) {
    push({
      ...eventBase(
        input.graphId,
        'schedule_committed',
        { updateId: update.updateId },
        update.committedAt,
      ),
      kind: 'schedule_committed',
      updateId: update.updateId,
      revision: update.revision,
      source: { ...update.source },
      workIds: update.addWork.map((work) => work.workId),
      stoppedTargetIds: update.stop.map((stopped) => stopped.targetId),
      closesGraph: update.finish !== undefined,
    });
    if (update.finish) {
      push({
        ...eventBase(
          input.graphId,
          'schedule_finished',
          { updateId: update.updateId },
          update.committedAt,
        ),
        kind: 'schedule_finished',
        updateId: update.updateId,
        revision: update.revision,
        source: { ...update.source },
        resultIds: [...update.finish.resultIds],
      });
    }
  }

  for (const provision of input.metadata.operatorProvisions) {
    push({
      ...eventBase(
        input.graphId,
        'operator_provisioned',
        { provisionId: provision.provisionId },
        provision.provisionedAt,
      ),
      kind: 'operator_provisioned',
      provisionId: provision.provisionId,
      workId: provision.workId,
      agentId: provision.agentId,
      operatorId: provision.operatorId,
      targetSessionId: provision.targetSessionId,
      initialTurnId: provision.initialTurnId,
      initialRunId: provision.initialRunId,
      edgeIds: provision.edges.map((edge) => edge.edgeId),
    });
  }

  const operatorSessionById = new Map(
    input.metadata.operatorProvisions.map((provision) => [
      provision.operatorId,
      provision.targetSessionId,
    ]),
  );
  const childRunByIdentity = new Map<string, AgentRunHeader>();
  for (const run of input.childRuns) {
    const key = `${run.sessionId}\0${run.runId}`;
    if (childRunByIdentity.has(key)) {
      throw new Error(`Agent graph timeline contains duplicate AgentRun ${run.runId}`);
    }
    childRunByIdentity.set(key, run);
  }
  for (const claim of input.metadata.intentClaims) {
    if (
      claim.graphId !== input.graphId ||
      operatorSessionById.get(claim.targetOperatorId) !== claim.targetSessionId
    ) {
      throw new Error(`Agent graph claim ${claim.intentId} has no matching operator binding`);
    }
    push({
      ...eventBase(input.graphId, 'intent_claimed', { claimId: claim.claimId }, claim.claimedAt),
      kind: 'intent_claimed',
      claimId: claim.claimId,
      intentId: claim.intentId,
      operatorId: claim.targetOperatorId,
      activation: {
        sessionId: claim.targetSessionId,
        runId: claim.targetRunId,
        turnId: claim.targetTurnId,
      },
    });
    const run = childRunByIdentity.get(`${claim.targetSessionId}\0${claim.targetRunId}`);
    if (!run) continue;
    if (run.turnId !== claim.targetTurnId) {
      throw new Error(
        `Agent graph activation ${claim.targetRunId} belongs to turn ${run.turnId}, expected ${claim.targetTurnId}`,
      );
    }
    push({
      ...eventBase(
        input.graphId,
        'activation_started',
        { operatorId: claim.targetOperatorId, runId: run.runId },
        run.createdAt,
      ),
      kind: 'activation_started',
      operatorId: claim.targetOperatorId,
      activation: timelineRunRef(run),
    });
  }

  const recordByRun = new Map<string, AgentGraphRecord[]>();
  for (const record of input.projection.records) {
    const records = recordByRun.get(record.agentRunId) ?? [];
    records.push(record);
    recordByRun.set(record.agentRunId, records);
    push(
      {
        ...eventBase(
          input.graphId,
          'record_committed',
          { recordId: record.recordId },
          record.eventTime,
        ),
        kind: 'record_committed',
        recordId: record.recordId,
        operatorId: record.operatorId,
        activation: {
          sessionId: record.sessionId,
          runId: record.agentRunId,
          turnId: record.source.turnId,
        },
        facets: [...record.facets],
        sourceRuntimeEventId: record.source.runtimeEventId,
      },
      recordTieBreak(record),
    );
  }
  for (const operator of input.projection.operators) {
    const state = input.projection.state.operators[operator.operatorId];
    if (!state) continue;
    for (const activation of Object.values(state.activations)) {
      const records = recordByRun.get(activation.agentRunId) ?? [];
      if (activation.terminalRecordId && isTerminalActivationStatus(activation.status)) {
        const terminal = records.find((record) => record.recordId === activation.terminalRecordId);
        if (!terminal) {
          throw new Error(
            `Agent graph activation ${activation.activationId} lost its terminal record`,
          );
        }
        push({
          ...eventBase(
            input.graphId,
            'activation_terminal',
            { terminalRecordId: activation.terminalRecordId },
            terminal.eventTime,
          ),
          kind: 'activation_terminal',
          operatorId: operator.operatorId,
          activation: {
            sessionId: operator.sessionId,
            runId: activation.agentRunId,
            turnId: terminal.source.turnId,
          },
          status: activation.status,
          terminalRecordId: activation.terminalRecordId,
        });
      }
    }
  }

  for (const { wake, attempts } of input.metadata.supervisorWakes) {
    if (wake.graphId !== input.graphId || wake.rootSessionId !== input.rootSessionId) {
      throw new Error(`Agent graph supervisor wake ${wake.wakeId} belongs to another graph`);
    }
    push({
      ...eventBase(
        input.graphId,
        'supervisor_wake_claimed',
        { wakeId: wake.wakeId },
        wake.createdAt,
      ),
      kind: 'supervisor_wake_claimed',
      wakeId: wake.wakeId,
      snapshotVersion: wake.snapshotVersion,
      rootSessionId: wake.rootSessionId,
    });
    for (const attempt of attempts) {
      push({
        ...eventBase(
          input.graphId,
          'supervisor_wake_attempted',
          { attemptId: attempt.attemptId },
          attempt.startedAt,
        ),
        kind: 'supervisor_wake_attempted',
        wakeId: attempt.wakeId,
        attemptId: attempt.attemptId,
        turnId: attempt.turnId,
      });
      if (
        attempt.completedAt !== undefined &&
        (attempt.status === 'delivered' ||
          attempt.status === 'superseded' ||
          attempt.status === 'retryable_failed')
      ) {
        push({
          ...eventBase(
            input.graphId,
            'supervisor_wake_settled',
            { attemptId: attempt.attemptId, status: attempt.status },
            attempt.completedAt,
          ),
          kind: 'supervisor_wake_settled',
          wakeId: attempt.wakeId,
          attemptId: attempt.attemptId,
          turnId: attempt.turnId,
          status: attempt.status,
        });
      }
    }
  }

  pending.sort(
    (a, b) =>
      a.event.eventTime - b.event.eventTime ||
      a.rank - b.rank ||
      a.tieBreak.localeCompare(b.tieBreak) ||
      a.event.eventId.localeCompare(b.event.eventId),
  );
  const seen = new Set<string>();
  return pending.map(({ event }, index) => {
    if (seen.has(event.eventId)) {
      throw new Error(`Duplicate agent graph timeline event ${event.eventId}`);
    }
    seen.add(event.eventId);
    return { ...event, sequence: index + 1 } as AgentGraphTimelineEvent;
  });
}

export function buildAgentGraphTimelineCurrentState(
  metadata: AgentGraphTimelineMetadataSnapshot,
  rootSessionId: string,
  graphId: string,
): AgentGraphTimelineCurrentState {
  if (metadata.graphId !== graphId) {
    throw new Error(`Agent graph timeline metadata belongs to ${metadata.graphId}`);
  }
  const claimIntentIds = new Set(metadata.intentClaims.map((claim) => claim.intentId));
  if (claimIntentIds.size !== metadata.intentClaims.length) {
    throw new Error(`Agent graph ${graphId} has duplicate intent claims`);
  }
  const admissionIntentIds = new Set<string>();
  const admissions = metadata.intentAdmissions.map((admission) => {
    if (admission.graphId !== graphId || !claimIntentIds.has(admission.intentId)) {
      throw new Error(`Agent graph admission ${admission.intentId} belongs to another graph`);
    }
    if (admissionIntentIds.has(admission.intentId)) {
      throw new Error(`Agent graph ${graphId} has duplicate admission snapshots`);
    }
    admissionIntentIds.add(admission.intentId);
    return {
      intentId: admission.intentId,
      state: admission.state,
      updatedAt: admission.updatedAt,
    };
  });
  if (admissionIntentIds.size !== claimIntentIds.size) {
    throw new Error(`Agent graph ${graphId} has a missing or duplicate admission snapshot`);
  }
  const supervisorWakes = metadata.supervisorWakes.map(({ wake }) => {
    if (wake.graphId !== graphId || wake.rootSessionId !== rootSessionId) {
      throw new Error(`Agent graph supervisor wake ${wake.wakeId} belongs to another graph`);
    }
    return {
      wakeId: wake.wakeId,
      status: wake.status,
      attemptCount: wake.attemptCount,
      updatedAt: wake.updatedAt,
      ...(wake.currentAttemptId ? { currentAttemptId: wake.currentAttemptId } : {}),
      ...(wake.currentTurnId ? { currentTurnId: wake.currentTurnId } : {}),
    };
  });
  admissions.sort((a, b) => a.intentId.localeCompare(b.intentId));
  supervisorWakes.sort((a, b) => a.wakeId.localeCompare(b.wakeId));
  return { admissions, supervisorWakes };
}

export function paginateAgentGraphTimeline(
  events: readonly AgentGraphTimelineEvent[],
  rootSessionId: string,
  graphId: string,
  currentState: AgentGraphTimelineCurrentState,
  options: AgentGraphTimelinePageOptions = {},
): AgentGraphTimelinePage {
  const limit = options.limit ?? AGENT_GRAPH_TIMELINE_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_GRAPH_TIMELINE_MAX_PAGE_SIZE) {
    throw new Error(
      `Agent graph timeline limit must be between 1 and ${AGENT_GRAPH_TIMELINE_MAX_PAGE_SIZE}`,
    );
  }
  let start = 0;
  if (options.cursor) {
    const cursor = decodeAgentGraphTimelineCursor(options.cursor);
    if (cursor.graphId !== graphId) {
      throw new Error('Agent graph timeline cursor belongs to another graph');
    }
    const index = events.findIndex(
      (event) => event.eventId === cursor.eventId && event.eventTime === cursor.eventTime,
    );
    if (index < 0) throw new Error('Agent graph timeline cursor is stale or invalid');
    start = index + 1;
  }
  const pageEvents = events.slice(start, start + limit).map(cloneTimelineEvent);
  const omittedAfter = Math.max(0, events.length - start - pageEvents.length);
  return {
    schemaVersion: AGENT_GRAPH_TIMELINE_SCHEMA_VERSION,
    graphId,
    rootSessionId,
    events: pageEvents,
    totalEvents: events.length,
    omittedBefore: start,
    omittedAfter,
    currentState: cloneTimelineCurrentState(currentState),
    ...(omittedAfter > 0 && pageEvents.length > 0
      ? { nextCursor: encodeAgentGraphTimelineCursor(graphId, pageEvents.at(-1)!) }
      : {}),
    coverage: {
      runtimeRecords: 'complete',
      limitations: [
        'admission_transition_history_not_persisted',
        'supervisor_wake_transition_history_not_persisted',
        'reconcile_history_not_persisted',
      ],
    },
  };
}

export function encodeAgentGraphTimelineCursor(
  graphId: string,
  event: Pick<AgentGraphTimelineEvent, 'eventId' | 'eventTime'>,
): string {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: AGENT_GRAPH_TIMELINE_SCHEMA_VERSION,
      graphId,
      eventId: event.eventId,
      eventTime: event.eventTime,
    }),
    'utf8',
  ).toString('base64url');
}

export function decodeAgentGraphTimelineCursor(cursor: string): {
  graphId: string;
  eventId: string;
  eventTime: number;
} {
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > 2_048 ||
    cursor.trim() !== cursor
  ) {
    throw new Error('Invalid agent graph timeline cursor');
  }
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const canonical = Buffer.from(json, 'utf8').toString('base64url');
    const value = JSON.parse(json) as Record<string, unknown>;
    if (
      canonical !== cursor ||
      Object.keys(value).sort().join(',') !== 'eventId,eventTime,graphId,schemaVersion' ||
      value.schemaVersion !== AGENT_GRAPH_TIMELINE_SCHEMA_VERSION ||
      typeof value.eventTime !== 'number' ||
      !Number.isSafeInteger(value.eventTime) ||
      value.eventTime < 0
    ) {
      throw new Error('invalid cursor envelope');
    }
    return {
      graphId: cursorIdentity(value.graphId),
      eventId: cursorIdentity(value.eventId),
      eventTime: value.eventTime,
    };
  } catch {
    throw new Error('Invalid agent graph timeline cursor');
  }
}

function eventBase(
  graphId: string,
  kind: AgentGraphTimelineEvent['kind'],
  identity: unknown,
  eventTime: number,
): Omit<AgentGraphTimelineEventBase, 'sequence'> {
  if (!Number.isSafeInteger(eventTime) || eventTime < 0) {
    throw new Error(`Invalid agent graph timeline timestamp for ${kind}`);
  }
  return {
    schemaVersion: AGENT_GRAPH_TIMELINE_SCHEMA_VERSION,
    eventId: `graph_timeline_${stableHash({ graphId, kind, identity }).slice('sha256:'.length, 48)}`,
    graphId,
    eventTime,
  };
}

function timelineRunRef(run: AgentRunHeader): AgentGraphTimelineRunRef {
  return {
    sessionId: run.sessionId,
    runId: run.runId,
    turnId: run.turnId,
  };
}

function assertRunRef(run: AgentRunHeader, sessionId: string): void {
  if (run.sessionId !== sessionId) {
    throw new Error(`AgentRun ${run.runId} belongs to ${run.sessionId}, expected ${sessionId}`);
  }
}

function recordTieBreak(record: AgentGraphRecord): string {
  return [
    String(record.orderKey.runCreatedAt).padStart(16, '0'),
    record.orderKey.operatorId,
    record.orderKey.runId,
    String(record.orderKey.committedEventOrdinal).padStart(12, '0'),
    record.orderKey.runtimeEventId,
  ].join('\0');
}

function isTerminalActivationStatus(
  status: AgentGraphActivationStatus,
): status is Extract<AgentGraphActivationStatus, 'completed' | 'failed' | 'aborted' | 'cancelled'> {
  return status !== 'running';
}

function cloneTimelineEvent(event: AgentGraphTimelineEvent): AgentGraphTimelineEvent {
  return structuredClone(event);
}

function cloneTimelineCurrentState(
  currentState: AgentGraphTimelineCurrentState,
): AgentGraphTimelineCurrentState {
  return {
    admissions: currentState.admissions.map((admission) => ({ ...admission })),
    supervisorWakes: currentState.supervisorWakes.map((wake) => ({ ...wake })),
  };
}

function assertIdentity(value: string, name: string): void {
  if (
    !value ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Invalid agent graph timeline ${name}`);
  }
}

function cursorIdentity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('invalid cursor identity');
  }
  return value;
}
