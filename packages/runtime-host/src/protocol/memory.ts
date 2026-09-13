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
  LOCAL_MEMORY_MAX_BYTES,
  type LocalMemoryEntryPreview,
  type LocalMemoryEntryStatus,
  type LocalMemoryScope,
  type LocalMemorySource,
} from '@maka/core/local-memory';
import {
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireString,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const MEMORY_DOCUMENT_CHUNK_MAX_BYTES = 32 * 1024;
export const MEMORY_RESULT_MAX_BYTES = 48 * 1024;
export const MEMORY_ENTRY_PAGE_MAX_ITEMS = 64;
export const MEMORY_SEMANTIC_CONTENT_MAX_BYTES = 24 * 1024;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'persistence_failed',
  'internal_failure',
] as const;
const MUTATE_ERRORS = [...QUERY_ERRORS, 'commit_outcome_unknown'] as const;
const REVISION = /^sha256:[a-f0-9]{64}$/;

export type MemoryDocumentName = 'memory' | 'pending';
export type MemoryRevision = `sha256:${string}`;
export type MemoryBackupKind = 'save' | 'reset' | 'restore';
export type MemoryEntriesView = 'active' | 'archived' | 'proposals';

export type MemoryQueryInput =
  | { readonly kind: 'state' }
  | {
      readonly kind: 'entries_start';
      readonly view: MemoryEntriesView;
    }
  | {
      readonly kind: 'entries_continue';
      readonly view: MemoryEntriesView;
      readonly revision: MemoryRevision;
      readonly cursor: number;
    }
  | {
      readonly kind: 'document_start';
      readonly document: MemoryDocumentName;
    }
  | {
      readonly kind: 'document_continue';
      readonly document: MemoryDocumentName;
      readonly revision: MemoryRevision;
      readonly cursor: number;
    };

export interface MemoryBackupProjection {
  readonly kind: MemoryBackupKind;
  readonly revision: MemoryRevision;
  readonly updatedAt: number;
  readonly sizeBytes: number;
  readonly entryCount: number;
  readonly activeEntryCount: number;
  readonly archivedEntryCount: number;
  readonly safeMode: boolean;
  readonly reason?: string;
}

export interface MemoryStateProjection {
  readonly kind: 'state';
  readonly revision: MemoryRevision;
  readonly memoryRevision: MemoryRevision | null;
  readonly pendingRevision: MemoryRevision | null;
  readonly agentReadEnabled: boolean;
  readonly status: 'ok' | 'missing' | 'safe_mode';
  readonly entryCount: number;
  readonly activeEntryCount: number;
  readonly archivedEntryCount: number;
  readonly proposalCount: number;
  readonly backups: readonly MemoryBackupProjection[];
}

export type MemoryEntryProjection = Pick<
  LocalMemoryEntryPreview,
  | 'id'
  | 'source'
  | 'status'
  | 'title'
  | 'content'
  | 'scope'
  | 'sessionId'
  | 'proposalId'
  | 'sourceTurnId'
  | 'createdAt'
  | 'updatedAt'
  | 'proposedAt'
  | 'confirmedAt'
  | 'archivedAt'
  | 'rejectedAt'
  | 'tags'
>;

export interface MemoryEntriesPage {
  readonly kind: 'entries_page';
  readonly view: MemoryEntriesView;
  readonly revision: MemoryRevision;
  readonly items: readonly MemoryEntryProjection[];
  readonly nextCursor: number | null;
}

export interface MemoryDocumentPage {
  readonly kind: 'document_page';
  readonly document: MemoryDocumentName;
  readonly revision: MemoryRevision;
  readonly totalBytes: number;
  readonly offset: number;
  readonly chunkBase64: string;
  readonly nextCursor: number | null;
}

