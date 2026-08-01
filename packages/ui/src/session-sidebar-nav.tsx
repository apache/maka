import type { PlanReminder } from '@maka/core';
import type { CSSProperties } from 'react';
import { Blocks, Settings, SquarePen, Timer } from './icons.js';
import type { NavModuleMemory, NavSelection } from './nav-selection.js';
import { useUiLocale } from './locale-context.js';
import { getShellControlsCopy } from './shell-controls-copy.js';
import { Button } from '@astryxdesign/core/Button';
import { SideNavItem } from '@astryxdesign/core/SideNav';

export function SessionSidebarNav(props: {
  selection: NavSelection;
  planReminders?: PlanReminder[];
  moduleMemory?: NavModuleMemory;
  onSelect(selection: NavSelection): void;
  onNew(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellControlsCopy(locale).navigation;
  const extensionsActive = props.selection.section === 'extensions';
  const automationsActive = props.selection.section === 'automations';
  const moduleMemory = props.moduleMemory ?? { extensions: 'skills', automations: 'plan-reminders' };
  const activePlanReminderCount = (props.planReminders ?? []).filter(
    (reminder) => reminder.status !== 'completed',
  ).length;

  return (
    <nav className="maka-sidebar-modules" aria-label={copy.mainLabel}>
      <SideNavItem
        label={copy.newTask}
        icon={SquarePen}
        size="md"
        onClick={props.onNew}
        endContent={<kbd className="maka-nav-kbd" aria-hidden="true">⌘ N</kbd>}
      />
      <SideNavItem
        label={copy.extensions}
        icon={Blocks}
        size="md"
        isSelected={extensionsActive}
        onClick={() => props.onSelect({ section: 'extensions', module: moduleMemory.extensions })}
      />
      <SideNavItem
        label={activePlanReminderCount > 0
          ? copy.pendingReminders(activePlanReminderCount)
          : copy.automations}
        icon={Timer}
        size="md"
        isSelected={automationsActive}
        onClick={() => props.onSelect({ section: 'automations', module: moduleMemory.automations })}
      />
    </nav>
  );
}

export type SidebarUpdateReminder = {
  state: 'available' | 'downloading' | 'downloaded' | 'error';
  latestVersion: string;
  progressPercent?: number;
};

export function SessionSidebarFooter(props: {
  updateReminder?: SidebarUpdateReminder;
  onOpenSettings(): void;
  onOpenUpdate?(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellControlsCopy(locale).navigation;
  const updatePercent = Math.round(props.updateReminder?.progressPercent ?? 0);
  const updateLabel = props.updateReminder?.state === 'downloaded'
    ? copy.restartUpdate
    : props.updateReminder?.state === 'downloading'
      ? `${updatePercent}%`
      : copy.update;
  const updateTitle = props.updateReminder?.state === 'downloaded'
    ? copy.updateDownloaded(props.updateReminder.latestVersion)
    : props.updateReminder?.state === 'downloading'
      ? copy.downloadingUpdate(updatePercent)
      : props.updateReminder
        ? copy.updateAvailable(props.updateReminder.latestVersion)
        : copy.update;
  return (
    <footer className="maka-session-panel-footer">
      <SideNavItem
        label={copy.settings}
        icon={Settings}
        size="md"
        onClick={props.onOpenSettings}
      />
      {props.updateReminder && props.onOpenUpdate && (
        <Button
          className="maka-sidebar-update-button"
          data-update-state={props.updateReminder.state}
          style={{ '--maka-update-progress': String(Math.max(0, Math.min(100, props.updateReminder.progressPercent ?? 0)) / 100) } as CSSProperties}
          label={updateTitle}
          size="sm"
          variant="ghost"
          width="100%"
          onClick={props.onOpenUpdate}
          isDisabled={props.updateReminder.state === 'downloading'}
        >
          {props.updateReminder.state === 'downloading' && <span className="maka-sidebar-update-progress" aria-hidden="true" />}
          <span>{updateLabel}</span>
        </Button>
      )}
    </footer>
  );
}
