import { useRef, useState } from 'react';

type RefBox<T> = { current: T };

/**
 * Generic keyed-pending registry shared by AppShell's four hand-rolled
 * de-dup sets (turn-footer actions, session-row actions, per-session
 * permission-mode changes, per-session model changes). Each tracks a Set of
 * in-flight keys so a second click while the first request is still settling
 * is ignored, then clears the key when the backend confirms.
 *
 * The four instances differ only along two axes, both opt-in:
 *
 *   - `trackState` — the turn-footer registry drives a React-visible disabled
 *     mask (the turn presentation derivation reads `keys`), so it mirrors the ref
 *     into state on every mutation. The three ref-only registries pass their
 *     `keysRef` straight to their action factories / the bootstrap cleanup
 *     effect and never re-render, so they skip the state mirror entirely.
 *   - `autoClearMs` — the turn-footer registry arms a per-key timeout so a
 *     button re-enables even if the confirming `sessions:changed` event is
 *     dropped. The others clear synchronously in their action's `finally`.
 *
 * `keysRef` is always a stable Set instance so the action factories that
 * mutate it directly (session-row-actions, session-settings-actions) and the
 * unmount cleanup (app-shell-effects) keep operating on the same object.
 */
export interface KeyedPendingRegistry {
  /**
   * Reactive snapshot of the pending keys. Only refreshed when the registry
   * is created with `trackState: true`; otherwise stays the empty seed and
   * callers read `keysRef` instead.
   */
  keys: Set<string>;
  /** Stable mirror of the pending keys for synchronous reads / external mutation. */
  keysRef: RefBox<Set<string>>;
  /** Per-key auto-clear timers. Empty unless the registry sets `autoClearMs`. */
  timersRef: RefBox<Map<string, ReturnType<typeof setTimeout>>>;
  /**
   * Marks `key` pending. Returns false (a no-op) if it was already pending so
   * callers can bail on a duplicate action. Bumps the reactive snapshot and
   * arms the auto-clear timer when the registry is configured for them.
   */
  addKey(key: string): boolean;
  /** Clears a single pending key along with its timer and snapshot entry. */
  clearKey(key: string): void;
  /** Clears every pending key prefixed with `${sessionId}:` (session teardown). */
  clearForSession(sessionId: string): void;
  /** Clears the registry when its owning Runtime Host generation changes. */
  clearAll(): void;
}

export function useKeyedPendingRegistry(options?: {
  trackState?: boolean;
  autoClearMs?: number;
}): KeyedPendingRegistry {
  const trackState = options?.trackState ?? false;
  const autoClearMs = options?.autoClearMs;
  const [keys, setKeys] = useState<Set<string>>(() => new Set());
  const keysRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const controllerRef = useRef<Omit<KeyedPendingRegistry, 'keys'> | null>(null);

  if (!controllerRef.current) {
    const syncState = (): void => {
      if (trackState) setKeys(new Set(keysRef.current));
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
      if (autoClearMs !== undefined) {
        const timeoutHandle = setTimeout(() => clearKey(key), autoClearMs);
        timersRef.current.set(key, timeoutHandle);
      }
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
    controllerRef.current = { keysRef, timersRef, addKey, clearKey, clearForSession, clearAll };
  }

  return { keys, ...controllerRef.current };
}