export type MemoryQueryResult =
  | MemoryStateProjection
  | MemoryEntriesPage
  | MemoryDocumentPage
  | {
      readonly kind: 'revision_changed';
      readonly expectedRevision: MemoryRevision;
      readonly actualRevision: MemoryRevision | null;
    }
  | {
      readonly kind: 'blocked';
      readonly reason: 'disabled' | 'incognito_active';
    }
  | {
      readonly kind: 'safe_mode';
      readonly document: MemoryDocumentName;
      readonly revision: MemoryRevision;
      readonly reason: 'invalid_utf8' | 'oversize';
      readonly byteLength: number;
    }
  | {
      readonly kind: 'missing';
      readonly document: MemoryDocumentName;
    };

export type MemoryScopeInput =
  | { readonly kind: 'workspace' }
  | { readonly kind: 'session'; readonly sessionId: string };

export type MemoryMutateInput =
  | {
      readonly kind: 'propose';
      readonly expectedRevision: MemoryRevision;
      readonly title: string;
      readonly content: string;
      readonly scope: MemoryScopeInput;
      readonly sourceTurnId?: string;
    }
  | {
      readonly kind: 'remember';
      readonly expectedRevision: MemoryRevision;
      readonly title: string;
      readonly content: string;
      readonly scope: MemoryScopeInput;
    }
  | {
      readonly kind: 'approve';
      readonly expectedRevision: MemoryRevision;
      readonly proposalId: string;
    }
  | {
      readonly kind: 'reject';
      readonly expectedRevision: MemoryRevision;
      readonly proposalId: string;
    }
  | {
      readonly kind: 'set_status';
      readonly expectedRevision: MemoryRevision;
      readonly entryId: string;
      readonly status: 'active' | 'archived';
      readonly archiveReason?: string;
    }
  | {
      readonly kind: 'reset';
      readonly expectedRevision: MemoryRevision;
    }
  | {
      readonly kind: 'restore_backup';
      readonly expectedRevision: MemoryRevision;
      readonly backupKind: MemoryBackupKind;
      readonly expectedBackupRevision: MemoryRevision;
    }
  | {
      readonly kind: 'replace_begin';
      readonly expectedRevision: MemoryRevision;
      readonly totalBytes: number;
      readonly contentSha256: MemoryRevision;
    }
  | {
      readonly kind: 'replace_chunk';
      readonly uploadId: string;
      readonly offset: number;
      readonly chunkBase64: string;
    }
  | {
      readonly kind: 'replace_commit';
      readonly uploadId: string;
    }
  | {
      readonly kind: 'replace_abort';
      readonly uploadId: string;
    };

export type MemoryMutationRejectionReason =
  | 'disabled'
  | 'incognito_active'
  | 'invalid_content'
  | 'invalid_scope'
  | 'invalid_state'
  | 'not_found'
  | 'not_pending'
  | 'oversize'
  | 'safe_mode'
  | 'upload_not_found'
  | 'upload_incomplete'
  | 'upload_conflict'
  | 'backup_not_found';

export type MemoryMutateResult =
  | {
      readonly kind: 'upload_opened';
      readonly uploadId: string;
      readonly nextOffset: 0;
    }
  | {
      readonly kind: 'chunk_accepted';
      readonly uploadId: string;
      readonly nextOffset: number;
    }
  | {
      readonly kind: 'upload_aborted';
      readonly uploadId: string;
    }
  | {
      readonly kind: 'committed' | 'unchanged';
      readonly revision: MemoryRevision;
      readonly memoryRevision: MemoryRevision | null;
      readonly pendingRevision: MemoryRevision | null;
    }
  | {
      readonly kind: 'revision_conflict';
      readonly expectedRevision: MemoryRevision;
      readonly actualRevision: MemoryRevision;
    }
  | {
      readonly kind: 'backup_revision_conflict';
      readonly backupKind: MemoryBackupKind;
      readonly expectedRevision: MemoryRevision;
      readonly actualRevision: MemoryRevision;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: MemoryMutationRejectionReason;
    };

