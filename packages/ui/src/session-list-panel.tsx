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
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { SideNav } from '@astryxdesign/core/SideNav';
import { SessionHistoryList } from './session-history-list.js';
import { SessionSelectionBar } from './session-selection-bar.js';
import {
  useSessionRailChrome,
  type SessionViewMode,
} from './session-rail-context.js';
import {
  SessionSidebarFooter,
  SessionSidebarNav,
} from './session-sidebar-nav.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

/**
 * One element, created once, for the ~1,000 fibers below it.
 *
 * The list takes no props — it reads `SessionRailData` — so this element never
 * needs rebuilding, and React skips the whole subtree whenever the panel around
 * it re-renders for chrome that changed. That is the boundary; there is no
 * `memo` comparator, because there is nothing to compare (#4109).
 */
const SESSION_HISTORY_LIST = <SessionHistoryList />;

/** The Session rail: permanent chrome around the history list. */
export function SessionListPanel() {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const chrome = useSessionRailChrome();
  const { collapsed, viewMode, onViewModeChange } = chrome;

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
        handleRef={chrome.collapseHandleRef}
        className="maka-session-panel agents-sidebar"
        aria-label={copy.listAriaLabel}
        collapsible={{
          isCollapsed: collapsed,
          onCollapsedChange: chrome.onCollapsedChange,
          hasButton: false,
        }}
        resizable={{
          defaultWidth: chrome.width,
          minWidth: chrome.minWidth,
          maxWidth: chrome.maxWidth,
          onWidthChange: chrome.onWidthChange,
        }}
        // Permanent chrome stays sticky via SideNav topContent; only history
        // scrolls in children (Astryx five-zone model). The section inside owns
        // the rows' rhythm; its title is hidden because the rail landmark
        // already names the panel on screen, and stays for assistive tech.
        topContent={
          <>
            <SessionSidebarNav />
            {groupingSwitch}
          </>
        }
        footer={<SessionSidebarFooter />}
      >
        {/* The selection bar belongs to the LIST, not to the chrome, and is
            rendered here rather than in `topContent` for that reason. SideNav
            draws one hairline under the whole top region, so a bar up there
            landed above that line — grouped with 按时间 / 按项目 and cut off
            from the rows it governs, with its own hairline making a second line
            9px from the first.

            It is `position: sticky` inside the scroller instead, so it still
            does not scroll away while the user marks rows further down.

            `SESSION_HISTORY_LIST` keeps its element identity through this
            fragment, so a selection change still skips the ~1,000 fibers under
            it (#4109). */}
        {!collapsed ? (
          <>
            <SessionSelectionBar />
            {SESSION_HISTORY_LIST}
          </>
        ) : null}
      </SideNav>
    </div>
  );
}
