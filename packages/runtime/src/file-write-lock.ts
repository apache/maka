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
// Serialize file-mutating tools (Write/Edit) per file. The AI SDK runs a single
// step's tool calls concurrently, so two edits to one file would race on the
// read-modify-write (read -> replace -> write back) and silently lose an update.
// withFileWriteLock(key, fn) runs work sharing a key strictly one-at-a-time, in
// submission order; distinct keys run concurrently. Callers pass a key that
// uniquely identifies the target file within their tool surface. Runtime tools
// key on the resolved absolute path. A failed task never wedges its key, and keys are reclaimed
// once their chain drains, so the map stays bounded.
//
// Keying is lexical, so one file reached under two names — via a symlinked parent
// dir, a hard link, or a case-insensitive filesystem ("a.txt" vs "A.txt") — takes
// two keys and is not merged. This matches opencode's lexical (path.resolve)
// per-file Semaphore. (Bash is not serialized either — a per-file lock cannot key
// arbitrary shell.)

const tails = new Map<string, Promise<void>>();

/** A prepared write owns the same queue across preparation, T1 and execution. */
export async function acquireFileWriteLock(key: string, signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => {
      release();
      reject(signal?.reason ?? new Error('Write preparation aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    if (signal?.aborted) abort();
    await Promise.race([previous, cancelled]);
    signal?.throwIfAborted();
    return release;
  } catch (error) {
    release();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Runs `fn` exclusively for `key`: it waits until any prior work for `key`
 * settles, then runs, then releases the key for the next waiter. Distinct keys
 * never block each other.
 *
 * @internal File tools own the keying, so an external caller would only share
 * this process-global queue by accident.
 */
export function withFileWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // Run fn after prev settles either way: a prior failed task must not wedge the
  // key. `prev.then(fn, fn)` ignores prev's outcome and just sequences.
  const run = prev.then(fn, fn);
  // The next waiter chains off `tail`, which tracks completion only (swallowing
  // result and error) so one task's rejection never propagates down the chain.
  const tail = run.then(
    () => {},
    () => {},
  );
  tails.set(key, tail);
  void tail.then(() => {
    // Drop the key once nobody chained after us, so the map stays bounded.
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
