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

import { open } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

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

export async function syncDirectoryChain(path: string, root: string): Promise<void> {
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