export const MEMORY_OPERATION_SPECS = {
  'memory.query': defineOperation<
    MemoryQueryInput,
    MemoryQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeMemoryQueryInput,
    decodeOutput: decodeMemoryQueryResult,
  }),
  'memory.mutate': defineOperation<
    MemoryMutateInput,
    MemoryMutateResult,
    (typeof MUTATE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATE_ERRORS,
    decodeInput: decodeMemoryMutateInput,
    decodeOutput: decodeMemoryMutateResult,
  }),
} as const;

export function decodeMemoryQueryInput(value: unknown): MemoryQueryInput {
  const input = requireRecord(value, 'Memory query input');
  switch (input.kind) {
    case 'state':
      requireExactRecord(input, 'Memory state query', ['kind']);
      return { kind: 'state' };
    case 'entries_start': {
      const exact = requireExactRecord(input, 'Memory entries start query', ['kind', 'view']);
      return { kind: 'entries_start', view: requireEntriesView(exact.view) };
    }
    case 'entries_continue': {
      const exact = requireExactRecord(input, 'Memory entries continuation', [
        'kind',
        'view',
        'revision',
        'cursor',
      ]);
      return {
        kind: 'entries_continue',
        view: requireEntriesView(exact.view),
        revision: requireRevision(exact.revision, 'Memory bundle revision'),
        cursor: requireCount(exact.cursor, 'Memory entries cursor'),
      };
    }
    case 'document_start': {
      const exact = requireExactRecord(input, 'Memory document start query', ['kind', 'document']);
      return {
        kind: 'document_start',
        document: requireDocumentName(exact.document),
      };
    }
    case 'document_continue': {
      const exact = requireExactRecord(input, 'Memory document continuation', [
        'kind',
        'document',
        'revision',
        'cursor',
      ]);
      return {
        kind: 'document_continue',
        document: requireDocumentName(exact.document),
        revision: requireRevision(exact.revision, 'Memory document revision'),
        cursor: requireCount(exact.cursor, 'Memory document cursor'),
      };
    }
    default:
      throw invalidProtocolFrame('Invalid Memory query kind');
  }
}

export function decodeMemoryQueryResult(value: unknown): MemoryQueryResult {
  assertMemoryResultSize(value);
  const result = requireRecord(value, 'Memory query result');
  switch (result.kind) {
    case 'state':
      return decodeState(result);
    case 'entries_page':
      return decodeEntriesPage(result);
    case 'document_page':
      return decodeDocumentPage(result);
    case 'revision_changed': {
      const exact = requireExactRecord(result, 'Memory revision change', [
        'kind',
        'expectedRevision',
        'actualRevision',
      ]);
      return {
        kind: 'revision_changed',
        expectedRevision: requireRevision(exact.expectedRevision, 'expected Memory revision'),
        actualRevision:
          exact.actualRevision === null
            ? null
            : requireRevision(exact.actualRevision, 'actual Memory revision'),
      };
    }
    case 'blocked': {
      const exact = requireExactRecord(result, 'Memory blocked result', ['kind', 'reason']);
      if (exact.reason !== 'disabled' && exact.reason !== 'incognito_active') {
        throw invalidProtocolFrame('Invalid Memory block reason');
      }
      return { kind: 'blocked', reason: exact.reason };
    }
    case 'safe_mode': {
      const exact = requireExactRecord(result, 'Memory safe-mode result', [
        'kind',
        'document',
        'revision',
        'reason',
        'byteLength',
      ]);
      if (exact.reason !== 'invalid_utf8' && exact.reason !== 'oversize') {
        throw invalidProtocolFrame('Invalid Memory safe-mode reason');
      }
      return {
        kind: 'safe_mode',
        document: requireDocumentName(exact.document),
        revision: requireRevision(exact.revision, 'Memory document revision'),
        reason: exact.reason,
        byteLength: requireCount(exact.byteLength, 'Memory document byte length'),
      };
    }
    case 'missing': {
      const exact = requireExactRecord(result, 'Memory missing result', ['kind', 'document']);
      return { kind: 'missing', document: requireDocumentName(exact.document) };
    }
    default:
      throw invalidProtocolFrame('Invalid Memory query result kind');
  }
}

