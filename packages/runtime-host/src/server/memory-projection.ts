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

import { parseLocalMemoryMarkdown, type LocalMemoryEntryPreview } from '@maka/core/local-memory';
import type {
  MemoryBackupSnapshot,
  MemoryBundleSnapshot,
  MemoryDocumentSnapshot,
} from '@maka/storage/memory-bundle-store';
import {
  MEMORY_DOCUMENT_CHUNK_MAX_BYTES,
  MEMORY_ENTRY_PAGE_MAX_ITEMS,
  MEMORY_RESULT_MAX_BYTES,
  type MemoryDocumentName,
  type MemoryEntriesPage,
  type MemoryEntryProjection,
  type MemoryQueryInput,
  type MemoryQueryResult,
} from '../protocol/index.js';

export class MemoryProjectionError extends Error {}

export function projectMemoryQuery(
  input: MemoryQueryInput,
  snapshot: MemoryBundleSnapshot,
  agentReadEnabled: boolean,
  backups: readonly MemoryBackupSnapshot[],
): MemoryQueryResult {
  switch (input.kind) {
    case 'state':
      return projectState(snapshot, agentReadEnabled, backups);
    case 'entries_start':
      return projectEntries(snapshot, input.view, 0);
    case 'entries_continue':
      return input.revision === snapshot.revision
        ? projectEntries(snapshot, input.view, input.cursor)
        : {
            kind: 'revision_changed',
            expectedRevision: input.revision,
            actualRevision: snapshot.revision,
          };
    case 'document_start':
      return projectDocument(snapshot, input.document, 0);
    case 'document_continue': {
      const document = snapshot[input.document];
      return document.revision === input.revision
        ? projectDocument(snapshot, input.document, input.cursor)
        : {
            kind: 'revision_changed',
            expectedRevision: input.revision,
            actualRevision: document.revision,
          };
    }
  }
}

function projectState(
  snapshot: MemoryBundleSnapshot,
  agentReadEnabled: boolean,
  backups: readonly MemoryBackupSnapshot[],
): MemoryQueryResult {
  const memory = parseSnapshot(snapshot.memory);
  const pending = parseSnapshot(snapshot.pending);
  const status =
    snapshot.memory.kind === 'safe_mode' || snapshot.pending.kind === 'safe_mode'
      ? 'safe_mode'
      : snapshot.memory.kind === 'missing'
        ? 'missing'
        : 'ok';
  return {
    kind: 'state',
    revision: snapshot.revision,
    memoryRevision: snapshot.memory.revision,
    pendingRevision: snapshot.pending.revision,
    agentReadEnabled,
    status,
    entryCount: memory?.entries.length ?? 0,
    activeEntryCount: memory?.activeEntries.length ?? 0,
    archivedEntryCount: memory?.archivedEntries.length ?? 0,
    proposalCount:
      pending?.entries.filter(
        (entry) => entry.status === 'draft' || entry.status === 'review_required',
      ).length ?? 0,
    backups: backups.map(projectBackup),
  };
}

function projectBackup(backup: MemoryBackupSnapshot) {
  const parsed =
    backup.document.kind === 'document'
      ? parseLocalMemoryMarkdown(decodeDocument(backup.document))
      : undefined;
  return {
    kind: backup.kind,
    revision: backup.revision,
    updatedAt: boundedCount(backup.updatedAt),
    sizeBytes: backup.document.byteLength,
    entryCount: parsed?.entries.length ?? 0,
    activeEntryCount: parsed?.activeEntries.length ?? 0,
    archivedEntryCount: parsed?.archivedEntries.length ?? 0,
    safeMode: backup.document.kind === 'safe_mode' || parsed?.safeMode === true,
    ...(backup.document.kind === 'safe_mode'
      ? { reason: backup.document.reason }
      : parsed?.reason
        ? { reason: parsed.reason }
        : {}),
  };
}

function projectEntries(
  snapshot: MemoryBundleSnapshot,
  view: 'active' | 'archived' | 'proposals',
  offset: number,
): MemoryQueryResult {
  const document = view === 'proposals' ? snapshot.pending : snapshot.memory;
  if (document.kind === 'missing') {
    return { kind: 'missing', document: view === 'proposals' ? 'pending' : 'memory' };
  }
  if (document.kind === 'safe_mode') {
    return projectSafeMode(document, view === 'proposals' ? 'pending' : 'memory');
  }
  const parsed = parseLocalMemoryMarkdown(decodeDocument(document));
  const source =
    view === 'active'
      ? parsed.activeEntries
      : view === 'archived'
        ? parsed.archivedEntries
        : parsed.entries.filter(
            (entry) => entry.status === 'draft' || entry.status === 'review_required',
          );
  if (offset > source.length) {
    throw new MemoryProjectionError('Memory entries cursor is out of range');
  }
  return entriesPage(snapshot.revision, view, source, offset);
}

