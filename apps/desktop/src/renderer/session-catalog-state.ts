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
import type { DesktopSessionSummary } from '../preload/bridge-contract.js';
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
      state.replaceState({ ...current, sessions: next, revision: current.revision + 1 });
    },
    setActiveSessionId(next: string | undefined): void {
      const current = state.getState();
      if (current.activeSessionId === next) return;
      state.replaceState({ ...current, activeSessionId: next });
    },
  };
}

export type SessionCatalogController = ReturnType<typeof createSessionCatalogController>;

export const selectSessions = (state: SessionCatalogState): readonly DesktopSessionSummary[] =>
  state.sessions;
export const selectCatalogRevision = (state: SessionCatalogState): number => state.revision;
export const selectActiveSessionId = (state: SessionCatalogState): string | undefined =>
  state.activeSessionId;

/**
 * The ids in the catalog, by value. A refresh replaces every row object even
 * when nothing about the membership moved (#2913), so an identity-only
 * selection would re-render every reader that only cares about which sessions
 * exist.
 */
export const selectAuthoritativeSessionIds = (state: SessionCatalogState): ReadonlySet<string> =>
  new Set(state.sessions.map(({ id }) => id));

/**
 * Owns the controller for the component's lifetime. Deliberately does NOT
 * subscribe: readers select what they need through `useExternalStoreSelector`.
 */
export function useSessionCatalogController(): SessionCatalogController {
  const controllerRef = useRef<SessionCatalogController | null>(null);
  if (!controllerRef.current) controllerRef.current = createSessionCatalogController();
  return controllerRef.current;
}