export function decodeMemoryMutateInput(value: unknown): MemoryMutateInput {
  const input = requireRecord(value, 'Memory mutation input');
  switch (input.kind) {
    case 'propose':
      return decodePropose(input);
    case 'remember':
      return decodeRemember(input);
    case 'approve':
    case 'reject': {
      const exact = requireExactRecord(input, `Memory ${input.kind} mutation`, [
        'kind',
        'expectedRevision',
        'proposalId',
      ]);
      return {
        kind: input.kind,
        expectedRevision: requireRevision(
          exact.expectedRevision,
          'expected Memory bundle revision',
        ),
        proposalId: requireEntityId(exact.proposalId, 'Memory proposal id'),
      };
    }
    case 'set_status': {
      const keys = ['kind', 'expectedRevision', 'entryId', 'status'];
      if (input.archiveReason !== undefined) keys.push('archiveReason');
      const exact = requireExactRecord(input, 'Memory status mutation', keys);
      if (exact.status !== 'active' && exact.status !== 'archived') {
        throw invalidProtocolFrame('Invalid Memory entry status');
      }
      return {
        kind: 'set_status',
        expectedRevision: requireRevision(
          exact.expectedRevision,
          'expected Memory bundle revision',
        ),
        entryId: requireEntityId(exact.entryId, 'Memory entry id'),
        status: exact.status,
        ...(exact.archiveReason === undefined
          ? {}
          : {
              archiveReason: requireUtf8String(exact.archiveReason, 'Memory archive reason', 512),
            }),
      };
    }
    case 'reset': {
      const exact = requireExactRecord(input, 'Memory reset mutation', [
        'kind',
        'expectedRevision',
      ]);
      return {
        kind: 'reset',
        expectedRevision: requireRevision(
          exact.expectedRevision,
          'expected Memory bundle revision',
        ),
      };
    }
    case 'restore_backup': {
      const exact = requireExactRecord(input, 'Memory backup restore mutation', [
        'kind',
        'expectedRevision',
        'backupKind',
        'expectedBackupRevision',
      ]);
      return {
        kind: 'restore_backup',
        expectedRevision: requireRevision(
          exact.expectedRevision,
          'expected Memory bundle revision',
        ),
        backupKind: requireBackupKind(exact.backupKind),
        expectedBackupRevision: requireRevision(
          exact.expectedBackupRevision,
          'expected Memory backup revision',
        ),
      };
    }
    case 'replace_begin': {
      const exact = requireExactRecord(input, 'Memory replace begin mutation', [
        'kind',
        'expectedRevision',
        'totalBytes',
        'contentSha256',
      ]);
      const totalBytes = requireCount(exact.totalBytes, 'Memory replacement byte length');
      if (totalBytes > LOCAL_MEMORY_MAX_BYTES) {
        throw invalidProtocolFrame('Memory replacement exceeds its byte limit');
      }
      return {
        kind: 'replace_begin',
        expectedRevision: requireRevision(
          exact.expectedRevision,
          'expected Memory bundle revision',
        ),
        totalBytes,
        contentSha256: requireRevision(exact.contentSha256, 'Memory replacement content revision'),
      };
    }
    case 'replace_chunk': {
      const exact = requireExactRecord(input, 'Memory replace chunk mutation', [
        'kind',
        'uploadId',
        'offset',
        'chunkBase64',
      ]);
      return {
        kind: 'replace_chunk',
        uploadId: requireEntityId(exact.uploadId, 'Memory upload id'),
        offset: requireCount(exact.offset, 'Memory upload offset'),
        chunkBase64: requireBase64Chunk(exact.chunkBase64),
      };
    }
    case 'replace_commit':
    case 'replace_abort': {
      const exact = requireExactRecord(input, `Memory ${input.kind} mutation`, [
        'kind',
        'uploadId',
      ]);
      return {
        kind: input.kind,
        uploadId: requireEntityId(exact.uploadId, 'Memory upload id'),
      };
    }
    default:
      throw invalidProtocolFrame('Invalid Memory mutation kind');
  }
}

