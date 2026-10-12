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

import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tryAcquireFileLifetimeOwner } from '@maka/storage/file-lifetime-owner';

/** Native leases cover separate runtime instances and are released by the OS on exit. */
export async function withPluginScratchDirectory<T>(
  root: string,
  signal: AbortSignal,
  use: (directory: string) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const lease = await acquire(root, signal);
  const directory = join(root, 'workspace');
  try {
    signal.throwIfAborted();
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { mode: 0o700 });
    const state = await lstat(directory);
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error('Plugin scratch cwd is not a directory');
    signal.throwIfAborted();
    return await use(await realpath(directory));
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } finally {
      await lease.close();
    }
  }
}

async function acquire(root: string, signal: AbortSignal) {
  while (true) {
    signal.throwIfAborted();
    const lease = await tryAcquireFileLifetimeOwner(join(root, 'owner.lease'));
    if (lease) return lease;
    await delay(25, undefined, { signal });
  }
}
