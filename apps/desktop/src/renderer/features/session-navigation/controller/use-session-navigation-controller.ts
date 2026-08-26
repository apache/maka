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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { ProjectRecord } from '@maka/core/project';
import type { SessionSummary } from '@maka/core/session';
import type { SideNavImperativeCollapseHandle } from '@astryxdesign/core/SideNav';
import { useUiLocale, type SessionHistoryGroup, type SessionViewMode } from '@maka/ui';
import { safeLocalStorageSet } from '../../../browser-storage.js';
import { useStableActions } from '../../../use-stable-actions.js';
import type { BranchBanner } from '../model/branch-banner.js';
import { deriveBranchBanner } from '../model/branch-banner.js';
import {
  readSessionListCollapsed,
  readSessionListViewMode,
  readSessionListWidth,
  SESSION_LIST_EXPANDED_MAX_WIDTH,
  SESSION_LIST_EXPANDED_MIN_WIDTH,
  writeSessionListViewMode,
} from '../model/session-list-layout.js';
import { deriveSessionNavigationGroups } from '../model/session-navigation-groups.js';
import { sessionMatchesRail } from '../model/session-nav-filter.js';
import { deriveWorktreeSessionIds } from '../model/session-project-grouping.js';
import { deriveSessionRail } from '../model/session-rail.js';
import {
  deriveSessionRevisionNavigation,
  type SessionRevisionNavigation,
} from '../model/session-revisions.js';
import type { SessionNavigationSession } from '../ports.js';
import { useSessionNavigationServices } from '../services-context.js';
import {
  createSessionNavigationRowActions,
  type SessionNavigationRowActions,
} from './session-row-actions.js';

const LAYOUT_PERSIST_DEBOUNCE_MS = 200;

export type SessionNavigationSearchTarget = {
  sessionId: string;
  turnId: string;
  sequence?: number;
  nonce: number;
};

export type SessionNavigationToastApi = {
  success(title: string, description?: string): void;
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string },
  ): void;
  confirm(options: {
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel: string;
    destructive?: boolean;
  }): Promise<boolean>;
};

export interface UseSessionNavigationControllerInput {
  sessions: readonly SessionNavigationSession[];
  activeSessionId: string | undefined;
  hiddenSessionIds: ReadonlySet<string>;
  projects: readonly ProjectRecord[];
  activateSession(sessionId: string | undefined): void;
  clearActiveMessages(): void;
  clearSessionRendererState(sessionId: string): void;
  exitWorkHub(): void;
  refreshSessions(): Promise<ReadonlyArray<SessionNavigationSession>>;
  selectSessionSurface(): void;
  setSearchTarget(target: SessionNavigationSearchTarget | null): void;
  toastApi: SessionNavigationToastApi;
}

export interface SessionNavigationLayout {
  collapsed: boolean;
  width: number;
  viewMode: SessionViewMode;
  collapseHandleRef: RefObject<SideNavImperativeCollapseHandle | null>;
  setCollapsed: Dispatch<SetStateAction<boolean>>;
  setWidth(width: number): void;
  setViewMode(mode: SessionViewMode): void;
}

export interface SessionNavigationSelectors {
  visibleSessions: SessionNavigationSession[];
  activeRowId: string | undefined;
  activeParentSession: SessionNavigationSession | undefined;
  branchBanner: BranchBanner | undefined;
  revisionNavigation: SessionRevisionNavigation | undefined;
  groups: SessionHistoryGroup[];
  worktreeSessionIds: ReadonlySet<string>;
  sessionMeta(session: SessionSummary): string | undefined;
}

export interface SessionNavigationCommands extends SessionNavigationRowActions {
  openSession(sessionId: string, turnId?: string, sequence?: number): void;
}

export interface SessionNavigationController {
  layout: SessionNavigationLayout;
  selectors: SessionNavigationSelectors;
  commands: SessionNavigationCommands;
}

