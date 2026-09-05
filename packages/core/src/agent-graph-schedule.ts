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

import type {
  AgentGraphIntentClaimRequest,
  AgentGraphIntentClaimResult,
  AgentGraphIntentClaimStore,
} from './agent-graph-control.js';
import type { AgentGraphTopologyStore } from './agent-graph-topology.js';
import type { OrchestrationMode } from './orchestration.js';

export const AGENT_GRAPH_SCHEDULE_UPDATE_SCHEMA_VERSION = 1 as const;

export const AGENT_GRAPH_SCHEDULE_MAX_ADD_WORK = 32;
export const AGENT_GRAPH_SCHEDULE_MAX_STOP = 20;
export const AGENT_GRAPH_SCHEDULE_MAX_INPUT_IDS = 64;
export const AGENT_GRAPH_SCHEDULE_MAX_SELECTED_RESULT_INPUTS = 64;
export const AGENT_GRAPH_SCHEDULE_MAX_RESULT_IDS = 64;
export const AGENT_GRAPH_SCHEDULE_MAX_INSTRUCTION_CHARS = 60_000;
export const AGENT_GRAPH_SCHEDULE_MAX_REASON_CHARS = 4_000;

export interface AgentGraphScheduleUpdateSource {
  sessionId: string;
  runId: string;
  turnId: string;
  toolCallId: string;
  /** Durable mode that created the graph; optional only on legacy updates. */
  orchestrationMode?: OrchestrationMode;
}

export type AgentGraphWorkTarget =
  | {
      kind: 'agent';
      agentId: string;
    }
  | {
      kind: 'preset';
      presetId: string;
    }
  | {
      kind: 'operator';
      operatorId: string;
    };

export interface AgentGraphScheduledWork {
  workId: string;
  target: AgentGraphWorkTarget;
  instruction: string;
  inputIds: string[];
  /** Explicit, immutable results selected from completed earlier epochs. */
  selectedResultInputs?: AgentGraphSelectedResultInput[];
  replaces?: string;
}

export interface AgentGraphSelectedResultInput {
  sourceGraphId: string;
  resultId: string;
}

export interface AgentGraphStoppedTarget {
  targetId: string;
  reason: string;
}

export interface AgentGraphScheduleFinish {
  resultIds: string[];
  reason: string;
}

/**
 * One main-agent schedule edit after the compact public tool input has been
 * normalized and assigned durable identities.
 */
export interface AgentGraphScheduleUpdateRequest {
  schemaVersion: typeof AGENT_GRAPH_SCHEDULE_UPDATE_SCHEMA_VERSION;
  updateId: string;
  updateFingerprint: string;
  graphId: string;
  source: AgentGraphScheduleUpdateSource;
  addWork: AgentGraphScheduledWork[];
  stop: AgentGraphStoppedTarget[];
  finish?: AgentGraphScheduleFinish;
}

export interface AgentGraphScheduleUpdate extends AgentGraphScheduleUpdateRequest {
  revision: number;
  committedAt: number;
}

export interface AgentGraphScheduleUpdateResult {
  update: AgentGraphScheduleUpdate;
  created: boolean;
}

export interface AgentGraphScheduleStore {
  commitAgentGraphScheduleUpdate(
    request: AgentGraphScheduleUpdateRequest,
  ): Promise<AgentGraphScheduleUpdateResult>;
  listAgentGraphScheduleUpdates(graphId: string): Promise<AgentGraphScheduleUpdate[]>;
}

export type AgentGraphIntentAdmissionState = 'claimed' | 'executing' | 'cancelled';

export interface AgentGraphIntentAdmissionTransition {
  state: AgentGraphIntentAdmissionState;
  previousState: AgentGraphIntentAdmissionState;
  changed: boolean;
}

/**
 * Raised when a reconciler tries to admit work from an observation that is no
 * longer the current durable schedule revision.
 */
export class AgentGraphScheduleRevisionConflictError extends Error {
  readonly name = 'AgentGraphScheduleRevisionConflictError';

  constructor(
    readonly graphId: string,
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `Agent graph schedule ${graphId} revision changed from ${expectedRevision} to ${currentRevision}`,
    );
  }
}

/**
 * Raised when a reconciler attempts a fresh admission after terminal closure.
 * Existing claims remain recoverable after closure.
 */
export class AgentGraphScheduleClosedError extends Error {
  readonly name = 'AgentGraphScheduleClosedError';

  constructor(readonly graphId: string) {
    super(`Agent graph schedule ${graphId} is already finished`);
  }
}

