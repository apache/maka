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

import { useEffect, useRef, useState } from 'react';

/**
 * Rising-edge delay before the transcript's running-status line appears (#646).
 * The line stays up for the whole active turn, so the flag is keyed off the turn
 * being active; the delay keeps a fast turn from flashing it. Lives here — a
 * feature-importable package — so the main conversation (`use-shell-live-turn`)
 * and the side-conversation panel share ONE delay and ONE `useDelayedFlag`
 * rather than the renderer-legacy original the architecture gate walls features
 * off from (which forced a drifting feature-local copy).
 */
export const RUNNING_STATUS_DELAY_MS = 200;

export interface DelayedFlagScheduler {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DelayedFlag {
  /** Feed the current condition; drives the flag through the delay. */
  setCondition(active: boolean): void;
  /** Current visible flag. */
  get(): boolean;
  /** Cancel any pending timer (unmount / teardown). */
  dispose(): void;
}

/**
 * A rising-edge–delayed boolean. The flag turns true only after the condition
 * stays true for `delayMs`; if the condition drops before the delay elapses the
 * flag never turns true (the fast-response no-flash rule). Falling to false is
 * immediate. The scheduler is injected so the timing is testable with fake
 * timers instead of a real 200ms wall-clock wait.
 */
export function createDelayedFlag(opts: {
  delayMs: number;
  scheduler: DelayedFlagScheduler;
  onChange?: (visible: boolean) => void;
}): DelayedFlag {
  const { delayMs, scheduler, onChange } = opts;
  let condition = false;
  let visible = false;
  let timer: unknown = null;

  function clearTimer(): void {
    if (timer !== null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
  }

  function emit(next: boolean): void {
    if (next === visible) return;
    visible = next;
    onChange?.(visible);
  }

  return {
    setCondition(active: boolean): void {
      if (active === condition) return;
      condition = active;
      if (active) {
        // Rising edge: arm once. Already-visible (re-entrant true) keeps state.
        if (!visible && timer === null) {
          timer = scheduler.setTimeout(() => {
            timer = null;
            emit(true);
          }, delayMs);
        }
      } else {
        // Falling edge: cancel a pending reveal and hide immediately.
        clearTimer();
        emit(false);
      }
    },
    get(): boolean {
      return visible;
    },
    dispose(): void {
      clearTimer();
    },
  };
}

/**
 * React binding for `createDelayedFlag` (#646): a boolean that turns true only
 * after `condition` has held true for `delayMs`, and false immediately when it
 * drops. The timing/arm/cancel logic lives in the pure `createDelayedFlag` (unit
 * tested with fake timers); this hook only wires it to `window` timers + a
 * re-render. `delayMs` is read once at mount — it is a constant in practice.
 */
export function useDelayedFlag(condition: boolean, delayMs: number): boolean {
  const [visible, setVisible] = useState(false);
  const flagRef = useRef<DelayedFlag | null>(null);
  if (flagRef.current === null) {
    flagRef.current = createDelayedFlag({
      delayMs,
      scheduler: {
        setTimeout: (handler, ms) => window.setTimeout(handler, ms),
        clearTimeout: (handle) => window.clearTimeout(handle as number),
      },
      onChange: setVisible,
    });
  }
  useEffect(() => {
    flagRef.current?.setCondition(condition);
  }, [condition]);
  useEffect(() => () => flagRef.current?.dispose(), []);
  return visible;
}
