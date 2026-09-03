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

import { SessionListPanel } from '../src/session-list-panel.js';
import {
  SessionRailProvider,
  type SessionRailChrome,
  type SessionRailData,
  type SessionRailSelection,
} from '../src/session-rail-context.js';

export type SessionRailStoryProps = Partial<SessionRailData> &
  Partial<SessionRailChrome> &
  Pick<SessionRailData, 'sessions'> &
  Pick<SessionRailChrome, 'selection'> & {
    /**
     * The multi-select context, which the app supplies from
     * `useSessionSelection`. Named apart from `selection` because that one is
     * already the shell's NavSelection.
     */
    railSelection?: SessionRailSelection;
  };

/**
 * The rail, described as one flat bag of state.
 *
 * In the app the rail reads two contexts and takes no props, which is what
 * keeps the shell's renders off it. A story has no shell to be kept off, and
 * one state per story reads better than two objects, so the split happens here.
 */
export function SessionRail(props: SessionRailStoryProps) {
  const data: SessionRailData = {
    sessions: props.sessions,
    activeId: props.activeId,
    streamingSessionIds: props.streamingSessionIds,
    staleSessionIds: props.staleSessionIds,
    worktreeSessionIds: props.worktreeSessionIds,
    groups: props.groups,
    groupVariant: props.groupVariant ?? props.viewMode ?? 'conversation',
    sessionMeta: props.sessionMeta,
    onSelectSession: props.onSelectSession ?? (() => undefined),
    rowActions: props.rowActions,
    projectActions: props.projectActions,
  };
  const chrome: SessionRailChrome = {
    collapsed: props.collapsed ?? false,
    onCollapsedChange: props.onCollapsedChange ?? (() => undefined),
    collapseHandleRef: props.collapseHandleRef,
    width: props.width ?? 260,
    onWidthChange: props.onWidthChange ?? (() => undefined),
    minWidth: props.minWidth ?? 180,
    maxWidth: props.maxWidth ?? 480,
    viewMode: props.viewMode ?? 'conversation',
    onViewModeChange: props.onViewModeChange,
    selection: props.selection,
    scheduledTasks: props.scheduledTasks,
    moduleMemory: props.moduleMemory,
    onSelect: props.onSelect ?? (() => undefined),
    onNew: props.onNew ?? (() => undefined),
    onOpenSettings: props.onOpenSettings ?? (() => undefined),
    updateReminder: props.updateReminder,
    onOpenUpdate: props.onOpenUpdate,
    workHubEntry: props.workHubEntry,
  };
  return (
    <SessionRailProvider
      data={data}
      chrome={chrome}
      {...(props.railSelection ? { selection: props.railSelection } : {})}
    >
      <SessionListPanel />
    </SessionRailProvider>
  );
}
