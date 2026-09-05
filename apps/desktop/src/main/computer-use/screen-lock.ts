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

import { createRequire } from 'node:module';
import type { CuOverlayHook } from '@maka/runtime/computer-use-types';

// Electron is CommonJS, and named imports from it fail outside a main process.
// Deferring the require keeps this module loadable under plain `node --test`,
// where both Electron touchpoints are injected instead.
const electron = (): typeof import('electron') =>
  createRequire(import.meta.url)('electron') as typeof import('electron');

/**
 * Whether the machine is locked, for the Computer Use dispatch guard.
 *
 * A locked screen is the user saying they have left. Every dispatch after that
 * point runs unattended on a machine its owner deliberately closed off, with
 * nobody watching what the agent does and no way to intervene. Codex treats
 * operating a locked machine as a capability of its own — a separate guardian
 * process holding per-thread auto-unlock leases behind a privacy curtain, and
 * an enterprise policy key (`allow_locked_computer_use`) to switch the whole
 * thing off. Maka has none of that machinery, so it refuses instead.
 *
 * macOS exposes two independent signals and each one has a hole:
 *
 *   - the `lock-screen` / `unlock-screen` events are exact about transitions
 *     but say nothing about the state at startup, so a process that launches
 *     while the screen is already locked never hears the lock happen.
 *   - `getSystemIdleState` can be asked at any moment, but it reads the login
 *     session dictionary, which has known blind spots (the Codex CUA Lab's own
 *     `screenIsLocked()` misses a locked screen while loginwindow is frontmost).
 *
 * So this takes the union, with one rule that keeps it from wedging: an
 * authoritative "not locked" clears the latch the events set. A platform that
 * delivered `lock-screen` and then somehow never delivered `unlock-screen`
 * would otherwise disable Computer Use until the app restarted.
 */
export interface ScreenLockMonitor {
  locked(): boolean;
  dispose(): void;
}

export type ScreenIdleState = 'active' | 'idle' | 'locked' | 'unknown';

export interface ScreenLockMonitorDeps {
  /**
   * Subscribe to lock/unlock transitions. Returns its own teardown.
   * Injected in tests; defaults to Electron's `powerMonitor`.
   */
  subscribe?: (handlers: { onLock: () => void; onUnlock: () => void }) => () => void;
  /**
   * Point-in-time query. Returning `undefined` or `'unknown'` means the
   * platform cannot answer, and the event latch decides instead.
   */
  probe?: () => ScreenIdleState | undefined;
  /** Transition callbacks, for callers that need to act at the moment it happens. */
  onLock?: () => void;
  onUnlock?: () => void;
}

function defaultSubscribe(handlers: { onLock: () => void; onUnlock: () => void }): () => void {
  const monitor = electron().powerMonitor;
  monitor.on('lock-screen', handlers.onLock);
  monitor.on('unlock-screen', handlers.onUnlock);
  return () => {
    monitor.off('lock-screen', handlers.onLock);
    monitor.off('unlock-screen', handlers.onUnlock);
  };
}

function defaultProbe(): ScreenIdleState | undefined {
  try {
    // The threshold only separates 'active' from 'idle', neither of which this
    // guard cares about; 'locked' is reported regardless of what is passed.
    return electron().powerMonitor.getSystemIdleState(1);
  } catch {
    return undefined;
  }
}

