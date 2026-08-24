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
  ARTIFACT_KINDS,
  ARTIFACT_SOURCES,
  ARTIFACT_STATUSES,
  type ArtifactRecord,
  type ArtifactBinaryReadFailureReason,
  type ArtifactKind,
  type ArtifactReadFailureReason,
  type ArtifactSource,
  type ArtifactStatus,
  isArtifactTurnKey,
  isCanonicalArtifactEntityId,
} from '@maka/core/artifacts';
import { MAX_ATTACHMENT_BYTES } from '@maka/core/attachments';
import { isCanonicalAttachmentRef, type AttachmentRef } from '@maka/core/events';
import { requireCount, requireEntityId, requireExactRecord, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const ARTIFACT_PAGE_MAX_ITEMS = 128;
export const ARTIFACT_RESULT_MAX_BYTES = 48 * 1024;
export const ARTIFACT_PREVIEW_MAX_BYTES = 32 * 1024;
export const ARTIFACT_READ_CHUNK_MAX_BYTES = 32 * 1024;
export const ARTIFACT_CURSOR_MAX_BYTES = 32;
export const ARTIFACT_NAME_MAX_BYTES = 512;
export const ARTIFACT_MIME_TYPE_MAX_BYTES = 512;
export const ARTIFACT_SUMMARY_MAX_BYTES = 8 * 1024;
export const ARTIFACT_INGEST_CHUNK_MAX_BYTES = 48 * 1024;
export const ARTIFACT_INGEST_MIME_TYPE_MAX_BYTES = 256;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'internal_failure',
  'invalid_request',
  'not_found',
  'persistence_failed',
] as const;
const DELETE_ERRORS = [...QUERY_ERRORS, 'operation_conflict'] as const;
const ARTIFACT_REQUIRED_FIELDS = [
  'id',
  'sessionId',
  'turnId',
  'createdAt',
  'name',
  'kind',
  'sizeBytes',
  'status',
] as const;
const ARTIFACT_FIELDS = new Set([...ARTIFACT_REQUIRED_FIELDS, 'mimeType', 'source', 'summary']);

export type ArtifactRevision = `sha256:${string}`;

export interface ArtifactProjection {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly createdAt: number;
  readonly name: string;
  readonly kind: ArtifactKind;
  readonly sizeBytes: number;
  readonly mimeType?: string;
  readonly source?: ArtifactSource;
  readonly summary?: string;
  readonly status: ArtifactStatus;
}

export type ArtifactQueryInput =
  | { readonly kind: 'list_start'; readonly sessionId: string }
  | {
      readonly kind: 'list_continue';
      readonly sessionId: string;
      readonly revision: ArtifactRevision;
      readonly cursor: string;
    }
  | { readonly kind: 'get'; readonly sessionId: string; readonly artifactId: string }
  | { readonly kind: 'read_text'; readonly sessionId: string; readonly artifactId: string }
  | { readonly kind: 'read_binary'; readonly sessionId: string; readonly artifactId: string }
  | {
      readonly kind: 'read_chunk';
      readonly sessionId: string;
      readonly artifactId: string;
      readonly offset: number;
    };

export type ArtifactTextPreview =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: ArtifactReadFailureReason };
export type ArtifactBinaryPreview =
  | { readonly ok: true; readonly base64: string; readonly mimeType: string }
  | { readonly ok: false; readonly reason: ArtifactBinaryReadFailureReason };

export type ArtifactQueryResult =
  | {
      readonly kind: 'page';
      readonly sessionId: string;
      readonly revision: ArtifactRevision;
      readonly artifacts: readonly ArtifactProjection[];
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expected: ArtifactRevision;
      readonly actual: ArtifactRevision;
    }
  | {
      readonly kind: 'artifact';
      readonly sessionId: string;
      readonly revision: ArtifactRevision;
      readonly artifact: ArtifactProjection | null;
    }
  | {
      readonly kind: 'text';
      readonly sessionId: string;
      readonly artifactId: string;
      readonly preview: ArtifactTextPreview;
    }
  | {
      readonly kind: 'binary';
      readonly sessionId: string;
      readonly artifactId: string;
      readonly preview: ArtifactBinaryPreview;
    }
  | {
      readonly kind: 'chunk';
      readonly sessionId: string;
      readonly artifactId: string;
      readonly offset: number;
      readonly totalBytes: number;
      readonly chunkBase64: string;
      readonly nextOffset: number | null;
    };

