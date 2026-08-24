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

import type { AgentRunHeader, AgentRunStore } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import { isSessionInlineRun } from '@maka/core/agent-run';
import { stableHash, stableStringify } from './request-shape.js';
import { compareAgentGraphIdentity } from './stream-graph-identity.js';

export const AGENT_GRAPH_RECORD_SCHEMA_VERSION = 1 as const;

export const AGENT_GRAPH_RECORD_FACETS = [
  'message',
  'thinking',
  'error',
  'tool_call',
  'tool_dispatch',
  'tool_result',
  'artifact_update',
  'permission_request',
  'permission_decision',
  'user_question_request',
  'transfer',
  'usage',
  'completed',
  'failed',
  'aborted',
  'cancelled',
  'runtime_fact',
] as const;

export type AgentGraphRecordFacet = (typeof AGENT_GRAPH_RECORD_FACETS)[number];

export type AgentGraphActivationStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'cancelled';

export type AgentGraphSupervisorAttentionReason = 'permission_request' | 'user_question_request';

export type AgentGraphSupervisorSignal =
  | {
      kind: 'attention';
      reason: AgentGraphSupervisorAttentionReason;
    }
  | {
      kind: 'terminal';
      status: Extract<AgentGraphActivationStatus, 'completed' | 'failed' | 'aborted' | 'cancelled'>;
    };

/**
 * Read-only binding between a graph operator and an existing durable Session.
 *
 * The graph does not own the Session or its RuntimeEvents. Each session-inline
 * AgentRun is projected as one activation while the Session remains the stable
 * operator execution identity across follow-ups and recovery.
 */
export interface AgentGraphOperatorBinding {
  operatorId: string;
  sessionId: string;
}

export interface AgentGraphRuntimeEventSource {
  kind: 'runtime_event';
  runtimeEventId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  ts: number;
}

/**
 * Stable tie-break metadata for records with the same immutable event time.
 *
 * `committedEventOrdinal` is counted after partial rows are excluded, so
 * legacy partial-row retention or migration cannot renumber committed facts.
 */
export interface AgentGraphRecordOrderKey {
  runCreatedAt: number;
  operatorId: string;
  runId: string;
  committedEventOrdinal: number;
  runtimeEventId: string;
}

/**
 * A bounded reference-only record projected from one committed RuntimeEvent.
 *
 * The source RuntimeEvent remains authoritative. The graph record deliberately
 * does not copy message/tool payloads, and `partial: true` events never enter
 * this stream. Every record is also part of the always-on main-agent supervisor
 * meta-stream; `supervisorSignals` marks facts that require semantic attention
 * without putting the supervisor on the downstream data path.
 */
export interface AgentGraphRecord {
  schemaVersion: typeof AGENT_GRAPH_RECORD_SCHEMA_VERSION;
  recordId: string;
  graphId: string;
  operatorId: string;
  activationId: string;
  sessionId: string;
  agentRunId: string;
  eventTime: number;
  orderKey: AgentGraphRecordOrderKey;
  previousRecordId?: string;
  type: 'agent_runtime_event';
  facets: AgentGraphRecordFacet[];
  supervisorSignals: AgentGraphSupervisorSignal[];
  source: AgentGraphRuntimeEventSource;
}

/**
 * Bounded always-on view consumed by the main-agent supervisor.
 *
 * It reuses the graph record identity and source reference, so it is a routing
 * projection rather than a second fact. Empty `signals` still carries normal
 * activity to the supervisor; non-empty signals mark semantic attention or a
 * terminal milestone.
 */
export interface AgentGraphSupervisorMetaRecord {
  recordId: string;
  graphId: string;
  operatorId: string;
  activationId: string;
  eventTime: number;
  orderKey: AgentGraphRecordOrderKey;
  facets: AgentGraphRecordFacet[];
  signals: AgentGraphSupervisorSignal[];
  source: AgentGraphRuntimeEventSource;
}

export interface AgentGraphActivationState {
  activationId: string;
  agentRunId: string;
  status: AgentGraphActivationStatus;
  recordCount: number;
  firstEventTime: number;
  lastEventTime: number;
  lastRecordId: string;
  terminalRecordId?: string;
}

