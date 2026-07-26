import {
  decodeCanonicalShellToolResultContent,
  normalizeShellToolResultContent,
} from './shell-run-result.js';
import { isPermissionMode } from './permission.js';
import { isStorageRef, type ToolResultContent } from './events.js';
import {
  defineObjectShape,
  hasExactShape,
  isFiniteNumber,
  isOptionalFiniteNumber,
  isOptionalString,
  isRecord,
  isStringArray,
} from './record-schema.js';

type Result<K extends ToolResultContent['kind']> = Extract<ToolResultContent, { kind: K }>;
type ExploreResult = Result<'explore_agent'>;
type AgentSwarmResult = Result<'agent_swarm'>;
type RiveResult = Result<'rive_workflow'>;

const TEXT_SHAPE = defineObjectShape<Result<'text'>>()(['kind', 'text'], []);
const JSON_SHAPE = defineObjectShape<Result<'json'>>()(['kind', 'value'], []);
const FILE_DIFF_SHAPE = defineObjectShape<Result<'file_diff'>>()(['kind', 'paths', 'diff'], []);
const FILE_WRITE_SHAPE = defineObjectShape<Result<'file_write'>>()(['kind', 'path', 'bytes'], []);
const ARCHIVED_SHAPE = defineObjectShape<Result<'archived_tool_result'>>()(
  [
    'kind',
    'status',
    'runtimeEventId',
    'toolCallId',
    'toolName',
    'originalEstimatedTokens',
    'originalBytes',
    'rewriteVersion',
    'reason',
  ],
  ['artifactId', 'bodySha256'],
);
const IMAGE_SHAPE = defineObjectShape<Result<'image'>>()(['kind', 'mimeType', 'ref'], []);
const SUMMARY_SHAPE = defineObjectShape<Result<'summary'>>()(
  ['kind', 'original', 'summarized', 'reason'],
  [],
);
const WEB_SEARCH_SHAPE = defineObjectShape<Result<'web_search'>>()(
  ['kind', 'provider', 'query', 'rows'],
  [],
);
type WebSearchRow = Result<'web_search'>['rows'][number];
const WEB_SEARCH_ROW_SHAPE = defineObjectShape<WebSearchRow>()(
  ['title', 'url', 'snippet', 'source'],
  [],
);
const WEB_SEARCH_ERROR_SHAPE = defineObjectShape<Result<'web_search_error'>>()(
  ['kind', 'ok', 'provider', 'reason', 'message'],
  ['query', 'credentialSource'],
);
const OFFICE_DOCUMENT_SHAPE = defineObjectShape<Result<'office_document'>>()(
  ['kind', 'ok'],
  ['operation', 'path', 'args', 'stdout', 'stderr', 'truncated', 'reason', 'message'],
);
const EXPLORE_SHAPE = defineObjectShape<ExploreResult>()(
  [
    'kind',
    'ok',
    'mode',
    'objective',
    'roots',
    'queries',
    'filesInspected',
    'filesSkipped',
    'bytesRead',
    'progress',
    'candidateFiles',
    'matches',
    'notes',
  ],
  [
    'partial',
    'terminalStatus',
    'ignoredPaths',
    'stoppingCondition',
    'limitReasons',
    'filesDiscovered',
    'sensitiveFilesSkipped',
    'startedAt',
    'completedAt',
    'durationMs',
    'recentEvents',
    'evidence',
    'summary',
    'report',
    'reason',
    'message',
  ],
);
type ExploreRecentEvent = NonNullable<ExploreResult['recentEvents']>[number];
type ExploreEvidence = NonNullable<ExploreResult['evidence']>[number];
type ExploreCandidate = ExploreResult['candidateFiles'][number];
type ExploreMatch = ExploreResult['matches'][number];
const EXPLORE_RECENT_EVENT_SHAPE = defineObjectShape<ExploreRecentEvent>()(
  ['type', 'at', 'message'],
  [],
);
const EXPLORE_EVIDENCE_SHAPE = defineObjectShape<ExploreEvidence>()(
  ['type', 'path', 'label'],
  ['line', 'score'],
);
const EXPLORE_CANDIDATE_SHAPE = defineObjectShape<ExploreCandidate>()(
  ['path', 'score', 'reasons'],
  [],
);
const EXPLORE_MATCH_SHAPE = defineObjectShape<ExploreMatch>()(
  ['path', 'line', 'query', 'snippet'],
  [],
);
const SUBAGENT_SHAPE = defineObjectShape<Result<'subagent'>>()(
  ['kind', 'agentName', 'turnId', 'status', 'permissionMode', 'summary', 'artifactIds'],
  [
    'childSessionId',
    'agentId',
    'runId',
    'startedAt',
    'completedAt',
    'durationMs',
    'eventCount',
    'failureClass',
  ],
);
const AGENT_SWARM_SHAPE = defineObjectShape<AgentSwarmResult>()(
  ['kind', 'status', 'items', 'startedAt', 'completedAt', 'durationMs'],
  [],
);
type AgentSwarmItem = AgentSwarmResult['items'][number];
const AGENT_SWARM_ITEM_SHAPE = defineObjectShape<AgentSwarmItem>()(
  ['itemId', 'index', 'profile', 'started', 'status', 'summary', 'artifactIds'],
  [
    'childSessionId',
    'agentId',
    'agentName',
    'turnId',
    'runId',
    'resumedFromRunId',
    'startedAt',
    'completedAt',
    'durationMs',
    'failureClass',
  ],
);
const RIVE_SHAPE = defineObjectShape<RiveResult>()(
  ['kind', 'ok', 'action', 'command', 'ids', 'summary'],
  ['state', 'projection', 'nodes', 'stdoutTail', 'stderrTail', 'error'],
);
const RIVE_IDS_SHAPE = defineObjectShape<RiveResult['ids']>()(
  [],
  ['workflowRunId', 'schedulerRunId', 'rootWorkNodeId'],
);
type RiveProjection = NonNullable<RiveResult['projection']>;
const RIVE_PROJECTION_SHAPE = defineObjectShape<RiveProjection>()(
  [],
  [
    'templateId',
    'version',
    'templateHash',
    'idempotencyStatus',
    'workflowRunId',
    'schedulerRunId',
    'rootWorkNodeId',
    'state',
    'schedulerState',
    'rootState',
  ],
);
type RiveNode = NonNullable<RiveResult['nodes']>[number];
const RIVE_NODE_SHAPE = defineObjectShape<RiveNode>()(
  [],
  ['id', 'templateId', 'title', 'state', 'runner', 'worker'],
);
type RiveError = NonNullable<RiveResult['error']>;
const RIVE_ERROR_SHAPE = defineObjectShape<RiveError>()(
  ['reason', 'message'],
  ['code', 'suggestedAction'],
);

