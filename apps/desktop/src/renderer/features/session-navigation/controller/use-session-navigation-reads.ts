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

import { useExternalStoreSelector } from '../../../application/contracts/session-catalog/use-external-store-selector.js';
import type { SessionCatalogState } from '../../../application/contracts/session-catalog/session-catalog-state.js';
import type { SessionCatalogController } from '../../../application/contracts/session-catalog/session-catalog-state.js';
import { deriveBranchBanner, type BranchBanner } from '../model/branch-banner.js';
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
  branchBanner: BranchBanner | undefined;
  revisionNavigation: SessionRevisionNavigation | undefined;
  /** The active Session's parent row, for the titlebar breadcrumb. */
  activeParentSession: SessionNavigationSession | undefined;
  layout: SessionRailLayoutState;
}

const selectBranchBanner = (
  state: SessionCatalogState,
  activeSessionId: string | undefined,
): BranchBanner | undefined =>
  deriveBranchBanner(
    activeSessionId === undefined
      ? undefined
      : state.sessions.find((session) => session.id === activeSessionId),
    state.sessions,
  );

const selectRevisionNavigation = (
  state: SessionCatalogState,
  activeSessionId: string | undefined,
): SessionRevisionNavigation | undefined =>
  deriveSessionRevisionNavigation(state.sessions, activeSessionId);

const selectActiveParentSession = (
  state: SessionCatalogState,
  activeSessionId: string | undefined,
): SessionNavigationSession | undefined => {
  const parentSessionId = state.sessions.find(
    (session) => session.id === activeSessionId,
  )?.parentSessionId;
  return parentSessionId === undefined
    ? undefined
    : state.sessions.find((session) => session.id === parentSessionId);
};

function branchBannersEqual(
  left: BranchBanner | undefined,
  right: BranchBanner | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.parentSessionId === right.parentSessionId
    && left.parentSessionName === right.parentSessionName
    && left.fromAbortedTurn === right.fromAbortedTurn;
}

function revisionNavigationsEqual(
  left: SessionRevisionNavigation | undefined,
  right: SessionRevisionNavigation | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.current === right.current
    && left.total === right.total
    && left.previousSessionId === right.previousSessionId
    && left.nextSessionId === right.nextSessionId;
}

/**
 * What the shell reads from Session Navigation, as opposed to what it owns.
 *
 * Each reading is its own selector with value equality, so a background
 * Session's catalog churn re-renders the shell only when the reading the
 * shell actually displays changes — the rail itself is not read here at all:
 * it subscribes the catalog inside `SessionNavigationProvider`, where the
 * churn it displays belongs (#4109).
 */
export function useSessionNavigationReads(input: {
  catalog: SessionCatalogController;
  activeSessionId: string | undefined;
}): SessionNavigationReads {
  const { activeSessionId, catalog } = input;
  const branchBanner = useExternalStoreSelector(
    catalog,
    selectBranchBanner,
    activeSessionId,
    branchBannersEqual,
  );
  const revisionNavigation = useExternalStoreSelector(
    catalog,
    selectRevisionNavigation,
    activeSessionId,
    revisionNavigationsEqual,
  );
  const activeParentSession = useExternalStoreSelector(
    catalog,
    selectActiveParentSession,
    activeSessionId,
  );
  const layout = useExternalStoreSelector(sessionRailLayoutStore, selectRailLayout);
  return { branchBanner, revisionNavigation, activeParentSession, layout };
}
