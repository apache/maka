import {
  requireCount,
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineHostPathOperation, defineOperation } from './operation-spec.js';
import { decodeSessionCatalogItem, type SessionCatalogItem } from './session-catalog.js';
import { decodeWorkspaceTarget, type WorkspaceTarget } from './workspace.js';

export const EXTERNAL_SESSION_PAGE_MAX_ITEMS = 16;
export const EXTERNAL_SESSION_RESULT_MAX_BYTES = 72 * 1024;
export const EXTERNAL_SESSION_CWD_MAX_BYTES = 4 * 1024;
export const EXTERNAL_SESSION_NAME_MAX_BYTES = 320;
export const EXTERNAL_SESSION_SOURCE_SESSION_ID_MAX_BYTES = 512;
export const EXTERNAL_SESSION_SOURCE_MAX_ITEMS = 16;
const EXTERNAL_SESSION_CURSOR_MAX_BYTES = 32;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'persistence_failed',
  'internal_failure',
] as const;
const IMPORT_ERRORS = [
  ...QUERY_ERRORS,
  'not_found',
  'operation_conflict',
  'commit_outcome_unknown',
] as const;

export type ExternalSessionSourceQueryInput = Record<never, never>;

export interface ExternalSessionSourceQueryResult {
  readonly adapterIds: readonly string[];
}

export interface ExternalSessionCatalogQueryInput {
  readonly adapterId: string;
  readonly includeArchived?: boolean;
  readonly workspace?: WorkspaceTarget;
  readonly cursor?: string;
}

export interface ExternalSessionCatalogQueryResult {
  readonly sessions: readonly ExternalSessionCatalogItem[];
  readonly nextCursor: string | null;
}

export interface ExternalSessionCatalogItem {
  readonly id: string;
  readonly name: string;
  readonly hostCwd: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly archived?: boolean;
}

export interface ExternalSessionImportInput {
  readonly adapterId: string;
  readonly sourceSessionId: string;
}

export interface ExternalSessionImportResult {
  readonly session: SessionCatalogItem;
}

export const EXTERNAL_SESSION_OPERATION_SPECS = {
  'external-session.source.query': defineOperation<
    ExternalSessionSourceQueryInput,
    ExternalSessionSourceQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeExternalSessionSourceQueryInput,
    decodeOutput: decodeExternalSessionSourceQueryResult,
  }),
  'external-session.catalog.query': defineHostPathOperation<
    ExternalSessionCatalogQueryInput,
    ExternalSessionCatalogQueryResult,
    (typeof QUERY_ERRORS)[number]
  >(
    {
      mode: 'query',
      availability: 'ready',
      errors: QUERY_ERRORS,
      decodeInput: decodeExternalSessionCatalogQueryInput,
      decodeOutput: decodeExternalSessionCatalogQueryResult,
    },
    (input) => input.workspace?.kind === 'host_path',
  ),
  'external-session.import': defineOperation<
    ExternalSessionImportInput,
    ExternalSessionImportResult,
    (typeof IMPORT_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: IMPORT_ERRORS,
    decodeInput: decodeExternalSessionImportInput,
    decodeOutput: decodeExternalSessionImportResult,
  }),
} as const;

export function decodeExternalSessionSourceQueryInput(
  value: unknown,
): ExternalSessionSourceQueryInput {
  requireExactRecord(value, 'external Session source query input', []);
  return {};
}

export function decodeExternalSessionSourceQueryResult(
  value: unknown,
): ExternalSessionSourceQueryResult {
  const result = requireExactRecord(value, 'external Session source query result', ['adapterIds']);
  if (
    !Array.isArray(result.adapterIds) ||
    result.adapterIds.length > EXTERNAL_SESSION_SOURCE_MAX_ITEMS
  ) {
    throw invalidProtocolFrame('Invalid external Session source list');
  }
  const decoded = { adapterIds: result.adapterIds.map((id) => adapterId(id)) };
  requireEncodedByteLimit(
    decoded,
    'external Session source query result',
    EXTERNAL_SESSION_RESULT_MAX_BYTES,
  );
  return decoded;
}

