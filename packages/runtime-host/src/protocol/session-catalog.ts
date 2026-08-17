import { isCollaborationMode, type CollaborationMode } from '@maka/core/collaboration';
import { isOrchestrationMode, type OrchestrationMode } from '@maka/core/orchestration';
import { isPermissionMode, type PermissionMode } from '@maka/core/permission';
import { isSessionStartMode, type SessionStartMode } from '@maka/core/explore-agent';
import {
  isSessionBlockedReason,
  isSessionToolProfile,
  type SessionBlockedReason,
  type SessionStatus,
  type SessionSubagentProjection,
  type SessionToolProfile,
} from '@maka/core/session';
import { isThinkingLevel, type ThinkingLevel } from '@maka/core/model-thinking';
import type { ExecutionBoundarySummary } from '@maka/core/sandbox-boundary';
export type { ExecutionBoundarySummary } from '@maka/core/sandbox-boundary';
import {
  assertAllowedKeys,
  requireCount,
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineHostPathOperation, defineOperation } from './operation-spec.js';
import { decodeSessionStatus } from './session-status.js';
import {
  decodeWorkspaceProjection,
  decodeWorkspaceTarget,
  type WorkspaceProjection,
  type WorkspaceTarget,
  WORKSPACE_HOST_PATH_MAX_BYTES,
} from './workspace.js';

export type { SessionSubagentProjection } from '@maka/core/session';

export const SESSION_CATALOG_PAGE_MAX_ITEMS = 32;
export const SESSION_CATALOG_RESULT_MAX_BYTES = 48 * 1024;
export const SESSION_CATALOG_CURSOR_MAX_BYTES = 512;
export const SESSION_CATALOG_CWD_MAX_BYTES = WORKSPACE_HOST_PATH_MAX_BYTES;
export const SESSION_CATALOG_NAME_MAX_BYTES = 320;
export const SESSION_CATALOG_LABEL_MAX_ITEMS = 32;
export const SESSION_CATALOG_LABEL_MAX_BYTES = 128;
export const SESSION_CATALOG_PREVIEW_MAX_BYTES = 4 * 1024;
export const SESSION_CATALOG_MODEL_MAX_BYTES = 512;
export const SESSION_CATALOG_CONNECTION_SLUG_MAX_BYTES = 256;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'persistence_failed',
  'internal_failure',
] as const;
const CREATE_ERRORS = [...QUERY_ERRORS, 'operation_conflict', 'commit_outcome_unknown'] as const;
const METADATA_UPDATE_ERRORS = [...QUERY_ERRORS, 'not_found', 'commit_outcome_unknown'] as const;
const CONFIGURATION_UPDATE_ERRORS = [
  ...METADATA_UPDATE_ERRORS,
  'session_busy',
  'operation_conflict',
] as const;
const READ_MARKER_ERRORS = [...METADATA_UPDATE_ERRORS, 'operation_conflict'] as const;
const EXECUTION_BOUNDARY_QUERY_ERRORS = [...QUERY_ERRORS, 'not_found'] as const;

const PROJECTION_REQUIRED_FIELDS = [
  'id',
  'revision',
  'workspace',
  'createdAt',
  'lastUsedAt',
  'name',
  'isFlagged',
  'isArchived',
  'labels',
  'labelsTruncated',
  'hasUnread',
  'status',
  'backend',
  'llmConnectionSlug',
  'connectionLocked',
  'model',
  'permissionMode',
  'collaborationMode',
  'orchestrationMode',
] as const;
const PROJECTION_FIELDS = [
  ...PROJECTION_REQUIRED_FIELDS,
  'lastMessageAt',
  'lastMessagePreview',
  'blockedReason',
  'statusUpdatedAt',
  'parentSessionId',
  'branchOfTurnId',
  'subagent',
  'revisionRootSessionId',
  'revisionParentSessionId',
  'revisionOfTurnId',
  'revisionIndex',
  'revisionState',
  'thinkingLevel',
  'lastReadMessageId',
] as const;

export type SessionCatalogRevision = `sha256:${string}`;

