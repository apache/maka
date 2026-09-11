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

import { mkdir, rm } from 'node:fs/promises';

const LOCK_POLL_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;

export async function withFileUpdateLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
  timeoutMs: number = LOCK_TIMEOUT_MS,
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `File update is locked by another process (${lockPath}). ` +
            'If no other process is using it, remove that directory and retry.',
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
