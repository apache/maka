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
import { mkdir, open, writeFile } from 'node:fs/promises';
import { nativeImage } from 'electron';
import { CUSTOM_APP_ICON_PREFIX, type CustomAppIcon } from '@maka/core/settings';
import {
  CustomAppIconError,
  CUSTOM_ICON_EDGE,
  CUSTOM_ICON_MAX_EDGE,
  CUSTOM_ICON_MAX_INPUT_BYTES,
  CUSTOM_ICON_MIN_EDGE,
  customAppIconDirectory,
  resolveCustomAppIconPath,
} from './custom-app-icon-store.js';
import { readImageHeader } from './image-header.js';

/**
 * Decode, square, scale, store. Non-square art is centre-cropped rather than
 * letterboxed: an icon that keeps its own transparent margin is the caller's
 * business, and silently adding one would change art the user already framed.
 *
 * The file is read ONCE into a capped buffer and everything downstream works
 * on that snapshot. Reading first closes two holes at the same time: the path
 * cannot be swapped between a stat and a decode, and the dimensions are known
 * from the header before any decoder allocates a bitmap for them.
 */
export async function importCustomAppIcon(input: {
  readonly sourcePath: string;
  readonly userDataPath: string;
}): Promise<CustomAppIcon> {
  const bytes = await readCapped(input.sourcePath);

  const header = readImageHeader(bytes);
  if (!header) throw new CustomAppIconError('unsupported_format', 'not a PNG or JPEG');
  const { width, height } = header;
  if (Math.max(width, height) > CUSTOM_ICON_MAX_EDGE) {
    throw new CustomAppIconError('too_many_pixels', `${width}×${height} is over ${CUSTOM_ICON_MAX_EDGE}`);
  }
  if (Math.min(width, height) < CUSTOM_ICON_MIN_EDGE) {
    throw new CustomAppIconError('too_small', `${width}×${height} is under ${CUSTOM_ICON_MIN_EDGE}`);
  }

  // Same bytes the header came from — nothing re-read from the path.
  const source = nativeImage.createFromBuffer(bytes);
  if (source.isEmpty()) throw new CustomAppIconError('unreadable', 'no decodable image');

  // Geometry comes from the DECODED image, not from the header. The header
  // says what the file declares; a JPEG carrying an EXIF orientation comes out
  // of the decoder rotated, and cropping it to the pre-rotation rectangle
  // would frame the wrong part of the picture or fall outside it entirely.
  const decoded = source.getSize();
  const edge = Math.min(decoded.width, decoded.height);
  const squared =
    decoded.width === decoded.height
      ? source
      : source.crop({
          x: Math.round((decoded.width - edge) / 2),
          y: Math.round((decoded.height - edge) / 2),
          width: edge,
          height: edge,
        });
  const png = squared
    .resize({ width: CUSTOM_ICON_EDGE, height: CUSTOM_ICON_EDGE, quality: 'better' })
    .toPNG();
  if (png.length === 0) throw new CustomAppIconError('unreadable', 're-encode produced nothing');

  const id = randomUUID().replaceAll('-', '');
  try {
    await mkdir(customAppIconDirectory(input.userDataPath), { recursive: true });
    await writeFile(resolveCustomAppIconPath(input.userDataPath, id), png);
  } catch (error) {
    throw new CustomAppIconError('write_failed', `could not store the icon: ${String(error)}`);
  }
  return `${CUSTOM_APP_ICON_PREFIX}${id}` as CustomAppIcon;
}

/** Chunk size for the snapshot read — big enough to be few syscalls, small
 *  enough that a 20 KB icon does not cost the whole cap up front. */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * One open handle, read to the end, capped as it goes.
 *
 * Reading through a single handle is what removes the swap window: the bytes
 * are a snapshot of one file, not of whatever the path pointed at each time.
 * The loop is not optional — `read()` is one syscall and may return fewer
 * bytes than asked for, and a truncated buffer would sail past the header
 * check and then fail to decode, reported as an unreadable image.
 */
async function readCapped(path: string): Promise<Buffer> {
  const file = await open(path, 'r').catch(() => undefined);
  if (!file) throw new CustomAppIconError('unreadable', 'not a readable file');
  try {
    const chunks: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > CUSTOM_ICON_MAX_INPUT_BYTES) {
        throw new CustomAppIconError('too_large', `over ${CUSTOM_ICON_MAX_INPUT_BYTES} bytes`);
      }
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await file.close();
  }
}
