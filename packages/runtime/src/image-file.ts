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

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { imageDimensionsFromData } from 'image-dimensions';
import {
  ATTACHMENT_MIME_SNIFF_BYTES,
  MAX_MODEL_IMAGE_EDGE,
  MAX_READ_IMAGE_BYTES,
  READ_IMAGE_TOO_LARGE_MESSAGE,
  sniffAttachmentMimeType,
} from '@maka/core/attachments';
import { ARTIFACT_IMAGE_PREVIEW_MAX_BYTES } from '@maka/core/artifacts';

export interface WorkspaceFileReadOptions {
  imagePurpose?: 'chat';
  abortSignal?: AbortSignal;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export class ImageFileError extends Error {
  constructor(
    readonly code: 'ERR_IMAGE_TOO_LARGE' | 'ERR_INVALID_IMAGE',
    message: string,
  ) {
    super(message);
  }
}

/** Translate validated image failures without changing backend/transport errors. */
export function imageFileFailureReason(error: ImageFileError): 'too_large' | 'unsupported_mime' {
  return error.code === 'ERR_IMAGE_TOO_LARGE' ? 'too_large' : 'unsupported_mime';
}

export function isSupportedImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

/** Classify a bounded prefix before decoding text or allocating an image body. */
export async function readWorkspaceFile(
  path: string,
  options: WorkspaceFileReadOptions = {},
): Promise<{ content: string } | { bytes: Uint8Array; mimeType: ImageMimeType }> {
  options.abortSignal?.throwIfAborted();
  // Chat capture must never block opening a FIFO or read an unbounded text file.
  const file = await open(
    path,
    options.imagePurpose === 'chat' ? constants.O_RDONLY | constants.O_NONBLOCK : 'r',
  );
  try {
    options.abortSignal?.throwIfAborted();
    if (options.imagePurpose === 'chat') {
      const size = await file.stat();
      if (!size.isFile()) throw new Error('Image path is not a file.');
      if (size.size > ARTIFACT_IMAGE_PREVIEW_MAX_BYTES) throw imageTooLargeError('chat');
      return validateImageBytes(await file.readFile({ signal: options.abortSignal }), 'chat');
    }
    const prefix = Buffer.alloc(ATTACHMENT_MIME_SNIFF_BYTES);
    // A positioned read leaves the descriptor's offset at zero for readFile.
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    if (isSupportedImagePath(path) || sniffImageMime(prefix.subarray(0, bytesRead))) {
      const size = await file.stat();
      if (!size.isFile()) throw new Error('Image path is not a file.');
      if (size.size > MAX_READ_IMAGE_BYTES) throw imageTooLargeError();
      return validateImageBytes(await file.readFile());
    }
    return { content: await file.readFile('utf8') };
  } finally {
    await file.close();
  }
}

export function validateImageBytes(
  bytes: Uint8Array,
  purpose: 'model' | 'chat' = 'model',
): {
  bytes: Uint8Array;
  mimeType: ImageMimeType;
} {
  if (bytes.length > (purpose === 'chat' ? ARTIFACT_IMAGE_PREVIEW_MAX_BYTES : MAX_READ_IMAGE_BYTES))
    throw imageTooLargeError(purpose);
  const mimeType = sniffImageMime(bytes);
  if (!mimeType)
    throw new ImageFileError(
      'ERR_INVALID_IMAGE',
      'Image content is not a supported PNG, JPEG, GIF, or WebP file.',
    );
  const dimensions = imageDimensionsFromData(bytes);
  if (
    !dimensions ||
    !Number.isFinite(dimensions.width) ||
    !Number.isFinite(dimensions.height) ||
    !Number.isInteger(dimensions.width) ||
    !Number.isInteger(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    throw new ImageFileError(
      'ERR_INVALID_IMAGE',
      'Image dimensions could not be read; verify the image file is valid.',
    );
  }
  if (purpose === 'model' && Math.max(dimensions.width, dimensions.height) > MAX_MODEL_IMAGE_EDGE) {
    throw new Error(
      `Image dimensions ${dimensions.width}x${dimensions.height} exceed the ${MAX_MODEL_IMAGE_EDGE}px model input limit; downscale it and try again.`,
    );
  }
  // Compressed byte size does not bound renderer decoding memory. Permit large
  // screenshots while rejecting pathological headers before archival/preview.
  if (
    purpose === 'chat' &&
    (Math.max(dimensions.width, dimensions.height) > 16_384 ||
      dimensions.width * dimensions.height > 32 * 1024 * 1024)
  ) {
    throw imageTooLargeError(purpose);
  }
  return { bytes, mimeType };
}

function imageTooLargeError(purpose: 'model' | 'chat' = 'model'): Error {
  return new ImageFileError(
    'ERR_IMAGE_TOO_LARGE',
    purpose === 'chat'
      ? 'Image exceeds a chat preview limit (2 MiB, 16384px per edge, or 32 megapixels); resize it before publishing.'
      : READ_IMAGE_TOO_LARGE_MESSAGE,
  );
}

function sniffImageMime(bytes: Uint8Array): ImageMimeType | undefined {
  // Core owns the byte signatures (shared with the attachment and artifact
  // paths); this reader decodes only images, so a sniffed PDF is not one here.
  const sniffed = sniffAttachmentMimeType(bytes);
  return sniffed && sniffed !== 'application/pdf' ? sniffed : undefined;
}