export interface ArtifactDeleteInput {
  readonly sessionId: string;
  readonly artifactId: string;
}

export interface ArtifactDeleteResult {
  readonly kind: 'deleted';
  readonly artifact: ArtifactProjection;
}

export type ArtifactIngestInput =
  | {
      readonly kind: 'begin';
      readonly sessionId: string;
      readonly uploadId: string;
      readonly name: string;
      readonly mimeType: string;
      readonly totalBytes: number;
      readonly contentSha256: `sha256:${string}`;
    }
  | {
      readonly kind: 'chunk';
      readonly sessionId: string;
      readonly uploadId: string;
      readonly offset: number;
      readonly chunkBase64: string;
    }
  | { readonly kind: 'commit'; readonly sessionId: string; readonly uploadId: string }
  | { readonly kind: 'abort'; readonly sessionId: string; readonly uploadId: string };

export type ArtifactIngestResult =
  | { readonly kind: 'upload_opened'; readonly uploadId: string; readonly nextOffset: number }
  | { readonly kind: 'chunk_accepted'; readonly uploadId: string; readonly nextOffset: number }
  | { readonly kind: 'committed'; readonly uploadId: string; readonly attachment: AttachmentRef }
  | { readonly kind: 'upload_aborted'; readonly uploadId: string };

export const ARTIFACT_OPERATION_SPECS = {
  'artifact.ingest': defineOperation<
    ArtifactIngestInput,
    ArtifactIngestResult,
    | 'host_not_ready'
    | 'host_draining'
    | 'operation_unavailable'
    | 'invalid_request'
    | 'not_found'
    | 'operation_conflict'
    | 'persistence_failed'
    | 'internal_failure'
  >({
    mode: 'command',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'invalid_request',
      'not_found',
      'operation_conflict',
      'persistence_failed',
      'internal_failure',
    ],
    decodeInput: decodeArtifactIngestInput,
    decodeOutput: decodeArtifactIngestResult,
    assertOutputForInput: (input, output) => {
      if (input.uploadId !== output.uploadId) {
        throw invalidProtocolFrame('Artifact ingest changed upload identity');
      }
      if (
        output.kind === 'committed' &&
        (output.attachment.ref.kind !== 'session_file' ||
          output.attachment.ref.sessionId !== input.sessionId)
      ) {
        throw invalidProtocolFrame('Artifact ingest changed Session identity');
      }
    },
  }),
  'artifact.query': defineOperation<
    ArtifactQueryInput,
    ArtifactQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeArtifactQueryInput,
    decodeOutput: decodeArtifactQueryResult,
  }),
  'artifact.delete': defineOperation<
    ArtifactDeleteInput,
    ArtifactDeleteResult,
    (typeof DELETE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: DELETE_ERRORS,
    decodeInput: decodeArtifactDeleteInput,
    decodeOutput: decodeArtifactDeleteResult,
  }),
} as const;

export function decodeArtifactIngestInput(value: unknown): ArtifactIngestInput {
  const input = requireRecord(value, 'artifact ingest input');
  if (input.kind === 'begin') {
    const exact = requireExactRecord(input, 'artifact ingest begin input', [
      'kind',
      'sessionId',
      'uploadId',
      'name',
      'mimeType',
      'totalBytes',
      'contentSha256',
    ]);
    return {
      kind: 'begin',
      sessionId: requireEntityId(exact.sessionId, 'sessionId'),
      uploadId: requireEntityId(exact.uploadId, 'uploadId'),
      name: boundedIngestText(exact.name, 'artifact ingest name', ARTIFACT_NAME_MAX_BYTES),
      mimeType: boundedIngestText(
        exact.mimeType,
        'artifact ingest mime type',
        ARTIFACT_INGEST_MIME_TYPE_MAX_BYTES,
      ),
      totalBytes: boundedAttachmentBytes(exact.totalBytes),
      contentSha256: contentDigest(exact.contentSha256),
    };
  }
  if (input.kind === 'chunk') {
    const exact = requireExactRecord(input, 'artifact ingest chunk input', [
      'kind',
      'sessionId',
      'uploadId',
      'offset',
      'chunkBase64',
    ]);
    const chunkBase64 = boundedText(
      exact.chunkBase64,
      'artifact ingest chunk',
      Math.ceil((ARTIFACT_INGEST_CHUNK_MAX_BYTES * 4) / 3) + 4,
      true,
    );
    if (!isCanonicalBase64(chunkBase64)) {
      throw invalidProtocolFrame('Invalid artifact ingest chunk');
    }
    const chunk = Buffer.from(chunkBase64, 'base64');
    if (chunk.byteLength === 0 || chunk.byteLength > ARTIFACT_INGEST_CHUNK_MAX_BYTES) {
      throw invalidProtocolFrame('Invalid artifact ingest chunk');
    }
    return {
      kind: 'chunk',
      sessionId: requireEntityId(exact.sessionId, 'sessionId'),
      uploadId: requireEntityId(exact.uploadId, 'uploadId'),
      offset: requireCount(exact.offset, 'artifact ingest offset'),
      chunkBase64,
    };
  }
  if (input.kind === 'commit' || input.kind === 'abort') {
    const exact = requireExactRecord(input, 'artifact ingest terminal input', [
      'kind',
      'sessionId',
      'uploadId',
    ]);
    return {
      kind: input.kind,
      sessionId: requireEntityId(exact.sessionId, 'sessionId'),
      uploadId: requireEntityId(exact.uploadId, 'uploadId'),
    };
  }
  throw invalidProtocolFrame('Invalid artifact ingest kind');
}

