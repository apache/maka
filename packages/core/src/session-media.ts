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

import { IMAGE_ARCHIVE_MAX_BYTES } from './image-delivery.js';
import type { StorageRef } from './events.js';
import { isCanonicalArtifactEntityId } from './artifacts.js';
import { formatAttachmentResourceRef } from './attachments.js';

/** Transport-neutral input. Only the Host may turn a source into a saved reference. */
export type SessionMediaInput =
  | { kind: 'inline'; mimeType: string; base64: string }
  | { kind: 'source'; source: string };

export type SessionContentPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; ref: Extract<StorageRef, { kind: 'session_file' }> }
  | { kind: 'file_diff'; paths: string[]; diff: string };

export const SESSION_CONTENT_MAX_PARTS = 64;
export const SESSION_MEDIA_MAX_BYTES = IMAGE_ARCHIVE_MAX_BYTES;
export const SESSION_MEDIA_MAX_BASE64 = 4 * Math.ceil(SESSION_MEDIA_MAX_BYTES / 3);

export function isSessionMediaInput(value: unknown): value is SessionMediaInput {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.kind === 'source')
    return (
      Object.keys(v).length === 2 &&
      typeof v.source === 'string' &&
      v.source.length > 0 &&
      v.source.length <= 4096 &&
      !/[\x00-\x1f\x7f]/.test(v.source)
    );
  return (
    v.kind === 'inline' &&
    Object.keys(v).length === 3 &&
    typeof v.mimeType === 'string' &&
    /^image\/[a-z0-9.+-]{1,64}$/.test(v.mimeType) &&
    typeof v.base64 === 'string' &&
    v.base64.length > 0 &&
    v.base64.length <= SESSION_MEDIA_MAX_BASE64 &&
    v.base64.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(v.base64)
  );
}

export function isSessionContentPart(value: unknown): value is SessionContentPart {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.kind === 'text')
    return Object.keys(v).length === 2 && typeof v.text === 'string' && v.text.length <= 8192;
  if (v.kind === 'file_diff')
    return (
      Object.keys(v).length === 3 &&
      Array.isArray(v.paths) &&
      v.paths.length > 0 &&
      v.paths.length <= 64 &&
      v.paths.every((p) => typeof p === 'string' && p.length <= 8192) &&
      typeof v.diff === 'string' &&
      v.diff.length <= 1024 * 1024
    );
  if (
    v.kind !== 'image' ||
    Object.keys(v).length !== 3 ||
    typeof v.mimeType !== 'string' ||
    !/^image\/[a-z0-9.+-]{1,64}$/.test(v.mimeType) ||
    !v.ref ||
    typeof v.ref !== 'object'
  )
    return false;
  const ref = v.ref as Record<string, unknown>;
  return (
    Object.keys(ref).length === 3 &&
    ref.kind === 'session_file' &&
    typeof ref.sessionId === 'string' &&
    ref.sessionId.length > 0 &&
    ref.sessionId.length <= 512 &&
    isCanonicalArtifactEntityId(ref.relativePath)
  );
}

/** Compatibility projection: ordered media uses the existing durable Markdown transcript. */
export function sessionContentMarkdown(
  part: Exclude<SessionContentPart, { kind: 'file_diff' }>,
): string {
  if (part.kind === 'text') return part.text;
  const source = formatAttachmentResourceRef(part.ref);
  return source ? `\n\n![](${source})\n\n` : '';
}