/** Owns Session rail projection, layout persistence, jumps, and row mutations. */
export function useSessionNavigationController(
  input: UseSessionNavigationControllerInput,
): SessionNavigationController {
  const locale = useUiLocale();
  const { sessions: service } = useSessionNavigationServices();
  const [width, setWidth] = useState(readSessionListWidth);
  const [collapsed, setCollapsed] = useState(readSessionListCollapsed);
  const [viewMode, setViewMode] = useState(readSessionListViewMode);
  const collapseHandleRef = useRef<SideNavImperativeCollapseHandle | null>(null);
  const activeIdRef = useRef(input.activeSessionId);
  const sessionsRef = useRef<ReadonlyArray<SessionNavigationSession>>(input.sessions);
  const pendingSessionRowActionsRef = useRef(new Set<string>());

  // Row actions can settle after the render that created them. Publish the
  // catalog/selection pair only when that render commits so an interrupted
  // concurrent render cannot leak an uncommitted snapshot to a live action.
  useLayoutEffect(() => {
    activeIdRef.current = input.activeSessionId;
    sessionsRef.current = input.sessions;
  }, [input.activeSessionId, input.sessions]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      safeLocalStorageSet('maka-chat-list-width-v1', String(width));
    }, LAYOUT_PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [width]);

  useEffect(() => {
    safeLocalStorageSet(
      'maka-chat-list-collapsed-v1',
      collapsed ? 'true' : 'false',
    );
  }, [collapsed]);

  useEffect(() => {
    writeSessionListViewMode(viewMode);
  }, [viewMode]);

  const rowActions = useStableActions(createSessionNavigationRowActions, {
    uiLocale: locale,
    activeIdRef,
    clearActiveMessages: input.clearActiveMessages,
    clearSessionRendererState: input.clearSessionRendererState,
    pendingSessionRowActionsRef,
    refreshSessions: input.refreshSessions,
    service,
    sessionsRef,
    setActiveId: input.activateSession,
    toastApi: input.toastApi,
  });

  const openSession = useCallback(
    (sessionId: string, turnId?: string, sequence?: number): void => {
      input.exitWorkHub();
      input.selectSessionSurface();
      input.activateSession(sessionId);
      input.setSearchTarget(
        turnId
          ? { sessionId, turnId, sequence, nonce: Date.now() }
          : null,
      );
    },
    [
      input.activateSession,
      input.exitWorkHub,
      input.selectSessionSurface,
      input.setSearchTarget,
    ],
  );

  const rail = useMemo(
    () =>
      deriveSessionRail(input.sessions, input.activeSessionId, (session) =>
        !input.hiddenSessionIds.has(session.id) && sessionMatchesRail(session),
      ),
    [input.activeSessionId, input.hiddenSessionIds, input.sessions],
  );
  const groups = useMemo(
    () => deriveSessionNavigationGroups(rail.sessions, input.projects, locale),
    [locale, input.projects, rail.sessions],
  );
  const worktreeSessionIds = useMemo(
    () =>
      deriveWorktreeSessionIds(
        rail.sessions.filter((session) => session.profileKind !== 'remote'),
        input.projects,
      ),
    [input.projects, rail.sessions],
  );
  const activeSession = input.sessions.find(
    (session) => session.id === input.activeSessionId,
  );
  const branchBanner = useMemo(
    () => deriveBranchBanner(activeSession, input.sessions),
    [activeSession, input.sessions],
  );
  const revisionNavigation = useMemo(
    () => deriveSessionRevisionNavigation(input.sessions, input.activeSessionId),
    [input.activeSessionId, input.sessions],
  );
  const sessionById = useMemo(
    () => new Map(input.sessions.map((session) => [session.id, session])),
    [input.sessions],
  );
  const sessionMeta = useCallback(
    (session: SessionSummary): string | undefined => {
      const projected = sessionById.get(session.id);
      return projected?.profileKind === 'remote'
        ? projected.profileName
        : undefined;
    },
    [sessionById],
  );

  const layout = useMemo<SessionNavigationLayout>(
    () => ({
      collapsed,
      width,
      viewMode,
      collapseHandleRef,
      setCollapsed,
      setWidth,
      setViewMode,
    }),
    [collapsed, viewMode, width],
  );
  const selectors = useMemo<SessionNavigationSelectors>(
    () => ({
      visibleSessions: rail.sessions,
      activeRowId: rail.activeRowId,
      activeParentSession: rail.activeParentSession,
      branchBanner,
      revisionNavigation,
      groups,
      worktreeSessionIds,
      sessionMeta,
    }),
    [branchBanner, groups, rail, revisionNavigation, sessionMeta, worktreeSessionIds],
  );
  const commands = useMemo<SessionNavigationCommands>(
    () => ({
      ...rowActions,
      openSession,
    }),
    [openSession, rowActions],
  );

  return useMemo(
    () => ({ layout, selectors, commands }),
    [commands, layout, selectors],
  );
}