export interface AgentGraphOperatorState {
  operatorId: string;
  sessionId: string;
  status: AgentGraphActivationStatus;
  currentActivationId: string;
  activations: Record<string, AgentGraphActivationState>;
}

/**
 * Deterministic trace state only. It intentionally has no graph-wide
 * completion flag: topology closure and admission closure require a later
 * control protocol and cannot be inferred from observed Agent runs alone.
 */
export interface AgentGraphReplayState {
  graphId: string;
  latestEventTime?: number;
  appliedRecordIds: string[];
  operators: Record<string, AgentGraphOperatorState>;
}

export interface AgentGraphRunStream {
  operator: AgentGraphOperatorBinding;
  run: AgentRunHeader;
  events: readonly RuntimeEvent[];
}

export interface ProjectAgentGraphRecordsInput {
  graphId: string;
  streams: readonly AgentGraphRunStream[];
}

export interface AgentGraphProjection {
  graphId: string;
  operators: AgentGraphOperatorBinding[];
  ignoredPartialEvents: number;
  records: AgentGraphRecord[];
  supervisorMetaStream: AgentGraphSupervisorMetaRecord[];
  state: AgentGraphReplayState;
}

export interface ReadCommittedAgentGraphProjectionInput {
  graphId: string;
  operators: readonly AgentGraphOperatorBinding[];
  runStore: Pick<AgentRunStore, 'listSessionRuns'>;
  runtimeEventStore: Pick<RuntimeEventStore, 'readImmutableRuntimeEvents'>;
}

export interface AgentGraphProjectionWithRuns {
  projection: AgentGraphProjection;
  runs: AgentRunHeader[];
}

interface OrderedRuntimeEvent {
  operator: AgentGraphOperatorBinding;
  run: AgentRunHeader;
  event: RuntimeEvent;
  committedEventOrdinal: number;
}

interface MutableAgentGraphOperatorState extends Omit<AgentGraphOperatorState, 'activations'> {
  activations: Map<string, AgentGraphActivationState>;
}

export async function readCommittedAgentGraphProjection(
  input: ReadCommittedAgentGraphProjectionInput,
): Promise<AgentGraphProjection> {
  return (await readCommittedAgentGraphProjectionWithRuns(input)).projection;
}

export async function readCommittedAgentGraphProjectionWithRuns(
  input: ReadCommittedAgentGraphProjectionInput,
): Promise<AgentGraphProjectionWithRuns> {
  assertGraphIdentity(input.graphId, input.operators);
  const readImmutableRuntimeEvents = input.runtimeEventStore.readImmutableRuntimeEvents;
  if (!readImmutableRuntimeEvents) {
    throw new Error('Committed graph projection requires immutable RuntimeEvent reads');
  }

  const streams = (
    await Promise.all(
      input.operators.map(async (operator) => {
        const runs = await input.runStore.listSessionRuns(operator.sessionId);
        const orderedRuns = runs
          .filter(isSessionInlineRun)
          .sort((a, b) => a.createdAt - b.createdAt || compareAgentGraphIdentity(a.runId, b.runId));
        return await Promise.all(
          orderedRuns.map(async (run): Promise<AgentGraphRunStream> => {
            if (run.sessionId !== operator.sessionId) {
              throw new Error(
                `Run ${run.runId} belongs to ${run.sessionId}, expected ${operator.sessionId}`,
              );
            }
            return {
              operator,
              run,
              events: await readImmutableRuntimeEvents.call(
                input.runtimeEventStore,
                operator.sessionId,
                run.runId,
              ),
            };
          }),
        );
      }),
    )
  ).flat();

  const projected = projectAgentGraphRecords({ graphId: input.graphId, streams });
  const state =
    projected.records.length > 0
      ? replayAgentGraphRecords(projected.records)
      : { graphId: input.graphId, appliedRecordIds: [], operators: {} };
  return {
    runs: streams.map((stream) => ({ ...stream.run })),
    projection: {
      graphId: input.graphId,
      operators: input.operators.map((operator) => ({ ...operator })),
      ignoredPartialEvents: projected.ignoredPartialEvents,
      records: projected.records,
      supervisorMetaStream: projected.supervisorMetaStream,
      state,
    },
  };
}