export function decodeArtifactIngestResult(value: unknown): ArtifactIngestResult {
  const result = requireRecord(value, 'artifact ingest result');
  if (result.kind === 'upload_opened' || result.kind === 'chunk_accepted') {
    const exact = requireExactRecord(result, 'artifact ingest progress result', [
      'kind',
      'uploadId',
      'nextOffset',
    ]);
    return {
      kind: result.kind,
      uploadId: requireEntityId(exact.uploadId, 'uploadId'),
      nextOffset: requireCount(exact.nextOffset, 'artifact ingest next offset'),
    };
  }
  if (result.kind === 'upload_aborted') {
    const exact = requireExactRecord(result, 'artifact ingest abort result', ['kind', 'uploadId']);
    return { kind: 'upload_aborted', uploadId: requireEntityId(exact.uploadId, 'uploadId') };
  }
  if (result.kind === 'committed') {
    const exact = requireExactRecord(result, 'artifact ingest committed result', [
      'kind',
      'uploadId',
      'attachment',
    ]);
    if (!isCanonicalAttachmentRef(exact.attachment)) {
      throw invalidProtocolFrame('Invalid artifact ingest AttachmentRef');
    }
    if (exact.attachment.ref.kind !== 'session_file') {
      throw invalidProtocolFrame('Invalid artifact ingest AttachmentRef');
    }
    return {
      kind: 'committed',
      uploadId: requireEntityId(exact.uploadId, 'uploadId'),
      attachment: {
        ...exact.attachment,
        ref: { ...exact.attachment.ref },
      },
    };
  }
  throw invalidProtocolFrame('Invalid artifact ingest result kind');
}

export function decodeArtifactQueryInput(value: unknown): ArtifactQueryInput {
  const input = requireRecord(value, 'artifact query input');
  if (input.kind === 'list_start') {
    const exact = requireExactRecord(input, 'artifact list start input', ['kind', 'sessionId']);
    return { kind: 'list_start', sessionId: artifactEntityId(exact.sessionId, 'sessionId') };
  }
  if (input.kind === 'list_continue') {
    const exact = requireExactRecord(input, 'artifact list continuation input', [
      'kind',
      'sessionId',
      'revision',
      'cursor',
    ]);
    return {
      kind: 'list_continue',
      sessionId: artifactEntityId(exact.sessionId, 'sessionId'),
      revision: artifactRevision(exact.revision, 'artifact revision'),
      cursor: boundedText(exact.cursor, 'artifact cursor', ARTIFACT_CURSOR_MAX_BYTES),
    };
  }
  if (input.kind === 'get' || input.kind === 'read_text' || input.kind === 'read_binary') {
    const exact = requireExactRecord(input, 'artifact item query input', [
      'kind',
      'sessionId',
      'artifactId',
    ]);
    return {
      kind: input.kind,
      sessionId: artifactEntityId(exact.sessionId, 'sessionId'),
      artifactId: artifactEntityId(exact.artifactId, 'artifactId'),
    };
  }
  if (input.kind === 'read_chunk') {
    const exact = requireExactRecord(input, 'artifact chunk query input', [
      'kind',
      'sessionId',
      'artifactId',
      'offset',
    ]);
    return {
      kind: 'read_chunk',
      sessionId: artifactEntityId(exact.sessionId, 'sessionId'),
      artifactId: artifactEntityId(exact.artifactId, 'artifactId'),
      offset: requireCount(exact.offset, 'artifact chunk offset'),
    };
  }
  throw invalidProtocolFrame('Invalid artifact query kind');
}