export function normalizeToolResultContentForRead(value: unknown): ToolResultContent {
  const shell = normalizeShellToolResultContent(value);
  if (shell.state === 'invalid') throw new Error('Invalid shell tool result content');
  const normalized = shell.state === 'valid' ? shell.content : value;
  return decodeCanonicalToolResultContent(normalized);
}

export function decodeCanonicalToolResultContent(value: unknown): ToolResultContent {
  const shell = decodeCanonicalShellToolResultContent(value);
  if (shell.state === 'invalid') throw new Error('Invalid shell tool result content');
  if (shell.state === 'valid') return shell.content;
  if (!isNonShellToolResultContent(value)) {
    throw new Error('Invalid tool result content');
  }
  return value;
}

function isNonShellToolResultContent(value: unknown): value is ToolResultContent {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'text':
      return hasExactShape(value, TEXT_SHAPE) && typeof value.text === 'string';
    case 'json':
      return hasExactShape(value, JSON_SHAPE) && Object.hasOwn(value, 'value');
    case 'file_diff':
      return (
        hasExactShape(value, FILE_DIFF_SHAPE) &&
        isStringArray(value.paths) &&
        typeof value.diff === 'string'
      );
    case 'file_write':
      return (
        hasExactShape(value, FILE_WRITE_SHAPE) &&
        typeof value.path === 'string' &&
        isFiniteNumber(value.bytes)
      );
    case 'archived_tool_result':
      return (
        hasExactShape(value, ARCHIVED_SHAPE) &&
        ['not_loaded', 'missing', 'corrupt'].includes(value.status as string) &&
        typeof value.runtimeEventId === 'string' &&
        typeof value.toolCallId === 'string' &&
        typeof value.toolName === 'string' &&
        isOptionalString(value.artifactId) &&
        isOptionalString(value.bodySha256) &&
        isFiniteNumber(value.originalEstimatedTokens) &&
        isFiniteNumber(value.originalBytes) &&
        isFiniteNumber(value.rewriteVersion) &&
        value.reason === 'stale_tool_result_pruned_before_compact'
      );
    case 'image':
      return (
        hasExactShape(value, IMAGE_SHAPE) &&
        typeof value.mimeType === 'string' &&
        isStorageRef(value.ref)
      );
    case 'summary':
      return (
        hasExactShape(value, SUMMARY_SHAPE) &&
        typeof value.original === 'string' &&
        typeof value.summarized === 'string' &&
        value.reason === 'too_large'
      );
    case 'web_search':
      return (
        hasExactShape(value, WEB_SEARCH_SHAPE) &&
        typeof value.provider === 'string' &&
        typeof value.query === 'string' &&
        Array.isArray(value.rows) &&
        value.rows.every(isWebSearchRow)
      );
    case 'web_search_error':
      return (
        hasExactShape(value, WEB_SEARCH_ERROR_SHAPE) &&
        value.ok === false &&
        typeof value.provider === 'string' &&
        isOptionalString(value.query) &&
        typeof value.reason === 'string' &&
        typeof value.message === 'string' &&
        isOptionalString(value.credentialSource)
      );
    case 'office_document':
      return (
        hasExactShape(value, OFFICE_DOCUMENT_SHAPE) &&
        typeof value.ok === 'boolean' &&
        isOptionalString(value.operation) &&
        isOptionalString(value.path) &&
        (value.args === undefined || isStringArray(value.args)) &&
        isOptionalString(value.stdout) &&
        isOptionalString(value.stderr) &&
        (value.truncated === undefined || typeof value.truncated === 'boolean') &&
        isOptionalString(value.reason) &&
        isOptionalString(value.message)
      );
    case 'explore_agent':
      return isExploreResult(value);
    case 'subagent':
      return (
        hasExactShape(value, SUBAGENT_SHAPE) &&
        isOptionalString(value.childSessionId) &&
        isOptionalString(value.agentId) &&
        typeof value.agentName === 'string' &&
        typeof value.turnId === 'string' &&
        isOptionalString(value.runId) &&
        ['completed', 'failed', 'cancelled', 'running', 'waiting_permission'].includes(
          value.status as string,
        ) &&
        isPermissionMode(value.permissionMode) &&
        typeof value.summary === 'string' &&
        isStringArray(value.artifactIds) &&
        isOptionalFiniteNumber(value.startedAt) &&
        isOptionalFiniteNumber(value.completedAt) &&
        isOptionalFiniteNumber(value.durationMs) &&
        isOptionalFiniteNumber(value.eventCount) &&
        isOptionalString(value.failureClass)
      );
    case 'agent_swarm':
      return isAgentSwarmResult(value);
    case 'rive_workflow':
      return isRiveResult(value);
    default:
      return false;
  }
}