export type SessionCatalogQueryInput =
  | { readonly kind: 'list_start' }
  | {
      readonly kind: 'list_continue';
      readonly revision: SessionCatalogRevision;
      readonly cursor: string;
    }
  | { readonly kind: 'get'; readonly sessionId: string };

export type SessionModelTarget =
  | { readonly kind: 'default' }
  | {
      readonly kind: 'explicit';
      readonly connectionSlug: string;
      readonly model: string;
    };

export interface SessionCreateInput {
  readonly sessionId: string;
  readonly workspace: WorkspaceTarget;
  readonly mode?: SessionStartMode;
  readonly name?: string;
  readonly labels?: readonly string[];
  readonly modelTarget: SessionModelTarget;
  readonly thinkingLevel?: ThinkingLevel;
  readonly toolProfile?: SessionToolProfile;
  readonly permissionMode?: PermissionMode;
  readonly collaborationMode?: CollaborationMode;
  readonly orchestrationMode?: OrchestrationMode;
}

export interface SessionMetadataPatch {
  readonly name?: string;
  readonly labels?: readonly string[];
  readonly isFlagged?: boolean;
}

export interface SessionMetadataUpdateInput {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly patch: SessionMetadataPatch;
}

export interface SessionConfiguration {
  readonly modelTarget: SessionModelTarget;
  readonly thinkingLevel: ThinkingLevel | null;
  readonly permissionMode: PermissionMode;
  readonly collaborationMode: CollaborationMode;
  readonly orchestrationMode: OrchestrationMode;
}

export interface SessionConfigurationUpdateInput {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly configuration: SessionConfiguration;
}

export interface SessionWorkspaceRelocateInput {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly workspace: WorkspaceTarget;
}

export interface SessionReadMarkerSetInput {
  readonly sessionId: string;
  readonly readThroughMessageId: string;
}

export interface SessionExecutionBoundaryQueryInput {
  readonly sessionId: string;
}

export interface SessionCatalogProjection {
  readonly id: string;
  readonly revision: number;
  readonly workspace: WorkspaceProjection;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly name: string;
  readonly isFlagged: boolean;
  readonly isArchived: boolean;
  readonly labels: readonly string[];
  readonly labelsTruncated: boolean;
  readonly hasUnread: boolean;
  readonly lastReadMessageId?: string;
  readonly lastMessageAt?: number;
  readonly lastMessagePreview?: string;
  readonly status: SessionStatus;
  readonly blockedReason?: SessionBlockedReason;
  readonly statusUpdatedAt?: number;
  readonly parentSessionId?: string;
  readonly branchOfTurnId?: string;
  readonly subagent?: SessionSubagentProjection;
  readonly revisionRootSessionId?: string;
  readonly revisionParentSessionId?: string;
  readonly revisionOfTurnId?: string;
  readonly revisionIndex?: number;
  readonly revisionState?: 'preparing' | 'committed';
  readonly backend: 'ai-sdk' | 'fake';
  readonly llmConnectionSlug: string;
  readonly connectionLocked: boolean;
  readonly model: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly permissionMode: PermissionMode;
  readonly collaborationMode: CollaborationMode;
  readonly orchestrationMode: OrchestrationMode;
}

export interface UnsupportedLegacySessionCatalogRecord {
  readonly kind: 'unsupported_legacy_record';
  readonly id: string;
  readonly revision: number;
  readonly reason: 'not_wire_representable';
}

export type SessionCatalogItem = SessionCatalogProjection | UnsupportedLegacySessionCatalogRecord;

export type SessionCatalogQueryResult =
  | {
      readonly kind: 'page';
      readonly revision: SessionCatalogRevision;
      readonly sessions: readonly SessionCatalogItem[];
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expectedRevision: SessionCatalogRevision;
      readonly actualRevision: SessionCatalogRevision;
    }
  | {
      readonly kind: 'session';
      readonly session: SessionCatalogItem | null;
    };

export type SessionUpdateResult =
  | { readonly kind: 'committed'; readonly session: SessionCatalogItem }
  | {
      readonly kind: 'revision_conflict';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    };

