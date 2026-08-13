import { AGENT_RUN_STATUSES, type AgentRunHeader } from './agent-run.js';
import { EXECUTION_LOG_LEDGERS, type ExecutionLogCoverage } from './execution-log-coverage.js';
import { SESSION_STATUSES, type SessionHeader } from './session.js';

export const AGENT_RUN_INSPECT_DOCUMENT_VERSION = 'maka.agent_run_inspect.v1' as const;
export const SESSION_INSPECT_DOCUMENT_VERSION = 'maka.session_inspect.v1' as const;

export type ExecutionInspectSeverity = 'error' | 'warning' | 'info';

export interface ExecutionInspectDiagnostic {
  severity: ExecutionInspectSeverity;
  code: string;
  message: string;
  sessionId: string;
  agentRunId?: string;
  turnId?: string;
  eventId?: string;
}

export interface AgentRunInspectIdentity {
  sessionId: string;
  agentRunId: string;
  invocationId?: string;
  turnId: string;
  parentRunId?: string;
  resumedFromRunId?: string;
  retriedFromRunId?: string;
  parentTurnId?: string;
  agentId?: string;
  status: AgentRunHeader['status'];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  failureClass?: string;
  abortSource?: string;
}

export interface AgentRunInspectToolFact {
  toolCallId: string;
  toolName: string;
  eventId: string;
}

export interface AgentRunInspectToolSummary {
  callCount: number;
  responseCount: number;
  errorResponseCount: number;
  callsWithoutResponse: AgentRunInspectToolFact[];
  responsesWithoutCall: AgentRunInspectToolFact[];
}

export interface AgentRunInspectCompactionCheckpoint {
  eventId: string;
  validation: 'shape_valid' | 'invalid';
  checkpointId?: string;
  policyVersion?: string;
  sourceCoverage?: ExecutionLogCoverage;
}

export interface AgentRunInspectSourceHealth {
  runtimeLedger: 'present' | 'missing' | 'read_failed';
  runtimeTerminalPresent: boolean;
  operationalTerminalPresent: boolean;
  statusConsistency: 'consistent' | 'inconsistent' | 'incomplete';
}

export interface AgentRunInspectDocument {
  schemaVersion: typeof AGENT_RUN_INSPECT_DOCUMENT_VERSION;
  kind: 'agent_run';
  agentRun: AgentRunInspectIdentity;
  sources: {
    operationalEventCount: number;
    runtimeEventCount: number;
    runtimeCoverage?: ExecutionLogCoverage;
    health: AgentRunInspectSourceHealth;
  };
  tools: AgentRunInspectToolSummary;
  compactionCheckpoints: AgentRunInspectCompactionCheckpoint[];
  diagnostics: ExecutionInspectDiagnostic[];
}

export interface SessionInspectSummary {
  sessionId: string;
  name: string;
  status: SessionHeader['status'];
  createdAt: number;
  lastUsedAt: number;
  lastMessageAt?: number;
  isArchived: boolean;
  parentSessionId?: string;
  branchOfTurnId?: string;
  revisionRootSessionId?: string;
  revisionParentSessionId?: string;
  revisionOfTurnId?: string;
  revisionIndex?: number;
  revisionState?: 'preparing' | 'committed';
}

export interface SessionInspectDocument {
  schemaVersion: typeof SESSION_INSPECT_DOCUMENT_VERSION;
  kind: 'session';
  session: SessionInspectSummary;
  agentRuns: AgentRunInspectDocument[];
  diagnostics: ExecutionInspectDiagnostic[];
}

