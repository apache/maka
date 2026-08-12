/**
 * `useOnboardingSnapshot` — renderer hook over the PR110b IPC.
 *
 * @kenji + @xuan PR110c review gates:
 *   1. Renderer NEVER re-derives provider readiness; only consumes
 *      `onboarding:getSnapshot()`. Connections, secrets, default
 *      slugs etc. are not touched.
 *   2. Invalidation uses ONLY existing event channels —
 *      `sessions:changed` and `connections:event`. No new event bus
 *      for PR110c.
 *   3. `refresh()` is provided for action-driven re-pulls (e.g.
 *      "the user just clicked '打开设置 · 模型' so re-pull when the
 *      modal closes").
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core/redaction';
import { type LlmConnection } from '@maka/core/llm-connections';
import { type SessionSummary } from '@maka/core/session';
import { type UiLocale } from '@maka/core/ui-locale';
import { hasSettledInitialOnboarding } from '@maka/core/onboarding-milestone';
import { useUiLocale } from '@maka/ui';
import type { OnboardingSnapshot } from '../preload/bridge-contract.js';
import { getOnboardingCopy } from './locales/onboarding-copy.js';

/**
 * Hook return type — `snapshot` is `null` while the initial getSnapshot
 * IPC is still in flight, then settles to the latest derived value.
 * `error` carries a generalized Chinese message if the IPC ever fails
 * (`onboarding:getSnapshot` is best-effort; main treats it as
 * non-throwing in current implementations, but we surface the slot
 * defensively).
 */
export interface UseOnboardingSnapshotResult {
  snapshot: OnboardingSnapshot | null;
  /** Latest mounted pull, handed to AppShell once for bootstrap reconciliation. */
  mountedSnapshotHandoff: OnboardingSnapshot | null;
  error: string | null;
  refresh: () => void;
  /** Sessions from the snapshot — populated on first load, before the separate sessions:list IPC. */
  getSessions(): SessionSummary[] | null;
  /** Connections from the snapshot — populated on first load, avoids separate connections:list + getDefault. */
  getConnections(): LlmConnection[] | null;
  getDefaultSlug(): string | null;
}

export interface UseOnboardingSnapshotDeps {
  /** Fetch the current snapshot. */
  getSnapshot: () => Promise<OnboardingSnapshot>;
  /**
   * Subscribe to invalidation signals. The handler is fired
   * (debounced internally by the caller if needed) whenever an
   * upstream event suggests the snapshot may be stale. Return value
   * is an unsubscribe function.
   */
  subscribeInvalidations: (onInvalidate: () => void) => () => void;
}

export interface OnboardingSnapshotState {
  snapshot: OnboardingSnapshot | null;
  mountedSnapshotHandoff: OnboardingSnapshot | null;
}

/**
 * The core readiness pair may seed only the unfinished first task. Once the
 * guide is settled or workspace history exists, normal Composer preference
 * rules own new-task selection again.
 */
export function getOnboardingActivationCandidate(
  snapshot: Pick<OnboardingSnapshot, 'state' | 'milestones'> | null,
  hasWorkspaceHistory: boolean,
): { llmConnectionSlug: string; model: string } | undefined {
  if (
    snapshot?.state.kind !== 'ready_empty' ||
    hasWorkspaceHistory ||
    hasSettledInitialOnboarding(snapshot.milestones)
  ) {
    return undefined;
  }
  return {
    llmConnectionSlug: snapshot.state.connectionSlug,
    model: snapshot.state.model,
  };
}

export function createOnboardingSnapshotState(initialSnapshot: OnboardingSnapshot | null): OnboardingSnapshotState {
  return { snapshot: initialSnapshot, mountedSnapshotHandoff: null };
}

export function advanceOnboardingSnapshotState(
  _current: OnboardingSnapshotState,
  next: OnboardingSnapshot,
): OnboardingSnapshotState {
  return {
    snapshot: next,
    mountedSnapshotHandoff: next,
  };
}

/**
 * Pure-deps form. Renderer code uses `useOnboardingSnapshot()` (no
 * args); tests pass injected `deps` to drive the hook with fakes
 * (no IPC required).
 *
 * The hook is a thin React shell over `createOnboardingSnapshotPoller`
 * — the React-less helper that owns the ticket-based stale-response
 * defense. Tests target the pure poller directly so they don't need
 * a DOM / React runtime.
 */
