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
import { SessionSidebarFooter, SessionSidebarNav, type SidebarUpdateReminder } from './session-sidebar-nav.js';
import { ICON_SIZE, Clock, FolderOpen } from './icons.js';
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
  projectActions?: ProjectRowActions;
  viewMode?: SessionViewMode;
  onViewModeChange?: (mode: SessionViewMode) => void;
  onSelectSession(sessionId: string): void;
  moduleMemory?: NavModuleMemory;
  onSelect(selection: NavSelection): void;
  onOpenSettings(): void;
  updateReminder?: SidebarUpdateReminder;
  onOpenUpdate?(): void;
  onNew(): void;
  onImport?(): void;
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
  // and ide templates, where the view mode sits inline as icon-only segments.
  // Both axes stay on screen and the current one is visible without opening
  // anything, where the dropdown cost a click to answer "which grouping am I
  // in?" and then answered it with a radio dot.
  const groupingSwitch = onViewModeChange ? (
    <SegmentedControl
      value={viewMode}
      onChange={(mode) => onViewModeChange(mode as SessionViewMode)}
      label={copy.groupingAriaLabel}
      size="sm"
    >
      <SegmentedControlItem
        value="conversation"
        label={copy.groupByTime}
        icon={<Clock size={ICON_SIZE.control} aria-hidden="true" />}
        isLabelHidden
      />
      <SegmentedControlItem
        value="project"
        label={copy.groupByProject}
        icon={<FolderOpen size={ICON_SIZE.control} aria-hidden="true" />}
        isLabelHidden
      />
    </SegmentedControl>
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
          <SessionSidebarNav
            selection={props.selection}
            scheduledTasks={props.scheduledTasks}
            moduleMemory={props.moduleMemory}
            onSelect={props.onSelect}
            onNew={props.onNew}
            onImport={props.onImport}
          />
        }
        footer={
          <SessionSidebarFooter
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
            projectActions={props.projectActions}
            onSelectSession={props.onSelectSession}
            rowActions={props.rowActions}
            /* The group-header trigger is the SAME creation path as the rail's
               新任务 row: one handler, two proximity entries (decision D1-a:
               a session created from the Pinned header is an ordinary new
               session, nothing auto-pinned). */
            onNewTask={props.onNew}
            heading={onViewModeChange ? copy.title : undefined}
            headingEnd={groupingSwitch}
          />
        ) : null}
      </SideNav>
    </div>
  );
}
