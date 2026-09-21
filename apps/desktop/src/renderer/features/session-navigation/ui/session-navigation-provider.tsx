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
  useLayoutEffect,
  useMemo,
  useRef,
  type ComponentType,
  type ReactNode,
} from 'react';
import type { ScheduledTask } from '@maka/core/scheduled-task';
import {
  SessionRailProvider,
  type NavModuleMemory,
  type NavSelection,
  type ProjectRowActions,
  type SessionRailChrome,
  type SessionMoveTarget,
  type SessionRailData,
  type SessionRowActions,
} from '@maka/ui';
import { useSessionNavigationController } from '../controller/use-session-navigation-controller.js';
import type { SessionNavigationRowActions } from '../controller/session-row-actions.js';
import {
  SESSION_LIST_EXPANDED_MAX_WIDTH,
  SESSION_LIST_EXPANDED_MIN_WIDTH,
} from '../model/session-list-layout.js';
import { deriveSessionRail } from '../model/session-rail.js';
import { sessionMatchesRail } from '../model/session-nav-filter.js';
import { sessionRailLayoutStore } from '../model/session-rail-layout-store.js';
import {
  projectGroupId,
  ungroupedGroupId,
} from '../model/session-navigation-groups.js';
import type {
  SessionNavigationPorts,
  SessionNavigationProjectScope,
  SessionNavigationSession,
} from '../ports.js';
import { selectSessions, type SessionCatalogController } from '../../../application/contracts/session-catalog/session-catalog-state.js';
import { selectStaleSessionIds } from '../../../application/contracts/session-catalog/stale-sessions.js';
import { sessionIdSetsEqual } from '../../../application/contracts/session-catalog/session-id-set.js';
import { useExternalStoreSelector } from '../../../application/contracts/session-catalog/use-external-store-selector.js';
import type { SessionSendProjection } from '@maka/core/session-send-projection';

/** The chrome the shell owns and the rail only displays. */
export interface SessionNavigationChromeInput {
  NavigationExtras?: ComponentType<{ readonly onOpenSession: (sessionId: string) => void }>;
  selection: NavSelection;
  scheduledTasks?: readonly ScheduledTask[];
  moduleMemory?: NavModuleMemory;
  workHubActive: boolean;
  workHubEntry?: { active: boolean; label: string; onSelect(): void };
  projectActions?: ProjectRowActions;
  onSelect(selection: NavSelection): void;
  onOpenSettings(): void;
  onNew(): void;
  onExitWorkHub(): void;
  onSelectSession(sessionId: string): void;
  /**
   * Create a project from the rail's ＋. Absent when no host can make one, and
   * the heading then carries no ＋ at all.
   */
  onNewProject?: () => void;
}

export interface SessionNavigationProviderProps extends SessionNavigationChromeInput {
  /** The rail subscribes the catalog itself: its rows are the churn it displays. */
  catalog: SessionCatalogController;
  activeSessionId: string | undefined;
  hiddenSessionIds: ReadonlySet<string>;
  projectScopes: readonly SessionNavigationProjectScope[];
  streamingSessionIds: ReadonlySet<string>;
  sessionSendOutcomes?: Readonly<Record<string, SessionSendProjection>>;
  SessionBadge?: ComponentType<{ readonly sessionId: string }>;
  ports: SessionNavigationPorts;
  /**
   * Where the shell reads the row mutations it issues from elsewhere — the
   * archived-tasks sweep, the chat header's rename. They are calls made from
   * event handlers, never values read during a render, so a ref is the whole
   * carrier they need and the shell does not re-render to receive them.
   */
  commandsRef: { current: SessionNavigationRowActions | null };
  children?: ReactNode;
}

/**
 * The Session rail's own scope (#4109).
 *
 * The shell renders this on every one of its ~14 commits per session switch,
 * and that is fine: this component is one fiber, its `children` element is
 * built once by the shell, and React skips an unchanged child. What reaches the
 * rail below is the two context values — and those change when the rail's data
 * changes, not when the shell renders. The rail's ~1,000 fibers are on the
 * first, the few dozen fibers of permanent chrome on the second.
 */
