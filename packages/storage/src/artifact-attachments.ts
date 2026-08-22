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
import { type StorageRef, type ToolResultContent } from '@maka/core/events';
import type {
  ArtifactAuthorityStore,
  ArtifactStore,
  DurableArtifactAttachmentReader,
} from './artifact-store.js';

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
    return {
      kind: 'session_file',
      sessionId: input.sessionId,
      relativePath: artifact.id,
    };
  };
}
