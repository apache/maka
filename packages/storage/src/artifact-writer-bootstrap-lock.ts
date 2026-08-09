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
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tryLock, unlock, waitForLock } from 'fs-native-extensions';

const lockGates = new Map<string, Promise<void>>();

export async function withArtifactWriterBootstrapLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  abortSignal?: AbortSignal,
): Promise<T> {
  const previous = lockGates.get(lockPath);
  let releaseGate!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  lockGates.set(lockPath, current);
  try {
    if (previous) await waitForGate(previous, abortSignal);
    abortSignal?.throwIfAborted();
    const handle = await open(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      0o600,
    );
    let locked = false;
    try {
      await assertStableRegularFile(handle, lockPath);
      if (process.platform !== 'win32') await handle.chmod(0o600);
      await acquireLock(handle.fd, abortSignal);
      locked = true;
      await assertStableRegularFile(handle, lockPath);
      abortSignal?.throwIfAborted();
      return await operation();
    } finally {
      if (locked) releaseLock(handle);
      await handle.close();
    }
  } finally {
    releaseGate();
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
    throw new Error(`Artifact writer bootstrap lock is not one stable file: ${lockPath}`);
  }
}

function releaseLock(handle: FileHandle): void {
  try {
    unlock(handle.fd);
  } catch {
    // Closing the OS handle is the authoritative release path.
  }
}
