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

import { useMemo } from 'react';
import { useExternalStoreSelector } from '../../../use-external-store-selector.js';
import { deriveBranchBanner, type BranchBanner } from '../model/branch-banner.js';
import { sessionMatchesRail } from '../model/session-nav-filter.js';
import { deriveSessionRail, type SessionRailProjection } from '../model/session-rail.js';
import {
  selectRailLayout,
  sessionRailLayoutStore,
  type SessionRailLayoutState,
} from '../model/session-rail-layout-store.js';
import {
  deriveSessionRevisionNavigation,
  type SessionRevisionNavigation,
} from '../model/session-revisions.js';
import type { SessionNavigationSession } from '../ports.js';

export interface SessionNavigationReads {
  /** The rail's membership, derived once and shared with the command palette. */
  rail: SessionRailProjection<SessionNavigationSession>;
  branchBanner: BranchBanner | undefined;
  revisionNavigation: SessionRevisionNavigation | undefined;
  layout: SessionRailLayoutState;
}

/**
 * What the shell reads from Session Navigation, as opposed to what it owns.
 *
 * Nothing here holds state: three `useMemo`s over the catalog the shell already
 * has, and one subscription to the rail's geometry — which the window frame
 * needs, because `--maka-sidenav-width` is where the titlebar's breadcrumb
 * starts. The rail's own state lives under `SessionNavigationProvider` and is
 * not visible from here, which is the point of #4109: a hook called in the
 * shell's render body has the whole tree as its scope, so the ones that remain
 * had better hold nothing.
 */
export function useSessionNavigationReads(input: {
  sessions: readonly SessionNavigationSession[];
  activeSessionId: string | undefined;
  activeSession: SessionNavigationSession | undefined;
  hiddenSessionIds: ReadonlySet<string>;
}): SessionNavigationReads {
  const { activeSession, activeSessionId, hiddenSessionIds, sessions } = input;
  const rail = useMemo(
    () =>
      deriveSessionRail(sessions, activeSessionId, (session) =>
        !hiddenSessionIds.has(session.id) && sessionMatchesRail(session),
      ),
    [activeSessionId, hiddenSessionIds, sessions],
  );
  const branchBanner = useMemo(
    () => deriveBranchBanner(activeSession, sessions),
    [activeSession, sessions],
  );
  const revisionNavigation = useMemo(
    () => deriveSessionRevisionNavigation(sessions, activeSessionId),
    [activeSessionId, sessions],
  );
  const layout = useExternalStoreSelector(sessionRailLayoutStore, selectRailLayout);
  return { rail, branchBanner, revisionNavigation, layout };
}
