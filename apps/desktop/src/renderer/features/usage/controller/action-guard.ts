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

// Feature-local copy of the settings one-shot action guard (#4425): a
// synchronous single-latch re-entrancy guard for the usage refresh action, kept
// React-free at its core so the check happens before React can re-render.

export interface OneShotActionGuard<Action> {
  /** Acquire the latch for `action`; false when one is already in flight. */
  begin(action: Action): boolean;
  /** Release the latch. */
  finish(): void;
  readonly current: Action | null;
}

export function createOneShotActionGuard<Action>(): OneShotActionGuard<Action> {
  let current: Action | null = null;
  return {
    begin(action: Action): boolean {
      if (current !== null) return false;
      current = action;
      return true;
    },
    finish(): void {
      current = null;
    },
    get current(): Action | null {
      return current;
    },
  };
}

/** React shell that owns one guard for the component's lifetime and releases it
 *  on unmount (so a StrictMode remount is never stuck latched). */
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
