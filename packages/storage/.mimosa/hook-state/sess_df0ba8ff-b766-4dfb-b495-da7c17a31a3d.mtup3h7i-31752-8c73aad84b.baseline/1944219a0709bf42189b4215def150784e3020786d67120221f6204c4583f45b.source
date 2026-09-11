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

import { MAX_READ_IMAGE_BYTES } from '@maka/core/attachments';
import {
  ReadImageSnapshotStoreError,
  type ContextOffloadReadResult,
  type ReadImageSnapshotReader,
  type ReadImageSnapshotStore,
  type SessionContextRef,
} from '@maka/core/context-offload';
import {
  authenticateInteractiveContextOffloadReader,
  authenticateInteractiveContextOffloadWriter,
  createInteractiveContextOffloadReader,
  type InteractiveContextOffloadReader,
  type InteractiveContextOffloadWriter,
} from './context-offload-store.js';

/** Derives the Read image hydration contract from an authenticated reader. */
export function createReadImageSnapshotReader(
  reader: InteractiveContextOffloadReader,
  sessionId: string,
): ReadImageSnapshotReader {
  const store = authenticateInteractiveContextOffloadReader(reader);
  if (!sessionId) throw new Error('Read image snapshot Session id is required');
  return Object.freeze({
    async read(input: SessionContextRef): Promise<ContextOffloadReadResult> {
      if (input.sessionId !== sessionId) return { ok: false, reason: 'session_mismatch' };
      const result = await store.read({
        sessionId,
        refId: input.refId,
        maxBytes: MAX_READ_IMAGE_BYTES,
      });
      if (!result.ok) return result;
      if (
        result.record.owner.kind !== 'read_image_snapshot' ||
        !result.record.mediaType.toLowerCase().startsWith('image/')
      ) {
        return { ok: false, reason: 'corrupt' };
      }
      return result;
    },
  });
}

/** Derives the Read image domain contract from the authenticated byte authority. */
export function createReadImageSnapshotStore(
  writer: InteractiveContextOffloadWriter,
  sessionId: string,
): ReadImageSnapshotStore {
  const store = authenticateInteractiveContextOffloadWriter(writer);
  if (!sessionId) throw new Error('Read image snapshot Session id is required');
  const reader = createReadImageSnapshotReader(
    createInteractiveContextOffloadReader(store),
    sessionId,
  );
  const facade: ReadImageSnapshotStore = {
    async snapshot(input) {
      const accepted = Object.freeze({
        sessionId,
        ownerId: input.ownerId,
        bytes: new Uint8Array(input.bytes),
        mimeType: input.mimeType,
      });
      if (!accepted.mimeType.toLowerCase().startsWith('image/')) {
        throw new Error('Read image snapshot media type must be an image');
      }
      if (accepted.bytes.byteLength > MAX_READ_IMAGE_BYTES) {
        throw new ReadImageSnapshotStoreError('too_large');
      }
      const result = await store.put({
        sessionId: accepted.sessionId,
        owner: { kind: 'read_image_snapshot', ownerId: accepted.ownerId },
        bytes: accepted.bytes,
        mediaType: accepted.mimeType,
      });
      if (!result.ok) throw new ReadImageSnapshotStoreError(result.reason);
      const { record } = result;
      if (
        record.sessionId !== accepted.sessionId ||
        record.owner.kind !== 'read_image_snapshot' ||
        record.owner.ownerId !== accepted.ownerId ||
        record.mediaType !== accepted.mimeType ||
        record.sizeBytes !== accepted.bytes.byteLength
      ) {
        throw new Error('Read image snapshot authority returned an inconsistent reference');
      }
      return Object.freeze({
        kind: 'session_context',
        sessionId: record.sessionId,
        refId: record.refId,
      });
    },

    read: (input) => reader.read(input),
  };
  return Object.freeze(facade);
}
