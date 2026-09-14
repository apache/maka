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

import { useEffect, useRef } from 'react';
import { createKeyedActionGuard, type KeyedActionGuard } from './action-guard.js';
import { createOneShotActionGuard, type OneShotActionGuard } from './oauth-login-flow-guard.js';

/**
 * Shared one-shot action guards for Settings async actions.
 *
 * Settings pages used to each hand-roll the same synchronous
 * `xRef.current` re-entrancy guard: check the ref, set it before the first
 * await, clear it in `finally`, and reset it from an unmount cleanup so a
 * StrictMode-remounted page is not stuck disabled. These hooks own that
 * machinery once, on top of the tested framework-free seams:
 *
 * - `useActionGuard` wraps `createOneShotActionGuard` (the seam behind
 *   `useOAuthLoginFlow`) for a component's single in-flight action; the
 *   held action label doubles as a staleness token (`guard.current === key`).
 * - `useKeyedActionGuard` wraps `createKeyedActionGuard` for components
 *   holding several independent latches at once (per-row action keys,
 *   mutually excluding sheet actions).
 *
 * Both release every hold on unmount, replacing the per-page
 * `xRef.current = false` cleanup effects.
 */
export function useActionGuard<Action>(): OneShotActionGuard<Action> {
  const guardRef = useRef<OneShotActionGuard<Action> | null>(null);
  if (guardRef.current === null) {
    guardRef.current = createOneShotActionGuard<Action>();
  }
  const guard = guardRef.current;

  useEffect(() => {
    return () => {
      guard.finish();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return guard;
}

export function useKeyedActionGuard<Key>(): KeyedActionGuard<Key> {
  const guardRef = useRef<KeyedActionGuard<Key> | null>(null);
  if (guardRef.current === null) {
    guardRef.current = createKeyedActionGuard<Key>();
  }
  const guard = guardRef.current;

  useEffect(() => {
    return () => {
      guard.reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return guard;
}
