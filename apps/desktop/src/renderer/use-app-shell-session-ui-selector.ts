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

import { useMemo, useSyncExternalStore } from 'react';
import type { AppShellSessionUiState, AppShellSessionUiStateController } from './app-shell-session-ui-state.js';

/**
 * Subscribe to one derived reading of session UI state (#1985).
 *
 * The controller is a single external store whose maps change at very different
 * rates — `liveTurnBySession` moves once per streamed token, the rest at human
 * speed. A component re-renders only when the value IT selects changes, so the
 * chat transcript can follow every delta while the shell around it stays still.
 *
 * `select` must be a stable (module-level) function, and whatever it varies by
 * — a session id, say — is passed as `arg` rather than captured. That is what
 * lets the snapshot be memoized instead of published through a render-phase ref
 * write, which React permits only for lazy initialization: a discarded
 * concurrent render would otherwise hand its selector to the committed
 * subscription. Changing `arg` rebuilds the cache, so the first render after
 * switching sessions already reads the new one.
 *
 * The cache is keyed by the STATE the value was derived from, because
 * `useSyncExternalStore` reads a snapshot several times per store state and
 * demands the same value each time. A selector that derives a fresh object
 * would otherwise loop, so keying it here is what makes `isEqual` a plain
 * fewer-renders optimization: it carries a value's identity ACROSS a state the
 * selection did not actually change.
 */
export function useAppShellSessionUiSelector<T, A = undefined>(
  controller: AppShellSessionUiStateController,
  select: (state: AppShellSessionUiState, arg: A) => T,
  arg?: A,
  isEqual?: (a: T, b: T) => boolean,
): T {
  const getSnapshot = useMemo(() => {
    let cache: { state: AppShellSessionUiState; value: T } | null = null;
    return (): T => {
      const state = controller.getState();
      if (cache && cache.state === state) return cache.value;
      const next = select(state, arg as A);
      const value = cache && (Object.is(cache.value, next) || isEqual?.(cache.value, next) === true)
        ? cache.value
        : next;
      cache = { state, value };
      return value;
    };
  }, [controller, select, arg, isEqual]);

  return useSyncExternalStore(controller.subscribe, getSnapshot, getSnapshot);
}
