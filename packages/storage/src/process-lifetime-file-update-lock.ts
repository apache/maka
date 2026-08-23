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

/// <reference path="./fs-native-extensions.d.ts" />

import { constants as fsConstants } from 'node:fs';
import { lstat, open, unlink, type FileHandle } from 'node:fs/promises';
import { tryLock, unlock } from 'fs-native-extensions';

const LOCK_POLL_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const lockGates = new Map<string, Promise<void>>();

export async function withProcessLifetimeFileUpdateLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
  timeoutMs: number = LOCK_TIMEOUT_MS,
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  const leasePath = `${targetPath}.lease`;
  return runWithLockGate(leasePath, deadline, async () => {
    const lease = await openStableLockFile(leasePath);
    let leased = false;
    let markerCreated = false;
    try {
      while (!(leased = tryLock(lease.fd))) await waitForLockTurn(lockPath, deadline);
      await acquireLegacyMarker(lockPath, deadline);
      markerCreated = true;
      return await operation();
    } finally {
      try {
        if (markerCreated) await unlink(lockPath).catch(ignoreMissing);
      } finally {
        if (leased) releaseLock(lease);
        await lease.close();
      }
    }
  });
}

async function runWithLockGate<T>(
  lockPath: string,
  deadline: number,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = lockGates.get(lockPath);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  lockGates.set(lockPath, current);
  try {
    if (previous) await waitForGate(previous, lockPath, deadline);
    return await operation();
  } finally {
    release();
    if (lockGates.get(lockPath) === current) lockGates.delete(lockPath);
  }
}

async function waitForGate(
  previous: Promise<void>,
  lockPath: string,
  deadline: number,
): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw lockTimeout(lockPath);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous.catch(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(lockTimeout(lockPath)), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function openStableLockFile(lockPath: string): Promise<FileHandle> {
  const handle = await open(
    lockPath,
    fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await assertStableRegularFile(handle, lockPath);
    if (process.platform !== 'win32') await handle.chmod(0o600);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function acquireLegacyMarker(lockPath: string, deadline: number): Promise<void> {
  for (;;) {
    try {
      const marker = await open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      await marker.close();
      return;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    const existing = await lstat(lockPath).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return undefined;
      throw error;
    });
    if (!existing) continue;
    if (existing.isFile() && !existing.isSymbolicLink()) {
      // Current writers hold the advisory lease before publishing this marker.
      // Owning the lease proves a remaining regular marker is stale.
      await unlink(lockPath);
      continue;
    }
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`File update lock path is not a regular marker: ${lockPath}`);
    }
    // Older builds use the directory itself as their live lock and publish no
    // owner identity, so it cannot be safely stolen.
    await waitForLockTurn(lockPath, deadline);
  }
}

async function assertStableRegularFile(handle: FileHandle, lockPath: string): Promise<void> {
  const [handleStat, pathStat] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(lockPath, { bigint: true }),
  ]);
  if (
    !handleStat.isFile() ||
    !pathStat.isFile() ||
    handleStat.dev !== pathStat.dev ||
    handleStat.ino !== pathStat.ino
  ) {
    throw new Error(`File update lease is not one stable regular file: ${lockPath}`);
  }
}

async function waitForLockTurn(lockPath: string, deadline: number): Promise<void> {
  if (Date.now() >= deadline) throw lockTimeout(lockPath);
  await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
}

function lockTimeout(lockPath: string): Error {
  return new Error(`File update is locked by another process (${lockPath})`);
}

function releaseLock(handle: FileHandle): void {
  try {
    unlock(handle.fd);
  } catch {
    // Closing the OS handle is the authoritative release path.
  }
}

function ignoreMissing(error: unknown): void {
  if (!isNodeError(error, 'ENOENT')) throw error;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
