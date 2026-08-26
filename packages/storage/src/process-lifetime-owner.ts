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
import { chmod, lstat, mkdir, readdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import {
  openStableNativeLockFile,
  releaseNativeFileLock,
  tryAcquireNativeFileLock,
  unlinkStableNativeLockFile,
} from './native-file-lock.js';

const OWNER_REFERENCE_PREFIX = 'lock-v1:';
const OWNER_REFERENCE_PATTERN =
  /^lock-v1:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const OWNER_FILE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.lease$/;

export interface ProcessLifetimeRecoveryClaim {
  retire(): Promise<void>;
  close(): Promise<void>;
}

export interface ProcessLifetimeOwner {
  readonly reference: string;
  tryClaimReleased(reference: string): Promise<ProcessLifetimeRecoveryClaim | undefined>;
  retireUnreferencedReleasedOwners(referenced: ReadonlySet<string>): Promise<void>;
  close(): Promise<void>;
}

export async function acquireProcessLifetimeOwner(root: string): Promise<ProcessLifetimeOwner> {
  const ownersRoot = join(root, 'owners');
  await mkdir(ownersRoot, { recursive: true, mode: 0o700 });
  const ownersRootStat = await lstat(ownersRoot);
  if (!ownersRootStat.isDirectory() || ownersRootStat.isSymbolicLink()) {
    throw new Error(`Process lifetime owner root is not a directory: ${ownersRoot}`);
  }
  if (process.platform !== 'win32') await chmod(ownersRoot, 0o700);

  const reference = `${OWNER_REFERENCE_PREFIX}${randomUUID()}`;
  const path = ownerPath(ownersRoot, reference);
  const handle = await openStableNativeLockFile(path);
  if (!tryAcquireNativeFileLock(handle)) {
    await handle.close();
    throw new Error(`New process lifetime owner reference is already active: ${reference}`);
  }
  return new ProcessLifetimeOwnerImpl(ownersRoot, reference, path, handle);
}

export function isProcessLifetimeOwnerReference(reference: string): boolean {
  return OWNER_REFERENCE_PATTERN.test(reference);
}

class ProcessLifetimeOwnerImpl implements ProcessLifetimeOwner {
  #closed = false;

  constructor(
    private readonly ownersRoot: string,
    readonly reference: string,
    private readonly path: string,
    private readonly handle: FileHandle,
  ) {}

  async tryClaimReleased(reference: string): Promise<ProcessLifetimeRecoveryClaim | undefined> {
    if (this.#closed) throw new Error('Process lifetime owner is closed');
    if (reference === this.reference) return undefined;
    const path = ownerPath(this.ownersRoot, reference);
    const handle = await openStableNativeLockFile(path);
    if (!tryAcquireNativeFileLock(handle)) {
      await handle.close();
      return undefined;
    }
    return new ProcessLifetimeRecoveryClaimImpl(path, handle);
  }

  async retireUnreferencedReleasedOwners(referenced: ReadonlySet<string>): Promise<void> {
    for (const entry of await readdir(this.ownersRoot, { withFileTypes: true })) {
      const match = OWNER_FILE_PATTERN.exec(entry.name);
      if (!match) continue;
      const reference = `${OWNER_REFERENCE_PREFIX}${match[1]}`;
      if (referenced.has(reference)) continue;
      const claim = await this.tryClaimReleased(reference);
      if (claim) await claim.retire();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      // Removing the name while the old inode is still locked prevents a gap
      // where two recovery claimants could lock two generations of the path.
      await unlinkStableNativeLockFile(this.handle, this.path);
    } finally {
      releaseNativeFileLock(this.handle);
      await this.handle.close();
    }
  }
}

class ProcessLifetimeRecoveryClaimImpl implements ProcessLifetimeRecoveryClaim {
  #closed = false;

  constructor(
    private readonly path: string,
    private readonly handle: FileHandle,
  ) {}

  async retire(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await unlinkStableNativeLockFile(this.handle, this.path);
    } finally {
      releaseNativeFileLock(this.handle);
      await this.handle.close();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    releaseNativeFileLock(this.handle);
    await this.handle.close();
  }
}

function ownerPath(ownersRoot: string, reference: string): string {
  const match = OWNER_REFERENCE_PATTERN.exec(reference);
  if (!match) throw new Error(`Invalid process lifetime owner reference: ${reference}`);
  return join(ownersRoot, `${match[1]}.lease`);
}
