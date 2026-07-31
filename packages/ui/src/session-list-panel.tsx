import type { PlanReminder, SessionSummary } from '@maka/core';
import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@astryxdesign/core/DropdownMenu';
import type { NavModuleMemory, NavSelection } from './nav-selection.js';
import {
  SessionHistoryList,
  type ProjectRowActions,
  type SessionHistoryGroup,
  type SessionRowActions,
} from './session-history-list.js';
import { SessionSidebarFooter, SessionSidebarNav, type SidebarUpdateReminder } from './session-sidebar-nav.js';
import { ListTodo } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

export type SessionViewMode = 'conversation' | 'project';

export function SessionListPanel(props: {
  selection: NavSelection;
  sessions: SessionSummary[];
  activeId?: string;
  planReminders?: PlanReminder[];
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
  groups?: ReadonlyArray<SessionHistoryGroup>;
  worktreeSessionIds?: ReadonlySet<string>;
  projectActions?: ProjectRowActions;
  childSessionsByParentId?: ReadonlyMap<string, readonly SessionSummary[]>;
  viewMode?: SessionViewMode;
  onViewModeChange?: (mode: SessionViewMode) => void;
  onSelectSession(sessionId: string): void;
  moduleMemory?: NavModuleMemory;
  onSelect(selection: NavSelection): void;
  onOpenSettings(): void;
  updateReminder?: SidebarUpdateReminder;
  onOpenUpdate?(): void;
  onNew(): void;
  rowActions?: SessionRowActions;
}) {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const {
    viewMode = 'conversation',
    onViewModeChange,
    groups,
  } = props;

  return (
    <aside
      className="maka-session-panel agents-sidebar"
      aria-label={copy.listAriaLabel}
    >
      <SessionSidebarNav
        selection={props.selection}
        planReminders={props.planReminders}
        moduleMemory={props.moduleMemory}
        onSelect={props.onSelect}
        onNew={props.onNew}
      />
      {onViewModeChange && (
        <div className="maka-session-list-toolbar">
          <span className="maka-session-list-heading">{copy.title}</span>
          <DropdownMenu
            button={{
              label: copy.groupingAriaLabel,
              icon: <ListTodo size={15} aria-hidden="true" />,
              isIconOnly: true,
              variant: 'ghost',
              size: 'sm',
              tooltip: copy.groupingAriaLabel,
            }}
          >
              <DropdownMenuRadioGroup
                value={viewMode}
                onChange={(mode) => onViewModeChange(mode as SessionViewMode)}
                aria-label={copy.groupingAriaLabel}
              >
                <DropdownMenuRadioItem value="conversation" label={copy.groupByTime} />
                <DropdownMenuRadioItem value="project" label={copy.groupByProject} />
              </DropdownMenuRadioGroup>
          </DropdownMenu>
        </div>
      )}
      <SessionHistoryList
        sessions={props.sessions}
        activeId={props.activeId}
        streamingSessionIds={props.streamingSessionIds}
        staleSessionIds={props.staleSessionIds}
        groupVariant={viewMode}
        groups={groups}
        worktreeSessionIds={props.worktreeSessionIds}
        projectActions={props.projectActions}
        childSessionsByParentId={props.childSessionsByParentId}
        onSelectSession={props.onSelectSession}
        rowActions={props.rowActions}
      />
      <SessionSidebarFooter
        updateReminder={props.updateReminder}
        onOpenSettings={props.onOpenSettings}
        onOpenUpdate={props.onOpenUpdate}
      />
    </aside>
  );
}
