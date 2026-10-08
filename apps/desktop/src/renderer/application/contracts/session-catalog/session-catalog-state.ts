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

import { createContext, useContext, useRef } from 'react';
import type { SessionChangedEvent } from '@maka/core/session';
import { valuesEqual } from '@maka/ui';
import {
  compareDesktopSessionCatalogSummaries,
  type DesktopSessionSummary,
} from '../../../../shared/desktop-session-projection.js';
import { createObservableState } from './observable-state.js';

/**
 * The session catalog and the selection, as one external store (#4109).
 *
 * They were `useState` inside a hook AppShell calls, which made the shell the
 * carrier: every catalog commit and every selection change re-rendered the
 * whole tree, and anything that wanted to follow them — the Session rail above
 * all — had to be handed them down a prop chain. As a store they have readers
 * instead of a carrier, and each reader re-renders only for the reading it
 * selects. Same mechanism as `app-shell-session-ui-state.ts` (#1985); this is
 * the second store, not a second way of having stores.
 *
 * The list and its observation revision are one committed snapshot. A failed
 * refresh changes neither, so consumers can fence transient writes against
 * successful catalog observations without a parallel error flag.
 */
export interface SessionCatalogState {
  readonly sessions: readonly DesktopSessionSummary[];
  readonly revision: number;
  /**
   * A list read has committed. A row patch also moves `revision`, but it can
   * only vouch for its own row, so membership readers wait for a list.
   */
  readonly listed: boolean;
  readonly activeSessionId: string | undefined;
  readonly automaticQueryBlockedSessionIds: ReadonlySet<string>;
  /**
   * Ids a targeted row read reported as gone (`sessions.get` → null). A list
   * omission never lands here: a snapshot taken before a session existed
   * cannot testify about it, so only the row-level answer counts as
   * authoritative absence for an id the catalog never held.
   */
  readonly removedIds: ReadonlySet<string>;
}

/**
 * Where the catalog's full lists and change events come from. Desktop
 * supplies it at composition, so the shell's catalog refresh and change
 * subscription do not reach the Session bridge themselves.
 */
export interface SessionCatalogSource {
  list(): Promise<DesktopSessionSummary[]>;
  subscribeChanges(handler: (event: SessionChangedEvent) => void): () => void;
}

const NO_SOURCE = 'This session catalog was created without a source';
/** A catalog that is only ever committed to, as in tests and stories; reading through it fails. */
const DETACHED_SOURCE: SessionCatalogSource = {
  list: () => Promise.reject(new Error(NO_SOURCE)),
  subscribeChanges: () => { throw new Error(NO_SOURCE); },
};