export function decodeArtifactDeleteInput(value: unknown): ArtifactDeleteInput {
  const input = requireExactRecord(value, 'artifact delete input', ['sessionId', 'artifactId']);
  return {
    sessionId: artifactEntityId(input.sessionId, 'sessionId'),
    artifactId: artifactEntityId(input.artifactId, 'artifactId'),
  };
}

export function decodeArtifactQueryResult(value: unknown): ArtifactQueryResult {
  const result = requireRecord(value, 'artifact query result');
  let decoded: ArtifactQueryResult;
  if (result.kind === 'revision_changed') {
    const exact = requireExactRecord(result, 'artifact revision changed result', [
      'kind',
      'expected',
      'actual',
    ]);
    decoded = {
      kind: 'revision_changed',
      expected: artifactRevision(exact.expected, 'expected artifact revision'),
      actual: artifactRevision(exact.actual, 'actual artifact revision'),
    };
  } else if (result.kind === 'artifact') {
    const exact = requireExactRecord(result, 'artifact item result', [
      'kind',
      'sessionId',
      'revision',
      'artifact',
    ]);
    decoded = {
      kind: 'artifact',
      sessionId: artifactEntityId(exact.sessionId, 'sessionId'),
      revision: artifactRevision(exact.revision, 'artifact revision'),
      artifact: exact.artifact === null ? null : decodeArtifactProjection(exact.artifact),
    };
  } else if (result.kind === 'page') {
    const exact = requireExactRecord(result, 'artifact page result', [
      'kind',
      'sessionId',
      'revision',
      'artifacts',
      'nextCursor',
    ]);
    if (!Array.isArray(exact.artifacts) || exact.artifacts.length > ARTIFACT_PAGE_MAX_ITEMS) {
      throw invalidProtocolFrame('Artifact page exceeds item limit');
    }
    decoded = {
      kind: 'page',
      sessionId: artifactEntityId(exact.sessionId, 'sessionId'),
      revision: artifactRevision(exact.revision, 'artifact revision'),
      artifacts: exact.artifacts.map(decodeArtifactProjection),
      nextCursor:
        exact.nextCursor === null
          ? null
          : boundedText(exact.nextCursor, 'artifact next cursor', ARTIFACT_CURSOR_MAX_BYTES),
    };
  } else if (result.kind === 'text') {
    const exact = requireExactRecord(result, 'artifact text result', [
      'kind',
      'sessionId',
      'artifactId',
      'preview',
    ]);
    decoded = {
      kind: 'text',
      sessionId: artifactEntityId(exact.sessionId, 'sessionId'),
      artifactId: artifactEntityId(exact.artifactId, 'artifactId'),
      preview: decodeTextPreview(exact.preview),
    };
  } else if (result.kind === 'binary') {
    const exact = requireExactRecord(result, 'artifact binary result', [
      'kind',
      'sessionId',
      'artifactId',
      'preview',
    ]);
    decoded = {
      kind: 'binary',
      sessionId: artifactEntityId(exact.sessionId, 'sessionId'),
      artifactId: artifactEntityId(exact.artifactId, 'artifactId'),
      preview: decodeBinaryPreview(exact.preview),
    };
  } else if (result.kind === 'chunk') {
    const exact = requireExactRecord(result, 'artifact chunk result', [
      'kind',
      'sessionId',
      'artifactId',
      'offset',
      'totalBytes',
      'chunkBase64',
      'nextOffset',
    ]);
    const offset = requireCount(exact.offset, 'artifact chunk offset');
    const totalBytes = requireCount(exact.totalBytes, 'artifact chunk total bytes');
    const chunkBase64 = boundedText(
      exact.chunkBase64,
      'artifact chunk',
      Math.ceil((ARTIFACT_READ_CHUNK_MAX_BYTES * 4) / 3) + 4,
      true,
    );
    if (!isCanonicalBase64(chunkBase64)) {
      throw invalidProtocolFrame('Invalid artifact chunk');
    }
    const chunkBytes = Buffer.from(chunkBase64, 'base64').byteLength;
    if (chunkBytes > ARTIFACT_READ_CHUNK_MAX_BYTES || offset + chunkBytes > totalBytes) {
      throw invalidProtocolFrame('Invalid artifact chunk bounds');
    }
    const nextOffset =
      exact.nextOffset === null
        ? null
        : requireCount(exact.nextOffset, 'artifact chunk next offset');
    if (
      (nextOffset === null && offset + chunkBytes !== totalBytes) ||
      (nextOffset !== null &&
        (chunkBytes === 0 || nextOffset !== offset + chunkBytes || nextOffset >= totalBytes))
    ) {
      throw invalidProtocolFrame('Invalid artifact chunk continuation');
    }
    decoded = {
      kind: 'chunk',
      sessionId: artifactEntityId(exact.sessionId, 'sessionId'),
      artifactId: artifactEntityId(exact.artifactId, 'artifactId'),
      offset,
      totalBytes,
      chunkBase64,
      nextOffset,
    };
  } else {
    throw invalidProtocolFrame('Invalid artifact query result kind');
  }
  assertResultSize(decoded);
  return decoded;
}

