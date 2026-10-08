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

// Framework-free keyed one-shot action guard: the multi-latch sibling of
// oauth-login-flow-guard.ts's createOneShotActionGuard for components that
// hold several independent action latches at once (the connection detail
// sheet's six mutually excluding actions and the memory controller's per-row
// action keys). Kept React-free so its behavior is
// unit-testable without a DOM (see action-guard.test.ts) and so the desktop
// test runner can import it without pulling React into its program.
//
// The check stays synchronous — a second concurrent action is rejected before
// React can re-render the disabled button, never subject to render batching.
export interface KeyedActionGuard<Key> {
  /** Acquire `key`; returns its release function, or null when already held. */
  begin(key: Key): (() => void) | null;
  /** Acquire `key` only while no action is in flight; otherwise null. */
  beginExclusive(key: Key): (() => void) | null;
  has(key: Key): boolean;
  /** Count of in-flight actions, for cross-action exclusion checks. */
  readonly size: number;
  /** Drop every hold (teardown). In-flight releases stay safe: see below. */
  reset(): void;
}

export function createKeyedActionGuard<Key>(): KeyedActionGuard<Key> {
  // key -> owner token. The release closure only drops its own token, so a
  // late release settling after reset() + a newer acquire of the same key
  // cannot strip the newer action's hold after a StrictMode remount. Tokens
  // are monotonic for the guard's lifetime, never
  // reused after reset.
  const owners = new Map<Key, number>();
  let sequence = 0;

  function acquire(key: Key): () => void {
    const owner = ++sequence;
    owners.set(key, owner);
    return () => {
      if (owners.get(key) === owner) owners.delete(key);
    };
  }

  return {
    begin(key: Key): (() => void) | null {
      if (owners.has(key)) return null;
      return acquire(key);
    },
    beginExclusive(key: Key): (() => void) | null {
      if (owners.size > 0) return null;
      return acquire(key);
    },
    has(key: Key): boolean {
      return owners.has(key);
    },
    get size(): number {
      return owners.size;
    },
    reset(): void {
      owners.clear();
    },
  };
}