export function createSessionCatalogController(source: SessionCatalogSource = DETACHED_SOURCE) {
  const state = createObservableState<SessionCatalogState>({
    sessions: [],
    revision: 0,
    listed: false,
    activeSessionId: undefined,
    automaticQueryBlockedSessionIds: new Set(),
    removedIds: new Set(),
  });
  // Catalog revision at which each row's existence was last confirmed by a
  // patch — the fence a stale list commit is measured against.
  const existenceConfirmedAt = new Map<string, number>();
  const automaticQueryBlockCounts = new Map<string, number>();
  const publishAutomaticQueryBlocks = () => {
    const current = state.getState();
    const next = new Set(automaticQueryBlockCounts.keys());
    if (
      current.automaticQueryBlockedSessionIds.size === next.size
      && [...next].every((id) => current.automaticQueryBlockedSessionIds.has(id))
    ) {
      return;
    }
    state.replaceState({ ...current, automaticQueryBlockedSessionIds: next });
  };

  return {
    source,
    getState: state.getState,
    subscribe: state.subscribe,
    isAutomaticQueryBlocked(sessionId: string): boolean {
      const current = state.getState();
      return (
        current.automaticQueryBlockedSessionIds.has(sessionId)
        || current.sessions.some((session) => session.id === sessionId && session.isArchived)
      );
    },
    acquireAutomaticQueryBlock(sessionIds: readonly string[]): { release(): void } {
      const ids = [...new Set(sessionIds)];
      for (const id of ids) {
        automaticQueryBlockCounts.set(id, (automaticQueryBlockCounts.get(id) ?? 0) + 1);
      }
      publishAutomaticQueryBlocks();

      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          for (const id of ids) {
            const count = automaticQueryBlockCounts.get(id) ?? 0;
            if (count <= 1) automaticQueryBlockCounts.delete(id);
            else automaticQueryBlockCounts.set(id, count - 1);
          }
          publishAutomaticQueryBlocks();
        },
      };
    },
    commitSessions(
      next: readonly DesktopSessionSummary[],
      options?: { observedAtRevision?: number },
    ): void {
      const current = state.getState();
      // Published references change iff values change: an unchanged row keeps
      // its identity so per-row readers and memos survive a re-list, and a
      // row already patched to a newer revision is never regressed by an
      // older snapshot.
      const previousById = new Map(current.sessions.map((s) => [s.id, s]));
      const reconciled = next.map((s) => {
        const prior = previousById.get(s.id);
        return prior !== undefined && (isStaleSummary(prior, s) || valuesEqual(prior, s))
          ? prior
          : s;
      });
      // A row whose existence a patch confirmed after this list was observed
      // is newer than anything the list can claim about it — keep it. This is
      // the membership-level analogue of the per-row staleness fence.
      const inNext = new Set(next.map((s) => s.id));
      const observedAt = options?.observedAtRevision;
      const sessions = observedAt === undefined
        ? reconciled
        : reconciled.concat(
            current.sessions.filter(
              (s) => !inNext.has(s.id) && (existenceConfirmedAt.get(s.id) ?? -1) > observedAt,
            ),
          );
      if (sessions.length !== reconciled.length)
        sessions.sort(compareDesktopSessionCatalogSummaries);
      let removedIds = current.removedIds;
      if (removedIds.size > 0) {
        const cleared = new Set(removedIds);
        for (const s of sessions) cleared.delete(s.id);
        if (cleared.size !== removedIds.size) removedIds = cleared;
      }
      for (const id of existenceConfirmedAt.keys())
        if (!sessions.some((s) => s.id === id)) existenceConfirmedAt.delete(id);
      const sameRows = sessions.length === current.sessions.length
        && sessions.every((s, i) => s === current.sessions[i]);
      // A commit that changed nothing publishes nothing — except the first
      // list: until one lands there is no authoritative observation, and even
      // an empty list, or one matching the rows patches admitted, is one.
      if (sameRows && removedIds === current.removedIds && current.listed) return;
      state.replaceState({
        ...current,
        sessions: sameRows ? current.sessions : sessions,
        removedIds,
        revision: current.revision + 1,
        listed: true,
      });
    },
    commitPatch(sessionId: string, summary: DesktopSessionSummary | null): void {
      const current = state.getState();
      const index = current.sessions.findIndex((s) => s.id === sessionId);
      const prior = index < 0 ? undefined : current.sessions[index];
      const revision = current.revision + 1;
      if (summary === null) {
        // A targeted "gone" answer tombstones the id even when the row was
        // never admitted — watchers can then tell removal apart from
        // admission still in flight.
        if (prior === undefined && current.removedIds.has(sessionId)) return;
        existenceConfirmedAt.delete(sessionId);
        const removedIds = new Set(current.removedIds);
        removedIds.add(sessionId);
        state.replaceState({
          ...current,
          sessions: prior === undefined
            ? current.sessions
            : current.sessions.filter((s) => s.id !== sessionId),
          removedIds,
          revision,
        });
        return;
      }
      if (prior !== undefined && isStaleSummary(prior, summary)) return;
      const row = prior !== undefined && valuesEqual(prior, summary) ? prior : summary;
      const sessions = [...current.sessions];
      if (index < 0) sessions.push(row); else sessions[index] = row;
      sessions.sort(compareDesktopSessionCatalogSummaries);
      const sameRows = sessions.length === current.sessions.length
        && sessions.every((s, i) => s === current.sessions[i]);
      const removedIds = current.removedIds.has(sessionId)
        ? new Set([...current.removedIds].filter((id) => id !== sessionId))
        : current.removedIds;
      existenceConfirmedAt.set(
        sessionId,
        sameRows && removedIds === current.removedIds ? current.revision : revision,
      );
      if (sameRows && removedIds === current.removedIds) return;
      state.replaceState({ ...current, sessions, removedIds, revision });
    },
    setActiveSessionId(next: string | undefined): void {
      const current = state.getState();
      if (current.activeSessionId === next) return;
      state.replaceState({ ...current, activeSessionId: next });
    },
    isRemoved(sessionId: string): boolean {
      return state.getState().removedIds.has(sessionId);
    },
  };
}