export function projectAgentGraphRecords(input: ProjectAgentGraphRecordsInput): {
  ignoredPartialEvents: number;
  records: AgentGraphRecord[];
  supervisorMetaStream: AgentGraphSupervisorMetaRecord[];
} {
  const operators = uniqueBindings(input.streams.map((stream) => stream.operator));
  assertGraphIdentity(input.graphId, operators);

  const ordered: OrderedRuntimeEvent[] = [];
  let ignoredPartialEvents = 0;
  const sourceEventIds = new Set<string>();

  for (const stream of input.streams) {
    assertRunStream(stream);
    let committedEventOrdinal = 0;
    for (const event of stream.events) {
      assertRuntimeEventIdentity(stream, event);
      if (event.partial) {
        ignoredPartialEvents += 1;
        continue;
      }
      if (sourceEventIds.has(event.id)) {
        throw new Error(
          `RuntimeEvent ${event.id} is bound more than once in graph ${input.graphId}`,
        );
      }
      sourceEventIds.add(event.id);
      ordered.push({
        operator: stream.operator,
        run: stream.run,
        event,
        committedEventOrdinal,
      });
      committedEventOrdinal += 1;
    }
  }

  ordered.sort(compareOrderedRuntimeEvents);

  const previousByActivation = new Map<string, string>();
  const records = ordered.map((item): AgentGraphRecord => {
    const activationId = item.run.runId;
    const activationKey = `${item.operator.operatorId}\0${activationId}`;
    const previousRecordId = previousByActivation.get(activationKey);
    const recordId = graphRecordId({
      graphId: input.graphId,
      operatorId: item.operator.operatorId,
      sessionId: item.operator.sessionId,
      runId: item.run.runId,
      runtimeEventId: item.event.id,
    });
    previousByActivation.set(activationKey, recordId);
    return {
      schemaVersion: AGENT_GRAPH_RECORD_SCHEMA_VERSION,
      recordId,
      graphId: input.graphId,
      operatorId: item.operator.operatorId,
      activationId,
      sessionId: item.operator.sessionId,
      agentRunId: item.run.runId,
      eventTime: item.event.ts,
      orderKey: {
        runCreatedAt: item.run.createdAt,
        operatorId: item.operator.operatorId,
        runId: item.run.runId,
        committedEventOrdinal: item.committedEventOrdinal,
        runtimeEventId: item.event.id,
      },
      ...(previousRecordId ? { previousRecordId } : {}),
      type: 'agent_runtime_event',
      facets: runtimeEventFacets(item.event, item.run),
      supervisorSignals: runtimeEventSupervisorSignals(item.event, item.run),
      source: {
        kind: 'runtime_event',
        runtimeEventId: item.event.id,
        sessionId: item.event.sessionId,
        runId: item.event.runId,
        turnId: item.event.turnId,
        ts: item.event.ts,
      },
    };
  });

  return {
    ignoredPartialEvents,
    records,
    supervisorMetaStream: records.map(projectSupervisorMetaRecord),
  };
}

function projectSupervisorMetaRecord(record: AgentGraphRecord): AgentGraphSupervisorMetaRecord {
  return {
    recordId: record.recordId,
    graphId: record.graphId,
    operatorId: record.operatorId,
    activationId: record.activationId,
    eventTime: record.eventTime,
    orderKey: { ...record.orderKey },
    facets: [...record.facets],
    signals: record.supervisorSignals.map((signal) => ({ ...signal })),
    source: { ...record.source },
  };
}

