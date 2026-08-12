import { useRef } from 'react';
import type { SessionEventStreamSnapshot } from '@maka/core/session-event-health';
import { confirmLiveTurn, type InteractionQueues, type LiveTurnProjection } from '@maka/ui';
import type { ShellRunUpdatesBySession } from './shell-run-update-state.js';

type StateUpdater<T> = (updater: (current: T) => T) => void;

export interface AppShellSessionUiState {
  messageLoadErrorBySession: Record<string, string>;
  messageRetryPendingBySession: Record<string, boolean>;
  stopPendingBySession: Record<string, boolean>;
  liveTurnBySession: Record<string, LiveTurnProjection>;
  shellRunUpdatesBySession: ShellRunUpdatesBySession;
  interactionBySession: InteractionQueues;
  pendingPermissionModeBySession: Record<string, boolean>;
  pendingSessionModelBySession: Record<string, boolean>;
}

type AppShellSessionUiStateMapKey = keyof AppShellSessionUiState;

const SESSION_UI_MAP_KEYS = [
  'messageLoadErrorBySession',
  'messageRetryPendingBySession',
  'stopPendingBySession',
  'liveTurnBySession',
  'shellRunUpdatesBySession',
  'interactionBySession',
  'pendingPermissionModeBySession',
  'pendingSessionModelBySession',
] as const satisfies readonly AppShellSessionUiStateMapKey[];

type MissingSessionUiMapKey = Exclude<AppShellSessionUiStateMapKey, typeof SESSION_UI_MAP_KEYS[number]>;
const allSessionUiMapsAreListed: Record<MissingSessionUiMapKey, never> = {};
void allSessionUiMapsAreListed;

// `useSettledSessionTransientReconcile` heals a session whose turn ended while
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
  let currentState = initialState;
  const liveTurnBySessionRef = { current: currentState.liveTurnBySession };
  // Written by the event-health probes and read back by them alone. Kept off
  // `currentState` so a probe never notifies a subscriber.
  const sessionEventHealthBySessionRef: { current: Record<string, SessionEventStreamSnapshot> } = {
    current: {},
  };
  const listeners = new Set<() => void>();

  function replaceState(next: AppShellSessionUiState): void {
    if (next === currentState) return;
    currentState = next;
    liveTurnBySessionRef.current = next.liveTurnBySession;
    // Synchronous, immediately after the swap. Never schedule this: the
    // terminal-turn handoff reads the state it announces (#1985).
    for (const listener of [...listeners]) listener();
  }

  /** Subscribe to state replacements. Stable identity, for `useSyncExternalStore`. */
  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function updateMap<K extends AppShellSessionUiStateMapKey>(
    key: K,
    updater: (current: AppShellSessionUiState[K]) => AppShellSessionUiState[K],
  ): void {
    const nextMap = updater(currentState[key]);
    const latestState = currentState;
    if (nextMap === latestState[key]) return;
    replaceState({ ...latestState, [key]: nextMap });
  }

  function createMapSetter<K extends AppShellSessionUiStateMapKey>(key: K): StateUpdater<AppShellSessionUiState[K]> {
    return (updater) => updateMap(key, updater);
  }

  return {
    getState: () => currentState,
    subscribe,
    liveTurnBySessionRef,
    sessionEventHealthBySessionRef,
    setMessageLoadErrorBySession: createMapSetter('messageLoadErrorBySession'),
    setMessageRetryPendingBySession: createMapSetter('messageRetryPendingBySession'),
    setStopPendingBySession: createMapSetter('stopPendingBySession'),
    setLiveTurnBySession: createMapSetter('liveTurnBySession'),
    setShellRunUpdatesBySession: createMapSetter('shellRunUpdatesBySession'),
    setInteractionBySession: createMapSetter('interactionBySession'),
    setSessionEventHealthBySession: ((updater) => {
      sessionEventHealthBySessionRef.current = updater(sessionEventHealthBySessionRef.current);
    }) satisfies StateUpdater<Record<string, SessionEventStreamSnapshot>>,
    setPendingPermissionModeBySession: createMapSetter('pendingPermissionModeBySession'),
    setPendingSessionModelBySession: createMapSetter('pendingSessionModelBySession'),
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
      replaceState(clearAppShellSessionUiStateForSession(currentState, sessionId));
    },
    clearAllSessionUiState: () => {
      sessionEventHealthBySessionRef.current = {};
      replaceState(createInitialAppShellSessionUiState());
    },
    clearTurnTransientState: (sessionId: string) => {
      replaceState(clearAppShellTurnTransientForSession(currentState, sessionId));
    },
  };
}

export type AppShellSessionUiStateController = ReturnType<typeof createAppShellSessionUiStateController>;

/**
 * Owns the controller for the component's lifetime. Deliberately does NOT
 * subscribe: readers select what they need through
 * `useAppShellSessionUiSelector`, so no single component re-renders for every
 * write to the store (#1985).
 */
export function useAppShellSessionUiState() {
  const controllerRef = useRef<AppShellSessionUiStateController | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = createAppShellSessionUiStateController();
  }

  const controller = controllerRef.current;

  return {
    controller,
    liveTurnBySessionRef: controller.liveTurnBySessionRef,
    sessionEventHealthBySessionRef: controller.sessionEventHealthBySessionRef,
    setMessageLoadErrorBySession: controller.setMessageLoadErrorBySession,
    setMessageRetryPendingBySession: controller.setMessageRetryPendingBySession,
    setStopPendingBySession: controller.setStopPendingBySession,
    setLiveTurnBySession: controller.setLiveTurnBySession,
    setShellRunUpdatesBySession: controller.setShellRunUpdatesBySession,
    setInteractionBySession: controller.setInteractionBySession,
    setSessionEventHealthBySession: controller.setSessionEventHealthBySession,
    setPendingPermissionModeBySession: controller.setPendingPermissionModeBySession,
    setPendingSessionModelBySession: controller.setPendingSessionModelBySession,
    confirmLiveTurn: controller.confirmLiveTurn,
    clearSessionUiState: controller.clearSessionUiState,
    clearAllSessionUiState: controller.clearAllSessionUiState,
    clearTurnTransientState: controller.clearTurnTransientState,
  };
}
