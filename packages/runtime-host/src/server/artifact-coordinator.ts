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

import { createHash } from 'node:crypto';
import { attachmentKindFromMimeType } from '@maka/core/attachments';
import type { AttachmentRef } from '@maka/core/events';
import type { ArtifactRecord } from '@maka/core/artifacts';
import {
  authenticateInteractiveArtifactStoreWriter,
  sanitizeArtifactName,
  type InteractiveArtifactStoreWriter,
} from '@maka/storage/artifact-stores';
import {
  ARTIFACT_PAGE_MAX_ITEMS,
  ARTIFACT_PREVIEW_MAX_BYTES,
  ARTIFACT_READ_CHUNK_MAX_BYTES,
  ARTIFACT_RESULT_MAX_BYTES,
  type ArtifactIngestInput,
  type ArtifactIngestResult,
  encodeArtifactDeleteResult,
  encodeArtifactQueryResult,
  type ArtifactProjection,
  type ArtifactQueryInput,
  type ArtifactQueryResult,
  type ArtifactRevision,
  type OperationOutcome,
} from '../protocol/index.js';
import { encodeArtifactProjection } from '../protocol/artifact.js';
import type { ArtifactOperationHandlerMap } from './operation-dispatcher.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import type { SessionPresenceReader } from './session-presence.js';
import { ConnectionBoundChunkUploads } from './connection-bound-chunk-uploads.js';

const MAX_ACTIVE_ARTIFACT_UPLOADS = 16;
const MAX_STAGED_ARTIFACT_UPLOAD_BYTES = 128 * 1024 * 1024;
const ARTIFACT_UPLOAD_TTL_MS = 5 * 60 * 1000;

interface ArtifactUploadMetadata {
  readonly attachmentKind: AttachmentRef['kind'];
  readonly name: string;
  readonly mimeType: string;
  readonly contentSha256: `sha256:${string}`;
}

/** Session-scoped Host projection and deletion authority for Artifacts. */
export class HostArtifactCoordinator {
  readonly handlers: ArtifactOperationHandlerMap = {
    'artifact.ingest': (input, context) =>
      this.#sessionAdmission.run(input.sessionId, () => this.#ingest(input, context)),
    'artifact.query': (input) =>
      this.#sessionAdmission.run(input.sessionId, () => this.#query(input)),
    'artifact.delete': (input) =>
      this.#sessionAdmission.run(input.sessionId, () => this.#delete(input)),
  };

  readonly #store: InteractiveArtifactStoreWriter;
  readonly #requestDrain: () => void;
  readonly #sessionAdmission: SessionAdmissionGate;
  readonly #sessions: SessionPresenceReader;
  readonly #uploads: ConnectionBoundChunkUploads<ArtifactUploadMetadata>;

