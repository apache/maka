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
import {
  compareDesktopSessionCatalogSummaries,
  type DesktopSessionSummary,
} from '../shared/desktop-session-projection.js';
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
  readonly activeSessionId: string | undefined;
}

export function createSessionCatalogController() {
  const state = createObservableState<SessionCatalogState>({
    sessions: [],
    revision: 0,
    activeSessionId: undefined,
  });

  return {
    getState: state.getState,
    subscribe: state.subscribe,
    commitSessions(next: readonly DesktopSessionSummary[]): void {
      const current = state.getState();
      // Published references change iff values change: an unchanged row keeps
      // its identity so per-row readers and memos survive a re-list, and a
      // row already patched to a newer revision is never regressed by an
      // older snapshot.
      const previousById = new Map(current.sessions.map((s) => [s.id, s]));
      const reconciled = next.map((s) => {
        const prior = previousById.get(s.id);
        return prior !== undefined && (isStaleSummary(prior, s) || summaryValuesEqual(prior, s))
          ? prior
          : s;
      });
      const sameRows = reconciled.length === current.sessions.length
        && reconciled.every((s, i) => s === current.sessions[i]);
      state.replaceState({
        ...current,
        sessions: sameRows ? current.sessions : reconciled,
        revision: current.revision + 1,
      });
    },
    commitPatch(sessionId: string, summary: DesktopSessionSummary | null): void {
      const current = state.getState();
      const index = current.sessions.findIndex((s) => s.id === sessionId);
      const prior = index < 0 ? undefined : current.sessions[index];
      if (summary === null) {
        if (prior === undefined) return;
        state.replaceState({
          ...current,
          sessions: current.sessions.filter((s) => s.id !== sessionId),
          revision: current.revision + 1,
        });
        return;
      }
      if (prior !== undefined && isStaleSummary(prior, summary)) return;
      const row = prior !== undefined && summaryValuesEqual(prior, summary) ? prior : summary;
      const sessions = [...current.sessions];
      if (index < 0) sessions.push(row); else sessions[index] = row;
      sessions.sort(compareDesktopSessionCatalogSummaries);
      const sameRows = sessions.length === current.sessions.length
        && sessions.every((s, i) => s === current.sessions[i]);
      state.replaceState({
        ...current,
        sessions: sameRows ? current.sessions : sessions,
        revision: current.revision + 1,
      });
    },
    setActiveSessionId(next: string | undefined): void {
      const current = state.getState();
      if (current.activeSessionId === next) return;
      state.replaceState({ ...current, activeSessionId: next });
    },
  };
}

export type SessionCatalogController = ReturnType<typeof createSessionCatalogController>;

/** A committed row at a newer revision is authoritative over an older snapshot of it. */
function isStaleSummary(prior: DesktopSessionSummary, next: DesktopSessionSummary): boolean {
  return prior.revision > next.revision;
}

function summaryValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((v, i) => summaryValuesEqual(v, b[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length
    && aKeys.every((k) => summaryValuesEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export const selectSessions = (state: SessionCatalogState): readonly DesktopSessionSummary[] =>
  state.sessions;
export const selectSessionById = (
  state: SessionCatalogState,
  sessionId: string | undefined,
): DesktopSessionSummary | undefined =>
  sessionId === undefined ? undefined : state.sessions.find((s) => s.id === sessionId);
export const selectSessionCount = (state: SessionCatalogState): number => state.sessions.length;
export const selectCatalogRevision = (state: SessionCatalogState): number => state.revision;
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
  // The initial empty catalog cannot prove that persisted Sessions were deleted.
  state.revision > 0 ? new Set(state.sessions.map(({ id }) => id)) : undefined;

/**
 * Owns the controller for the component's lifetime. Deliberately does NOT
 * subscribe: readers select what they need through `useExternalStoreSelector`.
 */
export function useSessionCatalogController(): SessionCatalogController {
  const controllerRef = useRef<SessionCatalogController | null>(null);
  if (!controllerRef.current) controllerRef.current = createSessionCatalogController();
  return controllerRef.current;
}
