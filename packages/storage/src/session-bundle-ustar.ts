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

import { Buffer } from 'node:buffer';
import { isValidUnicodeString, SessionBundleFileError } from './session-bundle-contract.js';

export const SESSION_BUNDLE_USTAR_BLOCK_BYTES = 512;

const USTAR_NAME_BYTES = 100;
const USTAR_PREFIX_BYTES = 155;
const USTAR_SIZE_MAX = 0o77_777_777_777;
const ASCII_ZERO = '0'.charCodeAt(0);
const ASCII_SPACE = ' '.charCodeAt(0);
const WINDOWS_FORBIDDEN_PATH_CHARACTERS = /[\u0000-\u001f<>:"|?*]/u;
const WINDOWS_RESERVED_PATH_SEGMENT =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu;

export interface SessionBundleUstarHeader {
  kind: 'directory' | 'file';
  path: string;
  mode: 0o644 | 0o755;
  size: number;
}

/**
 * Encode the exact POSIX USTAR header admitted by Session Bundle codec V1.
 * Paths use a portable subset on every host: Windows device names, forbidden
 * characters, and trailing dots/spaces are rejected even when running on POSIX.
 */
export function encodeSessionBundleUstarHeaderV1(value: SessionBundleUstarHeader): Uint8Array {
  const path = splitUstarPath(value.path);
  if (value.kind === 'directory') {
    if (value.mode !== 0o755 || value.size !== 0 || !value.path.endsWith('/')) {
      throw unsupportedEntry('Session bundle directory metadata is not canonical');
    }
  } else if (
    (value.mode !== 0o644 && value.mode !== 0o755) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    value.size > USTAR_SIZE_MAX ||
    value.path.endsWith('/')
  ) {
    throw unsupportedEntry('Session bundle regular-file metadata is not representable in V1');
  }

  const header = Buffer.alloc(SESSION_BUNDLE_USTAR_BLOCK_BYTES);
  Buffer.from(path.name, 'utf8').copy(header, 0);
  writeOctal(header, 100, 8, value.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, value.size);
  writeOctal(header, 136, 12, 0);
  header.fill(ASCII_SPACE, 148, 156);
  header[156] = value.kind === 'directory' ? '5'.charCodeAt(0) : '0'.charCodeAt(0);
  Buffer.from('ustar\0', 'ascii').copy(header, 257);
  Buffer.from('00', 'ascii').copy(header, 263);
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  Buffer.from(path.prefix, 'utf8').copy(header, 345);

  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeChecksum(header, checksum);
  return header;
}

/** Decode a header and reject every representation outside the exact V1 subset. */
export function decodeSessionBundleUstarHeaderV1(value: Uint8Array): SessionBundleUstarHeader {
  if (!(value instanceof Uint8Array) || value.byteLength !== SESSION_BUNDLE_USTAR_BLOCK_BYTES) {
    throw integrityError('Session bundle USTAR header is truncated');
  }
  const header = Buffer.from(value);
  const expectedChecksum = parseOctal(header.subarray(148, 156));
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(ASCII_SPACE, 148, 156);
  const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
  if (expectedChecksum !== actualChecksum) {
    throw integrityError('Session bundle USTAR checksum does not match');
  }

  const name = decodeNulTerminatedUtf8(header.subarray(0, 100));
  const prefix = decodeNulTerminatedUtf8(header.subarray(345, 500));
  const path = prefix.length === 0 ? name : `${prefix}/${name}`;
  if (path.length === 0) throw unsafePath('Session bundle USTAR path is empty');

  const type = header[156];
  const kind =
    type === '0'.charCodeAt(0) ? 'file' : type === '5'.charCodeAt(0) ? 'directory' : undefined;
  if (kind === undefined) {
    throw unsupportedEntry('Session bundle USTAR entry type is not supported');
  }

  const mode = parseOctal(header.subarray(100, 108));
  const size = parseOctal(header.subarray(124, 136));
  const decoded: SessionBundleUstarHeader = {
    kind,
    path,
    mode: mode as 0o644 | 0o755,
    size,
  };
  const canonical = encodeSessionBundleUstarHeaderV1(decoded);
  if (!header.equals(canonical)) {
    throw unsupportedEntry('Session bundle USTAR metadata is not canonical');
  }
  return decoded;
}

export function sessionBundleUstarPaddingBytes(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw unsupportedEntry('Session bundle USTAR entry size is invalid');
  }
  return (
    (SESSION_BUNDLE_USTAR_BLOCK_BYTES - (size % SESSION_BUNDLE_USTAR_BLOCK_BYTES)) %
    SESSION_BUNDLE_USTAR_BLOCK_BYTES
  );
}