export function decodeMemoryMutateResult(value: unknown): MemoryMutateResult {
  const result = requireRecord(value, 'Memory mutation result');
  switch (result.kind) {
    case 'upload_opened': {
      const exact = requireExactRecord(result, 'Memory upload opened result', [
        'kind',
        'uploadId',
        'nextOffset',
      ]);
      if (exact.nextOffset !== 0) throw invalidProtocolFrame('Invalid Memory upload offset');
      return {
        kind: 'upload_opened',
        uploadId: requireEntityId(exact.uploadId, 'Memory upload id'),
        nextOffset: 0,
      };
    }
    case 'chunk_accepted': {
      const exact = requireExactRecord(result, 'Memory chunk accepted result', [
        'kind',
        'uploadId',
        'nextOffset',
      ]);
      return {
        kind: 'chunk_accepted',
        uploadId: requireEntityId(exact.uploadId, 'Memory upload id'),
        nextOffset: requireCount(exact.nextOffset, 'Memory upload offset'),
      };
    }
    case 'upload_aborted': {
      const exact = requireExactRecord(result, 'Memory upload aborted result', [
        'kind',
        'uploadId',
      ]);
      return {
        kind: 'upload_aborted',
        uploadId: requireEntityId(exact.uploadId, 'Memory upload id'),
      };
    }
    case 'committed':
    case 'unchanged': {
      const exact = requireExactRecord(result, 'Memory committed result', [
        'kind',
        'revision',
        'memoryRevision',
        'pendingRevision',
      ]);
      return {
        kind: result.kind,
        revision: requireRevision(exact.revision, 'Memory bundle revision'),
        memoryRevision: requireNullableRevision(exact.memoryRevision, 'MEMORY.md revision'),
        pendingRevision: requireNullableRevision(exact.pendingRevision, 'PENDING.md revision'),
      };
    }
    case 'revision_conflict': {
      const exact = requireExactRecord(result, 'Memory revision conflict', [
        'kind',
        'expectedRevision',
        'actualRevision',
      ]);
      return {
        kind: 'revision_conflict',
        expectedRevision: requireRevision(
          exact.expectedRevision,
          'expected Memory bundle revision',
        ),
        actualRevision: requireRevision(exact.actualRevision, 'actual Memory bundle revision'),
      };
    }
    case 'backup_revision_conflict': {
      const exact = requireExactRecord(result, 'Memory backup revision conflict', [
        'kind',
        'backupKind',
        'expectedRevision',
        'actualRevision',
      ]);
      return {
        kind: 'backup_revision_conflict',
        backupKind: requireBackupKind(exact.backupKind),
        expectedRevision: requireRevision(
          exact.expectedRevision,
          'expected Memory backup revision',
        ),
        actualRevision: requireRevision(exact.actualRevision, 'actual Memory backup revision'),
      };
    }
    case 'rejected': {
      const exact = requireExactRecord(result, 'Memory rejected mutation', ['kind', 'reason']);
      return { kind: 'rejected', reason: requireRejectionReason(exact.reason) };
    }
    default:
      throw invalidProtocolFrame('Invalid Memory mutation result kind');
  }
}

function decodePropose(
  input: Record<string, unknown>,
): Extract<MemoryMutateInput, { kind: 'propose' }> {
  const keys = ['kind', 'expectedRevision', 'title', 'content', 'scope'];
  if (input.sourceTurnId !== undefined) keys.push('sourceTurnId');
  const exact = requireExactRecord(input, 'Memory propose mutation', keys);
  return {
    kind: 'propose',
    expectedRevision: requireRevision(exact.expectedRevision, 'expected Memory bundle revision'),
    title: requireUtf8String(exact.title, 'Memory title', 512),
    content: requireUtf8String(exact.content, 'Memory content', MEMORY_SEMANTIC_CONTENT_MAX_BYTES),
    scope: decodeScope(exact.scope),
    ...(exact.sourceTurnId === undefined
      ? {}
      : { sourceTurnId: requireEntityId(exact.sourceTurnId, 'source turn id') }),
  };
}

