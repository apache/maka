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

import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import type { ProjectRecord } from '@maka/core/project';
import type { ScheduledTask } from '@maka/core/scheduled-task';
import {
  SessionRailProvider,
  type NavModuleMemory,
  type NavSelection,
  type ProjectRowActions,
  type SessionRailChrome,
  type SessionRailData,
  type SessionRowActions,
  type SidebarUpdateReminder,
} from '@maka/ui';
import {
  useSessionNavigationController,
  type SessionNavigationPorts,
} from '../controller/use-session-navigation-controller.js';
import type { SessionNavigationRowActions } from '../controller/session-row-actions.js';
import {
  SESSION_LIST_EXPANDED_MAX_WIDTH,
  SESSION_LIST_EXPANDED_MIN_WIDTH,
} from '../model/session-list-layout.js';
import type { SessionRailProjection } from '../model/session-rail.js';
import { sessionRailLayoutStore } from '../model/session-rail-layout-store.js';
import type { SessionNavigationSession } from '../ports.js';

/** The chrome the shell owns and the rail only displays. */
export interface SessionNavigationChromeInput {
  selection: NavSelection;
  scheduledTasks?: readonly ScheduledTask[];
  moduleMemory?: NavModuleMemory;
  updateReminder?: SidebarUpdateReminder;
  workHubActive: boolean;
  workHubEntry?: { active: boolean; label: string; onSelect(): void };
  projectActions?: ProjectRowActions;
  onSelect(selection: NavSelection): void;
  onOpenSettings(): void;
  onOpenUpdate?(): void;
  onNew(): void;
  onExitWorkHub(): void;
  onSelectSession(sessionId: string): void;
}

export interface SessionNavigationProviderProps extends SessionNavigationChromeInput {
  rail: SessionRailProjection<SessionNavigationSession>;
  projects: readonly ProjectRecord[];
  streamingSessionIds: ReadonlySet<string>;
  staleSessionIds: ReadonlySet<string>;
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
  const controller = useSessionNavigationController({
    rail: props.rail,
    projects: props.projects,
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
      onDelete: (sessionId) => {
        void controller.commands.deleteSession(sessionId);
      },
    }),
    [controller.commands],
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
            onNew: (projectId) => chromeRef.current.projectActions?.onNew(projectId),
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

  const data = useMemo<SessionRailData>(
    () => ({
      sessions: props.rail.sessions,
      activeId: props.workHubActive ? undefined : props.rail.activeRowId,
      streamingSessionIds: props.streamingSessionIds,
      staleSessionIds: props.staleSessionIds,
      worktreeSessionIds: controller.selectors.worktreeSessionIds,
      groups: controller.layout.viewMode === 'project' ? controller.selectors.groups : undefined,
      groupVariant: controller.layout.viewMode,
      sessionMeta: controller.selectors.sessionMeta,
      onSelectSession: props.onSelectSession,
      rowActions,
      projectActions,
    }),
    [
      controller.layout.viewMode,
      controller.selectors.groups,
      controller.selectors.sessionMeta,
      controller.selectors.worktreeSessionIds,
      props.onSelectSession,
      projectActions,
      props.rail,
      props.staleSessionIds,
      props.streamingSessionIds,
      props.workHubActive,
      rowActions,
    ],
  );

  // Deliberately NOT memoized. Its readers are the nav rows and the footer —
  // a few dozen fibers — and every field on it follows the shell, so a
  // comparator here would run more often than it would save.
  const chrome: SessionRailChrome = {
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
    updateReminder: props.updateReminder,
    onOpenUpdate: props.onOpenUpdate,
    workHubEntry: props.workHubEntry,
  };

  return (
    <SessionRailProvider
      data={data}
      chrome={chrome}
      selection={controller.selection}
      rowSelection={controller.rowSelection}
    >
      {props.children}
    </SessionRailProvider>
  );
}
