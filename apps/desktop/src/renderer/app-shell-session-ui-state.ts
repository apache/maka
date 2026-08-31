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

import { useRef } from 'react';
import type { MessageQueueEntryProjection } from '@maka/core/events';
import type { SessionEventStreamSnapshot } from '@maka/core/session-event-health';
import { confirmLiveTurn, type InteractionQueues, type LiveTurnProjection } from '@maka/ui';
import { createObservableState } from './observable-state.js';
import type { ShellRunUpdatesBySession } from './shell-run-update-state.js';

type StateUpdater<T> = (updater: (current: T) => T) => void;

export interface AppShellSessionUiState {
  messageLoadErrorBySession: Record<string, string>;
  messageRetryPendingBySession: Record<string, boolean>;
  stopPendingBySession: Record<string, boolean>;
  liveTurnBySession: Record<string, LiveTurnProjection>;
  shellRunUpdatesBySession: ShellRunUpdatesBySession;
  interactionBySession: InteractionQueues;
  messageQueueBySession: Record<string, MessageQueueUiState>;
  pendingPermissionModeBySession: Record<string, boolean>;
  pendingSessionModelBySession: Record<string, boolean>;
}

// The pending plate keeps the Host revision beside its entries so edits can
// reject stale multi-client projections instead of silently overwriting them.
export interface MessageQueueUiState {
  readonly queueRevision?: number;
  readonly entries: readonly MessageQueueEntryProjection[];
}

type AppShellSessionUiStateMapKey = keyof AppShellSessionUiState;

/** The maps that record nothing but "an action is in flight for this key". */
type BooleanMapKey =
  | 'messageRetryPendingBySession'
  | 'stopPendingBySession'
  | 'pendingPermissionModeBySession'
  | 'pendingSessionModelBySession';

export interface SessionPendingClaim {
  /** Marks `key` in flight. Returns false — a no-op — if it already was. */
  claim(key: string): boolean;
  /** Gives the claim back. Safe to call for a key that never held one. */
  release(key: string): void;
}

const SESSION_UI_MAP_KEYS = [
  'messageLoadErrorBySession',
  'messageRetryPendingBySession',
  'stopPendingBySession',
  'liveTurnBySession',
  'shellRunUpdatesBySession',
  'interactionBySession',
  'messageQueueBySession',
  'pendingPermissionModeBySession',
  'pendingSessionModelBySession',
] as const satisfies readonly AppShellSessionUiStateMapKey[];

type MissingSessionUiMapKey = Exclude<AppShellSessionUiStateMapKey, typeof SESSION_UI_MAP_KEYS[number]>;
const allSessionUiMapsAreListed: Record<MissingSessionUiMapKey, never> = {};
void allSessionUiMapsAreListed;

// An authoritative session-list refresh heals a session whose turn ended while
// its SessionEvent stream wasn't being followed, and must drop only the live
// projection. The independently-scoped maps (message load error / retry, pending
// permission-mode / model toggles, the permission queue, stop-pending) each have
// their own lifecycle and must survive a mere turn settle — a full
// `clearAppShellSessionUiStateForSession` (session deletion) would wipe them too.
// Event-stream health is scoped the same way but lives outside this state; see
// `sessionEventHealthBySessionRef`.
const TURN_TRANSIENT_MAP_KEYS = [
  'liveTurnBySession',
] as const satisfies readonly AppShellSessionUiStateMapKey[];

export function createInitialAppShellSessionUiState(): AppShellSessionUiState {
  return Object.fromEntries(SESSION_UI_MAP_KEYS.map((key) => [key, {}])) as unknown as AppShellSessionUiState;
}

function omitSessionKey<T extends Record<string, unknown>>(current: T, sessionId: string): T {
  if (!(sessionId in current)) return current;
  const next = { ...current };
  delete (next as Record<string, unknown>)[sessionId];
  return next;
}

function updateAppShellSessionUiStateMap<K extends AppShellSessionUiStateMapKey>(
  state: AppShellSessionUiState,
  key: K,
  updater: (current: AppShellSessionUiState[K]) => AppShellSessionUiState[K],
): AppShellSessionUiState {
  const current = state[key];
  const next = updater(current);
  if (next === current) return state;
  return { ...state, [key]: next };
}

function clearSessionUiStateMap<K extends AppShellSessionUiStateMapKey>(
  state: AppShellSessionUiState,
  key: K,
  sessionId: string,
): AppShellSessionUiState {
  return updateAppShellSessionUiStateMap(state, key, (current) => omitSessionKey(current, sessionId));
}

export function clearAppShellSessionUiStateForSession(
  state: AppShellSessionUiState,
  sessionId: string,
): AppShellSessionUiState {
  let nextState = state;
  for (const key of SESSION_UI_MAP_KEYS) {
    nextState = clearSessionUiStateMap(nextState, key, sessionId);
  }
  return nextState;
}

export function clearAppShellTurnTransientForSession(
  state: AppShellSessionUiState,
  sessionId: string,
): AppShellSessionUiState {
  let nextState = state;
  for (const key of TURN_TRANSIENT_MAP_KEYS) {
    nextState = clearSessionUiStateMap(nextState, key, sessionId);
  }
  return nextState;
}