export const SESSION_CATALOG_OPERATION_SPECS = {
  'session.catalog.query': defineOperation<
    SessionCatalogQueryInput,
    SessionCatalogQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeSessionCatalogQueryInput,
    decodeOutput: decodeSessionCatalogQueryResult,
  }),
  'session.create': defineHostPathOperation<
    SessionCreateInput,
    SessionCatalogItem,
    (typeof CREATE_ERRORS)[number]
  >(
    {
      mode: 'command',
      availability: 'ready',
      errors: CREATE_ERRORS,
      decodeInput: decodeSessionCreateInput,
      decodeOutput: decodeSessionCatalogItem,
      assertOutputForInput: (input, output) => assertSessionIdentity(input.sessionId, output),
    },
    (input) => input.workspace.kind === 'host_path',
  ),
  'session.metadata.update': defineOperation<
    SessionMetadataUpdateInput,
    SessionUpdateResult,
    (typeof METADATA_UPDATE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: METADATA_UPDATE_ERRORS,
    decodeInput: decodeSessionMetadataUpdateInput,
    decodeOutput: decodeSessionUpdateResult,
    assertOutputForInput: assertUpdateOutputIdentity,
  }),
  'session.configuration.update': defineOperation<
    SessionConfigurationUpdateInput,
    SessionUpdateResult,
    (typeof CONFIGURATION_UPDATE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: CONFIGURATION_UPDATE_ERRORS,
    decodeInput: decodeSessionConfigurationUpdateInput,
    decodeOutput: decodeSessionUpdateResult,
    assertOutputForInput: assertUpdateOutputIdentity,
  }),
  'session.workspace.relocate': defineHostPathOperation<
    SessionWorkspaceRelocateInput,
    SessionUpdateResult,
    (typeof CONFIGURATION_UPDATE_ERRORS)[number]
  >(
    {
      mode: 'command',
      availability: 'ready',
      errors: CONFIGURATION_UPDATE_ERRORS,
      decodeInput: decodeSessionWorkspaceRelocateInput,
      decodeOutput: decodeSessionUpdateResult,
      assertOutputForInput: assertUpdateOutputIdentity,
    },
    (input) => input.workspace.kind === 'host_path',
  ),
  'session.read_marker.set': defineOperation<
    SessionReadMarkerSetInput,
    SessionCatalogItem,
    (typeof READ_MARKER_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: READ_MARKER_ERRORS,
    decodeInput: decodeSessionReadMarkerSetInput,
    decodeOutput: decodeSessionCatalogItem,
    assertOutputForInput: (input, output) => assertSessionIdentity(input.sessionId, output),
  }),
  'session.execution_boundary.query': defineOperation<
    SessionExecutionBoundaryQueryInput,
    ExecutionBoundarySummary,
    (typeof EXECUTION_BOUNDARY_QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: EXECUTION_BOUNDARY_QUERY_ERRORS,
    decodeInput: decodeSessionExecutionBoundaryQueryInput,
    decodeOutput: decodeExecutionBoundarySummary,
  }),
} as const;

export function decodeSessionExecutionBoundaryQueryInput(
  value: unknown,
): SessionExecutionBoundaryQueryInput {
  const input = requireExactRecord(value, 'Session execution boundary query input', ['sessionId']);
  return { sessionId: requireEntityId(input.sessionId, 'sessionId') };
}

export function decodeExecutionBoundarySummary(value: unknown): ExecutionBoundarySummary {
  const boundary = requireRecord(value, 'Session execution boundary summary');
  if (boundary.kind === 'managed') {
    const exact = requireExactRecord(boundary, 'Managed execution boundary summary', [
      'kind',
      'access',
      'revision',
    ]);
    if (exact.access !== 'read_only' && exact.access !== 'writable') {
      throw invalidProtocolFrame('Invalid managed execution boundary access');
    }
    return {
      kind: 'managed',
      access: exact.access,
      revision: requireCount(exact.revision, 'Execution boundary revision'),
    };
  }
  if (boundary.kind === 'bypass' || boundary.kind === 'external') {
    const exact = requireExactRecord(boundary, 'Execution boundary summary', ['kind', 'revision']);
    return {
      kind: boundary.kind,
      revision: requireCount(exact.revision, 'Execution boundary revision'),
    };
  }
  throw invalidProtocolFrame('Invalid execution boundary summary');
}

