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
import { generalizedErrorMessageForLocale } from '@maka/core/redaction';
import { type UiLocale } from '@maka/core/ui-locale';
import { hasSettledInitialOnboarding } from '@maka/core/onboarding-milestone';
import { useUiLocale, valuesEqual } from '@maka/ui';
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
  error: string | null;
  refresh: () => void;
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

  return {
    snapshot,
    error,
    refresh,
  };
}

/**
 * React-less poller. Serializes getSnapshot IPCs — an invalidation while a
 * pull is in flight schedules a single follow-up — and gates callbacks on
 * the active flag plus a dispose-bumped ticket so pending responses cannot
 * write after the first-run surface unmounts. Extracted from
 * `useOnboardingSnapshotImpl` so the pull discipline is testable without a
 * DOM / React.
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
  let inflight: Promise<void> | null = null;
  let pullAgain = false;

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
      if (!active || ticket !== inflightTicket) return; // unmounted or re-disposed
      emitSnapshot(next);
    } catch (err) {
      if (!active || ticket !== inflightTicket) return;
      emitError(onboardingSnapshotErrorMessage(err, getLocale()));
    }
  }

  return {
    activate(): void {
      active = true;
    },
    pull(): Promise<void> {
      if (!active) return Promise.resolve();
      // Invalidations arriving while a pull is in flight collapse into one
      // follow-up, so the IPC rate tracks pull latency, not event rate.
      if (inflight !== null) {
        pullAgain = true;
        return inflight;
      }
      const loop = (async () => {
        do {
          pullAgain = false;
          await runPull();
        } while (pullAgain && active);
        inflight = null;
      })();
      inflight = loop;
      return loop;
    },
    dispose(): void {
      active = false;
      inflightTicket += 1;
    },
  };
}

export function onboardingSnapshotErrorMessage(error: unknown, locale: UiLocale): string {
  const fallback = getOnboardingCopy(locale).snapshotErrorFallback;
  return generalizedErrorMessageForLocale(error, fallback, locale);
}

/**
 * Default renderer binding: subscribes to `sessions:changed` and
 * `connections:event` so any session lifecycle (create / delete / archive /
 * rebound / message-appended) or connection change (verified / disabled /
 * removed) invalidates the snapshot.
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
  return useOnboardingSnapshotImpl(LIVE_DEPS);
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
