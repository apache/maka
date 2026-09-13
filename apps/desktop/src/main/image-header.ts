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

/**
 * Format and pixel dimensions read out of image *bytes*, before any native
 * decoder sees them.
 *
 * A byte-size cap only bounds the compressed form: a few hundred KB of PNG can
 * carry a 30000×30000 image, and letting the platform decoder discover that
 * allocates the full bitmap inside the main process first. So the header is
 * parsed here, from a snapshot already held in memory, and the caller decodes
 * that same buffer only after the dimensions pass.
 *
 * PNG and JPEG only — the two formats Electron's `nativeImage` guarantees on
 * every platform, and therefore the two the picker offers.
 */
export interface ImageHeader {
  readonly format: 'png' | 'jpeg';
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Start-of-frame markers carry the dimensions; these four do not. */
const NOT_A_FRAME = new Set([0xc4, 0xc8, 0xcc, 0xd8]);

export function readImageHeader(bytes: Buffer): ImageHeader | undefined {
  return readPngHeader(bytes) ?? readJpegHeader(bytes);
}

function readPngHeader(bytes: Buffer): ImageHeader | undefined {
  // Signature, then a length + `IHDR` chunk whose first eight bytes are the
  // dimensions. IHDR is required by the spec to come first.
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return undefined;
  return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readJpegHeader(bytes: Buffer): ImageHeader | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;

  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined; // not a marker boundary any more
    const marker = bytes[offset + 1];
    // Padding fill bytes and the standalone markers carry no segment.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined; // EOI / start of scan
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && !NOT_A_FRAME.has(marker)) {
      if (offset + 9 > bytes.length) return undefined;
      return {
        format: 'jpeg',
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return undefined;
}