export function isAgentRunInspectDocument(value: unknown): value is AgentRunInspectDocument {
  if (
    !hasShape(
      value,
      [
        'schemaVersion',
        'kind',
        'agentRun',
        'sources',
        'tools',
        'compactionCheckpoints',
        'diagnostics',
      ],
      [],
    ) ||
    value.schemaVersion !== AGENT_RUN_INSPECT_DOCUMENT_VERSION ||
    value.kind !== 'agent_run' ||
    !isAgentRunIdentity(value.agentRun) ||
    !isAgentRunSources(value.sources) ||
    !isToolSummary(value.tools) ||
    !Array.isArray(value.compactionCheckpoints) ||
    !value.compactionCheckpoints.every(isCompactionCheckpoint) ||
    !Array.isArray(value.diagnostics)
  ) {
    return false;
  }
  const { sessionId, agentRunId, turnId } = value.agentRun;
  return value.diagnostics.every(
    (item) =>
      isDiagnostic(item) &&
      item.sessionId === sessionId &&
      item.agentRunId === agentRunId &&
      item.turnId === turnId,
  );
}

export function isSessionInspectDocument(value: unknown): value is SessionInspectDocument {
  if (
    !hasShape(value, ['schemaVersion', 'kind', 'session', 'agentRuns', 'diagnostics'], []) ||
    value.schemaVersion !== SESSION_INSPECT_DOCUMENT_VERSION ||
    value.kind !== 'session' ||
    !isSessionSummary(value.session) ||
    !Array.isArray(value.agentRuns) ||
    !Array.isArray(value.diagnostics)
  ) {
    return false;
  }
  const { sessionId } = value.session;
  if (
    !value.agentRuns.every(
      (item) => isAgentRunInspectDocument(item) && item.agentRun.sessionId === sessionId,
    )
  ) {
    return false;
  }
  const runTurns = new Map(
    value.agentRuns.map((item) => [item.agentRun.agentRunId, item.agentRun.turnId]),
  );
  return value.diagnostics.every(
    (item) =>
      isDiagnostic(item) &&
      item.sessionId === sessionId &&
      item.agentRunId !== undefined &&
      item.turnId === runTurns.get(item.agentRunId),
  );
}

function isAgentRunIdentity(value: unknown): value is AgentRunInspectIdentity {
  return (
    hasShape(
      value,
      ['sessionId', 'agentRunId', 'turnId', 'status', 'createdAt', 'updatedAt'],
      [
        'invocationId',
        'parentRunId',
        'resumedFromRunId',
        'retriedFromRunId',
        'parentTurnId',
        'agentId',
        'completedAt',
        'failureClass',
        'abortSource',
      ],
    ) &&
    isString(value.sessionId) &&
    isString(value.agentRunId) &&
    isString(value.turnId) &&
    AGENT_RUN_STATUSES.includes(value.status as (typeof AGENT_RUN_STATUSES)[number]) &&
    isCount(value.createdAt) &&
    isCount(value.updatedAt) &&
    isOptionalCount(value.completedAt) &&
    [
      value.invocationId,
      value.parentRunId,
      value.resumedFromRunId,
      value.retriedFromRunId,
      value.parentTurnId,
      value.agentId,
      value.failureClass,
      value.abortSource,
    ].every(isOptionalString)
  );
}

function isAgentRunSources(value: unknown): boolean {
  return (
    hasShape(
      value,
      ['operationalEventCount', 'runtimeEventCount', 'health'],
      ['runtimeCoverage'],
    ) &&
    isCount(value.operationalEventCount) &&
    isCount(value.runtimeEventCount) &&
    (value.runtimeCoverage === undefined || isCoverage(value.runtimeCoverage)) &&
    hasShape(
      value.health,
      [
        'runtimeLedger',
        'runtimeTerminalPresent',
        'operationalTerminalPresent',
        'statusConsistency',
      ],
      [],
    ) &&
    (value.health.runtimeLedger === 'present' ||
      value.health.runtimeLedger === 'missing' ||
      value.health.runtimeLedger === 'read_failed') &&
    typeof value.health.runtimeTerminalPresent === 'boolean' &&
    typeof value.health.operationalTerminalPresent === 'boolean' &&
    (value.health.statusConsistency === 'consistent' ||
      value.health.statusConsistency === 'inconsistent' ||
      value.health.statusConsistency === 'incomplete')
  );
}

