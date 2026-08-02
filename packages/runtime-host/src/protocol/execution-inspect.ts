import {
  isAgentRunInspectDocument,
  isSessionInspectDocument,
  type AgentRunInspectDocument,
  type SessionInspectDocument,
} from '@maka/core/execution-inspect';
import {
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireShapedRecord,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const EXECUTION_INSPECT_CANDIDATE_MAX_ITEMS = 32;
export const EXECUTION_INSPECT_SESSION_MAX_RUNS = 64;
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
    };

export type ExecutionInspectQueryResult =
  | { readonly kind: 'session'; readonly document: SessionInspectDocument }
  | { readonly kind: 'agent_run'; readonly document: AgentRunInspectDocument };

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
    ['agentRunId'],
  );
  const sessionId = requireEntityId(record.sessionId, 'inspect Session id');
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
  const record = requireExactRecord(value, 'execution.inspect.query result', ['kind', 'document']);
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

function requireExecutionInspectEntityKind(value: unknown): ExecutionInspectEntityKind {
  if (value === 'session' || value === 'agent_run') return value;
  throw invalidProtocolFrame('Invalid execution inspect entity kind');
}

function requireResolveStatus(value: unknown): ExecutionInspectResolveResult['status'] {
  if (value === 'resolved' || value === 'not_found' || value === 'ambiguous') return value;
  throw invalidProtocolFrame('Invalid execution inspect resolution status');
}
