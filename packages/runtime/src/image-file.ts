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

import { stat, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { imageDimensionsFromData } from 'image-dimensions';
import {
  MAX_MODEL_IMAGE_EDGE,
  MAX_READ_IMAGE_BYTES,
  READ_IMAGE_TOO_LARGE_MESSAGE,
} from '@maka/core/attachments';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const PNG_SIGNATURE = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1');
const JPEG_SIGNATURE = Buffer.from('\xff\xd8\xff', 'latin1');
const GIF87A_SIGNATURE = Buffer.from('GIF87a');
const GIF89A_SIGNATURE = Buffer.from('GIF89a');
const RIFF_SIGNATURE = Buffer.from('RIFF');
const WEBP_SIGNATURE = Buffer.from('WEBP');
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export function isSupportedImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

export async function readWorkspaceImage(
  path: string,
): Promise<{ bytes: Uint8Array; mimeType: ImageMimeType }> {
  const size = await stat(path).catch(() => {
    throw new Error('Image could not be read.');
  });
  if (!size.isFile()) throw new Error('Image path is not a file.');
  if (size.size > MAX_READ_IMAGE_BYTES) throw imageTooLargeError();
  const bytes = await readFile(path).catch(() => {
    throw new Error('Image could not be read.');
  });
  return validateImageBytes(bytes);
}

export function validateImageBytes(bytes: Uint8Array): {
  bytes: Uint8Array;
  mimeType: ImageMimeType;
} {
  if (bytes.length > MAX_READ_IMAGE_BYTES) throw imageTooLargeError();
  const mimeType = sniffImageMime(bytes);
  if (!mimeType) throw new Error('Image content is not a supported PNG, JPEG, GIF, or WebP file.');
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
    throw new Error('Image dimensions could not be read; verify the image file is valid.');
  }
  if (Math.max(dimensions.width, dimensions.height) > MAX_MODEL_IMAGE_EDGE) {
    throw new Error(
      `Image dimensions ${dimensions.width}x${dimensions.height} exceed the ${MAX_MODEL_IMAGE_EDGE}px model input limit; downscale it and try again.`,
    );
  }
  return { bytes, mimeType };
}

function imageTooLargeError(): Error {
  return new Error(READ_IMAGE_TOO_LARGE_MESSAGE);
}

function sniffImageMime(bytes: Uint8Array): ImageMimeType | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg';
  if (startsWith(bytes, GIF87A_SIGNATURE) || startsWith(bytes, GIF89A_SIGNATURE))
    return 'image/gif';
  if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_SIGNATURE, 8))
    return 'image/webp';
  return undefined;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array, offset = 0): boolean {
  return (
    bytes.length >= offset + prefix.length &&
    prefix.every((value, index) => bytes[offset + index] === value)
  );
}