export function isSessionBundleUstarZeroBlock(value: Uint8Array): boolean {
  return value.byteLength === SESSION_BUNDLE_USTAR_BLOCK_BYTES && value.every((byte) => byte === 0);
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  if (
    !isValidUnicodeString(path) ||
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw unsafePath('Session bundle path is not valid for USTAR');
  }
  const logicalPath = path.endsWith('/') ? path.slice(0, -1) : path;
  const segments = logicalPath.split('/');
  if (
    logicalPath.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        WINDOWS_FORBIDDEN_PATH_CHARACTERS.test(segment) ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        WINDOWS_RESERVED_PATH_SEGMENT.test(segment),
    )
  ) {
    throw unsafePath('Session bundle path is not valid for USTAR');
  }
  if (Buffer.byteLength(path, 'utf8') <= USTAR_NAME_BYTES) return { name: path, prefix: '' };

  for (let index = path.length - 1; index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (
      name.length > 0 &&
      Buffer.byteLength(prefix, 'utf8') <= USTAR_PREFIX_BYTES &&
      Buffer.byteLength(name, 'utf8') <= USTAR_NAME_BYTES
    ) {
      return { name, prefix };
    }
  }
  throw unsafePath('Session bundle path is not representable by USTAR V1');
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw unsupportedEntry('Session bundle USTAR numeric field is invalid');
  }
  const octal = value.toString(8);
  if (octal.length > length - 1) {
    throw unsupportedEntry('Session bundle USTAR numeric field exceeds V1');
  }
  target.fill(ASCII_ZERO, offset, offset + length - 1);
  target.write(octal, offset + length - 1 - octal.length, octal.length, 'ascii');
  target[offset + length - 1] = 0;
}

function writeChecksum(target: Buffer, value: number): void {
  const octal = value.toString(8);
  if (octal.length > 6) throw integrityError('Session bundle USTAR checksum exceeds its field');
  target.fill(ASCII_ZERO, 148, 154);
  target.write(octal, 154 - octal.length, octal.length, 'ascii');
  target[154] = 0;
  target[155] = ASCII_SPACE;
}

function parseOctal(value: Buffer): number {
  const nul = value.indexOf(0);
  const body = value
    .subarray(0, nul < 0 ? value.length : nul)
    .toString('ascii')
    .trim();
  if (body.length === 0 || !/^[0-7]+$/.test(body)) {
    throw unsupportedEntry('Session bundle USTAR numeric field is malformed');
  }
  if (nul >= 0 && value.subarray(nul + 1).some((byte) => byte !== 0 && byte !== ASCII_SPACE)) {
    throw unsupportedEntry('Session bundle USTAR numeric field has unsupported trailing bytes');
  }
  const parsed = Number.parseInt(body, 8);
  return parsed;
}

function decodeNulTerminatedUtf8(value: Buffer): string {
  const nul = value.indexOf(0);
  const bytes = value.subarray(0, nul < 0 ? value.length : nul);
  if (nul >= 0 && value.subarray(nul + 1).some((byte) => byte !== 0)) {
    throw unsupportedEntry('Session bundle USTAR string field has unsupported trailing bytes');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw unsafePath('Session bundle USTAR path is not valid UTF-8');
  }
}

function unsafePath(message: string): SessionBundleFileError {
  return new SessionBundleFileError('unsafe_path', message);
}

function unsupportedEntry(message: string): SessionBundleFileError {
  return new SessionBundleFileError('unsupported_entry', message);
}

function integrityError(message: string): SessionBundleFileError {
  return new SessionBundleFileError('integrity_mismatch', message);
}