function isAgentSwarmResult(value: Record<string, unknown>): value is AgentSwarmResult {
  return (
    hasExactShape(value, AGENT_SWARM_SHAPE) &&
    ['completed', 'partial', 'cancelled'].includes(value.status as string) &&
    Array.isArray(value.items) &&
    value.items.every(isAgentSwarmItem) &&
    isFiniteNumber(value.startedAt) &&
    isFiniteNumber(value.completedAt) &&
    isFiniteNumber(value.durationMs)
  );
}

function isAgentSwarmItem(value: unknown): value is AgentSwarmItem {
  return (
    isRecord(value) &&
    hasExactShape(value, AGENT_SWARM_ITEM_SHAPE) &&
    typeof value.itemId === 'string' &&
    Number.isSafeInteger(value.index) &&
    Number(value.index) >= 0 &&
    typeof value.profile === 'string' &&
    typeof value.started === 'boolean' &&
    isOptionalString(value.childSessionId) &&
    isOptionalString(value.agentId) &&
    isOptionalString(value.agentName) &&
    isOptionalString(value.turnId) &&
    isOptionalString(value.runId) &&
    isOptionalString(value.resumedFromRunId) &&
    ['completed', 'failed', 'cancelled'].includes(value.status as string) &&
    typeof value.summary === 'string' &&
    isStringArray(value.artifactIds) &&
    isOptionalFiniteNumber(value.startedAt) &&
    isOptionalFiniteNumber(value.completedAt) &&
    isOptionalFiniteNumber(value.durationMs) &&
    isOptionalString(value.failureClass)
  );
}

