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

import { useRef, useState } from 'react';

type RefBox<T> = { current: T };

/**
 * How long a turn-footer button stays disabled without a confirming
 * `sessions:changed` event. Long enough that the normal round trip wins the
 * race, short enough that a dropped event does not disable the button forever.
 */
const AUTO_CLEAR_MS = 5000;

/**
 * The in-flight keys behind the turn-footer buttons' disabled mask.
 *
 * A key is `${sessionId}:${turnId}:${actionId}`, claimed on click and released
 * when the Host confirms — so a second click while the first request settles is
 * ignored. `keys` drives the mask through the turn presentation derivation;
 * `keysRef` is the same content for synchronous reads.
 *
 * Deliberately concrete. This began as a generic registry with `trackState` and
 * `autoClearMs` options, serving these keys plus per-session permission-mode
 * and model changes. Those two moved to the session UI store, which already
 * held their rendered flag, and the options had no variation left: the timers
 * and the state mirror exist for the turn footer alone.
 */
export interface TurnActionRegistry {
  /** Reactive snapshot of the pending keys, for the disabled mask. */
  keys: Set<string>;
  /** Stable mirror of the pending keys for synchronous reads. */
  keysRef: RefBox<Set<string>>;
  /** Builds the namespaced identity consumed by every registry operation. */
  keyOf(sessionId: string, turnId: string, actionId: string): string;
  /**
   * Marks `key` pending and arms its auto-clear timer. Returns false (a no-op)
   * if it was already pending, so callers can bail on a duplicate action.
   */
  addKey(key: string): boolean;
  /** Clears a single pending key along with its timer and snapshot entry. */
  clearKey(key: string): void;
  /** Clears every pending key prefixed with `${sessionId}:` (session teardown). */
  clearForSession(sessionId: string): void;
  /** Clears every key and timer (unmount, or a Runtime Host generation change). */
  clearAll(): void;
}

export function useTurnActionRegistry(): TurnActionRegistry {
  const [keys, setKeys] = useState<Set<string>>(() => new Set());
  const keysRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const controllerRef = useRef<Omit<TurnActionRegistry, 'keys'> | null>(null);

  if (!controllerRef.current) {
    const keyOf = (sessionId: string, turnId: string, actionId: string): string =>
      `${sessionId}:${turnId}:${actionId}`;
    const syncState = (): void => {
      setKeys(new Set(keysRef.current));
    };
    const clearKey = (key: string): void => {
      if (!keysRef.current.has(key)) return;
      keysRef.current.delete(key);
      const timeoutHandle = timersRef.current.get(key);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timersRef.current.delete(key);
      syncState();
    };
    const addKey = (key: string): boolean => {
      if (keysRef.current.has(key)) return false;
      keysRef.current.add(key);
      syncState();
      timersRef.current.set(key, setTimeout(() => clearKey(key), AUTO_CLEAR_MS));
      return true;
    };
    const clearForSession = (sessionId: string): void => {
      const prefix = `${sessionId}:`;
      for (const key of Array.from(keysRef.current)) {
        if (key.startsWith(prefix)) clearKey(key);
      }
    };
    const clearAll = (): void => {
      for (const timeoutHandle of timersRef.current.values()) {
        clearTimeout(timeoutHandle);
      }
      timersRef.current.clear();
      keysRef.current.clear();
      syncState();
    };
    controllerRef.current = { keysRef, keyOf, addKey, clearKey, clearForSession, clearAll };
  }

  return { keys, ...controllerRef.current };
}
