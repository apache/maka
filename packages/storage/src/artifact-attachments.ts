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
  MAX_ATTACHMENT_BYTES,
  MAX_READ_IMAGE_BYTES,
  READ_IMAGE_TOO_LARGE_MESSAGE,
  type AttachmentByteReader,
} from '@maka/core/attachments';
import {
  isArtifactTurnKey,
  isCanonicalArtifactEntityId,
  normalizeArtifactImagePreviewMime,
} from '@maka/core/artifacts';
import { createHash } from 'node:crypto';
import { type StorageRef, type ToolResultContent } from '@maka/core/events';
import type { ReadImageSnapshotReader } from '@maka/core/context-offload';
import type {
  ArtifactAuthorityStore,
  ArtifactStore,
  DurableArtifactAttachmentReader,
} from './artifact-store.js';
import { sanitizeArtifactName } from './artifact-store.js';

export interface ArtifactAttachmentResourceReader {
  readAttachmentResource(
    sessionId: string,
    artifactId: string,
    abortSignal: AbortSignal,
  ): Promise<ToolResultContent>;
}

/** Read a user-uploaded Artifact without exposing its storage path. */
export function createArtifactAttachmentResourceReader(input: {
  artifactStore:
    | Pick<ArtifactAuthorityStore, 'getInSession' | 'readTextInSession'>
    | Pick<ArtifactStore, 'get' | 'readText'>;
}): ArtifactAttachmentResourceReader {
  return Object.freeze({
    async readAttachmentResource(
      sessionId: string,
      artifactId: string,
      abortSignal: AbortSignal,
    ): Promise<ToolResultContent> {
      abortSignal.throwIfAborted();
      const record =
        'getInSession' in input.artifactStore
          ? (await input.artifactStore.getInSession(sessionId, artifactId)).record
          : await input.artifactStore.get(artifactId);
      if (!record || record.status !== 'live' || record.source !== 'user_upload') {
        throw new Error('Attachment was not found in this Session');
      }
      if (record.sessionId !== sessionId) {
        throw new Error('Attachment was not found in this Session');
      }
      if (record.kind === 'image') {
        if (!record.mimeType) throw new Error('Attachment image has no media type');
        return {
          kind: 'image',
          mimeType: record.mimeType,
          ref: { kind: 'session_file', sessionId, relativePath: artifactId },
        };
      }
      if (record.kind === 'pdf') {
        throw new Error('PDF attachments cannot be decoded by Read');
      }
      const read =
        'readTextInSession' in input.artifactStore
          ? await input.artifactStore.readTextInSession(sessionId, artifactId)
          : await input.artifactStore.readText(artifactId);
      abortSignal.throwIfAborted();
      if (!read.ok) throw new Error(`Attachment could not be read: ${read.reason}`);
      return { kind: 'text', text: read.text };
    },
  });
}