function isExploreResult(value: Record<string, unknown>): value is ExploreResult {
  return (
    hasExactShape(value, EXPLORE_SHAPE) &&
    typeof value.ok === 'boolean' &&
    (value.partial === undefined || typeof value.partial === 'boolean') &&
    (value.terminalStatus === undefined ||
      ['completed', 'completed_empty', 'failed', 'canceled', 'canceled_partial'].includes(
        value.terminalStatus as string,
      )) &&
    value.mode === 'read_only' &&
    typeof value.objective === 'string' &&
    isStringArray(value.roots) &&
    isStringArray(value.queries) &&
    (value.ignoredPaths === undefined || isStringArray(value.ignoredPaths)) &&
    isOptionalString(value.stoppingCondition) &&
    (value.limitReasons === undefined ||
      (Array.isArray(value.limitReasons) &&
        value.limitReasons.every((reason) =>
          ['candidate_budget', 'file_budget', 'match_budget', 'byte_budget'].includes(reason),
        ))) &&
    isOptionalFiniteNumber(value.filesDiscovered) &&
    isFiniteNumber(value.filesInspected) &&
    isFiniteNumber(value.filesSkipped) &&
    isOptionalFiniteNumber(value.sensitiveFilesSkipped) &&
    isFiniteNumber(value.bytesRead) &&
    isOptionalFiniteNumber(value.startedAt) &&
    isOptionalFiniteNumber(value.completedAt) &&
    isOptionalFiniteNumber(value.durationMs) &&
    isStringArray(value.progress) &&
    (value.recentEvents === undefined ||
      (Array.isArray(value.recentEvents) && value.recentEvents.every(isExploreRecentEvent))) &&
    (value.evidence === undefined ||
      (Array.isArray(value.evidence) && value.evidence.every(isExploreEvidence))) &&
    isOptionalString(value.summary) &&
    isOptionalString(value.report) &&
    Array.isArray(value.candidateFiles) &&
    value.candidateFiles.every(isExploreCandidate) &&
    Array.isArray(value.matches) &&
    value.matches.every(isExploreMatch) &&
    isStringArray(value.notes) &&
    (value.reason === undefined ||
      ['invalid_objective', 'invalid_root', 'no_readable_roots', 'aborted'].includes(
        value.reason as string,
      )) &&
    isOptionalString(value.message)
  );
}

function isExploreRecentEvent(value: unknown): value is ExploreRecentEvent {
  return (
    isRecord(value) &&
    hasExactShape(value, EXPLORE_RECENT_EVENT_SHAPE) &&
    typeof value.type === 'string' &&
    isFiniteNumber(value.at) &&
    typeof value.message === 'string'
  );
}