export function decodeSessionCatalogQueryInput(value: unknown): SessionCatalogQueryInput {
  const input = requireRecord(value, 'Session catalog query input');
  if (input.kind === 'list_start') {
    requireExactRecord(input, 'Session catalog list start input', ['kind']);
    return { kind: 'list_start' };
  }
  if (input.kind === 'list_continue') {
    const exact = requireExactRecord(input, 'Session catalog list continuation input', [
      'kind',
      'revision',
      'cursor',
    ]);
    return {
      kind: 'list_continue',
      revision: catalogRevision(exact.revision),
      cursor: requireUtf8String(
        exact.cursor,
        'Session catalog cursor',
        SESSION_CATALOG_CURSOR_MAX_BYTES,
      ),
    };
  }
  if (input.kind === 'get') {
    const exact = requireExactRecord(input, 'Session catalog get input', ['kind', 'sessionId']);
    return { kind: 'get', sessionId: requireEntityId(exact.sessionId, 'sessionId') };
  }
  throw invalidProtocolFrame('Invalid Session catalog query kind');
}

export function decodeSessionCreateInput(value: unknown): SessionCreateInput {
  const input = requireShapedRecord(
    value,
    'Session create input',
    ['sessionId', 'workspace', 'modelTarget'],
    [
      'mode',
      'name',
      'labels',
      'thinkingLevel',
      'toolProfile',
      'permissionMode',
      'collaborationMode',
      'orchestrationMode',
    ],
  );
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    workspace: decodeWorkspaceTarget(input.workspace),
    ...(Object.hasOwn(input, 'mode') ? { mode: sessionStartMode(input.mode) } : {}),
    ...(Object.hasOwn(input, 'name') ? { name: sessionName(input.name) } : {}),
    ...(Object.hasOwn(input, 'labels') ? { labels: labels(input.labels) } : {}),
    modelTarget: modelTarget(input.modelTarget),
    ...(Object.hasOwn(input, 'thinkingLevel')
      ? { thinkingLevel: thinkingLevel(input.thinkingLevel) }
      : {}),
    ...(Object.hasOwn(input, 'toolProfile')
      ? { toolProfile: sessionToolProfile(input.toolProfile) }
      : {}),
    ...(Object.hasOwn(input, 'permissionMode')
      ? { permissionMode: permissionMode(input.permissionMode) }
      : {}),
    ...(Object.hasOwn(input, 'collaborationMode')
      ? { collaborationMode: collaborationMode(input.collaborationMode) }
      : {}),
    ...(Object.hasOwn(input, 'orchestrationMode')
      ? { orchestrationMode: orchestrationMode(input.orchestrationMode) }
      : {}),
  };
}

function sessionToolProfile(value: unknown): SessionToolProfile {
  if (!isSessionToolProfile(value)) throw invalidProtocolFrame('Invalid Session tool profile');
  return value;
}

function sessionStartMode(value: unknown): SessionStartMode {
  if (!isSessionStartMode(value)) throw invalidProtocolFrame('Invalid Session start mode');
  return value;
}

export function decodeSessionMetadataUpdateInput(value: unknown): SessionMetadataUpdateInput {
  const input = requireExactRecord(value, 'Session metadata update input', [
    'sessionId',
    'expectedRevision',
    'patch',
  ]);
  const patch = requireShapedRecord(
    input.patch,
    'Session metadata patch',
    [],
    ['name', 'labels', 'isFlagged'],
  );
  if (Object.keys(patch).length === 0) {
    throw invalidProtocolFrame('Session metadata patch is empty');
  }
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    expectedRevision: positiveRevision(input.expectedRevision, 'expected Session revision'),
    patch: {
      ...(Object.hasOwn(patch, 'name') ? { name: sessionName(patch.name) } : {}),
      ...(Object.hasOwn(patch, 'labels') ? { labels: labels(patch.labels) } : {}),
      ...(Object.hasOwn(patch, 'isFlagged')
        ? { isFlagged: boolean(patch.isFlagged, 'Session flagged state') }
        : {}),
    },
  };
}