export function replayAgentGraphRecords(
  records: readonly AgentGraphRecord[],
): AgentGraphReplayState {
  if (records.length === 0) {
    return { graphId: '', appliedRecordIds: [], operators: {} };
  }

  const uniqueRecords = new Map<string, AgentGraphRecord>();
  for (const record of records) {
    const existing = uniqueRecords.get(record.recordId);
    if (existing) {
      if (stableStringify(existing) !== stableStringify(record)) {
        throw new Error(`Conflicting graph record ${record.recordId}`);
      }
      continue;
    }
    uniqueRecords.set(record.recordId, record);
  }

  const ordered = [...uniqueRecords.values()].sort(compareAgentGraphRecords);
  const graphId = ordered[0]!.graphId;
  const operatorsById = new Map<string, MutableAgentGraphOperatorState>();
  const operatorBySession = new Map<string, string>();

  for (const record of ordered) {
    assertReplayRecord(record, graphId);
    const sessionOwner = operatorBySession.get(record.sessionId);
    if (sessionOwner && sessionOwner !== record.operatorId) {
      throw new Error(
        `Session ${record.sessionId} is bound to both ${sessionOwner} and ${record.operatorId}`,
      );
    }
    operatorBySession.set(record.sessionId, record.operatorId);

    let operator = operatorsById.get(record.operatorId);
    if (!operator) {
      operator = {
        operatorId: record.operatorId,
        sessionId: record.sessionId,
        status: 'running',
        currentActivationId: record.activationId,
        activations: new Map(),
      };
      operatorsById.set(record.operatorId, operator);
    } else if (operator.sessionId !== record.sessionId) {
      throw new Error(
        `Operator ${record.operatorId} is bound to both ${operator.sessionId} and ${record.sessionId}`,
      );
    }

    let activation = operator.activations.get(record.activationId);
    if (!activation) {
      activation = {
        activationId: record.activationId,
        agentRunId: record.agentRunId,
        status: 'running',
        recordCount: 0,
        firstEventTime: record.eventTime,
        lastEventTime: record.eventTime,
        lastRecordId: record.recordId,
      };
      operator.activations.set(record.activationId, activation);
    } else {
      if (activation.agentRunId !== record.agentRunId) {
        throw new Error(`Activation ${record.activationId} references multiple AgentRuns`);
      }
      if (activation.terminalRecordId) {
        throw new Error(
          `Graph record ${record.recordId} appears after terminal record ${activation.terminalRecordId}`,
        );
      }
    }

    const status = activationStatusAfterRecord(record.facets);
    activation.status = status;
    activation.recordCount += 1;
    activation.lastEventTime = record.eventTime;
    activation.lastRecordId = record.recordId;
    if (isTerminalActivationStatus(status)) {
      activation.terminalRecordId = record.recordId;
    }

    operator.currentActivationId = activation.activationId;
    operator.status = activation.status;
  }

  const operators: Record<string, AgentGraphOperatorState> = Object.fromEntries(
    [...operatorsById].map(([operatorId, operator]) => {
      const { activations, ...operatorState } = operator;
      return [
        operatorId,
        {
          ...operatorState,
          activations: Object.fromEntries(activations),
        },
      ];
    }),
  );

  return {
    graphId,
    latestEventTime: ordered.at(-1)!.eventTime,
    appliedRecordIds: ordered.map((record) => record.recordId),
    operators,
  };
}

function runtimeEventFacets(event: RuntimeEvent, run: AgentRunHeader): AgentGraphRecordFacet[] {
  const facets: AgentGraphRecordFacet[] = [];
  switch (event.content?.kind) {
    case 'text':
      facets.push('message');
      break;
    case 'thinking':
      facets.push('thinking');
      break;
    case 'error':
      facets.push('error');
      break;
    case 'function_call':
      facets.push('tool_call');
      break;
    case 'function_response':
      facets.push('tool_result');
      break;
  }

  const actions = event.actions;
  if (actions?.toolDispatch) facets.push('tool_dispatch');
  if (actions?.artifactDelta) facets.push('artifact_update');
  if (actions?.permissionRequest) facets.push('permission_request');
  if (actions?.permissionDecision) facets.push('permission_decision');
  if (actions?.userQuestionRequest) facets.push('user_question_request');
  if (actions?.transferToAgent) facets.push('transfer');
  if (actions?.tokenUsage) facets.push('usage');

  const terminalStatus = runtimeEventTerminalStatus(event, run);
  if (terminalStatus) facets.push(terminalStatus);
  if (facets.length === 0) facets.push('runtime_fact');
  return facets;
}

