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
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tryLock, unlock, waitForLock } from 'fs-native-extensions';
import { ARTIFACT_WRITER_LOCK_FILE } from './artifact-storage-layout.js';
import { withArtifactWriterBootstrapLock } from './artifact-writer-bootstrap-lock.js';
import {
  prepareArtifactWriterBootstrapAuthority,
  prepareArtifactWriterLockAuthorityForMarkedRoot,
  type ArtifactWriterLockAuthority,
} from './root-authority.js';

const lockGates = new Map<string, Promise<void>>();

// Operation-scoped and intentionally non-reentrant for the same workspace root.
export async function withArtifactWriterLock<T>(
  workspaceRoot: string,
  operation: (canonicalRoot: string) => Promise<T>,
  abortSignal?: AbortSignal,
): Promise<T> {
  abortSignal?.throwIfAborted();
  await mkdir(workspaceRoot, { recursive: true });
  const requestedCanonicalRoot = await realpath(workspaceRoot);
  const bootstrap = await prepareArtifactWriterBootstrapAuthority(requestedCanonicalRoot);
  return withArtifactWriterBootstrapLock(
    bootstrap.lockPath,
    async () => {
      abortSignal?.throwIfAborted();
      await bootstrap.assertCurrentRoot();
      const authority = await prepareArtifactWriterLockAuthorityForMarkedRoot(
        bootstrap.canonicalPath,
      );
      if (!authority) return operation(bootstrap.canonicalPath);
      if (authority.bootstrapLockPath !== bootstrap.lockPath) {
        throw new Error('Storage root identity changed while acquiring its Artifact writer lock');
      }
      return withAuthorityArtifactWriterLock(
        authority,
        () => operation(bootstrap.canonicalPath),
        abortSignal,
      );
    },
    abortSignal,
  );
}

export async function withLeaseBoundArtifactWriterLock<T>(
  authority: ArtifactWriterLockAuthority,
  operation: () => Promise<T>,
): Promise<T> {
  return withArtifactWriterBootstrapLock(authority.bootstrapLockPath, () =>
    withAuthorityArtifactWriterLock(authority, operation),
  );
}

async function withAuthorityArtifactWriterLock<T>(
  authority: ArtifactWriterLockAuthority,
  operation: () => Promise<T>,
  abortSignal?: AbortSignal,
): Promise<T> {
  return withArtifactWriterLockPath(
    join(authority.controlDirectory, ARTIFACT_WRITER_LOCK_FILE),
    async () => {
      await authority.assertCurrentRoot();
      return operation();
    },
    abortSignal,
  );
}

async function withArtifactWriterLockPath<T>(
  lockPath: string,
  operation: () => Promise<T>,
  abortSignal?: AbortSignal,
): Promise<T> {
  return runWithLockGate(
    lockPath,
    async () => {
      abortSignal?.throwIfAborted();
      const handle = await openArtifactWriterLock(lockPath);
      let acquired = false;
      try {
        await assertStableRegularFile(handle, lockPath);
        await acquireLock(handle.fd, abortSignal);
        acquired = true;
        await assertStableRegularFile(handle, lockPath);
        abortSignal?.throwIfAborted();
        return await operation();
      } finally {
        if (acquired) releaseLock(handle);
        await handle.close();
      }
    },
    abortSignal,
  );
}

async function runWithLockGate<T>(
  lockPath: string,
  operation: () => Promise<T>,
  abortSignal?: AbortSignal,
): Promise<T> {
  const previous = lockGates.get(lockPath);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  lockGates.set(lockPath, current);
  try {
    if (previous) await waitForGate(previous, abortSignal);
    abortSignal?.throwIfAborted();
    return await operation();
  } finally {
    release();
    if (lockGates.get(lockPath) === current) lockGates.delete(lockPath);
  }
}

async function acquireLock(fd: number, abortSignal: AbortSignal | undefined): Promise<void> {
  if (!abortSignal) {
    await waitForLock(fd);
    return;
  }
  abortSignal.throwIfAborted();
  while (!tryLock(fd)) {
    await delay(25, undefined, { signal: abortSignal });
  }
}

async function waitForGate(
  gate: Promise<void>,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  if (!abortSignal) {
    await gate.catch(() => {});
    return;
  }
  abortSignal.throwIfAborted();
  await Promise.race([
    gate.catch(() => {}),
    new Promise<never>((_resolve, reject) => {
      const onAbort = () =>
        reject(
          abortSignal.reason instanceof Error
            ? abortSignal.reason
            : new DOMException('Artifact writer admission was aborted', 'AbortError'),
        );
      abortSignal.addEventListener('abort', onAbort, { once: true });
      gate.finally(() => abortSignal.removeEventListener('abort', onAbort)).catch(() => {});
    }),
  ]);
}

async function openArtifactWriterLock(lockPath: string): Promise<FileHandle> {
  const handle = await open(
    lockPath,
    fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (process.platform !== 'win32') await handle.chmod(0o600);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
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
    throw new Error(`Artifact writer lock path is not one stable regular file: ${lockPath}`);
  }
}

function releaseLock(handle: FileHandle): void {
  try {
    unlock(handle.fd);
  } catch {
    // Closing the handle is the final OS-level release path.
  }
}