export function decodeSessionConfigurationUpdateInput(
  value: unknown,
): SessionConfigurationUpdateInput {
  const input = requireExactRecord(value, 'Session configuration update input', [
    'sessionId',
    'expectedRevision',
    'configuration',
  ]);
  const configuration = requireExactRecord(input.configuration, 'Session configuration', [
    'modelTarget',
    'thinkingLevel',
    'permissionMode',
    'collaborationMode',
    'orchestrationMode',
  ]);
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    expectedRevision: positiveRevision(input.expectedRevision, 'expected Session revision'),
    configuration: {
      modelTarget: modelTarget(configuration.modelTarget),
      thinkingLevel:
        configuration.thinkingLevel === null ? null : thinkingLevel(configuration.thinkingLevel),
      permissionMode: permissionMode(configuration.permissionMode),
      collaborationMode: collaborationMode(configuration.collaborationMode),
      orchestrationMode: orchestrationMode(configuration.orchestrationMode),
    },
  };
}

export function decodeSessionWorkspaceRelocateInput(value: unknown): SessionWorkspaceRelocateInput {
  const input = requireExactRecord(value, 'Session workspace relocate input', [
    'sessionId',
    'expectedRevision',
    'workspace',
  ]);
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    expectedRevision: positiveRevision(input.expectedRevision, 'expected Session revision'),
    workspace: decodeWorkspaceTarget(input.workspace),
  };
}

export function decodeSessionReadMarkerSetInput(value: unknown): SessionReadMarkerSetInput {
  const input = requireExactRecord(value, 'Session read marker input', [
    'sessionId',
    'readThroughMessageId',
  ]);
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    readThroughMessageId: requireEntityId(input.readThroughMessageId, 'readThroughMessageId'),
  };
}

export function decodeSessionCatalogQueryResult(value: unknown): SessionCatalogQueryResult {
  const result = requireRecord(value, 'Session catalog query result');
  if (result.kind === 'revision_changed') {
    const exact = requireExactRecord(result, 'Session catalog revision changed result', [
      'kind',
      'expectedRevision',
      'actualRevision',
    ]);
    return {
      kind: 'revision_changed',
      expectedRevision: catalogRevision(exact.expectedRevision),
      actualRevision: catalogRevision(exact.actualRevision),
    };
  }
  if (result.kind === 'session') {
    const exact = requireExactRecord(result, 'Session catalog item result', ['kind', 'session']);
    return {
      kind: 'session',
      session: exact.session === null ? null : decodeSessionCatalogItem(exact.session),
    };
  }
  if (result.kind !== 'page') throw invalidProtocolFrame('Invalid Session catalog result kind');
  const page = requireExactRecord(result, 'Session catalog page result', [
    'kind',
    'revision',
    'sessions',
    'nextCursor',
  ]);
  if (!Array.isArray(page.sessions) || page.sessions.length > SESSION_CATALOG_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Session catalog page exceeds item limit');
  }
  const decoded: SessionCatalogQueryResult = {
    kind: 'page',
    revision: catalogRevision(page.revision),
    sessions: page.sessions.map(decodeSessionCatalogItem),
    nextCursor:
      page.nextCursor === null
        ? null
        : requireUtf8String(
            page.nextCursor,
            'Session catalog next cursor',
            SESSION_CATALOG_CURSOR_MAX_BYTES,
          ),
  };
  requireEncodedByteLimit(decoded, 'Session catalog page', SESSION_CATALOG_RESULT_MAX_BYTES);
  return decoded;
}

