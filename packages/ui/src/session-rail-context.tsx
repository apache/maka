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

import { createContext, useContext, type ReactNode, type Ref } from 'react';
import type { ScheduledTask } from '@maka/core/scheduled-task';
import type { SessionSummary } from '@maka/core/session';
import type { SideNavImperativeCollapseHandle } from '@astryxdesign/core/SideNav';
import type { NavModuleMemory, NavSelection } from './nav-selection.js';
import type {
  ProjectRowActions,
  SessionHistoryGroup,
  SessionRowActions,
} from './session-history-list.js';
import type { SidebarUpdateReminder } from './session-sidebar-nav.js';

export type SessionViewMode = 'conversation' | 'project';

/**
 * What the rail's rows are made of.
 *
 * One declaration, read by the list and by every row under it. It used to be
 * the same eleven props redeclared at each of `SessionListPanel`,
 * `SessionHistoryList` and `SessionListGroups`, threaded by hand and kept
 * identity-stable by hand, because the state lived above the whole shell and
 * had no other way down (#4109). Read from here it has one producer, so its
 * identity is the producer's business alone: hold this value still and the
 * ~1,000 fibers below do not render.
 */
export interface SessionRailData {
  sessions: readonly SessionSummary[];
  activeId?: string;
  streamingSessionIds?: ReadonlySet<string>;
  staleSessionIds?: ReadonlySet<string>;
  worktreeSessionIds?: ReadonlySet<string>;
  /** Pre-grouped rows. Absent means group by recency here. */
  groups?: ReadonlyArray<SessionHistoryGroup>;
  groupVariant: SessionViewMode;
  sessionMeta?(session: SessionSummary): string | undefined;
  onSelectSession(sessionId: string): void;
  rowActions?: SessionRowActions;
  projectActions?: ProjectRowActions;
}

/**
 * The rail's permanent chrome: the nav above the list, the footer below it, and
 * the column's own geometry.
 *
 * Deliberately a SECOND context rather than more fields on `SessionRailData`.
 * These follow the shell — which section is selected, whether an update is
 * waiting — and they change far more often than the list does, while costing a
 * few dozen fibers against the list's thousand. Splitting them is what lets the
 * chrome follow the shell without dragging the list with it.
 */
export interface SessionRailChrome {
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
  collapseHandleRef?: Ref<SideNavImperativeCollapseHandle>;
  width: number;
  onWidthChange(width: number): void;
  minWidth: number;
  maxWidth: number;
  viewMode: SessionViewMode;
  onViewModeChange?(mode: SessionViewMode): void;
  selection: NavSelection;
  scheduledTasks?: readonly ScheduledTask[];
  moduleMemory?: NavModuleMemory;
  onSelect(selection: NavSelection): void;
  onNew(): void;
  onOpenSettings(): void;
  updateReminder?: SidebarUpdateReminder;
  onOpenUpdate?(): void;
  workHubEntry?: {
    active: boolean;
    label: string;
    onSelect(): void;
  };
}

const SessionRailDataContext = createContext<SessionRailData | null>(null);
const SessionRailChromeContext = createContext<SessionRailChrome | null>(null);

/**
 * `chrome` is optional so the list can be rendered on its own — a test or a
 * story about rows has no permanent chrome to describe, and inventing one would
 * be describing something it is not asserting.
 */
export function SessionRailProvider(props: {
  data: SessionRailData;
  chrome?: SessionRailChrome;
  children?: ReactNode;
}) {
  return (
    <SessionRailDataContext.Provider value={props.data}>
      <SessionRailChromeContext.Provider value={props.chrome ?? null}>
        {props.children}
      </SessionRailChromeContext.Provider>
    </SessionRailDataContext.Provider>
  );
}

export function useSessionRailData(): SessionRailData {
  const data = useContext(SessionRailDataContext);
  if (!data) throw new Error('SessionRailProvider is missing');
  return data;
}

export function useSessionRailChrome(): SessionRailChrome {
  const chrome = useContext(SessionRailChromeContext);
  if (!chrome) throw new Error('SessionRailProvider is missing');
  return chrome;
}
