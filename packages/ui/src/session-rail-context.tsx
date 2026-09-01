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

/**
 * What a ROW reads: whether the mode is on, whether this row is marked, and the
 * two ways a row changes that.
 *
 * Split from `SessionRailSelection` because a context consumer re-renders
 * whenever the value it subscribes to changes, and `memo` cannot stop it. The
 * wide value carries `listedSessionIds`, which is derived from the catalog and
 * gets a fresh identity on a session switch — a row reading that would
 * re-render along with every other row for a switch that changed two of them.
 * The e2e render contract measures exactly this and budgets 2 rows (#4109).
 *
 * This half moves only when the selection itself does.
 */
export interface SessionRailRowSelection {
  active: boolean;
  selectedIds: ReadonlySet<string>;
  onToggleRow(sessionId: string, selected: boolean): void;
  onEnter(sessionId?: string): void;
}

/**
 * What the selection BAR reads: the row half plus everything only the bar
 * needs — what "all" means, the sweeps, and whether one is running.
 *
 * A THIRD context, for the reason the chrome is a second one: it changes as the
 * user marks rows while the list does not, and folding it into
 * `SessionRailData` would give that value a new identity per click — the
 * ~1,000-fiber render that split exists to prevent (#4109).
 *
 * Absent means the rail has no multi-select: rows navigate, nothing marks, and
 * a surface that never wired it up renders exactly as before.
 */
export interface SessionRailSelection {
  /**
   * Whether the rail is in selection mode: rows carry a checkbox and the master
   * row is above them. Distinct from an empty `selectedIds` — unticking the
   * master box selects none, it does not leave.
   */
  active: boolean;
  selectedIds: ReadonlySet<string>;
  /** Every row the rail is listing, in rendered order. What "all" means. */
  listedSessionIds: readonly string[];
  onToggleRow(sessionId: string, selected: boolean): void;
  onEnter(sessionId?: string): void;
  /** Leaves the mode and drops what was marked. */
  onExit(): void;
  onToggleAll(selected: boolean): void;
  onArchiveSelected(): void | Promise<void>;
  onDeleteSelected(): void | Promise<void>;
  /** A sweep is running. The commands disable while one is, so a second click
   *  cannot ask for the same set twice. */
  busy?: boolean;
}

const SessionRailDataContext = createContext<SessionRailData | null>(null);
const SessionRailChromeContext = createContext<SessionRailChrome | null>(null);
const SessionRailSelectionContext = createContext<SessionRailSelection | null>(null);
const SessionRailRowSelectionContext = createContext<SessionRailRowSelection | null>(null);

/**
 * `chrome` is optional so the list can be rendered on its own — a test or a
 * story about rows has no permanent chrome to describe, and inventing one would
 * be describing something it is not asserting.
 */
export function SessionRailProvider(props: {
  data: SessionRailData;
  chrome?: SessionRailChrome;
  selection?: SessionRailSelection;
  /**
   * The rows' half. Supplied separately rather than derived here so its
   * identity is the producer's business: deriving it in this component would
   * rebuild it on every render of the tree above, which is the churn the split
   * exists to avoid.
   */
  rowSelection?: SessionRailRowSelection;
  children?: ReactNode;
}) {
  return (
    <SessionRailDataContext.Provider value={props.data}>
      <SessionRailChromeContext.Provider value={props.chrome ?? null}>
        <SessionRailSelectionContext.Provider value={props.selection ?? null}>
          <SessionRailRowSelectionContext.Provider value={props.rowSelection ?? null}>
            {props.children}
          </SessionRailRowSelectionContext.Provider>
        </SessionRailSelectionContext.Provider>
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

/**
 * Null rather than throwing, unlike the other two: multi-select is optional
 * chrome, and a rail without it is a rail, not a misconfiguration.
 */
export function useSessionRailSelection(): SessionRailSelection | null {
  return useContext(SessionRailSelectionContext);
}

/** What a row reads. Null when the rail has no multi-select. */
export function useSessionRailRowSelection(): SessionRailRowSelection | null {
  return useContext(SessionRailRowSelectionContext);
}
