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
import { createHash, type Hash } from 'node:crypto';
import {
  isSha256Digest,
  isValidUnicodeString,
  SESSION_BUNDLE_CANONICALIZATION_VERSION,
  SESSION_BUNDLE_STATE_IDENTITY_PATH,
  SESSION_BUNDLE_STATE_PATH,
  SESSION_BUNDLE_WORKSPACE_PATH,
  SessionBundleFileError,
  type Sha256Digest,
} from './session-bundle-contract.js';

const TREE_MAGIC = Buffer.from('MAKA_SESSION_BUNDLE_TREE\0', 'ascii');
const TREE_HEADER_BYTES = TREE_MAGIC.byteLength + 4 + 8;
const TREE_ENTRY_FIXED_BYTES = 1 + 4 + 2 + 8 + 32;
const MAX_UINT32 = 0xffff_ffff;
const DIRECTORY_ENTRY_TYPE = 0x01;
const REGULAR_FILE_ENTRY_TYPE = 0x02;
const DIRECTORY_MODE = 0o755;
const REGULAR_FILE_MODES = new Set([0o644, 0o755]);
const DIRECTORY_DIGEST = Buffer.alloc(32);

export interface SessionBundleCanonicalDirectoryEntry {
  kind: 'directory';
  path: string;
}

export interface SessionBundleCanonicalFileEntry {
  kind: 'file';
  path: string;
  mode: 0o644 | 0o755;
  size: number;
  contentDigest: Sha256Digest;
}

export type SessionBundleCanonicalTreeEntry =
  | SessionBundleCanonicalDirectoryEntry
  | SessionBundleCanonicalFileEntry;

export type SessionBundleCanonicalLayoutEntry =
  | SessionBundleCanonicalDirectoryEntry
  | Pick<SessionBundleCanonicalFileEntry, 'kind' | 'mode' | 'path'>;

export interface SessionBundleCanonicalTreeDigest {
  treeDigest: Sha256Digest;
  payloadBytes: number;
  entryCount: number;
}

interface ValidatedCanonicalTreeEntry {
  entry: SessionBundleCanonicalTreeEntry;
  pathBytes: Buffer;
  logicalPath: string;
  parentDirectory?: string;
}

/**
 * Encode the exact canonical tree-record stream defined by codec V1.
 *
 * Input order is irrelevant. Entries are validated and sorted by raw UTF-8
 * path bytes before encoding.
 */
export function encodeSessionBundleCanonicalTree(
  entries: readonly SessionBundleCanonicalTreeEntry[],
): Uint8Array {
  const sorted = validateAndSortEntries(entries);
  const builder = new SessionBundleCanonicalTreeDigestBuilder(sorted.length);
  const chunks: Buffer[] = [encodeTreeHeader(sorted.length)];
  for (const validated of sorted) {
    builder.add(validated.entry);
    chunks.push(encodeTreeEntry(validated));
  }
  builder.finish();
  return Buffer.concat(chunks);
}

export function computeSessionBundleCanonicalTreeDigest(
  entries: readonly SessionBundleCanonicalTreeEntry[],
): SessionBundleCanonicalTreeDigest {
  const sorted = validateAndSortEntries(entries);
  const builder = new SessionBundleCanonicalTreeDigestBuilder(sorted.length);
  for (const validated of sorted) builder.add(validated.entry);
  return builder.finish();
}

/**
 * Incremental digest builder for PR 2's streaming USTAR reader.
 *
 * The caller supplies the entry count from the validated manifest, then adds
 * payload entries in canonical raw-UTF-8 order after each regular file's
 * content digest is known. The builder enforces ordering, parent directories,
 * layout, normalized modes, and the final count without retaining file bytes.
 */
export class SessionBundleCanonicalTreeDigestBuilder {
  readonly #hash: Hash;
  readonly #layout: SessionBundleCanonicalLayoutValidator;
  #entryCount = 0;
  #payloadBytes = 0;
  #failed = false;
  #result?: SessionBundleCanonicalTreeDigest;

