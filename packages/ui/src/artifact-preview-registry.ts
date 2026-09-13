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

import {
  ARTIFACT_IMAGE_PREVIEW_MAX_BYTES,
  normalizeArtifactImagePreviewMime,
  resolveArtifactImagePreview,
  type ArtifactBinaryReadResult,
  type ArtifactImagePreviewInput,
  type ArtifactImagePreviewResolution,
} from '@maka/core/artifacts';

import type { UiLocale } from '@maka/core/ui-locale';
import { getSharedUiCopy } from './shared-ui-copy.js';

/** Path and ownership fields are intentionally outside this boundary. */
export type ArtifactPreviewInput = ArtifactImagePreviewInput;
export type PreviewResolution =
  | ArtifactImagePreviewResolution
  | { kind: 'unsupported'; reason: 'read_failed' };

/** Encoded-length cap, including base64 padding. */
const IMAGE_PAYLOAD_MAX_BASE64_LENGTH =
  Math.ceil((ARTIFACT_IMAGE_PREVIEW_MAX_BYTES * 4) / 3) + 2;

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
  const safeMime = normalizeArtifactImagePreviewMime(input.mimeType);
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

export function resolvePreviewKind(input: ArtifactPreviewInput): PreviewResolution {
  return resolveArtifactImagePreview(input);
}

/** Enforce the post-load cap using encoded length without decoding. */
function exceedsImagePayloadCap(base64: string): boolean {
  if (typeof base64 !== 'string') return true;
  return base64.length > IMAGE_PAYLOAD_MAX_BASE64_LENGTH;
}

export function formatPreviewSize(sizeBytes: number | undefined, locale: UiLocale): string {
  if (sizeBytes === undefined || sizeBytes < 0 || !Number.isFinite(sizeBytes)) return getSharedUiCopy(locale).artifact.unknownSize;
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
