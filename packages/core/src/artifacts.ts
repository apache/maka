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

export const ARTIFACT_KINDS = ['file', 'diff', 'html', 'image', 'pdf'] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Maximum encoded image payload admitted to a renderer preview. */
export const ARTIFACT_IMAGE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

const ARTIFACT_IMAGE_PREVIEW_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

const ARTIFACT_IMAGE_PREVIEW_MIMES = new Set(
  Object.values(ARTIFACT_IMAGE_PREVIEW_MIME_BY_EXTENSION),
);

export interface ArtifactImagePreviewInput {
  name: string;
  kind: ArtifactKind;
  mimeType?: string;
  sizeBytes?: number;
}

export type ArtifactImagePreviewResolution =
  | { kind: 'image'; reason: 'mime_match' | 'ext_fallback' }
  | {
      kind: 'unsupported';
      reason: 'kind_disallowed' | 'mime_disallowed' | 'no_mime_no_ext' | 'oversize';
    };

/** Normalize the raster MIME admitted to renderer image previews. */
export function normalizeArtifactImagePreviewMime(
  mimeType: string | undefined,
  name?: string,
): string | null {
  if (typeof mimeType === 'string' && mimeType.trim() !== '') {
    const normalized = mimeType.trim().toLowerCase();
    return ARTIFACT_IMAGE_PREVIEW_MIMES.has(normalized) ? normalized : null;
  }
  if (!name) return null;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return ARTIFACT_IMAGE_PREVIEW_MIME_BY_EXTENSION[name.slice(dot).toLowerCase()] ?? null;
}

/** One metadata policy shared by preview admission and renderer presentation. */
export function resolveArtifactImagePreview(
  input: ArtifactImagePreviewInput,
): ArtifactImagePreviewResolution {
  if (input.kind !== 'image') {
    return { kind: 'unsupported', reason: 'kind_disallowed' };
  }
  if (input.sizeBytes !== undefined && input.sizeBytes > ARTIFACT_IMAGE_PREVIEW_MAX_BYTES) {
    return { kind: 'unsupported', reason: 'oversize' };
  }
  if (input.mimeType) {
    return normalizeArtifactImagePreviewMime(input.mimeType)
      ? { kind: 'image', reason: 'mime_match' }
      : { kind: 'unsupported', reason: 'mime_disallowed' };
  }
  return normalizeArtifactImagePreviewMime(undefined, input.name)
    ? { kind: 'image', reason: 'ext_fallback' }
    : { kind: 'unsupported', reason: 'no_mime_no_ext' };
}

export const ARTIFACT_SOURCES = [
  'tool_result',
  'tool_result_projection',
  'tool_result_archive',
  'synthesis_cache_block',
  'history_compact_block',
  'history_compact_source',
  'provider_request_capture',
  'subagent_writeback',
  'deep_research',
  'user_upload',
  'export',
  'snapshot',
  'session_effect',
  'fixture',
] as const;

export type ArtifactSource = (typeof ARTIFACT_SOURCES)[number];

export const ARTIFACT_STATUSES = ['live', 'deleted'] as const;

export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const ARTIFACT_ENTITY_ID_MAX_CHARS = 128;
export const ARTIFACT_TURN_KEY_MAX_CHARS = 512;