  constructor(
    store: InteractiveArtifactStoreWriter,
    requestDrain: () => void,
    sessionAdmission: SessionAdmissionGate,
    sessions: SessionPresenceReader,
    now: () => number = Date.now,
  ) {
    this.#store = authenticateInteractiveArtifactStoreWriter(store);
    this.#requestDrain = requestDrain;
    this.#sessionAdmission = sessionAdmission;
    this.#sessions = sessions;
    this.#uploads = new ConnectionBoundChunkUploads(
      {
        maxActive: MAX_ACTIVE_ARTIFACT_UPLOADS,
        maxStagedBytes: MAX_STAGED_ARTIFACT_UPLOAD_BYTES,
        ttlMs: ARTIFACT_UPLOAD_TTL_MS,
      },
      now,
    );
  }

  releaseConnection(connectionId: string): void {
    this.#uploads.releaseConnection(connectionId);
  }

  async validateTurnAttachments(
    sessionId: string,
    attachments: readonly AttachmentRef[],
  ): Promise<string | undefined> {
    for (const attachment of attachments) {
      if (attachment.ref.kind !== 'session_file') {
        return 'Hosted Turn attachments must use a Session Artifact reference';
      }
      if (attachment.ref.sessionId !== sessionId) {
        return 'Attachment belongs to a different Session';
      }
      const entry = await this.#store.getInSession(sessionId, attachment.ref.relativePath);
      const record = entry.record;
      if (!record || record.status !== 'live') return 'Attachment Artifact was not found';
      if (
        record.name !== attachment.name ||
        record.mimeType !== attachment.mimeType ||
        record.sizeBytes !== attachment.bytes
      ) {
        return 'Attachment metadata does not match its canonical Artifact';
      }
      const canonicalKind = attachmentKindFromMimeType(record.mimeType, record.name);
      if (
        attachment.kind !== canonicalKind ||
        (canonicalKind === 'image' && record.kind !== 'image') ||
        (canonicalKind === 'pdf' && record.kind !== 'pdf') ||
        (record.kind === 'image' && canonicalKind !== 'image') ||
        (record.kind === 'pdf' && canonicalKind !== 'pdf')
      ) {
        return 'Attachment kind does not match its canonical Artifact';
      }
    }
    return undefined;
  }

  async #ingest(
    input: ArtifactIngestInput,
    context: { hostEpoch: string; connectionId: string },
  ): Promise<OperationOutcome<'artifact.ingest'>> {
    try {
      if ((await this.#sessions.probeSessionRemoval(input.sessionId)).kind !== 'present') {
        return ingestFailure('not_found', 'Session was not found');
      }
      switch (input.kind) {
        case 'begin':
          return await this.#beginIngest(input, context);
        case 'chunk':
          return this.#acceptIngestChunk(input, context);
        case 'abort':
          return this.#abortIngest(input, context);
        case 'commit':
          return await this.#commitIngest(input, context);
      }
    } catch {
      this.#requestDrain();
      return ingestFailure('persistence_failed', 'Attachment publication failed');
    }
  }

  async #beginIngest(
    input: Extract<ArtifactIngestInput, { kind: 'begin' }>,
    context: { hostEpoch: string; connectionId: string },
  ): Promise<OperationOutcome<'artifact.ingest'>> {
    const name = sanitizeArtifactName(input.name);
    const attachmentKind = attachmentKindFromMimeType(input.mimeType, name);
    const committed = await this.#readCommittedUpload(input.sessionId, input.uploadId);
    if (committed.kind === 'conflict') {
      return ingestFailure('operation_conflict', 'Upload identity belongs to another Artifact');
    }
    if (committed.kind === 'committed') {
      if (
        !uploadMatchesRecord(input, committed.record) ||
        committed.record.summary !== input.contentSha256
      ) {
        return ingestFailure('operation_conflict', 'Upload identity was already committed');
      }
      return ingestSuccess(committedUploadResult(input.uploadId, committed.record));
    }

    const opened = this.#uploads.open(
      uploadKey(input.sessionId, input.uploadId),
      context,
      input.totalBytes,
      {
        attachmentKind,
        name,
        mimeType: input.mimeType,
        contentSha256: input.contentSha256,
      },
    );
    if (opened.kind === 'identity_conflict') {
      return ingestFailure('operation_conflict', 'Upload identity is already in use');
    }
    if (opened.kind === 'owned_existing') {
      const existing = opened.upload;
      if (
        existing.metadata.attachmentKind !== attachmentKind ||
        existing.metadata.name !== name ||
        existing.metadata.mimeType !== input.mimeType ||
        existing.totalBytes !== input.totalBytes ||
        existing.metadata.contentSha256 !== input.contentSha256
      ) {
        return ingestFailure('operation_conflict', 'Upload identity is already in use');
      }
      const refreshed = this.#uploads.refreshOwned(
        uploadKey(input.sessionId, input.uploadId),
        context,
      );
      if (!refreshed) throw new Error('Owned Artifact upload disappeared during exact replay');
      return ingestSuccess({
        kind: 'upload_opened',
        uploadId: input.uploadId,
        nextOffset: refreshed.nextOffset,
      });
    }
    if (opened.kind === 'capacity_exhausted') {
      return ingestFailure('operation_conflict', 'Attachment upload capacity is exhausted');
    }
    return ingestSuccess({ kind: 'upload_opened', uploadId: input.uploadId, nextOffset: 0 });
  }

  #acceptIngestChunk(
    input: Extract<ArtifactIngestInput, { kind: 'chunk' }>,
    context: { hostEpoch: string; connectionId: string },
  ): OperationOutcome<'artifact.ingest'> {
    const chunk = Buffer.from(input.chunkBase64, 'base64');
    const accepted = this.#uploads.accept(
      uploadKey(input.sessionId, input.uploadId),
      context,
      input.offset,
      chunk,
    );
    if (accepted.kind === 'not_found') {
      return ingestFailure('not_found', 'Attachment upload was not found');
    }
    if (accepted.kind === 'conflict') {
      return ingestFailure('operation_conflict', 'Attachment chunk offset or replay is invalid');
    }
    return ingestSuccess({
      kind: 'chunk_accepted',
      uploadId: input.uploadId,
      nextOffset: accepted.nextOffset,
    });
  }

  #abortIngest(
    input: Extract<ArtifactIngestInput, { kind: 'abort' }>,
    context: { hostEpoch: string; connectionId: string },
  ): OperationOutcome<'artifact.ingest'> {
    this.#uploads.abort(uploadKey(input.sessionId, input.uploadId), context);
    return ingestSuccess({ kind: 'upload_aborted', uploadId: input.uploadId });
  }

  async #commitIngest(
    input: Extract<ArtifactIngestInput, { kind: 'commit' }>,
    context: { hostEpoch: string; connectionId: string },
  ): Promise<OperationOutcome<'artifact.ingest'>> {
    const committed = await this.#readCommittedUpload(input.sessionId, input.uploadId);
    if (committed.kind === 'conflict') {
      return ingestFailure('operation_conflict', 'Upload identity belongs to another Artifact');
    }
    if (committed.kind === 'committed') {
      return ingestSuccess(committedUploadResult(input.uploadId, committed.record));
    }
    const consumed = this.#uploads.consumeComplete(
      uploadKey(input.sessionId, input.uploadId),
      context,
    );
    if (consumed.kind === 'not_found') {
      return ingestFailure('not_found', 'Attachment upload was not found');
    }
    if (consumed.kind === 'incomplete') {
      return ingestFailure('operation_conflict', 'Attachment upload is incomplete');
    }
    const upload = consumed.upload;
    if (contentDigest(upload.bytes) !== upload.metadata.contentSha256) {
      return ingestFailure('operation_conflict', 'Attachment content digest does not match');
    }
    const record = await this.#store.create({
      id: artifactIdForUpload(input.sessionId, input.uploadId),
      sessionId: input.sessionId,
      turnId: input.uploadId,
      name: upload.metadata.name,
      kind: artifactKindForAttachment(upload.metadata.attachmentKind),
      content: upload.bytes,
      mimeType: upload.metadata.mimeType,
      source: 'user_upload',
      summary: upload.metadata.contentSha256,
    });
    return ingestSuccess(committedUploadResult(input.uploadId, record));
  }

  async #readCommittedUpload(
    sessionId: string,
    uploadId: string,
  ): Promise<
    { kind: 'missing' } | { kind: 'conflict' } | { kind: 'committed'; record: ArtifactRecord }
  > {
    const entry = await this.#store.getInSession(
      sessionId,
      artifactIdForUpload(sessionId, uploadId),
    );
    const record = entry.record;
    if (!record) return { kind: 'missing' };
    if (record.status !== 'live' || record.source !== 'user_upload' || record.turnId !== uploadId) {
      return { kind: 'conflict' };
    }
    return { kind: 'committed', record };
  }

  async #query(input: ArtifactQueryInput): Promise<OperationOutcome<'artifact.query'>> {
    try {
      if ((await this.#sessions.probeSessionRemoval(input.sessionId)).kind !== 'present') {
        return notFound('artifact.query', 'Session was not found');
      }
      if (input.kind === 'read_text' || input.kind === 'read_binary') {
        if (input.kind === 'read_text') {
          const preview = await this.#store.readTextInSession(input.sessionId, input.artifactId, {
            maxBytes: ARTIFACT_PREVIEW_MAX_BYTES,
          });
          return querySuccess(
            encodeTextResult({
              kind: 'text',
              sessionId: input.sessionId,
              artifactId: input.artifactId,
              preview,
            }),
          );
        }
        const preview = await this.#store.readBinaryInSession(input.sessionId, input.artifactId, {
          maxBytes: ARTIFACT_PREVIEW_MAX_BYTES,
        });
        return querySuccess(
          encodeArtifactQueryResult({
            kind: 'binary',
            sessionId: input.sessionId,
            artifactId: input.artifactId,
            preview,
          }),
        );
      }

      if (input.kind === 'read_chunk') {
        const chunk = await this.#store.readChunkInSession(input.sessionId, input.artifactId, {
          offset: input.offset,
          maxBytes: ARTIFACT_READ_CHUNK_MAX_BYTES,
        });
        if (!chunk.ok) {
          if (chunk.reason === 'not_found' || chunk.reason === 'deleted') {
            return notFound('artifact.query', 'Artifact was not found');
          }
          if (chunk.reason === 'out_of_range') {
            return invalidQuery('Artifact chunk offset is invalid');
          }
          return persistenceFailure('artifact.query', 'Artifact content is unavailable');
        }
        return querySuccess(
          encodeArtifactQueryResult({
            kind: 'chunk',
            sessionId: input.sessionId,
            artifactId: input.artifactId,
            offset: chunk.offset,
            totalBytes: chunk.totalBytes,
            chunkBase64: Buffer.from(chunk.bytes).toString('base64'),
            nextOffset: chunk.nextOffset,
          }),
        );
      }

      if (input.kind === 'get') {
        const entry = await this.#store.getInSession(input.sessionId, input.artifactId);
        return querySuccess(
          encodeArtifactQueryResult({
            kind: 'artifact',
            sessionId: input.sessionId,
            revision: entry.revision,
            artifact: entry.record ? encodeArtifactProjection(entry.record) : null,
          }),
        );
      }

      const decodedOffset = input.kind === 'list_start' ? 0 : decodeCursor(input.cursor);
      const offset = decodedOffset ?? 0;
      const page = await this.#store.listPage(input.sessionId, {
        offset,
        limit: ARTIFACT_PAGE_MAX_ITEMS,
      });
      if (input.kind === 'list_continue' && input.revision !== page.revision) {
        return querySuccess(
          encodeArtifactQueryResult({
            kind: 'revision_changed',
            expected: input.revision,
            actual: page.revision,
          }),
        );
      }
      if (
        decodedOffset === undefined ||
        (input.kind === 'list_continue' && (offset === 0 || offset >= page.total))
      ) {
        return invalidQuery('Artifact cursor is invalid');
      }
      return querySuccess(
        createPage(input.sessionId, page.revision, page.records, page.total, offset),
      );
    } catch {
      return persistenceFailure('artifact.query', 'Artifact projection is unavailable');
    }
  }

  async #delete(input: {
    readonly sessionId: string;
    readonly artifactId: string;
  }): Promise<OperationOutcome<'artifact.delete'>> {
    try {
      if ((await this.#sessions.probeSessionRemoval(input.sessionId)).kind !== 'present') {
        return notFound('artifact.delete', 'Session was not found');
      }
      const deleted = await this.#store.deleteUserArtifactInSession(
        input.sessionId,
        input.artifactId,
      );
      if (deleted.kind === 'not_found') {
        return {
          ok: false,
          error: { code: 'not_found', message: 'Artifact was not found' },
        };
      }
      if (deleted.kind === 'protected') {
        return {
          ok: false,
          error: {
            code: 'operation_conflict',
            message: 'Protected runtime evidence cannot be deleted through Runtime Host',
          },
        };
      }
      return {
        ok: true,
        result: encodeArtifactDeleteResult({
          kind: 'deleted',
          artifact: encodeArtifactProjection(deleted.record),
        }),
      };
    } catch {
      this.#requestDrain();
      return persistenceFailure('artifact.delete', 'Artifact deletion could not be committed');
    }
  }
}