export function decodeSessionUpdateResult(value: unknown): SessionUpdateResult {
  const result = requireRecord(value, 'Session update result');
  if (result.kind === 'committed') {
    const exact = requireExactRecord(result, 'Session committed update result', [
      'kind',
      'session',
    ]);
    return { kind: 'committed', session: decodeSessionCatalogItem(exact.session) };
  }
  if (result.kind === 'revision_conflict') {
    const exact = requireExactRecord(result, 'Session revision conflict result', [
      'kind',
      'expectedRevision',
      'actualRevision',
    ]);
    return {
      kind: 'revision_conflict',
      expectedRevision: positiveRevision(exact.expectedRevision, 'expected Session revision'),
      actualRevision: positiveRevision(exact.actualRevision, 'actual Session revision'),
    };
  }
  throw invalidProtocolFrame('Invalid Session update result kind');
}

export function decodeSessionCatalogProjection(value: unknown): SessionCatalogProjection {
  const record = requireRecord(value, 'Session catalog projection');
  assertAllowedKeys(record, 'Session catalog projection', PROJECTION_FIELDS);
  if (PROJECTION_REQUIRED_FIELDS.some((field) => !Object.hasOwn(record, field))) {
    throw invalidProtocolFrame('Invalid Session catalog projection fields');
  }
  const projection: SessionCatalogProjection = {
    id: requireEntityId(record.id, 'Session id'),
    revision: positiveRevision(record.revision, 'Session revision'),
    workspace: decodeWorkspaceProjection(record.workspace),
    createdAt: timestamp(record.createdAt, 'Session createdAt'),
    lastUsedAt: timestamp(record.lastUsedAt, 'Session lastUsedAt'),
    name: sessionName(record.name),
    isFlagged: boolean(record.isFlagged, 'Session flagged state'),
    isArchived: boolean(record.isArchived, 'Session archived state'),
    labels: labels(record.labels),
    labelsTruncated: boolean(record.labelsTruncated, 'Session labels truncated state'),
    hasUnread: boolean(record.hasUnread, 'Session unread state'),
    ...optionalEntityId(record, 'lastReadMessageId'),
    ...optionalTimestamp(record, 'lastMessageAt'),
    ...optionalText(record, 'lastMessagePreview', SESSION_CATALOG_PREVIEW_MAX_BYTES),
    status: decodeSessionStatus(record.status),
    ...optionalBlockedReason(record),
    ...optionalTimestamp(record, 'statusUpdatedAt'),
    ...optionalEntityId(record, 'parentSessionId'),
    ...optionalEntityId(record, 'branchOfTurnId'),
    ...optionalSubagent(record),
    ...optionalEntityId(record, 'revisionRootSessionId'),
    ...optionalEntityId(record, 'revisionParentSessionId'),
    ...optionalEntityId(record, 'revisionOfTurnId'),
    ...optionalRevisionIndex(record),
    ...optionalRevisionState(record),
    backend: backend(record.backend),
    llmConnectionSlug: requireUtf8String(
      record.llmConnectionSlug,
      'Session connection slug',
      SESSION_CATALOG_CONNECTION_SLUG_MAX_BYTES,
    ),
    connectionLocked: boolean(record.connectionLocked, 'Session connection lock'),
    model: requireUtf8String(record.model, 'Session model', SESSION_CATALOG_MODEL_MAX_BYTES),
    ...optionalThinkingLevel(record),
    permissionMode: permissionMode(record.permissionMode),
    collaborationMode: collaborationMode(record.collaborationMode),
    orchestrationMode: orchestrationMode(record.orchestrationMode),
  };
  requireEncodedByteLimit(
    projection,
    'Session catalog projection',
    SESSION_CATALOG_RESULT_MAX_BYTES,
  );
  return projection;
}

export function decodeSessionCatalogItem(value: unknown): SessionCatalogItem {
  const record = requireRecord(value, 'Session catalog item');
  if (record.kind !== 'unsupported_legacy_record') {
    return decodeSessionCatalogProjection(record);
  }
  const exact = requireExactRecord(record, 'unsupported legacy Session catalog record', [
    'kind',
    'id',
    'revision',
    'reason',
  ]);
  if (exact.reason !== 'not_wire_representable') {
    throw invalidProtocolFrame('Invalid unsupported legacy Session catalog reason');
  }
  return {
    kind: 'unsupported_legacy_record',
    id: requireEntityId(exact.id, 'Session id'),
    revision: positiveRevision(exact.revision, 'Session revision'),
    reason: exact.reason,
  };
}