function decodeRemember(
  input: Record<string, unknown>,
): Extract<MemoryMutateInput, { kind: 'remember' }> {
  const exact = requireExactRecord(input, 'Memory remember mutation', [
    'kind',
    'expectedRevision',
    'title',
    'content',
    'scope',
  ]);
  return {
    kind: 'remember',
    expectedRevision: requireRevision(exact.expectedRevision, 'expected Memory bundle revision'),
    title: requireUtf8String(exact.title, 'Memory title', 512),
    content: requireUtf8String(exact.content, 'Memory content', MEMORY_SEMANTIC_CONTENT_MAX_BYTES),
    scope: decodeScope(exact.scope),
  };
}

function decodeScope(value: unknown): MemoryScopeInput {
  const scope = requireRecord(value, 'Memory scope');
  if (scope.kind === 'workspace') {
    requireExactRecord(scope, 'workspace Memory scope', ['kind']);
    return { kind: 'workspace' };
  }
  if (scope.kind === 'session') {
    const exact = requireExactRecord(scope, 'session Memory scope', ['kind', 'sessionId']);
    return {
      kind: 'session',
      sessionId: requireEntityId(exact.sessionId, 'Memory session id'),
    };
  }
  throw invalidProtocolFrame('Invalid Memory scope');
}

function decodeState(input: Record<string, unknown>): MemoryStateProjection {
  const exact = requireExactRecord(input, 'Memory state result', [
    'kind',
    'revision',
    'memoryRevision',
    'pendingRevision',
    'agentReadEnabled',
    'status',
    'entryCount',
    'activeEntryCount',
    'archivedEntryCount',
    'proposalCount',
    'backups',
  ]);
  if (exact.status !== 'ok' && exact.status !== 'missing' && exact.status !== 'safe_mode') {
    throw invalidProtocolFrame('Invalid Memory state status');
  }
  if (
    typeof exact.agentReadEnabled !== 'boolean' ||
    !Array.isArray(exact.backups) ||
    exact.backups.length > 3
  ) {
    throw invalidProtocolFrame('Invalid Memory state projection');
  }
  return {
    kind: 'state',
    revision: requireRevision(exact.revision, 'Memory bundle revision'),
    memoryRevision: requireNullableRevision(exact.memoryRevision, 'MEMORY.md revision'),
    pendingRevision: requireNullableRevision(exact.pendingRevision, 'PENDING.md revision'),
    agentReadEnabled: exact.agentReadEnabled,
    status: exact.status,
    entryCount: requireCount(exact.entryCount, 'Memory entry count'),
    activeEntryCount: requireCount(exact.activeEntryCount, 'active Memory entry count'),
    archivedEntryCount: requireCount(exact.archivedEntryCount, 'archived Memory entry count'),
    proposalCount: requireCount(exact.proposalCount, 'Memory proposal count'),
    backups: exact.backups.map(decodeBackup),
  };
}

function decodeEntriesPage(input: Record<string, unknown>): MemoryEntriesPage {
  const exact = requireExactRecord(input, 'Memory entries page', [
    'kind',
    'view',
    'revision',
    'items',
    'nextCursor',
  ]);
  if (!Array.isArray(exact.items) || exact.items.length > MEMORY_ENTRY_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Invalid Memory entry page items');
  }
  return {
    kind: 'entries_page',
    view: requireEntriesView(exact.view),
    revision: requireRevision(exact.revision, 'Memory bundle revision'),
    items: exact.items.map(decodeEntry),
    nextCursor:
      exact.nextCursor === null ? null : requireCount(exact.nextCursor, 'Memory entries cursor'),
  };
}