export function createScreenLockMonitor(deps: ScreenLockMonitorDeps = {}): ScreenLockMonitor {
  const probe = deps.probe ?? defaultProbe;
  const subscribe = deps.subscribe ?? defaultSubscribe;
  let latched = false;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;

  // Subscribing is deferred, not eager: tool assembly runs at module load,
  // which is before `app.whenReady()`, and `powerMonitor` is documented as
  // unusable until then. The first `locked()` call happens on the first
  // dispatch, which is necessarily before any session can need releasing, and
  // a lock that happened before it is caught by the query rather than missed.
  function ensureSubscribed(): void {
    if (disposed || unsubscribe) return;
    try {
      unsubscribe = subscribe({
        onLock: () => {
          latched = true;
          deps.onLock?.();
        },
        onUnlock: () => {
          latched = false;
          deps.onUnlock?.();
        },
      });
    } catch {
      // Nothing to subscribe to on this platform. The query still answers, and
      // if it cannot either, the guard reports unlocked rather than refusing
      // every action forever on a machine that has no lock screen at all.
    }
  }

  return {
    locked(): boolean {
      if (disposed) return false;
      ensureSubscribed();
      let state: ScreenIdleState | undefined;
      try {
        state = probe();
      } catch {
        // A probe that throws is not an answer. Fall through to the latch,
        // which is the same fail-closed rule the dispatch guard applies.
        return latched;
      }
      if (state === 'locked') return true;
      if (state === undefined || state === 'unknown') return latched;
      latched = false;
      return false;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

/**
 * The session-facing half of the guard.
 *
 * Refusing a dispatch is only half of it. `applyTypedOutcomeState` turns a
 * `screen_locked` outcome into the session state of the same name, which also
 * blocks observation — reading a machine's screen into a transcript while its
 * owner has locked it and left is the same line the refusal draws, and Codex
 * draws it with a privacy curtain.
 *
 * But that state has exactly one way out, `screenUnlocked()`, and until now
 * nothing in the app ever called it: the state machine, the block reason and
 * the error code were all in place with no producer on either side. A session
 * that hit a lock would have stayed locked for the rest of its life. This is
 * the producer for both halves.
 */
export interface ComputerUseScreenLockGuard {
  /** The dispatch probe handed to the backend. */
  locked(): boolean;
  /** This session drove the machine, so it is one to release on unlock. */
  noteSessionActive(sessionId: string): void;
  clearForSession(sessionId: string): void;
  /**
   * Install the release path.
   *
   * Late-bound for the same reason the status item's stop handler is: the tool
   * set that owns these events is built around the overlay hook this guard
   * feeds, so it does not exist yet when the guard is constructed.
   */
  setSessionEvents(events: { screenUnlocked(sessionId: string): void }): void;
  dispose(): void;
}

export function createComputerUseScreenLockGuard(
  deps: ScreenLockMonitorDeps = {},
): ComputerUseScreenLockGuard {
  const sessions = new Set<string>();
  let sessionEvents: { screenUnlocked(sessionId: string): void } | undefined;
  const monitor = createScreenLockMonitor({
    ...deps,
    onUnlock: () => {
      deps.onUnlock?.();
      // `screenUnlocked()` moves a locked session to `reobserve_required`, not
      // straight back to active: whatever the agent last saw is from before the
      // machine was locked, and the screen it comes back to is not that one.
      for (const sessionId of sessions) sessionEvents?.screenUnlocked(sessionId);
    },
  });

  return {
    locked: () => monitor.locked(),
    noteSessionActive(sessionId: string): void {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;
      sessions.add(sessionId);
    },
    clearForSession(sessionId: string): void {
      sessions.delete(sessionId);
    },
    setSessionEvents(events): void {
      sessionEvents = events;
    },
    dispose(): void {
      sessions.clear();
      monitor.dispose();
    },
  };
}

/**
 * Register sessions from the same hook that drives the cursor and status item.
 *
 * This comment used to say a session earned a release by having tried to drive
 * the machine, "including the attempt that was refused, since `onActionBegin`
 * runs before the backend sees the action". That is not what happens, and a
 * probe against the built runtime says so plainly: with `screenLocked` forced
 * true, three calls came back `maka_computer failed: screen_locked`, the probe
 * saw the session three times, and `onActionBegin` saw nothing at all.
 * `onActionBegin` has one call site, inside `runWithPresentation`, and the
 * refusal returns several hundred lines above it.
 *
 * The refused attempt is covered — by the `screenLocked` callback in tool
 * assembly, which records the session as it answers. What this wrapper covers
 * is the other producer, and it is the only thing that does: the host's own
 * lock probe has documented blind spots, so a dispatch can go through and come
 * back with a `screen_locked` outcome from the executor. That path latches the
 * session state from `applyTypedOutcomeState`, long after the probe said the
 * machine was fine and long after `onActionBegin` ran. Nothing else would ever
 * have recorded that session, and `screenUnlocked` is the only way out of the
 * state it just entered.
 *
 * So the two producers divide cleanly: the probe covers what it refuses, this
 * covers what the executor refuses. Registration is per dispatch attempt and
 * cheap; the set is emptied by `clearForSession`, which every path that ends a
 * session calls — including a turn merely finishing, which for a while it did
 * not.
 */
export function withComputerUseScreenLock(
  hook: CuOverlayHook,
  guard: Pick<ComputerUseScreenLockGuard, 'noteSessionActive'>,
): CuOverlayHook {
  return {
    onActionBegin(action, context) {
      guard.noteSessionActive(context.sessionId);
      return hook.onActionBegin(action, context);
    },
    onActionEnd(action, result, context) {
      return hook.onActionEnd?.(action, result, context);
    },
  };
}