export type SessionCatalogController = ReturnType<typeof createSessionCatalogController>;

/** Resolve once the catalog holds `sessionId` — a selection is only durable after the authority has observed the row. */
export function waitForCatalogSession(
  catalog: Pick<SessionCatalogController, 'getState' | 'subscribe'>,
  sessionId: string,
): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (catalog.getState().sessions.some((s) => s.id === sessionId)) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = catalog.subscribe(check);
    check();
  });
}

/**
 * A committed row at a newer revision is authoritative over an older snapshot
 * of it. Equal revisions tie on the live run state's own order: a turn
 * starting or ending does not move `revision`, so two same-revision reads can
 * disagree about `runningTurnIds` — the run epoch says which observation is
 * older, and the stale one must not overwrite the fresher (#5713).
 *
 * The epoch counter only orders observations of one Host generation.
 * Generations themselves are not ordered, so a read from a different
 * generation is never stale: a restarted Host must take the row over from its
 * predecessor whatever the two counters read (#5713 review). A successful
 * cross-generation response cannot exist on the wire, either: closing a
 * connection rejects every in-flight request with `connection_lost`
 * (client/connection.ts), so a lagging predecessor read never delivers after
 * the successor's row has landed.
 */
function isStaleSummary(prior: DesktopSessionSummary, next: DesktopSessionSummary): boolean {
  if (prior.revision !== next.revision) return prior.revision > next.revision;
  const priorGeneration = prior.runHostGeneration;
  const nextGeneration = next.runHostGeneration;
  if (
    priorGeneration !== undefined &&
    nextGeneration !== undefined &&
    priorGeneration !== nextGeneration
  ) {
    return false;
  }
  const priorEpoch = prior.runEpoch;
  const nextEpoch = next.runEpoch;
  if (priorEpoch === undefined || nextEpoch === undefined || priorEpoch === nextEpoch) {
    return false;
  }
  return priorEpoch > nextEpoch;
}

export const selectSessions = (state: SessionCatalogState): readonly DesktopSessionSummary[] =>
  state.sessions;
export const selectSessionById = (
  state: SessionCatalogState,
  sessionId: string | undefined,
): DesktopSessionSummary | undefined =>
  sessionId === undefined ? undefined : state.sessions.find((s) => s.id === sessionId);
export const selectActiveSessionId = (state: SessionCatalogState): string | undefined =>
  state.activeSessionId;

/**
 * The ids in the catalog, by value. A refresh replaces every row object even
 * when nothing about the membership moved (#2913), so an identity-only
 * selection would re-render every reader that only cares about which sessions
 * exist.
 */
export const selectAuthoritativeSessionIds = (
  state: SessionCatalogState,
): ReadonlySet<string> | undefined =>
  // Neither the initial empty catalog nor rows admitted by targeted patches
  // before the first list can prove that persisted Sessions were deleted.
  state.listed ? new Set(state.sessions.map(({ id }) => id)) : undefined;

/**
 * The shell's catalog instance, mounted once above the feature services.
 * Providers that need the catalog read it here instead of receiving it as a
 * prop drilled through the shell. Deliberately does NOT subscribe: readers
 * select what they need through `useExternalStoreSelector`.
 */
export const SessionCatalogContext = createContext<SessionCatalogController | null>(null);

export function useSessionCatalogController(): SessionCatalogController {
  const catalog = useContext(SessionCatalogContext);
  if (catalog === null) throw new Error('SessionCatalogContext.Provider is missing');
  return catalog;
}