export const encodeArtifactQueryResult = decodeArtifactQueryResult;

export function decodeArtifactDeleteResult(value: unknown): ArtifactDeleteResult {
  const result = requireExactRecord(value, 'artifact delete result', ['kind', 'artifact']);
  if (result.kind !== 'deleted') throw invalidProtocolFrame('Invalid artifact delete result kind');
  const decoded = { kind: 'deleted' as const, artifact: decodeArtifactProjection(result.artifact) };
  assertResultSize(decoded);
  return decoded;
}

export const encodeArtifactDeleteResult = decodeArtifactDeleteResult;

export function encodeArtifactProjection(record: ArtifactRecord): ArtifactProjection {
  return {
    id: record.id,
    sessionId: record.sessionId,
    turnId: record.turnId,
    createdAt: record.createdAt,
    name: projectArtifactText(record.name, ARTIFACT_NAME_MAX_BYTES),
    kind: record.kind,
    sizeBytes: record.sizeBytes,
    ...(record.mimeType === undefined
      ? {}
      : { mimeType: projectArtifactText(record.mimeType, ARTIFACT_MIME_TYPE_MAX_BYTES) }),
    ...(record.source === undefined ? {} : { source: record.source }),
    ...(record.summary === undefined
      ? {}
      : { summary: projectArtifactText(record.summary, ARTIFACT_SUMMARY_MAX_BYTES) }),
    status: record.status,
  };
}

function decodeArtifactProjection(value: unknown): ArtifactProjection {
  const record = requireRecord(value, 'artifact projection');
  if (Object.keys(record).some((key) => !ARTIFACT_FIELDS.has(key))) {
    throw invalidProtocolFrame('Unknown artifact projection field');
  }
  if (ARTIFACT_REQUIRED_FIELDS.some((field) => !Object.hasOwn(record, field))) {
    throw invalidProtocolFrame('Invalid artifact projection fields');
  }
  return {
    id: artifactEntityId(record.id, 'artifact id'),
    sessionId: artifactEntityId(record.sessionId, 'artifact sessionId'),
    turnId: artifactTurnKey(record.turnId),
    createdAt: requireCount(record.createdAt, 'artifact createdAt'),
    name: boundedText(record.name, 'artifact name', ARTIFACT_NAME_MAX_BYTES),
    kind: artifactKind(record.kind),
    sizeBytes: requireCount(record.sizeBytes, 'artifact sizeBytes'),
    status: artifactStatus(record.status),
    ...(Object.hasOwn(record, 'mimeType')
      ? {
          mimeType: boundedText(record.mimeType, 'artifact mimeType', ARTIFACT_MIME_TYPE_MAX_BYTES),
        }
      : {}),
    ...(Object.hasOwn(record, 'source') ? { source: artifactSource(record.source) } : {}),
    ...(Object.hasOwn(record, 'summary')
      ? { summary: boundedText(record.summary, 'artifact summary', ARTIFACT_SUMMARY_MAX_BYTES) }
      : {}),
  };
}

function projectArtifactText(value: string, maxBytes: number): string {
  let bytes = 0;
  let projected = '';
  for (const codePoint of value) {
    const scalar = codePoint.codePointAt(0)!;
    const canonical = scalar <= 0x1f || scalar === 0x7f ? '\ufffd' : codePoint;
    const width = Buffer.byteLength(canonical, 'utf8');
    if (bytes + width > maxBytes) break;
    projected += canonical;
    bytes += width;
  }
  return projected || 'artifact';
}

