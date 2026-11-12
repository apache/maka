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

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  sniffAttachmentMimeType,
} from '@maka/core/attachments';
import type { AttachmentRef } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import type { ExternalMakaSession } from '@maka/core/external-session';
import type { ArtifactAuthorityStore } from './artifact-store.js';

// Bound disk growth and I/O independently of the transcript's text budget.
const MAX_IMPORT_IMAGE_BYTES = 256 * 1024 * 1024;

type ImportArtifactStore = Pick<ArtifactAuthorityStore, 'create' | 'purgeSessionArtifacts'>;

/** Source paths never become published references: only verified, durable bytes do. */
export async function prepareExternalSessionImages(
  sessionId: string,
  messages: readonly StoredMessage[],
  sources: NonNullable<ExternalMakaSession['sourceImages']>,
  artifacts: ImportArtifactStore | undefined,
): Promise<readonly StoredMessage[]> {
  const byMessage = new Map<string, string[]>();
  for (const source of sources) {
    const paths = byMessage.get(source.messageId) ?? [];
    paths.push(source.path);
    byMessage.set(source.messageId, paths);
  }
  const prepared: StoredMessage[] = [];
  let totalBytes = 0;
  try {
    for (const message of messages) {
      const paths = message.type === 'user' ? byMessage.get(message.id) : undefined;
      if (message.type !== 'user' || !paths?.length) {
        prepared.push(message);
        continue;
      }
      const attachments: AttachmentRef[] = [...(message.attachments ?? [])];
      const unavailable: number[] = [];
      for (const [index, path] of paths.entries()) {
        if (
          !artifacts ||
          index >= MAX_ATTACHMENT_COUNT ||
          attachments.length >= MAX_ATTACHMENT_COUNT
        ) {
          unavailable.push(index + 1);
          continue;
        }
        const image = await readSourceImage(path, MAX_IMPORT_IMAGE_BYTES - totalBytes);
        if (!image) {
          unavailable.push(index + 1);
          continue;
        }
        const id = `import_image_${randomUUID()}`;
        const record = await artifacts.create({
          id,
          sessionId,
          // Match native uploads: the artifact owns an upload key, not a source Turn id.
          turnId: id,
          name: basename(path),
          kind: 'image',
          content: image.bytes,
          mimeType: image.mimeType,
          source: 'user_upload',
        });
        totalBytes += image.bytes.byteLength;
        attachments.push({
          kind: 'image',
          name: record.name,
          mimeType: image.mimeType,
          bytes: record.sizeBytes,
          ref: { kind: 'session_file', sessionId, relativePath: record.id },
        });
      }
      const fallback =
        unavailable.length > 0
          ? `\n\n[${unavailable.length} imported image attachment(s) unavailable (source positions: ${unavailable.join(', ')}): the original file could not be recovered within attachment limits.]`
          : '';
      prepared.push({
        ...message,
        // Keep all source text, including useful metadata for unavailable originals.
        text: message.text + fallback,
        ...(message.displayText !== undefined
          ? { displayText: message.displayText + fallback }
          : {}),
        ...(attachments.length ? { attachments } : {}),
      });
    }
    return prepared;
  } catch (error) {
    // No Session metadata has been committed while this preparation callback runs.
    await artifacts?.purgeSessionArtifacts(sessionId);
    throw error;
  }
}

async function readSourceImage(
  path: string,
  remaining: number,
): Promise<
  | {
      bytes: Uint8Array;
      mimeType: string;
    }
  | undefined
> {
  if (!isAbsolute(path) || remaining <= 0) return undefined;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const metadata = await handle.stat();
      const limit = Math.min(MAX_ATTACHMENT_BYTES, remaining);
      if (!metadata.isFile() || metadata.size <= 0 || metadata.size > limit) return undefined;
      // One extra byte detects growth without ever buffering an unbounded source.
      const bytes = Buffer.alloc(metadata.size + 1);
      let total = 0;
      while (total < bytes.length) {
        const read = await handle.read(bytes, total, bytes.length - total, total);
        if (read.bytesRead === 0) break;
        total += read.bytesRead;
      }
      if (total !== metadata.size) return undefined;
      const payload = bytes.subarray(0, total);
      const mimeType = sniffAttachmentMimeType(payload);
      return mimeType?.startsWith('image/') ? { bytes: payload, mimeType } : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
