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

export const ARTIFACT_SOURCES = [
  'tool_result',
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

const ARTIFACT_USER_DELETE_ALLOWED_BY_SOURCE = {
  tool_result: true,
  tool_result_archive: false,
  synthesis_cache_block: true,
  history_compact_block: true,
  history_compact_source: true,
  provider_request_capture: true,
  subagent_writeback: false,
  deep_research: false,
  user_upload: true,
  export: true,
  snapshot: true,
  session_effect: false,
  fixture: true,
} as const satisfies Record<ArtifactSource, boolean>;

export function canUserDeleteArtifact(record: Pick<ArtifactRecord, 'source'>): boolean {
  return record.source === undefined || ARTIFACT_USER_DELETE_ALLOWED_BY_SOURCE[record.source];
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