export function decodeExternalSessionCatalogQueryInput(
  value: unknown,
): ExternalSessionCatalogQueryInput {
  const input = requireShapedRecord(
    value,
    'external Session catalog query input',
    ['adapterId'],
    ['includeArchived', 'workspace', 'cursor'],
  );
  return {
    adapterId: adapterId(input.adapterId),
    ...(Object.hasOwn(input, 'includeArchived')
      ? { includeArchived: boolean(input.includeArchived, 'includeArchived') }
      : {}),
    ...(Object.hasOwn(input, 'workspace')
      ? { workspace: decodeWorkspaceTarget(input.workspace) }
      : {}),
    ...(Object.hasOwn(input, 'cursor') ? { cursor: cursor(input.cursor) } : {}),
  };
}

export function decodeExternalSessionCatalogQueryResult(
  value: unknown,
): ExternalSessionCatalogQueryResult {
  const result = requireExactRecord(value, 'external Session catalog query result', [
    'sessions',
    'nextCursor',
  ]);
  if (!Array.isArray(result.sessions) || result.sessions.length > EXTERNAL_SESSION_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Invalid external Session catalog page');
  }
  const decoded = {
    sessions: result.sessions.map(decodeExternalSessionSummary),
    nextCursor: result.nextCursor === null ? null : cursor(result.nextCursor),
  };
  requireEncodedByteLimit(
    decoded,
    'external Session catalog query result',
    EXTERNAL_SESSION_RESULT_MAX_BYTES,
  );
  return decoded;
}

export function decodeExternalSessionImportInput(value: unknown): ExternalSessionImportInput {
  const input = requireExactRecord(value, 'external Session import input', [
    'adapterId',
    'sourceSessionId',
  ]);
  const sourceSessionId = requireUtf8String(
    input.sourceSessionId,
    'external source Session id',
    EXTERNAL_SESSION_SOURCE_SESSION_ID_MAX_BYTES,
  );
  if (/[\u0000-\u001f\u007f]/.test(sourceSessionId)) {
    throw invalidProtocolFrame('Invalid external source Session id');
  }
  return { adapterId: adapterId(input.adapterId), sourceSessionId };
}

export function decodeExternalSessionImportResult(value: unknown): ExternalSessionImportResult {
  const result = requireExactRecord(value, 'external Session import result', ['session']);
  const decoded = { session: decodeSessionCatalogItem(result.session) };
  requireEncodedByteLimit(
    decoded,
    'external Session import result',
    EXTERNAL_SESSION_RESULT_MAX_BYTES,
  );
  return decoded;
}

function decodeExternalSessionSummary(value: unknown): ExternalSessionCatalogItem {
  const summary = requireShapedRecord(
    value,
    'external Session summary',
    ['id', 'name', 'hostCwd'],
    ['createdAt', 'updatedAt', 'archived'],
  );
  const id = requireUtf8String(
    summary.id,
    'external source Session id',
    EXTERNAL_SESSION_SOURCE_SESSION_ID_MAX_BYTES,
  );
  if (/[\u0000-\u001f\u007f]/.test(id))
    throw invalidProtocolFrame('Invalid external source Session id');
  return {
    id,
    name: requireUtf8String(summary.name, 'external Session name', EXTERNAL_SESSION_NAME_MAX_BYTES),
    hostCwd: boundedPossiblyEmptyText(
      summary.hostCwd,
      'external Session Host cwd',
      EXTERNAL_SESSION_CWD_MAX_BYTES,
    ),
    ...(Object.hasOwn(summary, 'createdAt')
      ? { createdAt: requireCount(summary.createdAt, 'external Session createdAt') }
      : {}),
    ...(Object.hasOwn(summary, 'updatedAt')
      ? { updatedAt: requireCount(summary.updatedAt, 'external Session updatedAt') }
      : {}),
    ...(Object.hasOwn(summary, 'archived')
      ? { archived: boolean(summary.archived, 'archived') }
      : {}),
  };
}

function adapterId(value: unknown): string {
  return requireEntityId(value, 'external Session adapter id');
}

function cursor(value: unknown): string {
  const decoded = requireUtf8String(
    value,
    'external Session cursor',
    EXTERNAL_SESSION_CURSOR_MAX_BYTES,
  );
  if (!/^\d+$/.test(decoded) || !Number.isSafeInteger(Number(decoded))) {
    throw invalidProtocolFrame('Invalid external Session cursor');
  }
  return decoded;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function boundedPossiblyEmptyText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}
