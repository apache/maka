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
  /** Human-readable project identity for a session hover card. */
  sessionProjectName?(session: SessionSummary): string | undefined;
  sessionMeta?(session: SessionSummary): string | undefined;
  sessionBadge?(session: SessionSummary): ReactNode;
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

/** What a click on a session row means, decided by the modifier held with it. */
export type SessionRowPick =
  /**
   * Plain click, and the adoption a menu makes when it opens on an unpicked
   * row: the set becomes exactly this row. Opening the task is the row's own
   * business — this names what happens to the SET.
   */
  | 'replace'
  /** ⌘/Ctrl: add or remove this one row, leaving the rest of the set alone. */
  | 'toggle'
  /** Shift: pick the contiguous run between the anchor and this row. */
  | 'range';

/**
 * The commands a picked set can be asked for, held apart from the set itself so
 * their identity never moves.
 *
 * Rows receive these as a prop rather than reading them from context. A context
 * consumer re-renders whenever the value it subscribes to changes and `memo`
 * cannot stop it, and the set DOES change on an ordinary session switch now
 * that a plain click picks the row it opens — every row would redraw for a
 * switch that changed two of them, which is what the rail's render contract
 * budgets against (#4109).
 */
export interface SessionRailSelectionCommands {
  /**
   * One click on one row. `orderedSessionIds` is the rail's rendered order,
   * read from the DOM at the moment of the click, so a range knows how far it
   * may reach without any row having to carry the list around.
   */
  pick(input: {
    sessionId: string;
    pick: SessionRowPick;
    orderedSessionIds: readonly string[];
    /** The open task, which anchors a range when no click has set an anchor. */
    openSessionId?: string;
  }): void;
  /** Drops the picks. The open row stays open, and stays painted. */
  clear(): void;
  /**
   * Narrows the set to its intersection with `sessionIds`, anchor included.
   *
   * For the menu, and only for the menu: a sweep may act only on rows the user
   * could see and act on at the moment they pressed. A row does not have to
   * leave the rail to stop being one — collapsing its project keeps it mounted
   * and merely `inert`, and a session that becomes a shared projection loses
   * its actions in place — so `pruneSessionSelection` against the catalog, which
   * still lists both, cannot answer this.
   *
   * The invariant it buys: THE MENU MEANS THE SET IT NAMES. At the instant a
   * menu opens, the set becomes exactly the rows the user can see and act on,
   * and a pick that was folded away or turned into a shared projection leaves
   * it then — permanently, whether the menu is used or dismissed. Reopening the
   * project does not bring it back, because the set no longer holds it.
   *
   * Not narrowed when the project actually collapses, and not derived during
   * render, for the same reason: collapse is uncontrolled state inside Astryx's
   * `SideNavItem`, which the rail can only read back off the DOM. The menu's
   * entrance is the one moment that holds both the set and the DOM, and it is
   * also the single entrance to `archiveSelected` and `flagSelected` — so it is
   * where the two are reconciled.
   */
  retain(sessionIds: readonly string[]): void;
  /**
   * The rail's only sweep. There is no delete here: it cannot be undone, and it
   * belongs to Settings › 已归档任务, which can only reach a task that was
   * archived first.
   */
  archiveSelected(): void | Promise<void>;
  /** Pins or unpins the whole picked set. */
  flagSelected(flagged: boolean): void | Promise<void>;
}

/**
 * The rail's multi-select.
 *
 * A SECOND context beside `SessionRailData`, for the reason the chrome is a
 * third one: it changes as the user picks rows while the list does not, and
 * folding it into the data value would give that value a new identity per
 * click — the ~1,000-fiber render that split exists to prevent (#4109).
 *
 * Absent means the rail has no multi-select: rows navigate, nothing is picked,
 * and a surface that never wired it up renders exactly as before.
 */
export interface SessionRailSelection {
  selectedIds: ReadonlySet<string>;
  commands: SessionRailSelectionCommands;
}

const SessionRailDataContext = createContext<SessionRailData | null>(null);
const SessionRailChromeContext = createContext<SessionRailChrome | null>(null);
const SessionRailSelectionContext = createContext<SessionRailSelection | null>(null);

/**
 * `chrome` is optional so the list can be rendered on its own — a test or a
 * story about rows has no permanent chrome to describe, and inventing one would
 * be describing something it is not asserting.
 */
export function SessionRailProvider(props: {
  data: SessionRailData;
  chrome?: SessionRailChrome;
  selection?: SessionRailSelection;
  children?: ReactNode;
}) {
  return (
    <SessionRailDataContext.Provider value={props.data}>
      <SessionRailChromeContext.Provider value={props.chrome ?? null}>
        <SessionRailSelectionContext.Provider value={props.selection ?? null}>
          {props.children}
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
