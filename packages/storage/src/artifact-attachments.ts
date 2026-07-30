import {
  MAX_ATTACHMENT_BYTES,
  MAX_READ_IMAGE_BYTES,
  READ_IMAGE_TOO_LARGE_MESSAGE,
  type AttachmentByteReader,
  type StorageRef,
} from '@maka/core';
import type { ArtifactStore, DurableArtifactAttachmentReader } from './artifact-store.js';

export function createAttachmentByteReader(input: {
  artifactStore: DurableArtifactAttachmentReader;
  sessionId: string;
  maxBytes?: number;
}): AttachmentByteReader {
  const maxBytes = input.maxBytes ?? MAX_ATTACHMENT_BYTES;
  return async (ref) => {
    if (ref.kind !== 'session_file') return { ok: false, reason: 'unsupported_ref_kind' };
    if (ref.sessionId !== input.sessionId) return { ok: false, reason: 'session_mismatch' };
    const result = await input.artifactStore.readDurableAttachmentBinary({
      artifactId: ref.relativePath,
      sessionId: input.sessionId,
      maxBytes,
    });
    return result.ok
      ? { ok: true, bytes: Buffer.from(result.base64, 'base64') }
      : { ok: false, reason: result.reason };
  };
}

export function createReadImageSnapshotter(artifactStore: Pick<ArtifactStore, 'create'>) {
  return async (input: {
    sessionId: string;
    turnId: string;
    name: string;
    bytes: Uint8Array;
    mimeType: string;
  }): Promise<Extract<StorageRef, { kind: 'session_file' }>> => {
    if (input.bytes.byteLength > MAX_READ_IMAGE_BYTES) {
      throw new Error(READ_IMAGE_TOO_LARGE_MESSAGE);
    }
    const artifact = await artifactStore.create({
      sessionId: input.sessionId,
      turnId: input.turnId,
      name: input.name,
      kind: 'image',
      content: input.bytes,
      mimeType: input.mimeType,
      source: 'tool_result',
    });
    return { kind: 'session_file', sessionId: input.sessionId, relativePath: artifact.id };
  };
}