function createPage(
  sessionId: string,
  revision: ArtifactRevision,
  records: readonly ArtifactRecord[],
  total: number,
  offset: number,
): ArtifactQueryResult {
  const pageArtifacts: ArtifactProjection[] = [];
  for (const record of records) {
    const artifact = encodeArtifactProjection(record);
    const candidateArtifacts = [...pageArtifacts, artifact];
    const nextOffset = offset + candidateArtifacts.length;
    const candidate: ArtifactQueryResult = {
      kind: 'page',
      sessionId,
      revision,
      artifacts: candidateArtifacts,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > ARTIFACT_RESULT_MAX_BYTES) {
      if (pageArtifacts.length === 0) {
        throw new Error('A canonical Artifact cannot fit in one page');
      }
      break;
    }
    pageArtifacts.push(artifact);
  }
  const nextOffset = offset + pageArtifacts.length;
  return encodeArtifactQueryResult({
    kind: 'page',
    sessionId,
    revision,
    artifacts: pageArtifacts,
    nextCursor: nextOffset < total ? String(nextOffset) : null,
  });
}

function decodeCursor(cursor: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(cursor)) return undefined;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) ? offset : undefined;
}

function encodeTextResult(
  result: Extract<ArtifactQueryResult, { kind: 'text' }>,
): ArtifactQueryResult {
  if (
    result.preview.ok &&
    Buffer.byteLength(result.preview.text, 'utf8') > ARTIFACT_PREVIEW_MAX_BYTES
  ) {
    return encodeArtifactQueryResult({
      ...result,
      preview: { ok: false, reason: 'too_large' },
    });
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= ARTIFACT_RESULT_MAX_BYTES) {
    return encodeArtifactQueryResult(result);
  }
  return encodeArtifactQueryResult({
    ...result,
    preview: { ok: false, reason: 'too_large' },
  });
}

