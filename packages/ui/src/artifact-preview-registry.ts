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

/** Safe raster-image preview classification for renderer data URLs. */

import type { ArtifactBinaryReadResult, ArtifactKind } from '@maka/core/artifacts';

import type { UiLocale } from '@maka/core/ui-locale';
import { getSharedUiCopy } from './shared-ui-copy.js';

/** Path and ownership fields are intentionally outside this boundary. */
export interface ArtifactPreviewInput {
  name: string;
  kind: ArtifactKind;
  mimeType?: string;
  sizeBytes?: number;
}

export type PreviewResolution =
  | {
      kind: 'image';
      reason: 'mime_match' | 'ext_fallback';
    }
  | {
      kind: 'unsupported';
      reason: 'kind_disallowed' | 'mime_disallowed' | 'no_mime_no_ext' | 'oversize' | 'read_failed';
    };

/** Maximum decoded image payload allowed into renderer state. */
export const IMAGE_PAYLOAD_MAX_BYTES = 2 * 1024 * 1024;

/** Encoded-length cap, including base64 padding. */
const IMAGE_PAYLOAD_MAX_BASE64_LENGTH = Math.ceil((IMAGE_PAYLOAD_MAX_BYTES * 4) / 3) + 2;

/**
 * MIME allowlist shared by metadata and post-load validation. SVG is
 * intentionally absent.
 */
const ALLOWED_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

/** Return a normalized allowlisted MIME for constructing an image data URL. */
function normalizeAllowedImageMime(mimeType: string | undefined): string | null {
  if (typeof mimeType !== 'string') return null;
  const mime = mimeType.trim().toLowerCase();
  if (mime === '') return null;
  return ALLOWED_IMAGE_MIMES.has(mime) ? mime : null;
}

/** Post-load decision after payload size and sniffed MIME validation. */
export type ImagePostLoadOutcome =
  | { kind: 'image'; safeMime: string; base64: string }
  | { kind: 'unsupported'; reason: 'oversize' | 'mime_disallowed' | 'read_failed' };

function decideImagePostLoad(input: {
  base64: string;
  mimeType: string;
}): ImagePostLoadOutcome {
  if (exceedsImagePayloadCap(input.base64)) {
    return { kind: 'unsupported', reason: 'oversize' };
  }
  const safeMime = normalizeAllowedImageMime(input.mimeType);
  if (!safeMime) {
    return { kind: 'unsupported', reason: 'mime_disallowed' };
  }
  return { kind: 'image', safeMime, base64: input.base64 };
}

/** Reject raw IPC payloads before base64 can enter renderer state. */
export function decideImageReadOutcome(readResult: ArtifactBinaryReadResult): ImagePostLoadOutcome {
  if (!readResult.ok) {
    return { kind: 'unsupported', reason: 'read_failed' };
  }
  if (typeof readResult.base64 !== 'string' || typeof readResult.mimeType !== 'string') {
    return { kind: 'unsupported', reason: 'read_failed' };
  }
  return decideImagePostLoad({ base64: readResult.base64, mimeType: readResult.mimeType });
}

/** Safe extension fallback when MIME metadata is absent. */
const ALLOWED_IMAGE_EXTS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
]);

export function resolvePreviewKind(input: ArtifactPreviewInput): PreviewResolution {
  if (input.kind !== 'image') {
    return { kind: 'unsupported', reason: 'kind_disallowed' };
  }
  // Reject by metadata before materializing base64.
  if (input.sizeBytes !== undefined && input.sizeBytes > IMAGE_PAYLOAD_MAX_BYTES) {
    return { kind: 'unsupported', reason: 'oversize' };
  }
  // A present MIME is authoritative; extension fallback cannot override it.
  if (input.mimeType) {
    const mime = input.mimeType.trim().toLowerCase();
    if (ALLOWED_IMAGE_MIMES.has(mime)) {
      return { kind: 'image', reason: 'mime_match' };
    }
    return { kind: 'unsupported', reason: 'mime_disallowed' };
  }
  const ext = lowercaseExt(input.name);
  if (ext && ALLOWED_IMAGE_EXTS.has(ext)) {
    return { kind: 'image', reason: 'ext_fallback' };
  }
  return { kind: 'unsupported', reason: 'no_mime_no_ext' };
}

/** Enforce the post-load cap using encoded length without decoding. */
function exceedsImagePayloadCap(base64: string): boolean {
  if (typeof base64 !== 'string') return true;
  return base64.length > IMAGE_PAYLOAD_MAX_BASE64_LENGTH;
}

export function formatPreviewSize(sizeBytes: number | undefined, locale: UiLocale = 'zh'): string {
  if (sizeBytes === undefined || sizeBytes < 0 || !Number.isFinite(sizeBytes)) return getSharedUiCopy(locale).artifact.unknownSize;
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function lowercaseExt(name: string): string | null {
  if (typeof name !== 'string') return null;
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return null;
  return name.slice(idx).toLowerCase();
}
