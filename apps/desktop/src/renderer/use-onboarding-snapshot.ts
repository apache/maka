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

/**
 * `useOnboardingSnapshot` — renderer hook over the PR110b IPC.
 *
 * @kenji + @xuan PR110c review gates:
 *   1. Renderer NEVER re-derives provider readiness; it consumes
 *      `onboarding:getSnapshot()` and targeted onboarding updates. Connections, secrets, default
 *      slugs etc. are not touched.
 *   2. Invalidation uses existing event channels —
 *      `sessions:changed`, `connections:event`, and Host profile changes. No new event bus
 *      for PR110c.
 *   3. `refresh()` is provided for action-driven re-pulls (e.g.
 *      "the user just clicked '打开设置 · 模型' so re-pull when the
 *      modal closes").
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { type UiLocale } from '@maka/core/ui-locale';
import { useUiLocale, valuesEqual } from '@maka/ui';
import type { OnboardingSnapshot } from '../preload/bridge-contract.js';
import type { DesktopOnboardingSessionUpdate } from '../preload/bridge-contract.js';
import {
  desktopOnboardingSnapshotDeps,
  onboardingSnapshotErrorMessage,
} from './platform/desktop/onboarding-snapshot-bridge.js';
export { getOnboardingActivationCandidate } from './platform/desktop/onboarding-snapshot-bridge.js';

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
  error: string | null;
  refresh: () => void;
}

export interface UseOnboardingSnapshotDeps {
  /** Fetch the current snapshot. */
  getSnapshot: () => Promise<OnboardingSnapshot>;
  getSessionUpdate?: (sessionId: string) => Promise<DesktopOnboardingSessionUpdate | null>;
  /**
   * Subscribe to invalidation signals. The handler is fired
   * (debounced internally by the caller if needed) whenever an
   * upstream event suggests the snapshot may be stale. Return value
   * is an unsubscribe function.
   */
  subscribeInvalidations: (onInvalidate: (sessionId?: string) => void) => () => void;
}

/**
 * The core readiness pair may seed only the unfinished first task. Once the
 * guide is settled or workspace history exists, normal Composer preference
 * rules own new-task selection again.
 */
/**
 * `sessions` is excluded: it is boot-time seed data (the session catalog is
 * the live authority) whose rows churn on every background message event,
 * so including it would publish a new snapshot per event. The `satisfies`
 * witness makes the key list exhaustive — a new `OnboardingSnapshot` field
 * not added here fails to compile instead of silently dropping out of the
 * dedup key.
 */
const COMPARED_KEYS = {
  defaultSlug: true,
  state: true,
  milestones: true,
  connections: true,
  chatModelChoices: true,
  sessionSendOutcomes: true,
} satisfies Record<Exclude<keyof OnboardingSnapshot, 'sessions'>, true>;

export function onboardingSnapshotProjectionEqual(
  a: OnboardingSnapshot,
  b: OnboardingSnapshot,
): boolean {
  return (Object.keys(COMPARED_KEYS) as readonly (keyof typeof COMPARED_KEYS)[]).every(
    (key) => valuesEqual(a[key], b[key]),
  );
}

/**
 * Pure-deps form. Renderer code uses `useOnboardingSnapshot()` (no
 * args); tests pass injected `deps` to drive the hook with fakes
 * (no IPC required).
 *
 * The hook is a thin React shell over `createOnboardingSnapshotPoller`
 * — the React-less helper that owns pull serialization and the
 * stale-response defense. Tests target the pure poller directly so they
 * don't need a DOM / React runtime.
 */
