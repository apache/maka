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
