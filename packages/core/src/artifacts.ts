export const ARTIFACT_KINDS = ['file', 'diff', 'html', 'image', 'pdf'] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_SOURCES = [
  'tool_result',
  'tool_result_archive',
  'synthesis_cache_block',
  'history_compact_block',
  'history_compact_source',
  'provider_request_capture',
  'deep_research',
  'user_upload',
  'export',
  'snapshot',
  'fixture',
] as const;

export type ArtifactSource = (typeof ARTIFACT_SOURCES)[number];

export const ARTIFACT_STATUSES = ['live', 'deleted'] as const;

export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const ARTIFACT_ENTITY_ID_MAX_CHARS = 128;

const ARTIFACT_ENTITY_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${ARTIFACT_ENTITY_ID_MAX_CHARS}}$`);

export function isCanonicalArtifactEntityId(value: unknown): value is string {
  return typeof value === 'string' && ARTIFACT_ENTITY_ID_PATTERN.test(value);
}

export interface ArtifactRecord {
  id: string;
  sessionId: string;
  turnId: string;
  createdAt: number;
  name: string;
  kind: ArtifactKind;
  /**
   * Artifact-root-relative path. Never absolute and never exposed as a
   * filesystem path to renderer code.
   */
  relativePath: string;
  sizeBytes: number;
  mimeType?: string;
  source?: ArtifactSource;
  summary?: string;
  /** Durable role for artifacts owned by a Deep Research workspace. */
  deepResearchRole?: import('./deep-research-run.js').DeepResearchArtifactRole;
  status: ArtifactStatus;
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