export function useOnboardingSnapshotImpl(
  deps: UseOnboardingSnapshotDeps,
  initialSnapshot: OnboardingSnapshot | null = null,
): UseOnboardingSnapshotResult {
  const locale = useUiLocale();
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const [snapshotState, setSnapshotState] = useState(() => createOnboardingSnapshotState(initialSnapshot));
  const [error, setError] = useState<string | null>(null);
  const sessionsRef = useRef<SessionSummary[] | null>(initialSnapshot?.sessions ?? null);
  const connectionsRef = useRef<LlmConnection[] | null>(initialSnapshot?.connections ?? null);
  const defaultSlugRef = useRef<string | null>(initialSnapshot?.defaultSlug ?? null);
  const pollerRef = useRef<OnboardingSnapshotPoller | null>(null);

  if (pollerRef.current === null) {
    pollerRef.current = createOnboardingSnapshotPoller(deps, {
      onSnapshot: (next) => {
        setSnapshotState((current) => advanceOnboardingSnapshotState(current, next));
        setError(null);
        if (next.sessions) sessionsRef.current = next.sessions;
        if (next.connections) connectionsRef.current = next.connections;
        defaultSlugRef.current = next.defaultSlug;
      },
      onError: (message) => {
        setError(message);
      },
    }, () => localeRef.current);
  }

  useEffect(() => {
    const poller = pollerRef.current!;
    poller.activate();
    void poller.pull();
    const unsubscribe = deps.subscribeInvalidations(() => {
      void poller.pull();
    });
    return () => {
      unsubscribe();
      poller.dispose();
    };
  }, [deps]);

  const refresh = useCallback(() => {
    void pollerRef.current?.pull();
  }, []);

  const getSessions = useCallback((): SessionSummary[] | null => sessionsRef.current, []);
  const getConnections = useCallback((): LlmConnection[] | null => connectionsRef.current, []);
  const getDefaultSlug = useCallback((): string | null => defaultSlugRef.current, []);

  return {
    snapshot: snapshotState.snapshot,
    mountedSnapshotHandoff: snapshotState.mountedSnapshotHandoff,
    error,
    refresh,
    getSessions,
    getConnections,
    getDefaultSlug,
  };
}

/**
 * React-less poller. Tracks an inflight ticket so older getSnapshot
 * responses can't overwrite newer state, and owns a lifecycle gate so
 * pending IPC responses cannot write after the first-run surface
 * unmounts. Extracted from `useOnboardingSnapshotImpl` so the stale
 * response defense is testable without a DOM / React.
 */
export interface OnboardingSnapshotPollerCallbacks {
  onSnapshot(snapshot: OnboardingSnapshot): void;
  onError(message: string): void;
}

export interface OnboardingSnapshotPoller {
  /** React effect setup calls this so StrictMode cleanup replay can recover. */
  activate(): void;
  /** Fetch the latest snapshot unless disposed. */
  pull(): Promise<void>;
  /** Stop accepting callbacks. Pending IPC responses become no-ops. */
  dispose(): void;
}

export function createOnboardingSnapshotPoller(
  deps: Pick<UseOnboardingSnapshotDeps, 'getSnapshot'>,
  callbacks: OnboardingSnapshotPollerCallbacks,
  getLocale: () => UiLocale,
): OnboardingSnapshotPoller {
  let inflightTicket = 0;
  let active = true;

  function emitSnapshot(snapshot: OnboardingSnapshot): void {
    if (!active) return;
    callbacks.onSnapshot(snapshot);
  }

  function emitError(message: string): void {
    if (!active) return;
    callbacks.onError(message);
  }

  return {
    activate(): void {
      active = true;
    },
    async pull(): Promise<void> {
      if (!active) return;
      const ticket = ++inflightTicket;
      try {
        const next = await deps.getSnapshot();
        if (!active || ticket !== inflightTicket) return; // newer pull won or unmounted
        emitSnapshot(next);
      } catch (err) {
        if (!active || ticket !== inflightTicket) return;
        emitError(onboardingSnapshotErrorMessage(err, getLocale()));
      }
    },
    dispose(): void {
      active = false;
      inflightTicket += 1;
    },
  };
}

export function onboardingSnapshotErrorMessage(error: unknown, locale: UiLocale): string {
  const fallback = getOnboardingCopy(locale).snapshotErrorFallback;
  return locale === 'zh' ? generalizedErrorMessageChinese(error, fallback) : generalizedErrorMessage(error, fallback);
}

/**
 * Default renderer binding: subscribes to BOTH `sessions:changed`
 * and `connections:event` so any session lifecycle (create / delete /
 * archive / rebound / message-appended) or any connection change
 * (verified / disabled / removed) invalidates the snapshot.
 *
 * Settings changes are NOT subscribed: there is no existing
 * settings-wide event channel and PR110c is not inventing one. If a
 * settings write changes onboarding state (e.g. user picks a default
 * connection via the connection store IPCs), the resulting
 * `connections:event` should fire and cover this.
 *
 * Callers that need a re-pull on a specific UI action (e.g. modal
 * close) should call `refresh()` from the returned object.
 */
export function useOnboardingSnapshot(initialSnapshot: OnboardingSnapshot | null = null): UseOnboardingSnapshotResult {
  // Bind to the live IPC bridge. `deps` is memoized as a module-level
  // object so the effect deps stay stable across re-renders.
  // `initialSnapshot` comes from main.tsx's pre-mount prefetch: with it,
  // the very first commit already has sessions + connections, so the
  // startup path never shows the intermediate loading card ("配置页
  // 闪了一下"). The mount effect still pulls a fresh snapshot.
  return useOnboardingSnapshotImpl(LIVE_DEPS, initialSnapshot);
}

const LIVE_DEPS: UseOnboardingSnapshotDeps = {
  getSnapshot: () => window.maka.onboarding.getSnapshot(),
  subscribeInvalidations(onInvalidate) {
    const unsubscribeSessions = window.maka.sessions.subscribeChanges(() => onInvalidate());
    const unsubscribeConnections = window.maka.connections.subscribeEvents(() => onInvalidate());
    return () => {
      unsubscribeSessions();
      unsubscribeConnections();
    };
  },
};
