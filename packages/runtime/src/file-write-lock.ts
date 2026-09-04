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

// packages/runtime/src/file-write-lock.ts
// Compatibility adapter for callers that still request an exact file write
// lock directly. The queue is owned by processFilesystemLeases, so legacy
// writers conflict with the read/tree/write leases used by builtin tools.

import { processFilesystemLeases } from './filesystem-lease-coordinator.js';
import { hostFilesystemLeaseKey } from './filesystem-lease-key.js';

/**
 * Runs `fn` exclusively for `key`: it waits until any prior work for `key`
 * settles, then runs, then releases the key for the next waiter. Distinct keys
 * never block each other.
 *
 * `key` must be a canonical absolute host path. The adapter applies the same
 * Windows case fold as the filesystem owner before entering the shared queue.
 */
export function withFileWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return processFilesystemLeases.withLease(
    { key: hostFilesystemLeaseKey(key), mode: 'write', scope: 'exact' },
    undefined,
    fn,
  );
}