function decodeTextPreview(value: unknown): ArtifactTextPreview {
  const preview = requireRecord(value, 'artifact text preview');
  if (preview.ok === true) {
    const exact = requireExactRecord(preview, 'artifact text preview', ['ok', 'text']);
    return {
      ok: true,
      text: boundedText(exact.text, 'artifact text', ARTIFACT_PREVIEW_MAX_BYTES, true),
    };
  }
  const exact = requireExactRecord(preview, 'artifact text unavailable', ['ok', 'reason']);
  if (exact.ok !== false) throw invalidProtocolFrame('Invalid artifact text preview outcome');
  return { ok: false, reason: readFailureReason(exact.reason) };
}

function decodeBinaryPreview(value: unknown): ArtifactBinaryPreview {
  const preview = requireRecord(value, 'artifact binary preview');
  if (preview.ok === true) {
    const exact = requireExactRecord(preview, 'artifact binary preview', [
      'ok',
      'base64',
      'mimeType',
    ]);
    const base64 = boundedText(exact.base64, 'artifact binary base64', base64MaxBytes(), true);
    if (
      !isCanonicalBase64(base64) ||
      Buffer.from(base64, 'base64').byteLength > ARTIFACT_PREVIEW_MAX_BYTES
    ) {
      throw invalidProtocolFrame('Invalid artifact binary base64');
    }
    return {
      ok: true,
      base64,
      mimeType: boundedText(
        exact.mimeType,
        'artifact binary mimeType',
        ARTIFACT_MIME_TYPE_MAX_BYTES,
      ),
    };
  }
  const exact = requireExactRecord(preview, 'artifact binary unavailable', ['ok', 'reason']);
  if (exact.ok !== false) throw invalidProtocolFrame('Invalid artifact binary preview outcome');
  return { ok: false, reason: binaryReadFailureReason(exact.reason) };
}

function boundedText(value: unknown, label: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function boundedIngestText(value: unknown, label: string, maxBytes: number): string {
  const text = boundedText(value, label, maxBytes);
  // eslint-disable-next-line no-control-regex
  if (/[ -]/.test(text)) throw invalidProtocolFrame(`Invalid ${label}`);
  return text;
}

function artifactEntityId(value: unknown, label: string): string {
  if (!isCanonicalArtifactEntityId(value)) throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function artifactTurnKey(value: unknown): string {
  if (!isArtifactTurnKey(value)) throw invalidProtocolFrame('Invalid artifact turnId');
  return value;
}

function artifactRevision(value: unknown, label: string): ArtifactRevision {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as ArtifactRevision;
}

function boundedAttachmentBytes(value: unknown): number {
  const bytes = requireCount(value, 'artifact ingest total bytes');
  if (bytes > MAX_ATTACHMENT_BYTES) {
    throw invalidProtocolFrame('Artifact ingest exceeds attachment byte limit');
  }
  return bytes;
}

function contentDigest(value: unknown): `sha256:${string}` {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw invalidProtocolFrame('Invalid artifact ingest content digest');
  }
  return value as `sha256:${string}`;
}

function artifactKind(value: unknown): ArtifactKind {
  if (typeof value !== 'string' || !ARTIFACT_KINDS.includes(value as ArtifactKind)) {
    throw invalidProtocolFrame('Invalid artifact kind');
  }
  return value as ArtifactKind;
}

function artifactSource(value: unknown): ArtifactSource {
  if (typeof value !== 'string' || !ARTIFACT_SOURCES.includes(value as ArtifactSource)) {
    throw invalidProtocolFrame('Invalid artifact source');
  }
  return value as ArtifactSource;
}

function artifactStatus(value: unknown): ArtifactStatus {
  if (typeof value !== 'string' || !ARTIFACT_STATUSES.includes(value as ArtifactStatus)) {
    throw invalidProtocolFrame('Invalid artifact status');
  }
  return value as ArtifactStatus;
}

function readFailureReason(value: unknown): ArtifactReadFailureReason {
  if (
    value === 'not_found' ||
    value === 'too_large' ||
    value === 'read_failed' ||
    value === 'not_allowed' ||
    value === 'deleted'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid artifact read unavailable reason');
}

function binaryReadFailureReason(value: unknown): ArtifactBinaryReadFailureReason {
  return value === 'unsupported_mime' ? value : readFailureReason(value);
}

function base64MaxBytes(): number {
  return Math.ceil(ARTIFACT_PREVIEW_MAX_BYTES / 3) * 4;
}

function isCanonicalBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function assertResultSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > ARTIFACT_RESULT_MAX_BYTES) {
    throw invalidProtocolFrame('Artifact result exceeds byte limit');
  }
}
