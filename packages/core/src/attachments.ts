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

import type { AttachmentRef, StorageRef } from './events.js';
import { isCanonicalArtifactEntityId } from './artifacts.js';

/** Lives in core so @maka/runtime and @maka/storage share one type without a package cycle. */
export type AttachmentByteReader = (
  ref: StorageRef,
) => Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }>;

export const ATTACHMENT_RESOURCE_PREFIX = 'maka://runtime/attachments';

/**
 * Convert a durable Session attachment into the opaque ref accepted by Read.
 * The Session remains implicit in the tool invocation so a ref cannot grant
 * access across Session boundaries.
 */
export function formatAttachmentResourceRef(ref: StorageRef): string | null {
  if (ref.kind !== 'session_file' || !isCanonicalArtifactEntityId(ref.relativePath)) return null;
  return `${ATTACHMENT_RESOURCE_PREFIX}/${ref.relativePath}`;
}

export function parseAttachmentResourceRef(value: string): { artifactId: string } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'maka:' ||
    url.hostname !== 'runtime' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  const prefix = '/attachments/';
  if (!url.pathname.startsWith(prefix)) return null;
  const artifactId = url.pathname.slice(prefix.length);
  if (!isCanonicalArtifactEntityId(artifactId)) return null;
  return value === `${ATTACHMENT_RESOURCE_PREFIX}/${artifactId}` ? { artifactId } : null;
}

/** Per-send cap on attachment count, shared by renderer preflight and main resolve. */
export const MAX_ATTACHMENT_COUNT = 8;

/** Per-file byte cap, shared by renderer preflight, preload encode, and main resolve. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Raw-byte cap for workspace images returned by Read, leaving room for Base64 transport overhead. */
export const MAX_READ_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_MODEL_IMAGE_EDGE = 2000;
export const READ_IMAGE_TOO_LARGE_MESSAGE = `Image exceeds the ${MAX_READ_IMAGE_BYTES / 1024 / 1024}MB model input limit; downscale it and try again.`;

/** Leaves room for Base64 expansion, text, and tool schemas under provider request limits. */
export const MAX_PROVIDER_IMAGE_REQUEST_BYTES = 12 * 1024 * 1024;
export const PROVIDER_IMAGE_BUDGET_EXCEEDED_MESSAGE = `Image was read, but the per-request image budget (${MAX_PROVIDER_IMAGE_REQUEST_BYTES / 1024 / 1024}MB across all images this turn) was exceeded; earlier images were sent and this one was omitted. Read fewer or smaller images.`;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
};

/**
 * Best-effort MIME from a file name, used when the picker gives no MIME
 * (Electron's openDialog only returns paths). Falls back to
 * `application/octet-stream` so downstream validation always sees a MIME.
 */
export function guessMimeFromName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return 'application/octet-stream';
  const ext = fileName.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/**
 * Route a MIME type to an {@link AttachmentRef} kind. The runtime
 * consumption split is image vs. everything-else (images become provider
 * image parts; other kinds are read on demand by the model via Read), so this
 * only needs to single out the kinds that change
 * consumption or display. Unknown / unmapped MIME falls back to `other`.
 *
 * `fileName` is consulted for kinds whose MIME is unreliable across OSes
 * (Office documents arrive as `application/octet-stream` or a long
 * `vnd.openxmlformats` string depending on the source); MIME still wins
 * when it is present and specific.
 */
/** Extensions routed to the `code` kind. Consumption is identical to `other`
 * (the model Reads them on demand); the kind only drives display — the
 * FileCode icon in chat turns and the composer's staged-file card. */
const CODE_FILE_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'go',
  'h',
  'hpp',
  'java',
  'js',
  'json',
  'jsx',
  'kt',
  'mjs',
  'cjs',
  'php',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'svelte',
  'swift',
  'ts',
  'tsx',
  'vue',
  'yaml',
  'yml',
  'zsh',
]);

export function attachmentKindFromMimeType(
  mimeType: string,
  fileName?: string,
): AttachmentRef['kind'] {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (fileName) {
    const lowerName = fileName.toLowerCase();
    if (
      lowerName.endsWith('.docx') ||
      lowerName.endsWith('.doc') ||
      lowerName.endsWith('.xlsx') ||
      lowerName.endsWith('.xls') ||
      lowerName.endsWith('.pptx') ||
      lowerName.endsWith('.ppt')
    ) {
      return 'doc';
    }
    const dot = lowerName.lastIndexOf('.');
    if (dot >= 0 && CODE_FILE_EXTENSIONS.has(lowerName.slice(dot + 1))) {
      return 'code';
    }
  }
  return 'other';
}