const ARTIFACT_ENTITY_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${ARTIFACT_ENTITY_ID_MAX_CHARS}}$`);
const ARTIFACT_TURN_KEY_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function isCanonicalArtifactEntityId(value: unknown): value is string {
  return typeof value === 'string' && ARTIFACT_ENTITY_ID_PATTERN.test(value);
}

export function isArtifactTurnKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ARTIFACT_TURN_KEY_MAX_CHARS &&
    !ARTIFACT_TURN_KEY_CONTROL_CHARACTERS.test(value)
  );
}

export interface ArtifactDescriptor {
  id: string;
  sessionId: string;
  /** Opaque, bounded Runtime turn key. It is a reference, not a filesystem path component. */
  turnId: string;
  createdAt: number;
  name: string;
  kind: ArtifactKind;
  sizeBytes: number;
  mimeType?: string;
  source?: ArtifactSource;
  summary?: string;
  status: ArtifactStatus;
}

export interface ArtifactRecord extends ArtifactDescriptor {
  /**
   * Artifact-root-relative path. Never absolute and never exposed as a
   * filesystem path to renderer code.
   */
  relativePath: string;
  /** Durable role for artifacts owned by a Deep Research workspace. */
  deepResearchRole?: import('./deep-research-run.js').DeepResearchArtifactRole;
}

interface ArtifactSourcePolicy {
  readonly userDeletable: boolean;
  readonly userVisible: boolean;
  readonly sharedReadable: boolean;
}

const ARTIFACT_SOURCE_POLICIES = {
  tool_result: { userDeletable: true, userVisible: false, sharedReadable: true },
  tool_result_projection: { userDeletable: false, userVisible: false, sharedReadable: true },
  tool_result_archive: { userDeletable: false, userVisible: false, sharedReadable: false },
  synthesis_cache_block: { userDeletable: true, userVisible: false, sharedReadable: false },
  history_compact_block: { userDeletable: true, userVisible: false, sharedReadable: false },
  history_compact_source: { userDeletable: true, userVisible: false, sharedReadable: false },
  // Historical only: nothing produces these any more. The policy stays so the
  // records already on disk keep decoding and stay deletable.
  provider_request_capture: { userDeletable: true, userVisible: false, sharedReadable: false },
  subagent_writeback: { userDeletable: false, userVisible: true, sharedReadable: false },
  deep_research: { userDeletable: false, userVisible: true, sharedReadable: false },
  user_upload: { userDeletable: true, userVisible: false, sharedReadable: true },
  export: { userDeletable: true, userVisible: true, sharedReadable: false },
  snapshot: { userDeletable: true, userVisible: true, sharedReadable: false },
  session_effect: { userDeletable: false, userVisible: false, sharedReadable: false },
  fixture: { userDeletable: true, userVisible: true, sharedReadable: false },
} as const satisfies Record<ArtifactSource, ArtifactSourcePolicy>;

export function canUserDeleteArtifact(record: Pick<ArtifactRecord, 'source'>): boolean {
  return record.source === undefined || ARTIFACT_SOURCE_POLICIES[record.source].userDeletable;
}

export function isArtifactUserVisible(record: Pick<ArtifactRecord, 'source'>): boolean {
  return record.source === undefined || ARTIFACT_SOURCE_POLICIES[record.source].userVisible;
}

export function isArtifactSharedSessionReadable(record: Pick<ArtifactRecord, 'source'>): boolean {
  return record.source !== undefined && ARTIFACT_SOURCE_POLICIES[record.source].sharedReadable;
}

export type ArtifactChangedReason = 'created' | 'deleted' | 'purged';

export interface ArtifactChangedEvent {
  reason: ArtifactChangedReason;
  artifactId: string;
  sessionId: string;
  ts: number;
}

export type ArtifactReadFailureReason =
  | 'not_found'
  | 'too_large'
  | 'read_failed'
  | 'not_allowed'
  | 'deleted';

export type ArtifactBinaryReadFailureReason = ArtifactReadFailureReason | 'unsupported_mime';

export type ArtifactTextReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: ArtifactReadFailureReason };

export type ArtifactBinaryReadResult =
  | { ok: true; base64: string; mimeType: string }
  | { ok: false; reason: ArtifactBinaryReadFailureReason };

export type ArtifactSaveFailureReason =
  | 'canceled'
  | 'not_found'
  | 'not_allowed'
  | 'deleted'
  | 'write_failed';

export type ArtifactSaveResult =
  | { ok: true; saved: string }
  | { ok: false; reason: ArtifactSaveFailureReason };