  constructor(expectedEntryCount: number) {
    if (!Number.isSafeInteger(expectedEntryCount) || expectedEntryCount < 0) {
      throw new RangeError('Canonical tree entry count must be a non-negative safe integer');
    }
    this.#layout = new SessionBundleCanonicalLayoutValidator(expectedEntryCount);
    this.#hash = createHash('sha256');
    this.#hash.update(encodeTreeHeader(expectedEntryCount));
  }

  add(value: SessionBundleCanonicalTreeEntry): void {
    if (this.#result !== undefined) {
      throw integrityError('Canonical tree digest is already finalized');
    }
    if (this.#failed) {
      throw integrityError('Canonical tree digest builder previously rejected an entry');
    }

    try {
      const validated = validateEntry(value);
      this.#layout.add(validated.entry);
      const nextPayloadBytes =
        validated.entry.kind === 'file'
          ? this.#payloadBytes + validated.entry.size
          : this.#payloadBytes;
      if (!Number.isSafeInteger(nextPayloadBytes)) {
        throw unsupportedEntry('Canonical tree payload byte count exceeds safe integer range');
      }
      const record = encodeTreeEntry(validated);

      // Commit only after every validation and encoding step has succeeded.
      this.#hash.update(record);
      this.#entryCount += 1;
      this.#payloadBytes = nextPayloadBytes;
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  finish(): SessionBundleCanonicalTreeDigest {
    if (this.#result !== undefined) return { ...this.#result };
    if (this.#failed) {
      throw integrityError('Canonical tree digest builder previously rejected an entry');
    }
    try {
      this.#layout.finish();
    } catch (error) {
      this.#failed = true;
      throw error;
    }
    this.#result = Object.freeze({
      treeDigest: `sha256:${this.#hash.digest('hex')}` as Sha256Digest,
      payloadBytes: this.#payloadBytes,
      entryCount: this.#entryCount,
    });
    return { ...this.#result };
  }
}

/**
 * Shared state machine for canonical path order, explicit parents, conflicts,
 * required roots, and entry count. The streaming reader uses it before any
 * hydration write, while the digest builder applies the same rules after file
 * content hashes are available.
 */
export class SessionBundleCanonicalLayoutValidator {
  readonly #expectedEntryCount: number;
  readonly #logicalPaths = new Set<string>();
  readonly #directories = new Set<string>();
  #previousPathBytes?: Buffer;
  #entryCount = 0;
  #sawStateIdentity = false;
  #sawStateRoot = false;
  #sawWorkspaceRoot = false;
  #failed = false;
  #finished = false;

  constructor(expectedEntryCount: number) {
    if (!Number.isSafeInteger(expectedEntryCount) || expectedEntryCount < 0) {
      throw new RangeError('Canonical layout entry count must be a non-negative safe integer');
    }
    this.#expectedEntryCount = expectedEntryCount;
  }

  add(value: SessionBundleCanonicalLayoutEntry): void {
    if (this.#finished) throw integrityError('Canonical layout is already finalized');
    if (this.#failed)
      throw integrityError('Canonical layout validator previously rejected an entry');

    try {
      const entry = validateLayoutEntry(value);
      if (this.#entryCount >= this.#expectedEntryCount) {
        throw integrityError('Canonical tree contains more entries than declared');
      }
      const validated = validateCanonicalPath(entry.path, entry.kind);
      if (
        this.#previousPathBytes !== undefined &&
        Buffer.compare(this.#previousPathBytes, validated.pathBytes) >= 0
      ) {
        throw unsafePath('Canonical tree paths are duplicated or out of order');
      }
      if (this.#logicalPaths.has(validated.logicalPath)) {
        throw unsafePath('Canonical tree contains a file and directory path conflict');
      }
      if (
        validated.parentDirectory !== undefined &&
        !this.#directories.has(validated.parentDirectory)
      ) {
        throw unsafePath('Canonical tree entry is missing its explicit parent directory');
      }

      const layout = classifyPayloadPath(entry);
      this.#logicalPaths.add(validated.logicalPath);
      if (entry.kind === 'directory') this.#directories.add(entry.path);
      this.#previousPathBytes = validated.pathBytes;
      this.#entryCount += 1;
      if (layout === 'state_identity') this.#sawStateIdentity = true;
      if (layout === 'state_root') this.#sawStateRoot = true;
      if (layout === 'workspace_root') this.#sawWorkspaceRoot = true;
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  finish(): void {
    if (this.#finished) return;
    if (this.#failed)
      throw integrityError('Canonical layout validator previously rejected an entry');
    try {
      if (this.#entryCount !== this.#expectedEntryCount) {
        throw integrityError('Canonical tree entry count does not match the declared count');
      }
      if (!this.#sawStateIdentity || !this.#sawStateRoot || !this.#sawWorkspaceRoot) {
        throw integrityError('Canonical tree is missing a required V1 payload root');
      }
      this.#finished = true;
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }
}

export function compareSessionBundleCanonicalPaths(left: string, right: string): number {
  if (!isValidUnicodeString(left) || !isValidUnicodeString(right)) {
    throw unsafePath('Canonical tree path is not valid Unicode');
  }
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function validateAndSortEntries(
  entries: readonly SessionBundleCanonicalTreeEntry[],
): ValidatedCanonicalTreeEntry[] {
  if (!Array.isArray(entries)) {
    throw new TypeError('Canonical tree entries must be an array');
  }
  return entries
    .map((entry) => validateEntry(entry))
    .sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
}

function validateEntry(value: unknown): ValidatedCanonicalTreeEntry {
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.path !== 'string') {
    throw unsupportedEntry('Canonical tree entry has an invalid shape');
  }

  let entry: SessionBundleCanonicalTreeEntry;
  if (value.kind === 'directory') {
    if (!hasExactKeys(value, ['kind', 'path'])) {
      throw unsupportedEntry('Canonical directory entry has unsupported metadata');
    }
    entry = { kind: 'directory', path: value.path };
  } else if (value.kind === 'file') {
    if (
      !hasExactKeys(value, ['contentDigest', 'kind', 'mode', 'path', 'size']) ||
      typeof value.mode !== 'number' ||
      !REGULAR_FILE_MODES.has(value.mode) ||
      typeof value.size !== 'number' ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0 ||
      !isSha256Digest(value.contentDigest)
    ) {
      throw unsupportedEntry('Canonical regular file entry has unsupported metadata');
    }
    entry = {
      kind: 'file',
      path: value.path,
      mode: value.mode as 0o644 | 0o755,
      size: value.size,
      contentDigest: value.contentDigest,
    };
  } else {
    throw unsupportedEntry('Canonical tree entry type is not supported');
  }

  const path = validateCanonicalPath(entry.path, entry.kind);
  return {
    entry,
    pathBytes: path.pathBytes,
    logicalPath: path.logicalPath,
    ...(path.parentDirectory === undefined ? {} : { parentDirectory: path.parentDirectory }),
  };
}

function validateLayoutEntry(value: unknown): SessionBundleCanonicalLayoutEntry {
  if (!isRecord(value) || typeof value.path !== 'string') {
    throw unsupportedEntry('Canonical layout entry has an invalid shape');
  }
  if (value.kind === 'directory') return { kind: 'directory', path: value.path };
  if (
    value.kind === 'file' &&
    typeof value.mode === 'number' &&
    REGULAR_FILE_MODES.has(value.mode)
  ) {
    return { kind: 'file', path: value.path, mode: value.mode as 0o644 | 0o755 };
  }
  throw unsupportedEntry('Canonical layout entry has unsupported metadata');
}

function validateCanonicalPath(
  path: string,
  kind: SessionBundleCanonicalTreeEntry['kind'],
): {
  pathBytes: Buffer;
  logicalPath: string;
  parentDirectory?: string;
} {
  if (!path || !isValidUnicodeString(path) || path.includes('\0') || path.includes('\\')) {
    throw unsafePath('Canonical tree path contains unsupported characters');
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw unsafePath('Canonical tree path must be relative');
  }

  const isDirectory = kind === 'directory';
  if (isDirectory !== path.endsWith('/')) {
    throw unsafePath('Canonical tree directory marker does not match its entry type');
  }
  const logicalPath = isDirectory ? path.slice(0, -1) : path;
  const segments = logicalPath.split('/');
  if (
    logicalPath.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw unsafePath('Canonical tree path contains an unsafe segment');
  }

  const pathBytes = Buffer.from(path, 'utf8');
  if (pathBytes.byteLength > MAX_UINT32) {
    throw unsafePath('Canonical tree path exceeds the record encoding limit');
  }

  const lastSlash = logicalPath.lastIndexOf('/');
  const parentDirectory = lastSlash < 0 ? undefined : `${logicalPath.slice(0, lastSlash)}/`;
  return {
    pathBytes,
    logicalPath,
    ...(parentDirectory === undefined ? {} : { parentDirectory }),
  };
}

function classifyPayloadPath(
  entry: SessionBundleCanonicalLayoutEntry,
): 'state_identity' | 'state_root' | 'workspace_root' | 'payload' {
  if (entry.path === SESSION_BUNDLE_STATE_IDENTITY_PATH) {
    if (entry.kind !== 'file' || entry.mode !== 0o644) {
      throw unsupportedEntry('State identity must be a non-executable regular file');
    }
    return 'state_identity';
  }
  if (entry.path === SESSION_BUNDLE_STATE_PATH) {
    if (entry.kind !== 'directory') throw unsupportedEntry('State root must be a directory');
    return 'state_root';
  }
  if (entry.path === SESSION_BUNDLE_WORKSPACE_PATH) {
    if (entry.kind !== 'directory') throw unsupportedEntry('Workspace root must be a directory');
    return 'workspace_root';
  }
  if (
    entry.path.startsWith(SESSION_BUNDLE_STATE_PATH) ||
    entry.path.startsWith(SESSION_BUNDLE_WORKSPACE_PATH)
  ) {
    return 'payload';
  }
  throw unsafePath('Canonical tree path is outside the V1 payload roots');
}

function encodeTreeHeader(entryCount: number): Buffer {
  const header = Buffer.alloc(TREE_HEADER_BYTES);
  TREE_MAGIC.copy(header, 0);
  header.writeUInt32BE(SESSION_BUNDLE_CANONICALIZATION_VERSION, TREE_MAGIC.byteLength);
  header.writeBigUInt64BE(BigInt(entryCount), TREE_MAGIC.byteLength + 4);
  return header;
}

function encodeTreeEntry(validated: ValidatedCanonicalTreeEntry): Buffer {
  const { entry, pathBytes } = validated;
  const record = Buffer.alloc(TREE_ENTRY_FIXED_BYTES + pathBytes.byteLength);
  let offset = 0;
  record.writeUInt8(
    entry.kind === 'directory' ? DIRECTORY_ENTRY_TYPE : REGULAR_FILE_ENTRY_TYPE,
    offset,
  );
  offset += 1;
  record.writeUInt32BE(pathBytes.byteLength, offset);
  offset += 4;
  pathBytes.copy(record, offset);
  offset += pathBytes.byteLength;
  record.writeUInt16BE(entry.kind === 'directory' ? DIRECTORY_MODE : entry.mode, offset);
  offset += 2;
  record.writeBigUInt64BE(BigInt(entry.kind === 'directory' ? 0 : entry.size), offset);
  offset += 8;
  if (entry.kind === 'directory') {
    DIRECTORY_DIGEST.copy(record, offset);
  } else {
    Buffer.from(entry.contentDigest.slice('sha256:'.length), 'hex').copy(record, offset);
  }
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
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
