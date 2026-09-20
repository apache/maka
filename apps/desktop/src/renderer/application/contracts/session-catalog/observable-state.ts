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

/**
 * The writable half of a renderer store: one state value, replaced whole.
 *
 * The renderer has three of these — `app-shell-session-ui-state`,
 * `session-catalog-state`, `session-rail-layout-store` — and they differ only
 * in what they hold and which commands they expose. What they must NOT differ
 * in is the notification rule below, which is load-bearing and was previously
 * restated once per store.
 *
 * Pair with `useExternalStoreSelector` to read one derived value from it.
 */
export function createObservableState<S>(initial: S) {
  let current = initial;
  const listeners = new Set<() => void>();

  return {
    getState: (): S => current,

    /** Subscribe to state replacements. Stable identity, for `useSyncExternalStore`. */
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * Swap the state and notify, synchronously and in that order. Never
     * schedule the notification: the terminal-turn handoff reads back the
     * state it announces, and a selection change is read back by the handler
     * that made it (#1985, #4109).
     *
     * A replacement with the same identity is not a change and notifies
     * nobody, which is what lets a store's commands be written as plain
     * `if (unchanged) return`.
     */
    replaceState(next: S): void {
      if (next === current) return;
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
