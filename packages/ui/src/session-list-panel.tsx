import type { PlanReminder, SessionSummary } from '@maka/core';
import type { NavModuleMemory, NavSelection } from './nav-selection.js';
import { SessionHistoryList, type SessionHistoryGroup, type SessionRowActions } from './session-history-list.js';
import { SessionSidebarFooter, SessionSidebarNav, type SidebarUpdateReminder } from './session-sidebar-nav.js';
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from './primitives/menu.js';
import { Button as UiButton } from './ui.js';
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
      <header className="maka-session-panel-header">
        <div className="maka-sidebar-drag-strip" />
      </header>
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
          <Menu>
            <MenuTrigger
              render={<UiButton variant="quiet" size="icon-sm" />}
              type="button"
              aria-label={copy.groupingAriaLabel}
              title={copy.groupingAriaLabel}
            >
              <ListTodo size={15} aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup className="w-max !min-w-0" align="end">
              <MenuRadioGroup value={viewMode} onValueChange={(mode) => onViewModeChange(mode as SessionViewMode)}>
                <MenuRadioItem value="conversation">{copy.groupByTime}</MenuRadioItem>
                <MenuRadioItem value="project">{copy.groupByProject}</MenuRadioItem>
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        </div>
      )}
      <SessionHistoryList
        sessions={props.sessions}
        activeId={props.activeId}
        streamingSessionIds={props.streamingSessionIds}
        staleSessionIds={props.staleSessionIds}
        groupVariant={viewMode}
        groups={groups}
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
