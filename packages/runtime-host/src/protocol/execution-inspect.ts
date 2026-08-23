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
  isAgentRunInspectDocument,
  isSessionInspectDocument,
  type AgentRunInspectDocument,
  type SessionInspectDocument,
} from '@maka/core/execution-inspect';
import {
  isSessionTrace,
  isTurnTrace,
  SESSION_TRACE_SCHEMA_VERSION,
  type SessionTraceCoverage,
  type TurnTrace,
} from '@maka/core/session-trace';
import {
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const EXECUTION_INSPECT_CANDIDATE_MAX_ITEMS = 32;
export const EXECUTION_INSPECT_SESSION_MAX_RUNS = 64;
export const EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS = 16;
export const EXECUTION_INSPECT_RESULT_MAX_BYTES = 48 * 1024;
export const EXECUTION_INSPECT_EVIDENCE_MAX_RECORDS = 4096;
export const EXECUTION_INSPECT_EVIDENCE_MAX_BYTES = 512 * 1024;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'invalid_request',
  'persistence_failed',
  'internal_failure',
] as const;

export type ExecutionInspectEntityKind = 'session' | 'agent_run';

export type ExecutionInspectCandidate =
  | { readonly kind: 'session'; readonly id: string }
  | { readonly kind: 'agent_run'; readonly id: string; readonly sessionId: string };

export interface ExecutionInspectResolveInput {
  readonly id: string;
  readonly requestedKind?: ExecutionInspectEntityKind;
  readonly sessionId?: string;
}

export interface ExecutionInspectResolveResult {
  readonly status: 'resolved' | 'not_found' | 'ambiguous';
  readonly candidates: readonly ExecutionInspectCandidate[];
  readonly truncated: boolean;
}

export type ExecutionInspectQueryInput =
  | { readonly kind: 'session'; readonly sessionId: string }
  | {
      readonly kind: 'agent_run';
      readonly sessionId: string;
      readonly agentRunId: string;
    }
  | { readonly kind: 'session_trace_start'; readonly sessionId: string }
  | { readonly kind: 'turn_trace'; readonly sessionId: string; readonly turnId: string }
  | {
      readonly kind: 'session_trace_continue';
      readonly sessionId: string;
      readonly cursor: string;
    };

export type ExecutionInspectQueryResult =
  | { readonly kind: 'session'; readonly document: SessionInspectDocument }
  | { readonly kind: 'agent_run'; readonly document: AgentRunInspectDocument }
  | {
      readonly kind: 'turn_trace';
      readonly sessionId: string;
      readonly turn: TurnTrace;
    }
  | {
      readonly kind: 'session_trace_page';
      readonly schemaVersion: typeof SESSION_TRACE_SCHEMA_VERSION;
      readonly sessionId: string;
      readonly turns: readonly TurnTrace[];
      readonly coverage: SessionTraceCoverage;
      readonly nextCursor: string | null;
    };

export const EXECUTION_INSPECT_OPERATION_SPECS = {
  'execution.inspect.resolve': defineOperation<
    ExecutionInspectResolveInput,
    ExecutionInspectResolveResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeExecutionInspectResolveInput,
    decodeOutput: decodeExecutionInspectResolveResult,
    assertOutputForInput: assertResolveOutputForInput,
  }),
  'execution.inspect.query': defineOperation<
    ExecutionInspectQueryInput,
    ExecutionInspectQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeExecutionInspectQueryInput,
    decodeOutput: decodeExecutionInspectQueryResult,
    assertOutputForInput: assertQueryOutputForInput,
  }),
} as const;