export function createAppShellSessionUiStateController(
  initialState: AppShellSessionUiState = createInitialAppShellSessionUiState(),
) {
  const state = createObservableState(initialState);
  const liveTurnBySessionRef = { current: initialState.liveTurnBySession };
  // Written by the event-health probes and read back by them alone. Kept off
  // the observed state so a probe never notifies a subscriber.
  const sessionEventHealthBySessionRef: { current: Record<string, SessionEventStreamSnapshot> } = {
    current: {},
  };

  // The ref mirrors whatever is about to become current, so it is already
  // correct when the synchronous notification reaches a listener that reads it.
  function replaceState(next: AppShellSessionUiState): void {
    liveTurnBySessionRef.current = next.liveTurnBySession;
    state.replaceState(next);
  }

  function updateMap<K extends AppShellSessionUiStateMapKey>(
    key: K,
    updater: (current: AppShellSessionUiState[K]) => AppShellSessionUiState[K],
  ): void {
    const latestState = state.getState();
    const nextMap = updater(latestState[key]);
    if (nextMap === latestState[key]) return;
    replaceState({ ...latestState, [key]: nextMap });
  }

  function createMapSetter<K extends AppShellSessionUiStateMapKey>(key: K): StateUpdater<AppShellSessionUiState[K]> {
    return (updater) => updateMap(key, updater);
  }

  /**
   * The in-flight claim on one of the pending maps: `claim` marks a key and
   * reports whether it won, `release` gives it back.
   *
   * Both read and write the same map, which is what makes this the only
   * representation of "an action is in flight". Each of these four used to be a
   * `Set` ref for the duplicate guard beside a map for the rendered flag,
   * synchronized by hand at every add and every `finally`, and cleared by two
   * separate teardown paths that stayed aligned only by ordering. Nothing
   * needed the ref: state replacement is synchronous, so a claim is visible to
   * the next `getState()` in the same task.
   */
  function createPendingClaim(key: BooleanMapKey): SessionPendingClaim {
    return {
      claim(claimKey: string): boolean {
        if (state.getState()[key][claimKey] === true) return false;
        updateMap(key, (current) => ({ ...current, [claimKey]: true }));
        return true;
      },
      release(claimKey: string): void {
        updateMap(key, (current) => omitSessionKey(current, claimKey));
      },
    };
  }

  return {
    getState: state.getState,
    subscribe: state.subscribe,
    liveTurnBySessionRef,
    sessionEventHealthBySessionRef,
    setMessageLoadErrorBySession: createMapSetter('messageLoadErrorBySession'),
    messageRetryPending: createPendingClaim('messageRetryPendingBySession'),
    stopPending: createPendingClaim('stopPendingBySession'),
    permissionModePending: createPendingClaim('pendingPermissionModeBySession'),
    sessionModelPending: createPendingClaim('pendingSessionModelBySession'),
    setLiveTurnBySession: createMapSetter('liveTurnBySession'),
    setShellRunUpdatesBySession: createMapSetter('shellRunUpdatesBySession'),
    setInteractionBySession: createMapSetter('interactionBySession'),
    setMessageQueueBySession: createMapSetter('messageQueueBySession'),
    setSessionEventHealthBySession: ((updater) => {
      sessionEventHealthBySessionRef.current = updater(sessionEventHealthBySessionRef.current);
    }) satisfies StateUpdater<Record<string, SessionEventStreamSnapshot>>,
    /**
     * The authority said something about `turnId` — it started, failed to
     * start, or ended. Drop that arm's `unconfirmed` claim so a session list
     * may settle it again. An answer about a turn this session is not on says
     * nothing, and leaves the state untouched.
     */
    confirmLiveTurn: (sessionId: string, turnId: string) => {
      updateMap('liveTurnBySession', (current) => {
        const armed = current[sessionId];
        if (!armed) return current;
        const confirmed = confirmLiveTurn(armed, turnId);
        return confirmed === armed ? current : { ...current, [sessionId]: confirmed! };
      });
    },
    clearSessionUiState: (sessionId: string) => {
      sessionEventHealthBySessionRef.current = omitSessionKey(
        sessionEventHealthBySessionRef.current,
        sessionId,
      );
      replaceState(clearAppShellSessionUiStateForSession(state.getState(), sessionId));
    },
    clearTurnTransientStateIfCurrent: (
      sessionId: string,
      expected: LiveTurnProjection | undefined,
    ) => {
      const current = state.getState();
      if (current.liveTurnBySession[sessionId] !== expected) return;
      replaceState(clearAppShellTurnTransientForSession(current, sessionId));
    },
  };
}

export type AppShellSessionUiStateController = ReturnType<typeof createAppShellSessionUiStateController>;

/**
 * Owns the controller for the component's lifetime. Deliberately does NOT
 * subscribe: readers select what they need through
 * `useExternalStoreSelector`, so no single component re-renders for every
 * write to the store (#1985).
 *
 * Returns the controller itself rather than a bag of its members. The bag had
 * to name every setter, so did the workspace hook above it, and so did
 * AppShell's destructure — three places to edit for one new map, and three
 * chances for them to disagree about what the store offers.
 */
export function useAppShellSessionUiState(): AppShellSessionUiStateController {
  const controllerRef = useRef<AppShellSessionUiStateController | null>(null);
  controllerRef.current ??= createAppShellSessionUiStateController();
  return controllerRef.current;
}
