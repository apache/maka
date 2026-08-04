import type { PlanReminder } from '@maka/core';
import type { CSSProperties } from 'react';
import { Blocks, Settings, SquarePen, Timer } from './icons.js';
import type { NavModuleMemory, NavSelection } from './nav-selection.js';
import { useUiLocale } from './locale-context.js';
import { getShellControlsCopy } from './shell-controls-copy.js';
import { Button } from '@astryxdesign/core/Button';
import { SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';

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

  // Always SideNavItem — expanded and collapsed. Astryx collapse context turns
  // these into icon-only slots without remounting a different control recipe
  // (which read as a squeeze when the rail previously swapped to IconButton).
  //
  // SideNavSection, like the footer below, rather than a bare fragment in a
  // product div: the section is what owns the space BETWEEN nav rows
  // (`items` → --spacing-0-5). Handed to `topContent` as a plain div these three
  // were the only group on the rail outside that authority, so they stacked
  // edge to edge — invisible expanded, where the label separates the rows, and
  // plainly three-icons-as-one-slab at 48px. The header is hidden because the
  // rail landmark already names the panel; the title stays for a11y.
  return (
    <SideNavSection title={copy.mainLabel} isHeaderHidden className="maka-session-panel-top">
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
    </SideNavSection>
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
    : props.updateReminder?.state === 'error'
      ? copy.retryUpdate
    : props.updateReminder?.state === 'downloading'
      ? `${updatePercent}%`
      : copy.update;
  const updateTitle = props.updateReminder?.state === 'downloaded'
    ? copy.updateDownloaded(props.updateReminder.latestVersion)
    : props.updateReminder?.state === 'error'
      ? copy.updateFailed(props.updateReminder.latestVersion)
    : props.updateReminder?.state === 'downloading'
      ? copy.downloadingUpdate(updatePercent)
      : props.updateReminder
        ? copy.updateAvailable(props.updateReminder.latestVersion)
        : copy.update;
  // shell-side-nav footer authority: SideNavSection + SideNavItem, not a
  // product grid that re-lays out nav chrome beside the update chip.
  return (
    <SideNavSection title={copy.settings} isHeaderHidden className="maka-session-panel-footer">
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
          // #1879: was `sm` with a 34px height forced from product CSS. Astryx
          // sizes Button off --size-element-* (sm 28 / md 32), so `md` IS the
          // 32px this button wants, and the CSS height is gone rather than
          // fighting the component's own size token.
          size="md"
          variant="ghost"
          width="100%"
          onClick={props.onOpenUpdate}
        >
          {props.updateReminder.state === 'downloading' && <span className="maka-sidebar-update-progress" aria-hidden="true" />}
          <span>{updateLabel}</span>
        </Button>
      )}
    </SideNavSection>
  );
}