export function decodeExecutionInspectResolveInput(value: unknown): ExecutionInspectResolveInput {
  const record = requireShapedRecord(
    value,
    'execution.inspect.resolve input',
    ['id'],
    ['requestedKind', 'sessionId'],
  );
  const requestedKind =
    record.requestedKind === undefined
      ? undefined
      : requireExecutionInspectEntityKind(record.requestedKind);
  const sessionId =
    record.sessionId === undefined
      ? undefined
      : requireEntityId(record.sessionId, 'inspect Session id');
  if (sessionId !== undefined && requestedKind !== 'agent_run') {
    throw invalidProtocolFrame('Inspect Session filter requires AgentRun kind');
  }
  return {
    id: requireEntityId(record.id, 'inspect target id'),
    ...(requestedKind ? { requestedKind } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

export function decodeExecutionInspectResolveResult(value: unknown): ExecutionInspectResolveResult {
  requireEncodedByteLimit(
    value,
    'execution.inspect.resolve result',
    EXECUTION_INSPECT_RESULT_MAX_BYTES,
  );
  const record = requireExactRecord(value, 'execution.inspect.resolve result', [
    'status',
    'candidates',
    'truncated',
  ]);
  if (!Array.isArray(record.candidates)) {
    throw invalidProtocolFrame('Invalid execution inspect candidates');
  }
  if (record.candidates.length > EXECUTION_INSPECT_CANDIDATE_MAX_ITEMS) {
    throw invalidProtocolFrame('Execution inspect candidate page exceeds its item limit');
  }
  if (typeof record.truncated !== 'boolean') {
    throw invalidProtocolFrame('Invalid execution inspect candidate truncation');
  }
  const status = requireResolveStatus(record.status);
  const candidates = record.candidates.map(decodeExecutionInspectCandidate);
  const expectedStatus =
    candidates.length === 0 && !record.truncated
      ? 'not_found'
      : candidates.length === 1 && !record.truncated
        ? 'resolved'
        : 'ambiguous';
  if (status !== expectedStatus) {
    throw invalidProtocolFrame('Execution inspect resolution status does not match candidates');
  }
  return { status, candidates, truncated: record.truncated };
}

export function decodeExecutionInspectQueryInput(value: unknown): ExecutionInspectQueryInput {
  const record = requireShapedRecord(
    value,
    'execution.inspect.query input',
    ['kind', 'sessionId'],
    ['agentRunId', 'turnId', 'cursor'],
  );
  const sessionId = requireEntityId(record.sessionId, 'inspect Session id');
  if (record.kind === 'turn_trace') {
    requireExactRecord(record, 'Turn trace query', ['kind', 'sessionId', 'turnId']);
    return {
      kind: 'turn_trace',
      sessionId,
      turnId: requireEntityId(record.turnId, 'trace Turn id'),
    };
  }
  if (record.kind === 'session_trace_start') {
    requireExactRecord(record, 'Session trace start query', ['kind', 'sessionId']);
    return { kind: 'session_trace_start', sessionId };
  }
  if (record.kind === 'session_trace_continue') {
    const exact = requireExactRecord(record, 'Session trace continuation query', [
      'kind',
      'sessionId',
      'cursor',
    ]);
    return {
      kind: 'session_trace_continue',
      sessionId,
      cursor: requireTraceCursor(exact.cursor),
    };
  }
  if (record.kind === 'session') {
    requireExactRecord(record, 'Session inspect query', ['kind', 'sessionId']);
    return { kind: 'session', sessionId };
  }
  if (record.kind === 'agent_run') {
    requireExactRecord(record, 'AgentRun inspect query', ['kind', 'sessionId', 'agentRunId']);
    return {
      kind: 'agent_run',
      sessionId,
      agentRunId: requireEntityId(record.agentRunId, 'inspect AgentRun id'),
    };
  }
  throw invalidProtocolFrame('Invalid execution inspect query kind');
}

export function decodeExecutionInspectQueryResult(value: unknown): ExecutionInspectQueryResult {
  requireEncodedByteLimit(
    value,
    'execution.inspect.query result',
    EXECUTION_INSPECT_RESULT_MAX_BYTES,
  );
  const shaped = requireShapedRecord(
    value,
    'execution.inspect.query result',
    ['kind'],
    ['document', 'schemaVersion', 'sessionId', 'turns', 'coverage', 'nextCursor', 'turn'],
  );
  if (shaped.kind === 'turn_trace') {
    const record = requireExactRecord(shaped, 'Turn trace result', ['kind', 'sessionId', 'turn']);
    const sessionId = requireEntityId(record.sessionId, 'trace Session id');
    if (!isTurnTrace(record.turn)) {
      throw invalidProtocolFrame('Invalid Turn trace');
    }
    return { kind: 'turn_trace', sessionId, turn: record.turn };
  }
  if (shaped.kind === 'session_trace_page') {
    const record = requireExactRecord(shaped, 'Session trace page result', [
      'kind',
      'schemaVersion',
      'sessionId',
      'turns',
      'coverage',
      'nextCursor',
    ]);
    const sessionId = requireEntityId(record.sessionId, 'trace Session id');
    const decodedTrace = {
      schemaVersion: record.schemaVersion,
      sessionId,
      turns: record.turns,
      coverage: record.coverage,
    };
    if (
      !Array.isArray(record.turns) ||
      record.turns.length > EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS ||
      !isSessionTrace(decodedTrace)
    ) {
      throw invalidProtocolFrame('Invalid Session trace page');
    }
    const nextCursor = record.nextCursor === null ? null : requireTraceCursor(record.nextCursor);
    return {
      kind: 'session_trace_page',
      schemaVersion: SESSION_TRACE_SCHEMA_VERSION,
      sessionId,
      turns: decodedTrace.turns,
      coverage: decodedTrace.coverage,
      nextCursor,
    };
  }
  const record = requireExactRecord(shaped, 'execution.inspect.query result', ['kind', 'document']);
  if (record.kind === 'session') {
    if (
      !isSessionInspectDocument(record.document) ||
      record.document.agentRuns.length > EXECUTION_INSPECT_SESSION_MAX_RUNS
    ) {
      throw invalidProtocolFrame('Invalid Session inspect document');
    }
    return { kind: 'session', document: record.document };
  }
  if (record.kind === 'agent_run') {
    if (!isAgentRunInspectDocument(record.document)) {
      throw invalidProtocolFrame('Invalid AgentRun inspect document');
    }
    return { kind: 'agent_run', document: record.document };
  }
  throw invalidProtocolFrame('Invalid execution inspect query result kind');
}

function decodeExecutionInspectCandidate(value: unknown): ExecutionInspectCandidate {
  const record = requireShapedRecord(
    value,
    'execution inspect candidate',
    ['kind', 'id'],
    ['sessionId'],
  );
  const kind = requireExecutionInspectEntityKind(record.kind);
  const sessionId =
    record.sessionId === undefined
      ? undefined
      : requireEntityId(record.sessionId, 'candidate Session id');
  const id = requireEntityId(record.id, 'candidate id');
  if (kind === 'agent_run') {
    if (sessionId === undefined) {
      throw invalidProtocolFrame('AgentRun inspect candidate requires a Session identity');
    }
    return { kind, id, sessionId };
  }
  if (sessionId !== undefined) {
    throw invalidProtocolFrame(
      'Session inspect candidate cannot include a parent Session identity',
    );
  }
  return { kind, id };
}

function assertResolveOutputForInput(
  input: ExecutionInspectResolveInput,
  output: ExecutionInspectResolveResult,
): void {
  for (const candidate of output.candidates) {
    if (
      candidate.id !== input.id ||
      (input.requestedKind !== undefined && candidate.kind !== input.requestedKind) ||
      (input.sessionId !== undefined &&
        (candidate.kind !== 'agent_run' || candidate.sessionId !== input.sessionId))
    ) {
      throw invalidProtocolFrame('Execution inspect resolution changed request identity');
    }
  }
}

function assertQueryOutputForInput(
  input: ExecutionInspectQueryInput,
  output: ExecutionInspectQueryResult,
): void {
  if (input.kind === 'turn_trace') {
    if (
      output.kind !== 'turn_trace' ||
      output.sessionId !== input.sessionId ||
      output.turn.turnId !== input.turnId
    ) {
      throw invalidProtocolFrame('Turn trace result changed request identity');
    }
    return;
  }
  if (input.kind === 'session_trace_start' || input.kind === 'session_trace_continue') {
    if (output.kind !== 'session_trace_page' || output.sessionId !== input.sessionId) {
      throw invalidProtocolFrame('Session trace result changed request identity');
    }
    return;
  }
  if (input.kind === 'session') {
    if (output.kind !== 'session' || output.document.session.sessionId !== input.sessionId) {
      throw invalidProtocolFrame('Session inspect result changed request identity');
    }
    return;
  }
  if (
    output.kind !== 'agent_run' ||
    output.document.agentRun.sessionId !== input.sessionId ||
    output.document.agentRun.agentRunId !== input.agentRunId
  ) {
    throw invalidProtocolFrame('AgentRun inspect result changed request identity');
  }
}

function requireTraceCursor(value: unknown): string {
  const cursor = requireUtf8String(value, 'Session trace cursor', 512);
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw invalidProtocolFrame('Invalid Session trace cursor');
  }
  return cursor;
}

function requireExecutionInspectEntityKind(value: unknown): ExecutionInspectEntityKind {
  if (value === 'session' || value === 'agent_run') return value;
  throw invalidProtocolFrame('Invalid execution inspect entity kind');
}

function requireResolveStatus(value: unknown): ExecutionInspectResolveResult['status'] {
  if (value === 'resolved' || value === 'not_found' || value === 'ambiguous') return value;
  throw invalidProtocolFrame('Invalid execution inspect resolution status');
}