function isToolSummary(value: unknown): boolean {
  return (
    hasShape(
      value,
      [
        'callCount',
        'responseCount',
        'errorResponseCount',
        'callsWithoutResponse',
        'responsesWithoutCall',
      ],
      [],
    ) &&
    isCount(value.callCount) &&
    isCount(value.responseCount) &&
    isCount(value.errorResponseCount) &&
    Array.isArray(value.callsWithoutResponse) &&
    value.callsWithoutResponse.every(isToolFact) &&
    Array.isArray(value.responsesWithoutCall) &&
    value.responsesWithoutCall.every(isToolFact)
  );
}

function isToolFact(value: unknown): boolean {
  return (
    hasShape(value, ['toolCallId', 'toolName', 'eventId'], []) &&
    typeof value.toolCallId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.eventId === 'string'
  );
}

function isCompactionCheckpoint(value: unknown): boolean {
  return (
    hasShape(
      value,
      ['eventId', 'validation'],
      ['checkpointId', 'policyVersion', 'sourceCoverage'],
    ) &&
    typeof value.eventId === 'string' &&
    (value.validation === 'shape_valid' || value.validation === 'invalid') &&
    isOptionalString(value.checkpointId) &&
    isOptionalString(value.policyVersion) &&
    (value.sourceCoverage === undefined || isCoverage(value.sourceCoverage))
  );
}

function isDiagnostic(value: unknown): value is ExecutionInspectDiagnostic {
  return (
    hasShape(
      value,
      ['severity', 'code', 'message', 'sessionId'],
      ['agentRunId', 'turnId', 'eventId'],
    ) &&
    (value.severity === 'error' || value.severity === 'warning' || value.severity === 'info') &&
    isString(value.code) &&
    isString(value.message) &&
    isString(value.sessionId) &&
    isOptionalString(value.agentRunId) &&
    isOptionalString(value.turnId) &&
    isOptionalString(value.eventId)
  );
}

function isSessionSummary(value: unknown): value is SessionInspectSummary {
  return (
    hasShape(
      value,
      ['sessionId', 'name', 'status', 'createdAt', 'lastUsedAt', 'isArchived'],
      [
        'lastMessageAt',
        'parentSessionId',
        'branchOfTurnId',
        'revisionRootSessionId',
        'revisionParentSessionId',
        'revisionOfTurnId',
        'revisionIndex',
        'revisionState',
      ],
    ) &&
    isString(value.sessionId) &&
    typeof value.name === 'string' &&
    SESSION_STATUSES.includes(value.status as (typeof SESSION_STATUSES)[number]) &&
    isCount(value.createdAt) &&
    isCount(value.lastUsedAt) &&
    isOptionalCount(value.lastMessageAt) &&
    typeof value.isArchived === 'boolean' &&
    [
      value.parentSessionId,
      value.branchOfTurnId,
      value.revisionRootSessionId,
      value.revisionParentSessionId,
      value.revisionOfTurnId,
    ].every(isOptionalString) &&
    isOptionalCount(value.revisionIndex) &&
    (value.revisionState === undefined ||
      value.revisionState === 'preparing' ||
      value.revisionState === 'committed')
  );
}

function isCoverage(value: unknown): boolean {
  return (
    hasShape(value, ['highWater'], ['lowWater', 'eventCount']) &&
    isCursor(value.highWater) &&
    (value.lowWater === undefined || isCursor(value.lowWater)) &&
    isOptionalCount(value.eventCount)
  );
}

function isCursor(value: unknown): boolean {
  return (
    hasShape(value, ['ledger', 'streamId', 'sequence'], ['eventId']) &&
    EXECUTION_LOG_LEDGERS.includes(value.ledger as (typeof EXECUTION_LOG_LEDGERS)[number]) &&
    isString(value.streamId) &&
    isCount(value.sequence) &&
    isOptionalString(value.eventId)
  );
}

function hasShape<Required extends string, Optional extends string>(
  value: unknown,
  required: readonly Required[],
  optional: readonly Optional[],
): value is Record<Required, unknown> & Partial<Record<Optional, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    Object.keys(record).every((key) => allowed.has(key))
  );
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOptionalCount(value: unknown): boolean {
  return value === undefined || isCount(value);
}