function runtimeEventSupervisorSignals(
  event: RuntimeEvent,
  run: AgentRunHeader,
): AgentGraphSupervisorSignal[] {
  const signals: AgentGraphSupervisorSignal[] = [];
  if (event.actions?.permissionRequest) {
    signals.push({ kind: 'attention', reason: 'permission_request' });
  }
  if (event.actions?.userQuestionRequest) {
    signals.push({ kind: 'attention', reason: 'user_question_request' });
  }
  const terminalStatus = runtimeEventTerminalStatus(event, run);
  if (terminalStatus) {
    signals.push({ kind: 'terminal', status: terminalStatus });
  }
  return signals;
}

function runtimeEventTerminalStatus(
  event: RuntimeEvent,
  run: AgentRunHeader,
):
  | Extract<AgentGraphActivationStatus, 'completed' | 'failed' | 'aborted' | 'cancelled'>
  | undefined {
  if (
    event.status === 'completed' ||
    event.status === 'failed' ||
    event.status === 'aborted' ||
    event.status === 'cancelled'
  ) {
    return event.status;
  }
  return event.actions?.endInvocation ? terminalStatusFromRun(run) : undefined;
}

function terminalStatusFromRun(
  run: AgentRunHeader,
): Extract<AgentGraphRecordFacet, 'completed' | 'failed' | 'cancelled'> {
  switch (run.status) {
    case 'completed':
    case 'failed':
    case 'cancelled':
      return run.status;
    default:
      throw new Error(
        `RuntimeEvent ended invocation ${run.runId} while its AgentRun is ${run.status}`,
      );
  }
}

function activationStatusAfterRecord(
  facets: readonly AgentGraphRecordFacet[],
): AgentGraphActivationStatus {
  const terminal = terminalStatusFromFacets(facets);
  return terminal ?? 'running';
}

function terminalStatusFromFacets(
  facets: readonly AgentGraphRecordFacet[],
):
  | Extract<AgentGraphActivationStatus, 'completed' | 'failed' | 'aborted' | 'cancelled'>
  | undefined {
  const terminal = facets.filter(
    (
      facet,
    ): facet is Extract<AgentGraphRecordFacet, 'completed' | 'failed' | 'aborted' | 'cancelled'> =>
      facet === 'completed' || facet === 'failed' || facet === 'aborted' || facet === 'cancelled',
  );
  if (terminal.length > 1) {
    throw new Error(`Graph record carries conflicting terminal facets: ${terminal.join(', ')}`);
  }
  return terminal[0];
}

function isTerminalActivationStatus(status: AgentGraphActivationStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'aborted' || status === 'cancelled'
  );
}

function uniqueBindings(
  operators: readonly AgentGraphOperatorBinding[],
): AgentGraphOperatorBinding[] {
  const byOperator = new Map<string, AgentGraphOperatorBinding>();
  for (const operator of operators) {
    const existing = byOperator.get(operator.operatorId);
    if (existing && existing.sessionId !== operator.sessionId) {
      throw new Error(
        `Operator ${operator.operatorId} is bound to both ${existing.sessionId} and ${operator.sessionId}`,
      );
    }
    byOperator.set(operator.operatorId, operator);
  }
  return [...byOperator.values()];
}

function assertGraphIdentity(
  graphId: string,
  operators: readonly AgentGraphOperatorBinding[],
): void {
  if (!graphId.trim()) throw new Error('Graph id must not be empty');
  const operatorIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const operator of operators) {
    if (!operator.operatorId.trim()) throw new Error('Operator id must not be empty');
    if (!operator.sessionId.trim()) throw new Error('Operator session id must not be empty');
    if (operatorIds.has(operator.operatorId)) {
      throw new Error(`Duplicate graph operator ${operator.operatorId}`);
    }
    if (sessionIds.has(operator.sessionId)) {
      throw new Error(`Session ${operator.sessionId} is bound to multiple graph operators`);
    }
    operatorIds.add(operator.operatorId);
    sessionIds.add(operator.sessionId);
  }
}