export function useOnboardingSnapshotImpl(
  deps: UseOnboardingSnapshotDeps,
): UseOnboardingSnapshotResult {
  const locale = useUiLocale();
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollerRef = useRef<OnboardingSnapshotPoller | null>(null);

  if (pollerRef.current === null) {
    pollerRef.current = createOnboardingSnapshotPoller(deps, {
      onSnapshot: (next) => {
        setSnapshot((prev) =>
          prev !== null && onboardingSnapshotProjectionEqual(prev, next) ? prev : next,
        );
        setError(null);
      },
      onSessionUpdate: (update) => {
        setSnapshot((prev) => prev === null ? prev : applyOnboardingSessionUpdate(prev, update));
        setError(null);
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
    const unsubscribe = deps.subscribeInvalidations((sessionId) => {
      if (sessionId) void poller.pullSession(sessionId);
      else void poller.pull();
    });
    return () => {
      unsubscribe();
      poller.dispose();
    };
  }, [deps]);

  const refresh = useCallback(() => {
    void pollerRef.current?.pull();
  }, []);

  return {
    snapshot,
    error,
    refresh,
  };
}

/**
 * React-less poller. Serializes complete and targeted IPCs — an invalidation while a
 * read is in flight schedules a bounded follow-up — and gates callbacks on
 * the active flag plus a dispose-bumped ticket so pending responses cannot
 * write after the first-run surface unmounts. Extracted from
 * `useOnboardingSnapshotImpl` so the pull discipline is testable without a
 * DOM / React.
 */
export interface OnboardingSnapshotPollerCallbacks {
  onSnapshot(snapshot: OnboardingSnapshot): void;
  onSessionUpdate?(update: Extract<DesktopOnboardingSessionUpdate, {kind: 'delta'}>): void;
  onError(message: string): void;
}

export interface OnboardingSnapshotPoller {
  /** React effect setup calls this so StrictMode cleanup replay can recover. */
  activate(): void;
  /** Fetch the latest snapshot unless disposed. */
  pull(): Promise<void>;
  /** Refresh one Session's projection after an identified change. */
  pullSession(sessionId: string): Promise<void>;
  /** Stop accepting callbacks. Pending IPC responses become no-ops. */
  dispose(): void;
}

export function createOnboardingSnapshotPoller(
  deps: Pick<UseOnboardingSnapshotDeps, 'getSnapshot' | 'getSessionUpdate'>,
  callbacks: OnboardingSnapshotPollerCallbacks,
  getLocale: () => UiLocale,
): OnboardingSnapshotPoller {
  let inflightTicket = 0;
  let active = true;
  let inflight: Promise<void> | null = null;
  let fullPending = false;
  let hasSnapshot = false;
  const pendingSessions = new Set<string>();
  const maxPendingSessions = 64;

  function emitSnapshot(snapshot: OnboardingSnapshot): void {
    if (!active) return;
    callbacks.onSnapshot(snapshot);
  }

  function emitError(message: string): void {
    if (!active) return;
    callbacks.onError(message);
  }

  async function runPull(): Promise<void> {
    const ticket = ++inflightTicket;
    try {
      const next = await deps.getSnapshot();
      if (!active || ticket !== inflightTicket || fullPending) return;
      hasSnapshot = true;
      emitSnapshot(next);
    } catch (err) {
      if (!active || ticket !== inflightTicket || fullPending) return;
      emitError(onboardingSnapshotErrorMessage(err, getLocale()));
    }
  }

  async function runSessionUpdate(sessionId: string): Promise<void> {
    const ticket = ++inflightTicket;
    try {
      const update = await deps.getSessionUpdate!(sessionId);
      if (!active || ticket !== inflightTicket) return;
      if (update?.kind === 'resync') {
        fullPending = true;
      } else if (update?.kind === 'delta' && !fullPending && !pendingSessions.has(sessionId)) {
        callbacks.onSessionUpdate?.(update);
      }
    } catch (error) {
      if (!active || ticket !== inflightTicket || fullPending) return;
      fullPending = true;
      emitError(onboardingSnapshotErrorMessage(error, getLocale()));
    }
  }

  function drain(): Promise<void> {
    if (!active) return Promise.resolve();
    if (inflight !== null) return inflight;
    const loop = (async () => {
      do {
        if (fullPending) {
          fullPending = false;
          pendingSessions.clear();
          await runPull();
        } else {
          const sessionId = pendingSessions.values().next().value;
          if (sessionId === undefined) break;
          pendingSessions.delete(sessionId);
          await runSessionUpdate(sessionId);
        }
      } while (active && (fullPending || pendingSessions.size > 0));
      inflight = null;
    })();
    inflight = loop;
    return loop;
  }

  return {
    activate(): void {
      active = true;
    },
    pull(): Promise<void> {
      if (!active) return Promise.resolve();
      fullPending = true;
      pendingSessions.clear();
      return drain();
    },
    pullSession(sessionId: string): Promise<void> {
      if (!active) return Promise.resolve();
      if (
        !deps.getSessionUpdate ||
        (!hasSnapshot && inflight === null) ||
        (pendingSessions.size >= maxPendingSessions && !pendingSessions.has(sessionId))
      ) {
        fullPending = true;
        pendingSessions.clear();
        return drain();
      }
      if (!fullPending) pendingSessions.add(sessionId);
      return drain();
    },
    dispose(): void {
      active = false;
      inflightTicket += 1;
      fullPending = false;
      pendingSessions.clear();
      hasSnapshot = false;
    },
  };
}

export function applyOnboardingSessionUpdate(
  snapshot: OnboardingSnapshot,
  update: Extract<DesktopOnboardingSessionUpdate, {kind: 'delta'}>,
): OnboardingSnapshot {
  const previous = snapshot.sessionSendOutcomes[update.sessionId];
  const outcomeChanged = update.outcome === null
    ? previous !== undefined
    : !valuesEqual(previous, update.outcome);
  const state = update.defaultHost?.state ?? snapshot.state;
  const milestones = update.defaultHost?.milestones ?? snapshot.milestones;
  if (!outcomeChanged && valuesEqual(state, snapshot.state) &&
    valuesEqual(milestones, snapshot.milestones)) return snapshot;
  const sessionSendOutcomes = outcomeChanged
    ? { ...snapshot.sessionSendOutcomes }
    : snapshot.sessionSendOutcomes;
  if (outcomeChanged) {
    if (update.outcome === null) delete sessionSendOutcomes[update.sessionId];
    else sessionSendOutcomes[update.sessionId] = update.outcome;
  }
  return { ...snapshot, state, milestones, sessionSendOutcomes };
}

/**
 * Default renderer binding lives in the Desktop platform adapter. Named
 * Session events use targeted reads; connection and Owner profile changes
 * request complete snapshots.
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
export function useOnboardingSnapshot(): UseOnboardingSnapshotResult {
  // Bind to the live IPC bridge. `deps` is memoized as a module-level
  // object so the effect deps stay stable across re-renders.
  return useOnboardingSnapshotImpl(desktopOnboardingSnapshotDeps);
}