export function createAttachmentByteReader(input: {
  artifactStore: DurableArtifactAttachmentReader;
  sessionId: string;
  readImageSnapshots?: ReadImageSnapshotReader;
  readImageSnapshotsUnavailable?: boolean;
  maxBytes?: number;
}): AttachmentByteReader {
  const maxBytes = input.maxBytes ?? MAX_ATTACHMENT_BYTES;
  return async (ref) => {
    if (ref.kind === 'session_context') {
      if (ref.sessionId !== input.sessionId) return { ok: false, reason: 'session_mismatch' };
      if (!input.readImageSnapshots) {
        return {
          ok: false,
          reason: input.readImageSnapshotsUnavailable ? 'unavailable' : 'unsupported_ref_kind',
        };
      }
      const result = await input.readImageSnapshots.read(ref);
      return result.ok
        ? { ok: true, bytes: new Uint8Array(result.bytes) }
        : { ok: false, reason: result.reason };
    }
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

interface ReadImageSnapshotInput {
  sessionId: string;
  turnId: string;
  name: string;
  bytes: Uint8Array;
  mimeType: string;
}

export interface ReadImageSnapshotPlan {
  ref: Extract<StorageRef, { kind: 'session_file' }>;
  persist(): Promise<void>;
  /**
   * Undo a publication whose projection was never admitted (#4283).
   *
   * A Tool Result projection carrying several images publishes them one at a
   * time; if a later one fails, the projection is rejected and the earlier
   * publications become artifacts no durable record will ever name. Retracting
   * them is best-effort by design: failing to retract only delays reclamation,
   * while failing to reject would put an unreferenced artifact in front of the
   * user as if the tool had produced it.
   */
  retract(): Promise<void>;
}

export interface ReadImageSnapshotArtifactStore extends Pick<ArtifactStore, 'create'> {
  /** Create with a receipt saying whether this call published the artifact. */
  createOwned?: (input: Parameters<ArtifactStore['create']>[0]) => Promise<{
    record: Awaited<ReturnType<ArtifactStore['create']>>;
    publishedByThisCall: boolean;
  }>;
}

export function createReadImageSnapshotPlanner(
  artifactStore: ReadImageSnapshotArtifactStore,
  /**
   * Narrow reclaim for a `tool_result_projection` artifact this planner
   * published. Optional so callers that cannot reclaim still get the planner;
   * without it `retract()` is a no-op and reclamation waits for reachability.
   */
  retractPublished?: (sessionId: string, artifactId: string) => Promise<void>,
) {
  return (input: ReadImageSnapshotInput): ReadImageSnapshotPlan => {
    if (input.bytes.byteLength > MAX_READ_IMAGE_BYTES) {
      throw new Error(READ_IMAGE_TOO_LARGE_MESSAGE);
    }
    if (normalizeArtifactImagePreviewMime(input.mimeType) !== input.mimeType) {
      throw new Error('Image media type is not canonical or safe');
    }
    if (!isCanonicalArtifactEntityId(input.sessionId)) {
      throw new Error('Image Session id is not canonical');
    }
    if (!isArtifactTurnKey(input.turnId)) {
      throw new Error('Image turn id is not canonical');
    }
    const accepted = Object.freeze({
      sessionId: input.sessionId,
      turnId: input.turnId,
      name: sanitizeArtifactName(input.name),
      bytes: input.bytes.slice(),
      mimeType: input.mimeType,
    });
    const id = `image_${createHash('sha256')
      .update(accepted.sessionId, 'utf8')
      .update('\0', 'utf8')
      .update(accepted.turnId, 'utf8')
      .update('\0', 'utf8')
      .update(accepted.name, 'utf8')
      .update('\0', 'utf8')
      .update(accepted.mimeType, 'utf8')
      .update('\0', 'utf8')
      .update(accepted.bytes)
      .digest('hex')}`;
    let publication: Promise<void> | undefined;
    // Ownership, not success. The id is derived from the bytes, so a create for
    // an image an earlier projection already published succeeds by replaying
    // that record — and reclaiming it would delete content that is still in
    // use. Only a create that actually published may be retracted.
    let owned = false;
    const ref = Object.freeze({
      kind: 'session_file' as const,
      sessionId: accepted.sessionId,
      relativePath: id,
    });
    return Object.freeze({
      ref,
      persist() {
        const input = {
          id,
          sessionId: accepted.sessionId,
          turnId: accepted.turnId,
          name: accepted.name,
          kind: 'image' as const,
          content: accepted.bytes,
          mimeType: accepted.mimeType,
          source: 'tool_result_projection' as const,
        };
        publication ??= (
          artifactStore.createOwned
            ? artifactStore.createOwned(input)
            : artifactStore.create(input).then((record) => ({
                record,
                publishedByThisCall: false,
              }))
        ).then(({ record, publishedByThisCall }) => {
          if (record.id !== id) throw new Error('Artifact publication changed its planned id');
          owned = publishedByThisCall;
        });
        return publication;
      },
      async retract() {
        if (!owned || !retractPublished) return;
        owned = false;
        publication = undefined;
        await retractPublished(accepted.sessionId, id).catch(() => undefined);
      },
    });
  };
}

export function createReadImageSnapshotter(artifactStore: Pick<ArtifactStore, 'create'>) {
  const planSnapshot = createReadImageSnapshotPlanner(artifactStore);
  return async (
    input: ReadImageSnapshotInput,
  ): Promise<Extract<StorageRef, { kind: 'session_file' }>> => {
    const plan = planSnapshot(input);
    await plan.persist();
    return plan.ref;
  };
}