function assertRunStream(stream: AgentGraphRunStream): void {
  if (stream.run.sessionId !== stream.operator.sessionId) {
    throw new Error(
      `Run ${stream.run.runId} belongs to ${stream.run.sessionId}, expected ${stream.operator.sessionId}`,
    );
  }
  if (!isSessionInlineRun(stream.run)) {
    throw new Error(`Graph activation ${stream.run.runId} must be a session-inline AgentRun`);
  }
}

function assertRuntimeEventIdentity(stream: AgentGraphRunStream, event: RuntimeEvent): void {
  if (
    event.sessionId !== stream.operator.sessionId ||
    event.runId !== stream.run.runId ||
    event.turnId !== stream.run.turnId
  ) {
    throw new Error(
      `RuntimeEvent ${event.id} does not belong to ${stream.operator.sessionId}/${stream.run.runId}/${stream.run.turnId}`,
    );
  }
}

function compareOrderedRuntimeEvents(a: OrderedRuntimeEvent, b: OrderedRuntimeEvent): number {
  return (
    a.event.ts - b.event.ts ||
    a.run.createdAt - b.run.createdAt ||
    compareAgentGraphIdentity(a.operator.operatorId, b.operator.operatorId) ||
    compareAgentGraphIdentity(a.run.runId, b.run.runId) ||
    a.committedEventOrdinal - b.committedEventOrdinal ||
    compareAgentGraphIdentity(a.event.id, b.event.id)
  );
}

function compareAgentGraphRecords(a: AgentGraphRecord, b: AgentGraphRecord): number {
  return (
    a.eventTime - b.eventTime ||
    a.orderKey.runCreatedAt - b.orderKey.runCreatedAt ||
    compareAgentGraphIdentity(a.orderKey.operatorId, b.orderKey.operatorId) ||
    compareAgentGraphIdentity(a.orderKey.runId, b.orderKey.runId) ||
    a.orderKey.committedEventOrdinal - b.orderKey.committedEventOrdinal ||
    compareAgentGraphIdentity(a.orderKey.runtimeEventId, b.orderKey.runtimeEventId) ||
    compareAgentGraphIdentity(a.recordId, b.recordId)
  );
}

function graphRecordId(input: {
  graphId: string;
  operatorId: string;
  sessionId: string;
  runId: string;
  runtimeEventId: string;
}): string {
  return `graph_record_${stableHash(input).slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

function assertReplayRecord(record: AgentGraphRecord, graphId: string): void {
  if (record.schemaVersion !== AGENT_GRAPH_RECORD_SCHEMA_VERSION) {
    throw new Error(`Unsupported graph record schema ${record.schemaVersion}`);
  }
  if (record.graphId !== graphId) {
    throw new Error(`Cannot replay records from graphs ${graphId} and ${record.graphId} together`);
  }
  if (!Number.isFinite(record.eventTime)) {
    throw new Error(`Invalid event time on graph record ${record.recordId}`);
  }
  if (
    record.source.sessionId !== record.sessionId ||
    record.source.runId !== record.agentRunId ||
    record.activationId !== record.agentRunId ||
    record.source.ts !== record.eventTime ||
    record.orderKey.operatorId !== record.operatorId ||
    record.orderKey.runId !== record.agentRunId ||
    record.orderKey.runtimeEventId !== record.source.runtimeEventId ||
    !Number.isFinite(record.orderKey.runCreatedAt) ||
    !Number.isSafeInteger(record.orderKey.committedEventOrdinal) ||
    record.orderKey.committedEventOrdinal < 0
  ) {
    throw new Error(`Invalid source identity on graph record ${record.recordId}`);
  }
  terminalStatusFromFacets(record.facets);
  for (const signal of record.supervisorSignals) {
    if (signal.kind === 'attention' && !record.facets.includes(signal.reason)) {
      throw new Error(`Supervisor signal does not match graph record ${record.recordId}`);
    }
    if (signal.kind === 'terminal' && !record.facets.includes(signal.status)) {
      throw new Error(`Supervisor terminal does not match graph record ${record.recordId}`);
    }
  }
}