function isExploreEvidence(value: unknown): value is ExploreEvidence {
  return (
    isRecord(value) &&
    hasExactShape(value, EXPLORE_EVIDENCE_SHAPE) &&
    (value.type === 'match' || value.type === 'candidate') &&
    typeof value.path === 'string' &&
    isOptionalFiniteNumber(value.line) &&
    typeof value.label === 'string' &&
    isOptionalFiniteNumber(value.score)
  );
}

function isExploreCandidate(value: unknown): value is ExploreCandidate {
  return (
    isRecord(value) &&
    hasExactShape(value, EXPLORE_CANDIDATE_SHAPE) &&
    typeof value.path === 'string' &&
    isFiniteNumber(value.score) &&
    isStringArray(value.reasons)
  );
}

function isExploreMatch(value: unknown): value is ExploreMatch {
  return (
    isRecord(value) &&
    hasExactShape(value, EXPLORE_MATCH_SHAPE) &&
    typeof value.path === 'string' &&
    isFiniteNumber(value.line) &&
    typeof value.query === 'string' &&
    typeof value.snippet === 'string'
  );
}

function isWebSearchRow(value: unknown): value is WebSearchRow {
  return (
    isRecord(value) &&
    hasExactShape(value, WEB_SEARCH_ROW_SHAPE) &&
    typeof value.title === 'string' &&
    typeof value.url === 'string' &&
    typeof value.snippet === 'string' &&
    typeof value.source === 'string'
  );
}

function isRiveResult(value: Record<string, unknown>): value is RiveResult {
  return (
    hasExactShape(value, RIVE_SHAPE) &&
    typeof value.ok === 'boolean' &&
    typeof value.action === 'string' &&
    isStringArray(value.command) &&
    isOptionalString(value.state) &&
    isRiveIds(value.ids) &&
    typeof value.summary === 'string' &&
    (value.projection === undefined || isRiveProjection(value.projection)) &&
    (value.nodes === undefined || (Array.isArray(value.nodes) && value.nodes.every(isRiveNode))) &&
    isOptionalString(value.stdoutTail) &&
    isOptionalString(value.stderrTail) &&
    (value.error === undefined || isRiveError(value.error))
  );
}

function isRiveIds(value: unknown): value is RiveResult['ids'] {
  return (
    isRecord(value) &&
    hasExactShape(value, RIVE_IDS_SHAPE) &&
    isOptionalString(value.workflowRunId) &&
    isOptionalString(value.schedulerRunId) &&
    isOptionalString(value.rootWorkNodeId)
  );
}

function isRiveProjection(value: unknown): value is RiveProjection {
  return (
    isRecord(value) &&
    hasExactShape(value, RIVE_PROJECTION_SHAPE) &&
    isOptionalString(value.templateId) &&
    isOptionalFiniteNumber(value.version) &&
    isOptionalString(value.templateHash) &&
    isOptionalString(value.idempotencyStatus) &&
    isOptionalString(value.workflowRunId) &&
    isOptionalString(value.schedulerRunId) &&
    isOptionalString(value.rootWorkNodeId) &&
    isOptionalString(value.state) &&
    isOptionalString(value.schedulerState) &&
    isOptionalString(value.rootState)
  );
}

function isRiveNode(value: unknown): value is RiveNode {
  return (
    isRecord(value) &&
    hasExactShape(value, RIVE_NODE_SHAPE) &&
    isOptionalString(value.id) &&
    isOptionalString(value.templateId) &&
    isOptionalString(value.title) &&
    isOptionalString(value.state) &&
    isOptionalString(value.runner) &&
    isOptionalString(value.worker)
  );
}

function isRiveError(value: unknown): value is RiveError {
  return (
    isRecord(value) &&
    hasExactShape(value, RIVE_ERROR_SHAPE) &&
    typeof value.reason === 'string' &&
    typeof value.message === 'string' &&
    isOptionalString(value.code) &&
    isOptionalString(value.suggestedAction)
  );
}