export function SessionNavigationProvider(props: SessionNavigationProviderProps) {
  const sessions = useExternalStoreSelector(props.catalog, selectSessions);
  const staleSessionIds = useExternalStoreSelector(
    props.catalog,
    selectStaleSessionIds,
    props.sessionSendOutcomes,
    sessionIdSetsEqual,
  );
  const rail = useMemo(
    () =>
      deriveSessionRail(sessions, props.activeSessionId, (session) =>
        !props.hiddenSessionIds.has(session.id) && sessionMatchesRail(session),
      ),
    [sessions, props.activeSessionId, props.hiddenSessionIds],
  );
  const controller = useSessionNavigationController({
    rail,
    projectScopes: props.projectScopes,
    ports: props.ports,
  });

  useLayoutEffect(() => {
    props.commandsRef.current = controller.commands;
  }, [controller.commands, props.commandsRef]);

  const rowActions = useMemo<SessionRowActions>(
    () => ({
      onToggleFlag: (sessionId, next) => {
        void controller.commands.flagSession(sessionId, next);
      },
      onArchive: (sessionId) => {
        void controller.commands.archiveSession(sessionId);
      },
      onUnarchive: (sessionId) => {
        void controller.commands.unarchiveSession(sessionId);
      },
      onRename: (sessionId, name) => {
        void controller.commands.renameSession(sessionId, name);
      },
      onMoveToProject: (sessionId, projectId) => {
        void controller.commands.moveSessionToProject(sessionId, projectId);
      },
      // No `onDelete`: the rail cannot delete. `deleteSession` is still a
      // command, reached from Settings › 已归档任务, where the task has already
      // been archived once.
    }),
    [controller.commands],
  );

  // The rail draws a row for every Host's Projects, so a task may only be moved
  // among its own Host's — and only into a project that can receive one. Both
  // answers come from the same scopes, so the rows that carry the drop marker and
  // the destinations a task is offered cannot disagree.
  const moveDropGroupKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const scope of props.projectScopes) {
      if (scope.project.available && scope.project.archivedAt === undefined) {
        keys.add(projectGroupId(scope.key));
      }
    }
    for (const session of rail.sessions) {
      if (!session.projectId) keys.add(ungroupedGroupId(session.runtimeHostId));
    }
    return keys;
  }, [props.projectScopes, rail.sessions]);

  const moveTargets = useCallback(
    (sessionId: string): readonly SessionMoveTarget[] => {
      const session = rail.sessions.find((candidate) => candidate.id === sessionId);
      if (!session) return [];
      const targets: SessionMoveTarget[] = props.projectScopes
        .filter(
          (scope) =>
            scope.hostId === session.runtimeHostId &&
            scope.project.available &&
            scope.project.archivedAt === undefined,
        )
        .map((scope) => ({
          groupKey: projectGroupId(scope.key),
          projectId: scope.project.id,
          name: scope.project.name,
        }));
      if (session.projectId) {
        // The one row that means "leave every project". Its name is the rail's
        // to say, so none is given here.
        targets.push({
          groupKey: ungroupedGroupId(session.runtimeHostId),
          projectId: null,
        });
      }
      return targets;
    },
    [props.projectScopes, rail.sessions],
  );

  // Project row mutations are commands too, and they arrive from a different
  // feature entirely. Read through a ref for the same reason as the ports: what
  // the rail needs is that they can be CALLED, and their identity says nothing
  // about whether a row should be redrawn. Only their presence does, so that is
  // what this depends on.
  const chromeRef = useRef(props);
  useLayoutEffect(() => {
    chromeRef.current = props;
  });
  const hasProjectActions = props.projectActions !== undefined;
  const hasRelink = props.projectActions?.onRelink !== undefined;
  const projectActions = useMemo<ProjectRowActions | undefined>(
    () =>
      hasProjectActions
        ? {
            onNew: (projectId) => {
              chromeRef.current.onExitWorkHub();
              return chromeRef.current.projectActions?.onNew(projectId);
            },
            onRename: (projectId, name) =>
              chromeRef.current.projectActions?.onRename(projectId, name),
            onArchive: (projectId) => chromeRef.current.projectActions?.onArchive(projectId),
            onRestore: (projectId) => chromeRef.current.projectActions?.onRestore(projectId),
            ...(hasRelink
              ? {
                  onRelink: (projectId: string) =>
                    chromeRef.current.projectActions?.onRelink?.(projectId),
                }
              : {}),
          }
        : undefined,
    [hasProjectActions, hasRelink],
  );

  const sessionBadge = useMemo<SessionRailData['sessionBadge']>(() => {
    const SessionBadge = props.SessionBadge;
    return SessionBadge ? (session) => <SessionBadge sessionId={session.id} /> : undefined;
  }, [props.SessionBadge]);
  const relinkableProjectIds = useMemo(
    () =>
      new Set(
        props.projectScopes
          .filter((scope) => scope.capabilities.chooseClientDirectory)
          .map((scope) => scope.key),
      ),
    [props.projectScopes],
  );

  const data = useMemo<SessionRailData>(
    () => ({
      sessions: rail.sessions,
      activeId: props.workHubActive ? undefined : rail.activeRowId,
      streamingSessionIds: props.streamingSessionIds,
      staleSessionIds,
      worktreeSessionIds: controller.selectors.worktreeSessionIds,
      groups: controller.layout.viewMode === 'project' ? controller.selectors.groups : undefined,
      groupVariant: controller.layout.viewMode,
      sessionProjectName: controller.selectors.sessionProjectName,
      sessionMeta: controller.selectors.sessionMeta,
      sessionBadge,
      onSelectSession: props.onSelectSession,
      rowActions,
      projectActions,
      relinkableProjectIds,
      moveDropGroupKeys,
      moveTargets,
      onNewProject: props.onNewProject,
    }),
    [
      controller.layout.viewMode,
      controller.selectors.groups,
      controller.selectors.sessionMeta,
      controller.selectors.sessionProjectName,
      controller.selectors.worktreeSessionIds,
      props.onSelectSession,
      props.onNewProject,
      moveDropGroupKeys,
      moveTargets,
      projectActions,
      relinkableProjectIds,
      rail,
      staleSessionIds,
      props.streamingSessionIds,
      props.workHubActive,
      rowActions,
      sessionBadge,
    ],
  );

  // Deliberately NOT memoized. Its readers are the nav rows and the footer —
  // a few dozen fibers — and every field on it follows the shell, so a
  // comparator here would run more often than it would save.
  const chrome: SessionRailChrome = {
    auxiliaryNavigation: props.NavigationExtras
      ? <props.NavigationExtras onOpenSession={props.onSelectSession} /> : undefined,
    collapsed: controller.layout.collapsed,
    onCollapsedChange: sessionRailLayoutStore.setCollapsed,
    collapseHandleRef: sessionRailLayoutStore.collapseHandleRef,
    width: controller.layout.width,
    onWidthChange: sessionRailLayoutStore.setWidth,
    minWidth: SESSION_LIST_EXPANDED_MIN_WIDTH,
    maxWidth: SESSION_LIST_EXPANDED_MAX_WIDTH,
    viewMode: controller.layout.viewMode,
    onViewModeChange: sessionRailLayoutStore.setViewMode,
    selection: props.selection,
    scheduledTasks: props.scheduledTasks,
    moduleMemory: props.moduleMemory,
    onSelect: (selection) => {
      props.onExitWorkHub();
      props.onSelect(selection);
    },
    onNew: () => {
      props.onExitWorkHub();
      props.onNew();
    },
    onOpenSettings: props.onOpenSettings,
    workHubEntry: props.workHubEntry,
  };

  return (
    <SessionRailProvider
      data={data}
      chrome={chrome}
      selection={controller.selection}
    >
      {props.children}
    </SessionRailProvider>
  );
}
