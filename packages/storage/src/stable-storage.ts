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

import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface ReadStableBoundedFileInput {
  readonly path: string;
  readonly maxBytes: number;
  invalidFile(): Error;
}

export interface StableBoundedFileHandle {
  stat(options: { bigint: true }): Promise<BigIntStats>;
  read<TBuffer extends NodeJS.ArrayBufferView>(
    buffer: TBuffer,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesRead: number; buffer: TBuffer }>;
  close(): Promise<void>;
}

export interface ReadStableBoundedFileDependencies {
  open(path: string, flags: string | number): Promise<StableBoundedFileHandle>;
  lstat(path: string, options: { bigint: true }): Promise<BigIntStats>;
}

const openStableFile = open;
const lstatStableFile = lstat;
const defaultReadDependencies: ReadStableBoundedFileDependencies = {
  open: openStableFile,
  lstat: lstatStableFile,
};

/** Reads one immutable regular-file snapshot without trusting its pathname or declared size. */
export async function readStableBoundedFile(
  input: ReadStableBoundedFileInput,
  dependencies: Partial<ReadStableBoundedFileDependencies> = {},
): Promise<Buffer> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
  const deps = { ...defaultReadDependencies, ...dependencies };
  let handle: StableBoundedFileHandle;
  try {
    handle = await deps.open(input.path, stableReadFlags());
  } catch (error) {
    if (isInvalidStableFileError(error)) throw input.invalidFile();
    throw error;
  }
  try {
    const initial = await stableFileSnapshot(handle, input, deps);
    const bytes = Buffer.allocUnsafe(input.maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > input.maxBytes) throw input.invalidFile();

    const final = await stableFileSnapshot(handle, input, deps);
    if (!sameStableFileSnapshot(initial, final) || BigInt(offset) !== initial.size) {
      throw input.invalidFile();
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function syncFile(path: string): Promise<void> {
  // Windows rejects fsync on a read-only handle (EPERM). Durable store files
  // are writer-owned, so reopen the existing file read/write without creating
  // or truncating it before re-establishing the stable-storage barrier.
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectoryChain(
  path: string,
  root: string,
  beforeSync?: (path: string) => void | Promise<void>,
): Promise<void> {
  const boundary = resolve(root);
  let current = resolve(path);
  const pathFromBoundary = relative(boundary, current);
  if (
    pathFromBoundary === '..' ||
    pathFromBoundary.startsWith(`..${sep}`) ||
    isAbsolute(pathFromBoundary)
  ) {
    throw new Error(`Durability path escapes workspace root: ${path}`);
  }
  while (true) {
    await beforeSync?.(current);
    await syncDirectory(current);
    if (current === boundary) return;
    current = dirname(current);
  }
}

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function stableFileSnapshot(
  handle: StableBoundedFileHandle,
  input: ReadStableBoundedFileInput,
  dependencies: ReadStableBoundedFileDependencies,
): Promise<BigIntStats> {
  let handleStat: BigIntStats;
  let pathStat: BigIntStats;
  try {
    [handleStat, pathStat] = await Promise.all([
      handle.stat({ bigint: true }),
      dependencies.lstat(input.path, { bigint: true }),
    ]);
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isInvalidStableFileError(error)) {
      throw input.invalidFile();
    }
    throw error;
  }
  if (
    !handleStat.isFile() ||
    !pathStat.isFile() ||
    handleStat.size > BigInt(input.maxBytes) ||
    handleStat.dev !== pathStat.dev ||
    handleStat.ino !== pathStat.ino
  ) {
    throw input.invalidFile();
  }
  return handleStat;
}

function sameStableFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function stableReadFlags(): string | number {
  return process.platform === 'win32'
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isInvalidStableFileError(error: unknown): boolean {
  return (
    isNodeError(error, 'ELOOP') || isNodeError(error, 'ENOTDIR') || isNodeError(error, 'ENXIO')
  );
}