function querySuccess(result: ArtifactQueryResult): OperationOutcome<'artifact.query'> {
  return { ok: true, result };
}

function invalidQuery(message: string): OperationOutcome<'artifact.query'> {
  return { ok: false, error: { code: 'invalid_request', message } };
}

function persistenceFailure<K extends 'artifact.query' | 'artifact.delete'>(
  _operation: K,
  message: string,
): OperationOutcome<K> {
  return { ok: false, error: { code: 'persistence_failed', message } } as OperationOutcome<K>;
}

function notFound<K extends 'artifact.query' | 'artifact.delete'>(
  _operation: K,
  message: string,
): OperationOutcome<K> {
  return { ok: false, error: { code: 'not_found', message } } as OperationOutcome<K>;
}

function uploadKey(sessionId: string, uploadId: string): string {
  return `${sessionId}\0${uploadId}`;
}

function artifactIdForUpload(sessionId: string, uploadId: string): string {
  return `attachment-${createHash('sha256')
    .update(`${sessionId}\0${uploadId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function contentDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function artifactKindForAttachment(kind: AttachmentRef['kind']): ArtifactRecord['kind'] {
  if (kind === 'image') return 'image';
  if (kind === 'pdf') return 'pdf';
  return 'file';
}

function committedUploadResult(uploadId: string, record: ArtifactRecord): ArtifactIngestResult {
  if (!record.mimeType) throw new Error('Committed Attachment Artifact has no media type');
  return {
    kind: 'committed',
    uploadId,
    attachment: {
      kind: attachmentKindFromMimeType(record.mimeType, record.name),
      name: record.name,
      mimeType: record.mimeType,
      bytes: record.sizeBytes,
      ref: { kind: 'session_file', sessionId: record.sessionId, relativePath: record.id },
    },
  };
}

function uploadMatchesRecord(
  upload: Extract<ArtifactIngestInput, { kind: 'begin' }>,
  record: ArtifactRecord,
): boolean {
  const name = sanitizeArtifactName(upload.name);
  const attachmentKind = attachmentKindFromMimeType(upload.mimeType, name);
  return (
    record.name === name &&
    record.mimeType === upload.mimeType &&
    record.sizeBytes === upload.totalBytes &&
    record.kind === artifactKindForAttachment(attachmentKind)
  );
}

function ingestSuccess(result: ArtifactIngestResult): OperationOutcome<'artifact.ingest'> {
  return { ok: true, result };
}

function ingestFailure(
  code: 'invalid_request' | 'not_found' | 'operation_conflict' | 'persistence_failed',
  message: string,
): OperationOutcome<'artifact.ingest'> {
  return { ok: false, error: { code, message } };
}