/**
 * SQLite-backed control-plane boundary used by the schedule reconciler.
 *
 * The conditional claim linearizes supervisor stop/finish updates against new
 * Runtime admission without making the Agent runtime understand graph state.
 */
export interface AgentGraphScheduleControlStore
  extends AgentGraphScheduleStore,
    AgentGraphIntentClaimStore,
    AgentGraphTopologyStore {
  claimAgentGraphIntentAtScheduleRevision(
    request: AgentGraphIntentClaimRequest,
    expectedRevision: number,
  ): Promise<AgentGraphIntentClaimResult>;
  beginAgentGraphIntentExecutionAtScheduleRevision(
    graphId: string,
    intentId: string,
    expectedRevision: number,
  ): Promise<AgentGraphIntentAdmissionTransition>;
  cancelAgentGraphIntentExecution(
    graphId: string,
    intentId: string,
    reason: string,
  ): Promise<AgentGraphIntentAdmissionTransition>;
}

export function isAgentGraphScheduleUpdateRequest(
  value: unknown,
): value is AgentGraphScheduleUpdateRequest {
  if (
    !isExactRecord(value, [
      'schemaVersion',
      'updateId',
      'updateFingerprint',
      'graphId',
      'source',
      'addWork',
      'stop',
      ...(hasOwn(value, 'finish') ? ['finish'] : []),
    ])
  ) {
    return false;
  }
  const request = value as unknown as AgentGraphScheduleUpdateRequest;
  return (
    request.schemaVersion === AGENT_GRAPH_SCHEDULE_UPDATE_SCHEMA_VERSION &&
    /^graph_update_[a-f0-9]{32}$/.test(request.updateId) &&
    isSha256Fingerprint(request.updateFingerprint) &&
    isOpaqueIdentity(request.graphId) &&
    isScheduleSource(request.source) &&
    Array.isArray(request.addWork) &&
    request.addWork.length <= AGENT_GRAPH_SCHEDULE_MAX_ADD_WORK &&
    request.addWork.every(isScheduledWork) &&
    unique(request.addWork.map((work) => work.workId)) &&
    request.addWork.reduce((count, work) => count + (work.selectedResultInputs?.length ?? 0), 0) <=
      AGENT_GRAPH_SCHEDULE_MAX_SELECTED_RESULT_INPUTS &&
    Array.isArray(request.stop) &&
    request.stop.length <= AGENT_GRAPH_SCHEDULE_MAX_STOP &&
    request.stop.every(isStoppedTarget) &&
    unique(request.stop.map((stopped) => stopped.targetId)) &&
    (request.finish === undefined || isScheduleFinish(request.finish)) &&
    request.addWork.length + request.stop.length + (request.finish ? 1 : 0) > 0 &&
    !(request.finish && request.addWork.length > 0)
  );
}

export function isAgentGraphScheduleUpdate(value: unknown): value is AgentGraphScheduleUpdate {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !hasOwn(value, 'revision') ||
    !hasOwn(value, 'committedAt')
  ) {
    return false;
  }
  const { revision, committedAt, ...request } = value as Record<string, unknown>;
  return (
    isAgentGraphScheduleUpdateRequest(request) &&
    isPositiveSafeInteger(revision) &&
    isNonNegativeSafeInteger(committedAt)
  );
}

export function assertAgentGraphScheduleUpdateRequest(
  value: unknown,
): asserts value is AgentGraphScheduleUpdateRequest {
  if (!isAgentGraphScheduleUpdateRequest(value)) {
    throw new Error('Invalid agent graph schedule update request');
  }
}

export function decodeAgentGraphScheduleUpdate(value: unknown): AgentGraphScheduleUpdate {
  if (!isAgentGraphScheduleUpdate(value)) {
    throw new Error('Invalid agent graph schedule update');
  }
  return {
    schemaVersion: value.schemaVersion,
    updateId: value.updateId,
    updateFingerprint: value.updateFingerprint,
    graphId: value.graphId,
    source: { ...value.source },
    addWork: value.addWork.map((work) => ({
      workId: work.workId,
      target: { ...work.target },
      instruction: work.instruction,
      inputIds: [...work.inputIds],
      ...(work.selectedResultInputs
        ? {
            selectedResultInputs: work.selectedResultInputs.map((input) => ({ ...input })),
          }
        : {}),
      ...(work.replaces ? { replaces: work.replaces } : {}),
    })),
    stop: value.stop.map((stopped) => ({ ...stopped })),
    ...(value.finish
      ? {
          finish: {
            resultIds: [...value.finish.resultIds],
            reason: value.finish.reason,
          },
        }
      : {}),
    revision: value.revision,
    committedAt: value.committedAt,
  };
}

