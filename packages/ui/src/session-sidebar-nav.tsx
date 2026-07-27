import type { PlanReminder } from '@maka/core';
import type { CSSProperties } from 'react';
import { Blocks, Settings, SquarePen, Timer } from './icons.js';
import type { NavModuleMemory, NavSelection } from './nav-selection.js';
import { cn } from './ui.js';
import { cva } from 'class-variance-authority';
import { Button as BaseButton } from '@base-ui/react/button';
import { useUiLocale } from './locale-context.js';
import { getShellControlsCopy } from './shell-controls-copy.js';

const navRowVariants = cva(
  [
    'min-h-[var(--h-control-lg)] gap-2 rounded-sm border-0 bg-transparent px-1.5 py-0.5',
    'text-left text-sm font-medium text-[var(--foreground-secondary)]',
    // Glyphs pin to the 80%-ink chrome tone (same as titlebar icon actions)
    // instead of inheriting: the darwin glass override forces row TEXT to
    // full foreground, and icons must not follow it.
    '[&_.maka-nav-icon]:text-[var(--foreground-secondary)]',
    'transition-[background-color,color] duration-[var(--duration-base)] ease-[var(--ease-out-strong)]',
    'hover:bg-[var(--state-hover-bg)] hover:text-foreground',
    'data-[active=true]:bg-[var(--state-selected-bg)] data-[active=true]:font-semibold data-[active=true]:text-foreground data-[active=true]:shadow-none',
    'data-[active=true]:[&_.maka-nav-icon]:text-foreground',
    '[&_.maka-nav-count]:bg-[var(--state-hover-bg)] [&_.maka-nav-count]:text-[var(--muted-foreground)]',
    'data-[active=true]:[&_.maka-nav-count]:bg-[var(--state-selected-bg)] data-[active=true]:[&_.maka-nav-count]:text-foreground',
    'aria-disabled:cursor-not-allowed aria-disabled:opacity-55 aria-disabled:hover:bg-transparent',
    'data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-55 data-[disabled=true]:hover:bg-transparent',
  ],
  {
    variants: {
      tone: {
        default: '',
        newTask: 'text-foreground',
      },
    },
    defaultVariants: {
      tone: 'default',
    },
  },
);

const settingsButtonClass =
  'w-full min-w-0 gap-2 rounded-sm border-0 bg-transparent px-1.5 py-1.5 ' +
  'text-left text-sm font-medium text-[var(--foreground-secondary)] ' +
  'transition-[background-color,color] duration-[var(--duration-base)] ease-[var(--ease-out-strong)] ' +
  'hover:bg-[var(--state-hover-bg)] hover:text-foreground';

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
      <BaseButton
        className={cn('maka-nav-row maka-nav-new-task', navRowVariants({ tone: 'newTask' }))}
        aria-label={copy.newTask}
        type="button"
        onClick={props.onNew}
      >
        <SquarePen className="maka-nav-icon" aria-hidden="true" />
        <span>{copy.newTask}</span>
        <kbd className="maka-nav-kbd" aria-hidden="true">
          ⌘ N
        </kbd>
      </BaseButton>
      <BaseButton
        className={cn('maka-nav-row', navRowVariants())}
        data-active={extensionsActive}
        aria-current={extensionsActive ? 'page' : undefined}
        aria-label={copy.extensions}
        type="button"
        onClick={() => props.onSelect({ section: 'extensions', module: moduleMemory.extensions })}
      >
        <Blocks className="maka-nav-icon" aria-hidden="true" />
        <span>{copy.extensions}</span>
      </BaseButton>
      <BaseButton
        className={cn('maka-nav-row', navRowVariants())}
        data-active={automationsActive}
        aria-current={automationsActive ? 'page' : undefined}
        type="button"
        onClick={() => props.onSelect({ section: 'automations', module: moduleMemory.automations })}
        aria-label={activePlanReminderCount > 0 ? copy.pendingReminders(activePlanReminderCount) : copy.automations}
      >
        <Timer className="maka-nav-icon" aria-hidden="true" />
        <span>{copy.automations}</span>
        {activePlanReminderCount > 0 && (
          <small className="maka-nav-count" aria-hidden="true">
            {activePlanReminderCount}
          </small>
        )}
      </BaseButton>
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
      <BaseButton
        className={cn('maka-sidebar-settings-button', settingsButtonClass)}
        type="button"
        onClick={props.onOpenSettings}
        aria-label={copy.settings}
        title={copy.settings}
      >
        <Settings className="maka-nav-icon" aria-hidden="true" />
        <span>{copy.settings}</span>
      </BaseButton>
      {props.updateReminder && props.onOpenUpdate && (
        <BaseButton
          className="maka-sidebar-update-button"
          data-update-state={props.updateReminder.state}
          style={{ '--maka-update-progress': String(Math.max(0, Math.min(100, props.updateReminder.progressPercent ?? 0)) / 100) } as CSSProperties}
          type="button"
          onClick={props.onOpenUpdate}
          disabled={props.updateReminder.state === 'downloading'}
          aria-label={updateTitle}
          title={updateTitle}
        >
          {props.updateReminder.state === 'downloading' && <span className="maka-sidebar-update-progress" aria-hidden="true" />}
          <span>{updateLabel}</span>
        </BaseButton>
      )}
    </footer>
  );
}
