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
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
};

export const ATTACHMENT_MIME_SNIFF_BYTES = 16;

/**
 * PDF permits arbitrary bytes before the `%PDF-` header and readers
 * conventionally scan roughly the first kilobyte for it. Searching that window
 * keeps a PDF with a preamble from sniffing as nothing — which downstream would
 * otherwise decode as UTF-8 text — while staying bounded so sniffing never
 * becomes an unbounded read. Only the PDF header needs it: image signatures are
 * valid solely at their fixed offset within {@link ATTACHMENT_MIME_SNIFF_BYTES}.
 */
export const PDF_HEADER_SCAN_BYTES = 1024;

export type SniffedAttachmentMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'application/pdf';

/**
 * Identify the attachment formats whose bytes affect how Maka processes them.
 * Image signatures are read from the fixed {@link ATTACHMENT_MIME_SNIFF_BYTES}
 * prefix at their required offset; the PDF header may sit behind a short
 * preamble, so it is searched across the first {@link PDF_HEADER_SCAN_BYTES}.
 * Both bounds are fixed, so callers can apply this before handing untrusted
 * input to an image decoder without turning sniffing into an unbounded read.
 */
export function sniffAttachmentMimeType(bytes: Uint8Array): SniffedAttachmentMimeType | undefined {
  const prefix = bytes.subarray(0, ATTACHMENT_MIME_SNIFF_BYTES);
  if (startsWithBytes(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWithBytes(prefix, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWithAscii(prefix, 'GIF87a') || startsWithAscii(prefix, 'GIF89a')) return 'image/gif';
  if (startsWithAscii(prefix, 'RIFF') && startsWithAscii(prefix, 'WEBP', 8)) return 'image/webp';
  if (containsAscii(bytes.subarray(0, PDF_HEADER_SCAN_BYTES), '%PDF-')) return 'application/pdf';
  return undefined;
}

function startsWithBytes(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return (
    bytes.length >= offset + signature.length &&
    signature.every((value, index) => bytes[offset + index] === value)
  );
}

function startsWithAscii(bytes: Uint8Array, signature: string, offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature.charCodeAt(index)) return false;
  }
  return true;
}

/** True if `signature` appears anywhere in `bytes` (bounded by the caller's
 * slice), for headers a format allows to sit behind a preamble. */
function containsAscii(bytes: Uint8Array, signature: string): boolean {
  const lastOffset = bytes.length - signature.length;
  for (let offset = 0; offset <= lastOffset; offset += 1) {
    if (startsWithAscii(bytes, signature, offset)) return true;
  }
  return false;
}

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
 * Decide an attachment's MIME with content taking precedence over the name and
 * any renderer-supplied MIME, so a spoofed extension cannot steer routing.
 * Sniffed bytes win outright. When nothing sniffs, a *claimed* image/PDF MIME
 * (from the name or the renderer) is downgraded to `application/octet-stream`
 * so unverified bytes never enter the image or PDF path; any other claim is
 * kept so genuine document kinds still resolve. `bytes` may be a prefix rather
 * than the whole file: image signatures resolve from the
 * {@link ATTACHMENT_MIME_SNIFF_BYTES} prefix, while a PDF header behind a
 * preamble is only found within the first {@link PDF_HEADER_SCAN_BYTES} — the
 * send path passes the full bytes, pick-time staging passes the short prefix.
 */
export function resolveAttachmentMimeType(
  bytes: Uint8Array,
  suppliedMimeType: string | undefined,
  fileName: string,
): string {
  const sniffed = sniffAttachmentMimeType(bytes);
  if (sniffed) return sniffed;

  const fallback =
    suppliedMimeType && suppliedMimeType.length > 0
      ? suppliedMimeType
      : guessMimeFromName(fileName);
  const normalized = fallback.toLowerCase();
  return normalized.startsWith('image/') || normalized === 'application/pdf'
    ? 'application/octet-stream'
    : fallback;
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
