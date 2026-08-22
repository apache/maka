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

import type { ScheduledTask } from '@maka/core/scheduled-task';
import type { SessionSummary } from '@maka/core/session';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { SideNav, type SideNavImperativeCollapseHandle } from '@astryxdesign/core/SideNav';
import type { NavModuleMemory, NavSelection } from './nav-selection.js';
import {
  SessionHistoryList,
  type ProjectRowActions,
  type SessionHistoryGroup,
  type SessionRowActions,
} from './session-history-list.js';
import {
  SessionSidebarFooter,
  SessionSidebarNav,
  type SidebarBuildStamp,
  type SidebarUpdateReminder,
} from './session-sidebar-nav.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';
import type { Ref } from 'react';

export type SessionViewMode = 'conversation' | 'project';

export function SessionListPanel(props: {
  collapsed?: boolean;
  onCollapsedChange?(collapsed: boolean): void;
  /* The rail's collapse is two pieces of state, not one: the boolean this shell
     owns, and the width Astryx's `useResizable` keeps behind `resizable`.
     Dragging the handle past Astryx's threshold zeroes that width and reports
     the collapse outward, so a toggle that only flips the boolean back leaves
     the rail expanded over a stored width of 0 — the next drag starts from
     zero. `toggle()` is the one call that moves both. */
  collapseHandleRef?: Ref<SideNavImperativeCollapseHandle>;
  width?: number;
  onWidthChange?(width: number): void;
  minWidth?: number;
  maxWidth?: number;
  selection: NavSelection;
  sessions: SessionSummary[];
  activeId?: string;
  scheduledTasks?: ScheduledTask[];
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
  groups?: ReadonlyArray<SessionHistoryGroup>;
  worktreeSessionIds?: ReadonlySet<string>;
  sessionMeta?(session: SessionSummary): string | undefined;
  projectActions?: ProjectRowActions;
  viewMode?: SessionViewMode;
  onViewModeChange?: (mode: SessionViewMode) => void;
  onSelectSession(sessionId: string): void;
  moduleMemory?: NavModuleMemory;
  onSelect(selection: NavSelection): void;
  onOpenSettings(): void;
  buildStamp?: SidebarBuildStamp;
  updateReminder?: SidebarUpdateReminder;
  onOpenUpdate?(): void;
  onNew(): void;
  rowActions?: SessionRowActions;
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const {
    collapsed = false,
    onCollapsedChange = () => {},
    width = 260,
    onWidthChange = () => {},
    minWidth = 180,
    maxWidth = 480,
    viewMode = 'conversation',
    onViewModeChange,
    groups,
  } = props;

  // A view switch, not a command: two exclusive ways to read the same list.
  // Astryx spends a SegmentedControl on exactly this — see its own file-explorer
  // and ide templates. Both axes stay on screen and the current one is visible
  // without opening anything, where the dropdown cost a click to answer "which
  // grouping am I in?" and then answered it with a radio dot.
  //
  // Text labels, not icons: a clock and a folder are two icons the rail has to
  // teach, and it never had anywhere to teach them — 按时间 / 按项目 is the
  // whole vocabulary and it fits. The control spans the rail's full width so
  // the two segments are one object with a visible current half, rather than a
  // pair of small buttons floating beside a title.
  //
  // It lives here, in the sticky top region, and NOT as a list heading's
  // endContent: the heading is gone (the rail landmark already names the panel,
  // so "会话" was a label for a list that is the only thing under it), and a
  // switch that scrolls away with the list it switches is a switch you have to
  // scroll back up to find. Collapsed at 48px there is no room for either
  // segment's label, and the list it governs is not rendered at all.
  const groupingSwitch = onViewModeChange && !collapsed ? (
    <div className="maka-session-grouping-switch">
      <SegmentedControl
        value={viewMode}
        onChange={(mode) => onViewModeChange(mode as SessionViewMode)}
        label={copy.groupingAriaLabel}
        size="sm"
        layout="fill"
      >
        <SegmentedControlItem value="conversation" label={copy.groupByTime} />
        <SegmentedControlItem value="project" label={copy.groupByProject} />
      </SegmentedControl>
    </div>
  ) : undefined;

  return (
    // Width easing needs an element that survives the collapse. SideNav swaps
    // its own root element type across the toggle — expanded it wraps the <nav>
    // in a positioned div for the overlay resize handle
    // (`showResizeHandle = isResizable && !collapsed`), collapsed it renders the
    // bare <nav> — so React unmounts that subtree and mounts a fresh one. A
    // transition declared on the nav has no start value to interpolate from and
    // the rail snaps. This wrapper is outside SideNav, so it is the same element
    // before and after; shell-layout.css eases ITS width and stretches whatever
    // SideNav mounted inside to match.
    //
    // The width itself comes from `--maka-sidenav-width`, which AppShell
    // publishes on `.appFrame` rather than this element writing it inline. The
    // frame is the only node that is an ancestor of both this column and the
    // window titlebar, and the titlebar has to know where this column ends: its
    // session breadcrumb starts at that edge so it lines up with the content
    // plate instead of straddling the seam between the two.
    <div className="maka-sidenav-motion">
      <SideNav
        handleRef={props.collapseHandleRef}
        className="maka-session-panel agents-sidebar"
        aria-label={copy.listAriaLabel}
        collapsible={{
          isCollapsed: collapsed,
          onCollapsedChange,
          hasButton: false,
        }}
        resizable={{
          defaultWidth: width,
          minWidth,
          maxWidth,
          onWidthChange,
        }}
        // Permanent chrome stays sticky via SideNav topContent; only history
        // scrolls in children (Astryx five-zone model). The section inside owns
        // the rows' rhythm; its title is hidden because the rail landmark
        // already names the panel on screen, and stays for assistive tech.
        topContent={
          <>
            <SessionSidebarNav
              selection={props.selection}
              scheduledTasks={props.scheduledTasks}
              moduleMemory={props.moduleMemory}
              onSelect={props.onSelect}
              onNew={props.onNew}
            />
            {groupingSwitch}
          </>
        }
        footer={
          <SessionSidebarFooter
            buildStamp={props.buildStamp}
            updateReminder={props.updateReminder}
            onOpenSettings={props.onOpenSettings}
            onOpenUpdate={props.onOpenUpdate}
          />
        }
      >
        {!collapsed ? (
          <SessionHistoryList
            sessions={props.sessions}
            activeId={props.activeId}
            streamingSessionIds={props.streamingSessionIds}
            staleSessionIds={props.staleSessionIds}
            groupVariant={viewMode}
            groups={groups}
            worktreeSessionIds={props.worktreeSessionIds}
            sessionMeta={props.sessionMeta}
            projectActions={props.projectActions}
            onSelectSession={props.onSelectSession}
            rowActions={props.rowActions}
          />
        ) : null}
      </SideNav>
    </div>
  );
}
