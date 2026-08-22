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

import { nativeImage } from 'electron';
import { computeResizeDimensions } from './attachment-resize.js';

/**
 * Resize an image attachment's bytes so its longest edge fits the
 * attachment cap, then re-encode as PNG. Uses Electron's nativeImage, so
 * this runs in the main process only and is not unit-tested — the size
 * math lives in the tested {@link computeResizeDimensions}. GIFs collapse
 * to their first frame (accepted trade-off; animated GIF attachments are
 * rare and the alternative is shipping the full bytes).
 */
export async function resizeImageForAttachment(bytes: Uint8Array): Promise<Uint8Array> {
  const img = nativeImage.createFromBuffer(Buffer.from(bytes));
  const size = img.getSize();
  const target = computeResizeDimensions(size.width, size.height);
  if (!target) return bytes;
  const resized = img.resize({ width: target.width, height: target.height });
  return resized.toPNG();
}

/** Longest edge for composer-drawer preview thumbnails. The drawer renders a
 * 64px square; 512 keeps it crisp on retina + drawer zoom while the data URL
 * handed to the renderer stays small. */
export const ATTACHMENT_PREVIEW_MAX_EDGE = 512;

/**
 * Render a staged attachment's preview thumbnail: decode, scale the longest
 * edge down to {@link ATTACHMENT_PREVIEW_MAX_EDGE}, re-encode as PNG (always
 * PNG so the renderer never sees the original container format). Returns
 * null when the bytes don't decode as an image (corrupt file or a spoofed
 * extension), so the caller can fall back to the placeholder glyph. Same
 * nativeImage caveats as {@link resizeImageForAttachment}.
 */
export async function renderAttachmentPreview(
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const img = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (img.isEmpty()) return null;
  const size = img.getSize();
  const target = computeResizeDimensions(size.width, size.height, ATTACHMENT_PREVIEW_MAX_EDGE);
  const scaled = target ? img.resize({ width: target.width, height: target.height }) : img;
  return { bytes: scaled.toPNG(), mimeType: 'image/png' };
}
