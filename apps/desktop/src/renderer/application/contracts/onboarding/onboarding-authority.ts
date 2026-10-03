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
 * The renderer's one onboarding authority (PR110c contract, #4582 M5).
 *
 * The renderer NEVER re-derives provider readiness: it consumes Main's
 * snapshot and targeted Session updates, invalidated by existing event
 * channels only. Desktop supplies that source at composition; the authority
 * owns the pull discipline and the skip command, and readers take read-only
 * projections. A failed read is reported as a flag, never as error text.
 */

import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { hasSettledInitialOnboarding } from '@maka/core/onboarding-milestone';
import type { SessionSendProjection } from '@maka/core/session-send-projection';
import { valuesEqual } from '@maka/ui';
import type {
  DesktopOnboardingSessionUpdate,
  OnboardingSnapshot,
} from '../../../../shared/onboarding-snapshot.js';

export type { OnboardingSnapshot };

export interface OnboardingSource {
  getSnapshot(): Promise<OnboardingSnapshot>;
  getSessionUpdate?(sessionId: string): Promise<DesktopOnboardingSessionUpdate | null>;
  /** Fires with a Session id for a named change, without one when anything else may be stale. */
  subscribeInvalidations(onInvalidate: (sessionId?: string) => void): () => void;
  /** Records that the user skipped first-run setup on the default Host. */
  skipInitialOnboarding(): Promise<void>;
}

export interface OnboardingProjection {
  /** `null` until the first complete read lands. */
  readonly snapshot: OnboardingSnapshot | null;
  /** The last read failed; the next successful read clears it. */
  readonly failed: boolean;
}

export interface OnboardingAuthority {
  getProjection(): OnboardingProjection;
  subscribe(listener: () => void): () => void;
  /** Re-pull after an action Main has no event for, such as closing Settings. */
  refresh(): void;
  skipInitialOnboarding(): Promise<void>;
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
 * Serializes complete and targeted reads — an invalidation while a read is
 * in flight schedules a bounded follow-up — and gates callbacks on the active
 * flag plus a dispose-bumped ticket so pending responses cannot write after
 * the last reader leaves.
 */
export interface OnboardingSnapshotPollerCallbacks {
  onSnapshot(snapshot: OnboardingSnapshot): void;
  onSessionUpdate?(update: Extract<DesktopOnboardingSessionUpdate, {kind: 'delta'}>): void;
  onError(): void;
}

export interface OnboardingSnapshotPoller {
  /** Called when a reader arrives, so StrictMode cleanup replay can recover. */
  activate(): void;
  /** Fetch the latest snapshot unless disposed. */
  pull(): Promise<void>;
  /** Refresh one Session's projection after an identified change. */
  pullSession(sessionId: string): Promise<void>;
  /** Stop accepting callbacks. Pending responses become no-ops. */
  dispose(): void;
}

export function createOnboardingSnapshotPoller(
  deps: Pick<OnboardingSource, 'getSnapshot' | 'getSessionUpdate'>,
  callbacks: OnboardingSnapshotPollerCallbacks,
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

  function emitError(): void {
    if (!active) return;
    callbacks.onError();
  }

  async function runPull(): Promise<void> {
    const ticket = ++inflightTicket;
    try {
      const next = await deps.getSnapshot();
      if (!active || ticket !== inflightTicket || fullPending) return;
      hasSnapshot = true;
      emitSnapshot(next);
    } catch {
      if (!active || ticket !== inflightTicket || fullPending) return;
      emitError();
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
    } catch {
      if (!active || ticket !== inflightTicket || fullPending) return;
      fullPending = true;
      emitError();
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

const INITIAL: OnboardingProjection = { snapshot: null, failed: false };

/**
 * Reads while anyone is subscribed. The last accepted snapshot survives a
 * reader leaving and is revalidated when one returns, as the shell's own
 * state survived StrictMode's effect replay.
 */
export function createOnboardingAuthority(source: OnboardingSource): OnboardingAuthority {
  const listeners = new Set<() => void>();
  let projection = INITIAL;
  let unsubscribeInvalidations: (() => void) | undefined;
  const publish = (snapshot: OnboardingSnapshot | null, failed: boolean) => {
    if (snapshot === projection.snapshot && failed === projection.failed) return;
    projection = { snapshot, failed };
    for (const listener of [...listeners]) listener();
  };
  const poller = createOnboardingSnapshotPoller(source, {
    onSnapshot: (next) => publish(
      projection.snapshot !== null && onboardingSnapshotProjectionEqual(projection.snapshot, next)
        ? projection.snapshot
        : next,
      false,
    ),
    onSessionUpdate: (update) => publish(
      projection.snapshot === null ? null : applyOnboardingSessionUpdate(projection.snapshot, update),
      false,
    ),
    onError: () => publish(projection.snapshot, true),
  });
  poller.dispose();
  return {
    getProjection: () => projection,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        poller.activate();
        void poller.pull();
        unsubscribeInvalidations = source.subscribeInvalidations((sessionId) => {
          if (sessionId) void poller.pullSession(sessionId);
          else void poller.pull();
        });
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        unsubscribeInvalidations?.();
        unsubscribeInvalidations = undefined;
        poller.dispose();
      };
    },
    refresh: () => void poller.pull(),
    async skipInitialOnboarding() {
      await source.skipInitialOnboarding();
      void poller.pull();
    },
  };
}

const AuthorityContext = createContext<OnboardingAuthority | null>(null);
export const OnboardingAuthorityProvider = AuthorityContext.Provider;

/**
 * A missing provider fails here: an idle stand-in would hold the first-run
 * gate (and the launch overlay) closed forever without saying why.
 */
function useOnboardingAuthority(): OnboardingAuthority {
  const authority = useContext(AuthorityContext);
  if (!authority) throw new Error('OnboardingAuthorityProvider is missing');
  return authority;
}

export type OnboardingShellProjection =
  OnboardingProjection & Pick<OnboardingAuthority, 'refresh' | 'skipInitialOnboarding'>;

/**
 * The shell's read, handed down like the other shell roots' projections:
 * first-run surface gating, the default-Host connection seed, the model
 * activation candidate and the readiness refresh key derive from this
 * read-only projection; refresh and skip are its only commands.
 */
export function OnboardingProjectionRoot(props: {
  children(onboarding: OnboardingShellProjection): ReactNode;
}) {
  const authority = useOnboardingAuthority();
  const projection = useSyncExternalStore(authority.subscribe, authority.getProjection);
  return props.children({
    ...projection,
    refresh: authority.refresh,
    skipInitialOnboarding: authority.skipInitialOnboarding,
  });
}

/** The current snapshot, for readers that check something again whenever onboarding changes. */
export function useCurrentOnboardingSnapshot(): OnboardingSnapshot | null {
  const authority = useOnboardingAuthority();
  return useSyncExternalStore(authority.subscribe, () => authority.getProjection().snapshot);
}

const selectSendOutcomes = (authority: OnboardingAuthority) => authority.getProjection().snapshot?.sessionSendOutcomes;

/** Per-Session send outcomes, for readers that need nothing else from onboarding. */
export function useOnboardingSessionSendOutcomes(): Readonly<Record<string, SessionSendProjection>> | undefined {
  const authority = useOnboardingAuthority();
  return useSyncExternalStore(authority.subscribe, () => selectSendOutcomes(authority));
}