function modelTarget(value: unknown): SessionModelTarget {
  const target = requireRecord(value, 'Session model target');
  if (target.kind === 'default') {
    requireExactRecord(target, 'default Session model target', ['kind']);
    return { kind: 'default' };
  }
  if (target.kind === 'explicit') {
    const exact = requireExactRecord(target, 'explicit Session model target', [
      'kind',
      'connectionSlug',
      'model',
    ]);
    return {
      kind: 'explicit',
      connectionSlug: requireUtf8String(
        exact.connectionSlug,
        'Session connection slug',
        SESSION_CATALOG_CONNECTION_SLUG_MAX_BYTES,
      ),
      model: requireUtf8String(exact.model, 'Session model', SESSION_CATALOG_MODEL_MAX_BYTES),
    };
  }
  throw invalidProtocolFrame('Invalid Session model target');
}

function labels(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > SESSION_CATALOG_LABEL_MAX_ITEMS) {
    throw invalidProtocolFrame('Invalid Session labels');
  }
  const decoded = value.map((label) =>
    boundedText(label, 'Session label', SESSION_CATALOG_LABEL_MAX_BYTES),
  );
  if (new Set(decoded).size !== decoded.length) {
    throw invalidProtocolFrame('Duplicate Session label');
  }
  return decoded;
}

function optionalTimestamp<Field extends 'lastMessageAt' | 'statusUpdatedAt'>(
  record: Record<string, unknown>,
  field: Field,
): Pick<SessionCatalogProjection, Field> | Record<string, never> {
  return Object.hasOwn(record, field)
    ? ({ [field]: timestamp(record[field], `Session ${field}`) } as Pick<
        SessionCatalogProjection,
        Field
      >)
    : {};
}

function optionalText<Field extends 'lastMessagePreview'>(
  record: Record<string, unknown>,
  field: Field,
  maxBytes: number,
): Pick<SessionCatalogProjection, Field> | Record<string, never> {
  return Object.hasOwn(record, field)
    ? ({ [field]: boundedText(record[field], `Session ${field}`, maxBytes) } as Pick<
        SessionCatalogProjection,
        Field
      >)
    : {};
}

function optionalEntityId<
  Field extends
    | 'parentSessionId'
    | 'branchOfTurnId'
    | 'lastReadMessageId'
    | 'revisionRootSessionId'
    | 'revisionParentSessionId'
    | 'revisionOfTurnId',
>(
  record: Record<string, unknown>,
  field: Field,
): Pick<SessionCatalogProjection, Field> | Record<string, never> {
  return Object.hasOwn(record, field)
    ? ({ [field]: requireEntityId(record[field], `Session ${field}`) } as Pick<
        SessionCatalogProjection,
        Field
      >)
    : {};
}

function optionalBlockedReason(
  record: Record<string, unknown>,
): Pick<SessionCatalogProjection, 'blockedReason'> | Record<string, never> {
  if (!Object.hasOwn(record, 'blockedReason')) return {};
  if (!isSessionBlockedReason(record.blockedReason)) {
    throw invalidProtocolFrame('Invalid Session blocked reason');
  }
  return { blockedReason: record.blockedReason };
}

function optionalSubagent(
  record: Record<string, unknown>,
): Pick<SessionCatalogProjection, 'subagent'> | Record<string, never> {
  if (!Object.hasOwn(record, 'subagent')) return {};
  const subagent = requireShapedRecord(
    record.subagent,
    'Session subagent projection',
    ['parentSessionId'],
    ['agentId', 'agentName', 'profile'],
  );
  return {
    subagent: {
      parentSessionId: requireEntityId(subagent.parentSessionId, 'subagent parentSessionId'),
      ...(Object.hasOwn(subagent, 'agentId')
        ? { agentId: boundedText(subagent.agentId, 'subagent agentId', 512) }
        : {}),
      ...(Object.hasOwn(subagent, 'agentName')
        ? { agentName: boundedText(subagent.agentName, 'subagent agentName', 512) }
        : {}),
      ...(Object.hasOwn(subagent, 'profile')
        ? { profile: boundedText(subagent.profile, 'subagent profile', 512) }
        : {}),
    },
  };
}

