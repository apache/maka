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

import { useMemo, type ComponentProps } from 'react';
import { SessionListPanel } from '@maka/ui';
import type { SessionNavigationController } from '../controller/use-session-navigation-controller.js';
import {
  SESSION_LIST_EXPANDED_MAX_WIDTH,
  SESSION_LIST_EXPANDED_MIN_WIDTH,
} from '../model/session-list-layout.js';

type PanelProps = ComponentProps<typeof SessionListPanel>;

export type SessionNavigationHostProps = Pick<
  PanelProps,
  | 'selection'
  | 'scheduledTasks'
  | 'streamingSessionIds'
  | 'staleSessionIds'
  | 'moduleMemory'
  | 'onSelect'
  | 'onOpenSettings'
  | 'updateReminder'
  | 'onOpenUpdate'
  | 'onNew'
  | 'workHubEntry'
  | 'projectActions'
> & {
  controller: SessionNavigationController;
  onExitWorkHub(): void;
  workHubActive: boolean;
};

/** Renders the complete Session navigation rail from its feature controller. */
export function SessionNavigationHost(props: SessionNavigationHostProps) {
  const { controller } = props;
  const rowActions = useMemo<NonNullable<PanelProps['rowActions']>>(
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

  return (
    <SessionListPanel
      collapseHandleRef={controller.layout.collapseHandleRef}
      collapsed={controller.layout.collapsed}
      onCollapsedChange={controller.layout.setCollapsed}
      width={controller.layout.width}
      onWidthChange={(width) => {
        if (width >= SESSION_LIST_EXPANDED_MIN_WIDTH) {
          controller.layout.setWidth(width);
        }
      }}
      minWidth={SESSION_LIST_EXPANDED_MIN_WIDTH}
      maxWidth={SESSION_LIST_EXPANDED_MAX_WIDTH}
      selection={props.selection}
      sessions={controller.selectors.visibleSessions}
      activeId={props.workHubActive ? undefined : controller.selectors.activeRowId}
      scheduledTasks={props.scheduledTasks}
      streamingSessionIds={props.streamingSessionIds}
      staleSessionIds={props.staleSessionIds}
      viewMode={controller.layout.viewMode}
      onViewModeChange={controller.layout.setViewMode}
      groups={
        controller.layout.viewMode === 'project'
          ? controller.selectors.groups
          : undefined
      }
      worktreeSessionIds={controller.selectors.worktreeSessionIds}
      sessionMeta={controller.selectors.sessionMeta}
      moduleMemory={props.moduleMemory}
      onSelect={(selection) => {
        props.onExitWorkHub();
        props.onSelect(selection);
      }}
      onSelectSession={controller.commands.openSession}
      onOpenSettings={props.onOpenSettings}
      updateReminder={props.updateReminder}
      onOpenUpdate={props.onOpenUpdate}
      onNew={() => {
        props.onExitWorkHub();
        props.onNew();
      }}
      workHubEntry={props.workHubEntry}
      rowActions={rowActions}
      projectActions={props.projectActions}
    />
  );
}