function decodeDocumentPage(input: Record<string, unknown>): MemoryDocumentPage {
  const exact = requireExactRecord(input, 'Memory document page', [
    'kind',
    'document',
    'revision',
    'totalBytes',
    'offset',
    'chunkBase64',
    'nextCursor',
  ]);
  return {
    kind: 'document_page',
    document: requireDocumentName(exact.document),
    revision: requireRevision(exact.revision, 'Memory document revision'),
    totalBytes: requireCount(exact.totalBytes, 'Memory document byte length'),
    offset: requireCount(exact.offset, 'Memory document offset'),
    chunkBase64: requireBase64Chunk(exact.chunkBase64, true),
    nextCursor:
      exact.nextCursor === null ? null : requireCount(exact.nextCursor, 'Memory document cursor'),
  };
}

function decodeEntry(value: unknown): MemoryEntryProjection {
  const entry = requireRecord(value, 'Memory entry');
  const required = ['id', 'source', 'status', 'title', 'content', 'scope', 'tags'];
  const optional = [
    'sessionId',
    'proposalId',
    'sourceTurnId',
    'createdAt',
    'updatedAt',
    'proposedAt',
    'confirmedAt',
    'archivedAt',
    'rejectedAt',
  ];
  assertKnownOptionalKeys(entry, 'Memory entry', required, optional);
  if (!Array.isArray(entry.tags) || entry.tags.length > 8) {
    throw invalidProtocolFrame('Invalid Memory entry tags');
  }
  const source = requireMemorySource(entry.source);
  const status = requireMemoryStatus(entry.status);
  const scope = requireMemoryScope(entry.scope);
  return {
    id: requireUtf8String(entry.id, 'Memory entry id', 512),
    source,
    status,
    title: requireUtf8String(entry.title, 'Memory entry title', 512),
    content: requireUtf8String(entry.content, 'Memory entry content', 4 * 1024),
    scope,
    ...(entry.sessionId === undefined
      ? {}
      : { sessionId: requireUtf8String(entry.sessionId, 'Memory session id', 512) }),
    ...(entry.proposalId === undefined
      ? {}
      : { proposalId: requireUtf8String(entry.proposalId, 'Memory proposal id', 512) }),
    ...(entry.sourceTurnId === undefined
      ? {}
      : { sourceTurnId: requireUtf8String(entry.sourceTurnId, 'source turn id', 512) }),
    ...decodeOptionalTimestamps(entry),
    tags: entry.tags.map((tag) => requireUtf8String(tag, 'Memory tag', 64)),
  };
}

function decodeOptionalTimestamps(
  entry: Record<string, unknown>,
): Partial<
  Pick<
    MemoryEntryProjection,
    'createdAt' | 'updatedAt' | 'proposedAt' | 'confirmedAt' | 'archivedAt' | 'rejectedAt'
  >
> {
  const result: Record<string, number> = {};
  for (const key of [
    'createdAt',
    'updatedAt',
    'proposedAt',
    'confirmedAt',
    'archivedAt',
    'rejectedAt',
  ] as const) {
    if (entry[key] !== undefined) result[key] = requireCount(entry[key], `Memory ${key}`);
  }
  return result;
}

function decodeBackup(value: unknown): MemoryBackupProjection {
  const backup = requireRecord(value, 'Memory backup');
  const required = [
    'kind',
    'revision',
    'updatedAt',
    'sizeBytes',
    'entryCount',
    'activeEntryCount',
    'archivedEntryCount',
    'safeMode',
  ];
  assertKnownOptionalKeys(backup, 'Memory backup', required, ['reason']);
  if (typeof backup.safeMode !== 'boolean') {
    throw invalidProtocolFrame('Invalid Memory backup safe-mode state');
  }
  return {
    kind: requireBackupKind(backup.kind),
    revision: requireRevision(backup.revision, 'Memory backup revision'),
    updatedAt: requireCount(backup.updatedAt, 'Memory backup timestamp'),
    sizeBytes: requireCount(backup.sizeBytes, 'Memory backup size'),
    entryCount: requireCount(backup.entryCount, 'Memory backup entry count'),
    activeEntryCount: requireCount(backup.activeEntryCount, 'Memory backup active entry count'),
    archivedEntryCount: requireCount(
      backup.archivedEntryCount,
      'Memory backup archived entry count',
    ),
    safeMode: backup.safeMode,
    ...(backup.reason === undefined
      ? {}
      : { reason: requireUtf8String(backup.reason, 'Memory backup reason', 512) }),
  };
}

