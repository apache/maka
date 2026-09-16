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

import { chmod, lstat, mkdir, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  openStableNativeLockFile,
  releaseNativeFileLock,
  tryAcquireNativeFileLock,
} from './native-file-lock.js';

export interface FileLifetimeOwner {
  close(): Promise<void>;
}

export async function acquireFileLifetimeOwner(path: string): Promise<FileLifetimeOwner> {
  const owner = await tryAcquireOpenedFileLifetimeOwner(path);
  if (!owner) throw new Error(`Another process owns ${path}`);
  return owner;
}

/** Try once to own one named file for the lifetime of this process handle. */
export async function tryAcquireFileLifetimeOwner(
  path: string,
): Promise<FileLifetimeOwner | undefined> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`File lifetime owner root is not a directory: ${directory}`);
  }
  if (process.platform !== 'win32') await chmod(directory, 0o700);

  return tryAcquireOpenedFileLifetimeOwner(path);
}

async function tryAcquireOpenedFileLifetimeOwner(
  path: string,
): Promise<FileLifetimeOwner | undefined> {
  const handle = await openStableNativeLockFile(path);
  let acquired: boolean;
  try {
    acquired = tryAcquireNativeFileLock(handle);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  if (!acquired) {
    await handle.close();
    return undefined;
  }
  return new FileLifetimeOwnerImpl(handle);
}

class FileLifetimeOwnerImpl implements FileLifetimeOwner {
  #closeTask: Promise<void> | undefined;

  constructor(private readonly handle: FileHandle) {}

  close(): Promise<void> {
    this.#closeTask ??= this.#close();
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    releaseNativeFileLock(this.handle);
    await this.handle.close();
  }
}