function optionalRevisionIndex(
  record: Record<string, unknown>,
): Pick<SessionCatalogProjection, 'revisionIndex'> | Record<string, never> {
  if (!Object.hasOwn(record, 'revisionIndex')) return {};
  return { revisionIndex: positiveRevision(record.revisionIndex, 'Session revision index') };
}

function optionalRevisionState(
  record: Record<string, unknown>,
): Pick<SessionCatalogProjection, 'revisionState'> | Record<string, never> {
  if (!Object.hasOwn(record, 'revisionState')) return {};
  if (record.revisionState !== 'preparing' && record.revisionState !== 'committed') {
    throw invalidProtocolFrame('Invalid Session revision state');
  }
  return { revisionState: record.revisionState };
}

function optionalThinkingLevel(
  record: Record<string, unknown>,
): Pick<SessionCatalogProjection, 'thinkingLevel'> | Record<string, never> {
  if (!Object.hasOwn(record, 'thinkingLevel')) return {};
  return { thinkingLevel: thinkingLevel(record.thinkingLevel) };
}

function backend(value: unknown): SessionCatalogProjection['backend'] {
  if (value !== 'ai-sdk' && value !== 'fake') {
    throw invalidProtocolFrame('Invalid Session backend');
  }
  return value;
}

function thinkingLevel(value: unknown): ThinkingLevel {
  if (!isThinkingLevel(value)) throw invalidProtocolFrame('Invalid Session thinking level');
  return value;
}

function permissionMode(value: unknown): PermissionMode {
  if (!isPermissionMode(value)) throw invalidProtocolFrame('Invalid Session permission mode');
  return value;
}

function collaborationMode(value: unknown): CollaborationMode {
  if (!isCollaborationMode(value)) {
    throw invalidProtocolFrame('Invalid Session collaboration mode');
  }
  return value;
}

function orchestrationMode(value: unknown): OrchestrationMode {
  if (!isOrchestrationMode(value)) {
    throw invalidProtocolFrame('Invalid Session orchestration mode');
  }
  return value;
}

function sessionName(value: unknown): string {
  return boundedText(value, 'Session name', SESSION_CATALOG_NAME_MAX_BYTES);
}

function timestamp(value: unknown, label: string): number {
  const result = requireCount(value, label);
  return result;
}

function positiveRevision(value: unknown, label: string): number {
  const revision = requireCount(value, label);
  if (revision < 1) throw invalidProtocolFrame(`Invalid ${label}`);
  return revision;
}

function catalogRevision(value: unknown): SessionCatalogRevision {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw invalidProtocolFrame('Invalid Session catalog revision');
  }
  return value as SessionCatalogRevision;
}

function boundedText(value: unknown, label: string, maxBytes: number): string {
  const text = requireUtf8String(value, label, maxBytes);
  if (text.trim() !== text || /[\u0000-\u001f\u007f]/.test(text)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return text;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function assertUpdateOutputIdentity(
  input:
    | SessionMetadataUpdateInput
    | SessionConfigurationUpdateInput
    | SessionWorkspaceRelocateInput,
  output: SessionUpdateResult,
): void {
  if (output.kind === 'committed') assertSessionIdentity(input.sessionId, output.session);
  if (output.kind === 'revision_conflict' && output.expectedRevision !== input.expectedRevision) {
    throw invalidProtocolFrame('Session revision conflict does not match request');
  }
}

function assertSessionIdentity(
  sessionId: string,
  output: Pick<SessionCatalogProjection, 'id'>,
): void {
  if (output.id !== sessionId) {
    throw invalidProtocolFrame('Session operation result identity does not match request');
  }
}
