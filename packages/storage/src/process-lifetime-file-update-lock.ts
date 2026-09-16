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

import { constants as fsConstants } from 'node:fs';
import { lstat, open, rmdir, unlink } from 'node:fs/promises';
import {
  openStableNativeLockFile,
  releaseNativeFileLock,
  tryAcquireNativeFileLock,
} from './native-file-lock.js';

const LOCK_POLL_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const lockGates = new Map<string, Promise<void>>();

export async function withLegacyFileUpdateLockLease<T>(
  targetPath: string,
  operation: (inheritedFd: number) => Promise<T>,
  timeoutMs: number = LOCK_TIMEOUT_MS,
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const leasePath = `${targetPath}.lease`;
  const supervisionPath = `${targetPath}.supervised`;
  const deadline = Date.now() + timeoutMs;
  return runWithLockGate(leasePath, deadline, async () => {
    const lease = await openStableNativeLockFile(leasePath);
    let leased = false;
    let supervised = false;
    let completed = false;
    try {
      while (!(leased = tryAcquireNativeFileLock(lease))) {
        await waitForLockTurn(lockPath, deadline);
      }
      // The inherited advisory lease follows the legacy child process. A surviving
      // supervision marker therefore proves that its directory lock is ownerless
      // once a later process can acquire this lease.
      await recoverSupervisedLegacyLock(lockPath, supervisionPath);
      await createSupervisionMarker(supervisionPath);
      supervised = true;
      const result = await operation(lease.fd);
      completed = true;
      return result;
    } finally {
      try {
        if (supervised && completed) await unlink(supervisionPath).catch(ignoreMissing);
      } finally {
        if (leased) releaseNativeFileLock(lease);
        await lease.close();
      }
    }
  });
}

/**
 * The callback may pass the lease fd as an extra child stdio descriptor. The
 * advisory lock then survives a parent crash until that exact child exits.
 */
export async function withProcessLifetimeFileUpdateLock<T>(
  targetPath: string,
  operation: (inheritableLeaseFd: number) => Promise<T>,
  timeoutMs: number = LOCK_TIMEOUT_MS,
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  const leasePath = `${targetPath}.lease`;
  return runWithLockGate(leasePath, deadline, async () => {
    const lease = await openStableNativeLockFile(leasePath);
    let leased = false;
    let markerCreated = false;
    try {
      while (!(leased = tryAcquireNativeFileLock(lease))) {
        await waitForLockTurn(lockPath, deadline);
      }
      await recoverSupervisedLegacyLock(lockPath, `${targetPath}.supervised`);
      await acquireLegacyMarker(lockPath, deadline);
      markerCreated = true;
      return await operation(lease.fd);
    } finally {
      try {
        if (markerCreated) await unlink(lockPath).catch(ignoreMissing);
      } finally {
        if (leased) releaseNativeFileLock(lease);
        await lease.close();
      }
    }
  });
}

async function createSupervisionMarker(path: string): Promise<void> {
  const marker = await open(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  await marker.close();
}

async function recoverSupervisedLegacyLock(
  lockPath: string,
  supervisionPath: string,
): Promise<void> {
  const supervision = await lstat(supervisionPath).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (!supervision) return;
  if (!supervision.isFile() || supervision.isSymbolicLink()) {
    throw new Error(`File update supervision marker is not a regular file: ${supervisionPath}`);
  }
  const lock = await lstat(lockPath).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (lock?.isDirectory() && !lock.isSymbolicLink()) await rmdir(lockPath);
  await unlink(supervisionPath);
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

async function waitForLockTurn(lockPath: string, deadline: number): Promise<void> {
  if (Date.now() >= deadline) throw lockTimeout(lockPath);
  await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
}

function lockTimeout(lockPath: string): Error {
  return new Error(`File update is locked by another process (${lockPath})`);
}

function ignoreMissing(error: unknown): void {
  if (!isNodeError(error, 'ENOENT')) throw error;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
