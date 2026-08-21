/**
 * Published artifact-store surface.
 *
 * The owning module also exports the write authority; only artifact-stores.ts
 * may construct it, bound to a storage-root lease, so it stays package-private,
 * exactly as the deleted barrel kept it.
 */
export {
  ARTIFACT_BINARY_PREVIEW_LIMIT_BYTES,
  ARTIFACT_TEXT_PREVIEW_LIMIT_BYTES,
  createSqliteArtifactStore,
  isSafeRelativeArtifactPath,
  resolveArtifactPath,
  sanitizeArtifactName,
} from './artifact-store.js';
export type {
  ArtifactStore,
  ArtifactStoreReader,
  CreateArtifactInput,
  DurableArtifactAttachmentReader,
  DurableArtifactBinaryReadResult,
} from './artifact-store.js';