function isScheduleSource(value: unknown): value is AgentGraphScheduleUpdateSource {
  return (
    isExactRecord(value, [
      'sessionId',
      'runId',
      'turnId',
      'toolCallId',
      ...(hasOwn(value, 'orchestrationMode') ? ['orchestrationMode'] : []),
    ]) &&
    isOpaqueIdentity(value.sessionId) &&
    isOpaqueIdentity(value.runId) &&
    isOpaqueIdentity(value.turnId) &&
    isOpaqueIdentity(value.toolCallId) &&
    (value.orchestrationMode === undefined ||
      value.orchestrationMode === 'default' ||
      value.orchestrationMode === 'graph' ||
      value.orchestrationMode === 'swarm')
  );
}

function isScheduledWork(value: unknown): value is AgentGraphScheduledWork {
  if (
    !isExactRecord(value, [
      'workId',
      'target',
      'instruction',
      'inputIds',
      ...(hasOwn(value, 'selectedResultInputs') ? ['selectedResultInputs'] : []),
      ...(hasOwn(value, 'replaces') ? ['replaces'] : []),
    ])
  ) {
    return false;
  }
  const inputIds = Array.isArray(value.inputIds) ? value.inputIds : [];
  return (
    typeof value.workId === 'string' &&
    /^graph_work_[a-f0-9]{32}$/.test(value.workId) &&
    isWorkTarget(value.target) &&
    isBoundedText(value.instruction, AGENT_GRAPH_SCHEDULE_MAX_INSTRUCTION_CHARS) &&
    Array.isArray(value.inputIds) &&
    inputIds.length <= AGENT_GRAPH_SCHEDULE_MAX_INPUT_IDS &&
    inputIds.every(isOpaqueIdentity) &&
    unique(inputIds) &&
    (value.selectedResultInputs === undefined ||
      (Array.isArray(value.selectedResultInputs) &&
        value.selectedResultInputs.length > 0 &&
        inputIds.length + value.selectedResultInputs.length <= AGENT_GRAPH_SCHEDULE_MAX_INPUT_IDS &&
        value.selectedResultInputs.every(isSelectedResultInput) &&
        unique(value.selectedResultInputs.map((input) => input.resultId)) &&
        value.selectedResultInputs.every((input) => !inputIds.includes(input.resultId)))) &&
    (value.replaces === undefined || isOpaqueIdentity(value.replaces))
  );
}

function isSelectedResultInput(value: unknown): value is AgentGraphSelectedResultInput {
  return (
    isExactRecord(value, ['sourceGraphId', 'resultId']) &&
    isOpaqueIdentity(value.sourceGraphId) &&
    isOpaqueIdentity(value.resultId)
  );
}

function isWorkTarget(value: unknown): value is AgentGraphWorkTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (
    isExactRecord(value, ['kind', 'agentId']) &&
    value.kind === 'agent' &&
    isOpaqueIdentity(value.agentId)
  ) {
    return true;
  }
  if (
    isExactRecord(value, ['kind', 'presetId']) &&
    value.kind === 'preset' &&
    isOpaqueIdentity(value.presetId)
  ) {
    return true;
  }
  return (
    isExactRecord(value, ['kind', 'operatorId']) &&
    value.kind === 'operator' &&
    isOpaqueIdentity(value.operatorId)
  );
}

function isStoppedTarget(value: unknown): value is AgentGraphStoppedTarget {
  return (
    isExactRecord(value, ['targetId', 'reason']) &&
    isOpaqueIdentity(value.targetId) &&
    isBoundedText(value.reason, AGENT_GRAPH_SCHEDULE_MAX_REASON_CHARS)
  );
}

function isScheduleFinish(value: unknown): value is AgentGraphScheduleFinish {
  return (
    isExactRecord(value, ['resultIds', 'reason']) &&
    Array.isArray(value.resultIds) &&
    value.resultIds.length > 0 &&
    value.resultIds.length <= AGENT_GRAPH_SCHEDULE_MAX_RESULT_IDS &&
    value.resultIds.every(isOpaqueIdentity) &&
    unique(value.resultIds) &&
    isBoundedText(value.reason, AGENT_GRAPH_SCHEDULE_MAX_REASON_CHARS)
  );
}

function isBoundedText(value: unknown, maxChars: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxChars &&
    value.trim() === value &&
    !/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

function isOpaqueIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isSha256Fingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function hasOwn(value: unknown, key: string): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