function requireDocumentName(value: unknown): MemoryDocumentName {
  if (value !== 'memory' && value !== 'pending') {
    throw invalidProtocolFrame('Invalid Memory document name');
  }
  return value;
}

function requireEntriesView(value: unknown): MemoryEntriesView {
  if (value !== 'active' && value !== 'archived' && value !== 'proposals') {
    throw invalidProtocolFrame('Invalid Memory entries view');
  }
  return value;
}

function requireBackupKind(value: unknown): MemoryBackupKind {
  if (value !== 'save' && value !== 'reset' && value !== 'restore') {
    throw invalidProtocolFrame('Invalid Memory backup kind');
  }
  return value;
}

function requireMemoryScope(value: unknown): LocalMemoryScope {
  if (value !== 'workspace' && value !== 'session') {
    throw invalidProtocolFrame('Invalid Memory entry scope');
  }
  return value;
}

function requireMemorySource(value: unknown): LocalMemorySource {
  if (value !== 'user_authored' && value !== 'chat_extracted' && value !== 'unknown') {
    throw invalidProtocolFrame('Invalid Memory entry source');
  }
  return value;
}

function requireMemoryStatus(value: unknown): LocalMemoryEntryStatus {
  if (
    value !== 'draft' &&
    value !== 'review_required' &&
    value !== 'active' &&
    value !== 'archived' &&
    value !== 'rejected' &&
    value !== 'unknown'
  ) {
    throw invalidProtocolFrame('Invalid Memory entry status');
  }
  return value;
}

function requireRejectionReason(value: unknown): MemoryMutationRejectionReason {
  const allowed: readonly MemoryMutationRejectionReason[] = [
    'disabled',
    'incognito_active',
    'invalid_content',
    'invalid_scope',
    'invalid_state',
    'not_found',
    'not_pending',
    'oversize',
    'safe_mode',
    'upload_not_found',
    'upload_incomplete',
    'upload_conflict',
    'backup_not_found',
  ];
  if (typeof value !== 'string' || !allowed.includes(value as MemoryMutationRejectionReason)) {
    throw invalidProtocolFrame('Invalid Memory mutation rejection reason');
  }
  return value as MemoryMutationRejectionReason;
}

function requireRevision(value: unknown, label: string): MemoryRevision {
  if (typeof value !== 'string' || !REVISION.test(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as MemoryRevision;
}

function requireNullableRevision(value: unknown, label: string): MemoryRevision | null {
  return value === null ? null : requireRevision(value, label);
}

function requireUtf8String(value: unknown, label: string, maxBytes: number): string {
  const text = requireString(value, label, maxBytes);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return text;
}

function requireBase64Chunk(value: unknown, allowEmpty = false): string {
  if (allowEmpty && value === '') return '';
  const encoded = requireString(
    value,
    'Memory chunk',
    Math.ceil(MEMORY_DOCUMENT_CHUNK_MAX_BYTES / 3) * 4,
  );
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw invalidProtocolFrame('Invalid Memory chunk');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (
    decoded.byteLength > MEMORY_DOCUMENT_CHUNK_MAX_BYTES ||
    decoded.toString('base64') !== encoded
  ) {
    throw invalidProtocolFrame('Invalid Memory chunk');
  }
  return encoded;
}

function assertKnownOptionalKeys(
  record: Record<string, unknown>,
  label: string,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw invalidProtocolFrame(`Invalid ${label} fields`);
  }
}

function assertMemoryResultSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MEMORY_RESULT_MAX_BYTES) {
    throw invalidProtocolFrame('Memory result exceeds byte limit');
  }
}