function entriesPage(
  revision: MemoryBundleSnapshot['revision'],
  view: 'active' | 'archived' | 'proposals',
  source: readonly LocalMemoryEntryPreview[],
  offset: number,
): MemoryEntriesPage {
  const items: MemoryEntryProjection[] = [];
  const limit = Math.min(source.length, offset + MEMORY_ENTRY_PAGE_MAX_ITEMS);
  for (let index = offset; index < limit; index += 1) {
    const entry = source[index];
    if (!entry) break;
    const candidate = [...items, projectEntry(entry)];
    const nextOffset = offset + candidate.length;
    const page = {
      kind: 'entries_page' as const,
      view,
      revision,
      items: candidate,
      nextCursor: nextOffset < source.length ? nextOffset : null,
    };
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') > MEMORY_RESULT_MAX_BYTES) break;
    items.push(candidate.at(-1)!);
  }
  if (items.length === 0 && offset < source.length) {
    throw new Error('A legal Memory entry exceeded the page result byte limit');
  }
  const nextOffset = offset + items.length;
  return {
    kind: 'entries_page',
    view,
    revision,
    items,
    nextCursor: nextOffset < source.length ? nextOffset : null,
  };
}

function projectEntry(entry: LocalMemoryEntryPreview): MemoryEntryProjection {
  return {
    id: entry.id,
    source: entry.source,
    status: entry.status,
    title: boundedUtf8(entry.title, 512),
    content: boundedUtf8(entry.content, 4 * 1024),
    scope: entry.scope ?? 'workspace',
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(entry.proposalId ? { proposalId: entry.proposalId } : {}),
    ...(entry.sourceTurnId ? { sourceTurnId: entry.sourceTurnId } : {}),
    ...projectTimestamps(entry),
    tags: entry.tags.map((tag) => boundedUtf8(tag, 64)),
  };
}

type MemoryTimestampProjection = Pick<
  MemoryEntryProjection,
  'createdAt' | 'updatedAt' | 'proposedAt' | 'confirmedAt' | 'archivedAt' | 'rejectedAt'
>;

function projectTimestamps(entry: LocalMemoryEntryPreview): Partial<MemoryTimestampProjection> {
  return {
    ...(isProtocolCount(entry.createdAt) ? { createdAt: entry.createdAt } : {}),
    ...(isProtocolCount(entry.updatedAt) ? { updatedAt: entry.updatedAt } : {}),
    ...(isProtocolCount(entry.proposedAt) ? { proposedAt: entry.proposedAt } : {}),
    ...(isProtocolCount(entry.confirmedAt) ? { confirmedAt: entry.confirmedAt } : {}),
    ...(isProtocolCount(entry.archivedAt) ? { archivedAt: entry.archivedAt } : {}),
    ...(isProtocolCount(entry.rejectedAt) ? { rejectedAt: entry.rejectedAt } : {}),
  };
}

function isProtocolCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bounded = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    bounded += character;
    bytes += characterBytes;
  }
  return bounded;
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value)));
}

function projectDocument(
  snapshot: MemoryBundleSnapshot,
  name: MemoryDocumentName,
  offset: number,
): MemoryQueryResult {
  const document = snapshot[name];
  if (document.kind === 'missing') return { kind: 'missing', document: name };
  if (document.kind === 'safe_mode') return projectSafeMode(document, name);
  if (offset > document.byteLength) {
    throw new MemoryProjectionError('Memory document cursor is out of range');
  }
  const chunk = Buffer.from(document.bytes).subarray(
    offset,
    Math.min(document.byteLength, offset + MEMORY_DOCUMENT_CHUNK_MAX_BYTES),
  );
  const nextOffset = offset + chunk.byteLength;
  return {
    kind: 'document_page',
    document: name,
    revision: document.revision,
    totalBytes: document.byteLength,
    offset,
    chunkBase64: chunk.toString('base64'),
    nextCursor: nextOffset < document.byteLength ? nextOffset : null,
  };
}

function projectSafeMode(
  document: Extract<MemoryDocumentSnapshot, { kind: 'safe_mode' }>,
  name: MemoryDocumentName,
): MemoryQueryResult {
  return {
    kind: 'safe_mode',
    document: name,
    revision: document.revision,
    reason: document.reason,
    byteLength: document.byteLength,
  };
}

function parseSnapshot(document: MemoryDocumentSnapshot) {
  return document.kind === 'document'
    ? parseLocalMemoryMarkdown(decodeDocument(document))
    : undefined;
}

function decodeDocument(document: Extract<MemoryDocumentSnapshot, { kind: 'document' }>): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(document.bytes);
}
