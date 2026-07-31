import { useEffect, useRef, useState } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import { useToast } from './toast.js';
import {
  ArchiveRestore,
  Clock,
  Copy,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCcw,
  Trash2,
} from './icons.js';
import type { PlanReminder, PlanReminderStatus } from '@maka/core';
import {
  generalizedErrorMessage,
  generalizedErrorMessageChinese,
} from '@maka/core';
import {
  type PlanReminderFormSeed,
  comparePlanReminderBySort,
  createPlanReminderFormSeed,
  formatPlanRecurrence,
  formatPlanReminderDeliveryTargetLabel,
  formatReminderCountdown,
  formatReminderTime,
  normalizePlanReminderSearchQuery,
  planReminderDuplicateSeed,
  planReminderEditSeed,
  planReminderMatchesSearch,
  planReminderRunRangeStart,
  planReminderStatusLabel,
  runStatusLabel,
} from './plan-reminder-helpers.js';
import { PlanReminderFormDialog } from './plan-reminder-form-dialog.js';
import {
  TabsList,
  TabsPanel,
  TabsRoot,
  TabsTrigger,
} from './ui.js';
import {
  Badge,
  Button as UiButton,
  Selector,
  Switch,
} from '@astryxdesign/core';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';
import { Divider } from '@astryxdesign/core/Divider';
import { Chip, type ChipProps } from './primitives/chip.js';
import { PageHeader } from './primitives/page-header.js';
import { TextInput } from '@astryxdesign/core';
import { EmptyState } from './empty-state.js';
import type { ModuleHubHeader } from './module-hub-selector.js';
import type {
  PlanReminderDraftInput,
  PlanReminderUpdatePatch,
} from './module-panel-types.js';
import { getPlanReminderCopy } from './plan-reminder-copy.js';
import { useUiLocale } from './locale-context.js';

// Run-history status Chip tone. triggered = it fired (info, informational,
// not a health signal), blocked = intentionally skipped (warning), failed =
// delivery error (destructive). Exception-only: no success green for a plain
// "it ran" record.
function planRunStatusChipTone(
  status: NonNullable<PlanReminder['lastRun']>['status'],
): ChipProps['variant'] {
  if (status === 'blocked') return 'warning';
  if (status === 'failed') return 'destructive';
  return 'info';
}

export function PlanReminderPanel(props: {
  reminders: PlanReminder[];
  createRequestNonce?: number;
  onCreateRequestHandled?: () => void;
  hubHeader?: ModuleHubHeader;
  /**
   * Current persisted 保持系统唤醒 state. `undefined` means the capability is
   * unavailable (bridge absent / older main) — the row hides entirely.
   */
  keepSystemAwake?: boolean;
  /** Persist a new keep-awake value; rejects on failure so the row reverts. */
  onKeepSystemAwakeChange?: (next: boolean) => Promise<void>;
  onRefresh?(): void | Promise<void>;
  onCreate?(input: PlanReminderDraftInput): boolean | Promise<boolean> | void | Promise<void>;
  onUpdate?(id: string, patch: PlanReminderUpdatePatch): boolean | Promise<boolean> | void | Promise<void>;
  onToggle?(id: string, enabled: boolean): void | Promise<void>;
  onTriggerNow?(id: string): void | Promise<void>;
  onSnooze?(id: string): void | Promise<void>;
  onClearRunHistory?(id: string): void | Promise<void>;
  onDelete?(id: string): void | Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getPlanReminderCopy(locale);
  // 'active' = scheduled + paused. The low-volume default is 'all' so
  // completed reminders remain manageable even before filters are justified.
  type PlanReminderListFilter = 'active' | 'all' | PlanReminderStatus;
  type PlanReminderView = 'tasks' | 'runs';
  type PlanReminderRunRange = 'day' | 'week' | 'month' | 'all';
  type PlanReminderSort = 'created-desc' | 'next-run-asc' | 'updated-desc';
  const [pendingActionKeys, setPendingActionKeys] = useState<ReadonlySet<string>>(() => new Set());
  const planReminderMountedRef = useMountedRef();
  const refreshPendingRef = useRef(false);
  const pendingActionKeysRef = useRef<Set<string>>(new Set());
  const pendingReminderMenuIntentRef = useRef<(() => void) | null>(null);
  // A reminder row's menu trigger button, keyed by reminder id. When a
  // deferred menu intent (edit/duplicate/clear-runs/delete) opens a dialog
  // after the menu closes, Astryx Dialog restores focus on Esc to whatever
  // was `document.activeElement` when it opened. The menu's own close-focus-
  // return and the deferred dialog open sit two `requestAnimationFrame`s
  // apart, so on a loaded runner the captured element can land on <body>
  // instead of the trigger and Esc strands focus away from the row. The
  // deferred intent re-focuses the trigger right before opening the dialog,
  // making that capture deterministic. See plan-reminders E2E.
  const reminderMenuTriggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  // Issue #1044: all create/edit form fields + submit moved into
  // PlanReminderFormDialog. The panel owns its open state and seed;
  // `formNonce` remounts a closed form session before Astryx opens it.
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [openReminderMenuId, setOpenReminderMenuId] = useState<string | null>(null);
  const [formSeed, setFormSeed] = useState<PlanReminderFormSeed>(() => createPlanReminderFormSeed());
  const [formNonce, setFormNonce] = useState(0);
  const [planView, setPlanView] = useState<PlanReminderView>('tasks');
  const [runRange, setRunRange] = useState<PlanReminderRunRange>('week');
  const [listFilter, setListFilter] = useState<PlanReminderListFilter>('all');
  const [listSort, setListSort] = useState<PlanReminderSort>('created-desc');
  const [listQuery, setListQuery] = useState('');
  const [refreshPending, setRefreshPending] = useState(false);
  const toast = useToast();
  // 保持系统唤醒 capability control. Available only when the host wires both
  // the current value and the setter (bridge present); otherwise the row
  // hides. Local optimistic state drives the switch, initialized from the
  // persisted snapshot and re-synced when the prop changes (but never while a
  // write is in flight, so a slow snapshot can't clobber the optimistic flip).
  const keepSystemAwakeSupported =
    props.keepSystemAwake !== undefined && typeof props.onKeepSystemAwakeChange === 'function';
  const [keepSystemAwakeChecked, setKeepSystemAwakeChecked] = useState(props.keepSystemAwake ?? false);
  const [keepSystemAwakePending, setKeepSystemAwakePending] = useState(false);
  const keepSystemAwakePendingRef = useRef(false);
  const normalizedListQuery = normalizePlanReminderSearchQuery(listQuery);
  const showListControls =
    props.reminders.length >= 8 ||
    normalizedListQuery.length > 0 ||
    listFilter !== 'all' ||
    listSort !== 'created-desc';
  const searchMatchedReminders = normalizedListQuery
    ? props.reminders.filter((reminder) => planReminderMatchesSearch(reminder, normalizedListQuery, locale))
    : props.reminders;
  const visibleReminders = listFilter === 'all'
    ? searchMatchedReminders
    : listFilter === 'active'
      ? searchMatchedReminders.filter((reminder) => reminder.status !== 'completed')
      : searchMatchedReminders.filter((reminder) => reminder.status === listFilter);
  const sortedReminders = [...visibleReminders].sort((a, b) => comparePlanReminderBySort(a, b, listSort, locale));
  const runRangeStart = planReminderRunRangeStart(runRange, Date.now());
  const visibleRunEntries = props.reminders
    .flatMap((reminder) => reminder.runs.map((run) => ({ reminder, run })))
    .filter((entry) => runRangeStart === null || entry.run.at >= runRangeStart)
    .sort((a, b) => b.run.at - a.run.at);
  const filterCounts: Record<PlanReminderListFilter, number> = {
    active: searchMatchedReminders.filter((reminder) => reminder.status !== 'completed').length,
    all: searchMatchedReminders.length,
    scheduled: searchMatchedReminders.filter((reminder) => reminder.status === 'scheduled').length,
    paused: searchMatchedReminders.filter((reminder) => reminder.status === 'paused').length,
    completed: searchMatchedReminders.filter((reminder) => reminder.status === 'completed').length,
  };

  useEffect(() => {
    return () => {
      refreshPendingRef.current = false;
      pendingActionKeysRef.current = new Set();
      keepSystemAwakePendingRef.current = false;
    };
  }, []);

  // Re-sync the switch to the persisted snapshot when it changes (external
  // edit, relaunch), unless a local write is mid-flight — the optimistic
  // value wins until the write settles.
  useEffect(() => {
    if (keepSystemAwakePendingRef.current) return;
    if (props.keepSystemAwake !== undefined) setKeepSystemAwakeChecked(props.keepSystemAwake);
  }, [props.keepSystemAwake]);

  useEffect(() => {
    if (!props.createRequestNonce) return;
    openReminderDialog(createPlanReminderFormSeed());
    props.onCreateRequestHandled?.();
  }, [props.createRequestNonce]);

  async function toggleKeepSystemAwake(next: boolean) {
    if (!props.onKeepSystemAwakeChange || keepSystemAwakePendingRef.current) return;
    keepSystemAwakePendingRef.current = true;
    setKeepSystemAwakePending(true);
    setKeepSystemAwakeChecked(next); // optimistic
    try {
      await props.onKeepSystemAwakeChange(next);
    } catch (error) {
      // Revert to reflect REALITY, and surface the failure in Chinese.
      if (planReminderMountedRef.current) setKeepSystemAwakeChecked(!next);
      toast.error(copy.page.keepAwakeErrorTitle, locale === 'zh'
        ? generalizedErrorMessageChinese(error, copy.page.keepAwakeErrorFallback)
        : generalizedErrorMessage(error, copy.page.keepAwakeErrorFallback));
    } finally {
      keepSystemAwakePendingRef.current = false;
      if (planReminderMountedRef.current) setKeepSystemAwakePending(false);
    }
  }

  function openReminderDialog(seed: PlanReminderFormSeed) {
    setFormDialogOpen(false);
    setFormSeed(seed);
    setFormNonce((nonce) => nonce + 1);
    window.requestAnimationFrame(() => {
      if (planReminderMountedRef.current) setFormDialogOpen(true);
    });
  }

  function openCreateReminderDialog() {
    openReminderDialog(createPlanReminderFormSeed());
  }

  function editReminder(reminder: PlanReminder) {
    openReminderDialog(planReminderEditSeed(reminder));
  }

  function duplicateReminder(reminder: PlanReminder) {
    openReminderDialog(planReminderDuplicateSeed(reminder, locale));
  }

  function runReminderMenuIntentAfterClose(intent: () => void) {
    pendingReminderMenuIntentRef.current = intent;
  }

  function handleReminderMenuOpenChange(reminderId: string, open: boolean) {
    setOpenReminderMenuId(open ? reminderId : null);
    if (open) return;
    const intent = pendingReminderMenuIntentRef.current;
    pendingReminderMenuIntentRef.current = null;
    if (intent) {
      window.requestAnimationFrame(() => {
        if (!planReminderMountedRef.current) return;
        // Re-establish the trigger as the active element before the intent
        // opens a dialog, so the dialog captures and later restores focus to
        // the row's menu trigger instead of whatever drifted to <body> during
        // the menu-close → deferred-open window.
        reminderMenuTriggerRefs.current.get(reminderId)?.focus();
        intent();
      });
    }
  }

  async function runPlanReminderAction(
    actionKey: string,
    action: (() => void | Promise<void>) | undefined,
  ) {
    if (!action || pendingActionKeysRef.current.has(actionKey)) return;
    const pendingWithAction = new Set(pendingActionKeysRef.current);
    pendingWithAction.add(actionKey);
    pendingActionKeysRef.current = pendingWithAction;
    setPendingActionKeys(pendingWithAction);
    try {
      await action();
    } finally {
      const pendingWithoutAction = new Set(pendingActionKeysRef.current);
      pendingWithoutAction.delete(actionKey);
      pendingActionKeysRef.current = pendingWithoutAction;
      if (planReminderMountedRef.current) setPendingActionKeys(pendingWithoutAction);
    }
  }

  async function refreshFromPanel() {
    if (!props.onRefresh || refreshPendingRef.current) return;
    refreshPendingRef.current = true;
    setRefreshPending(true);
    try {
      await props.onRefresh();
    } finally {
      refreshPendingRef.current = false;
      if (planReminderMountedRef.current) setRefreshPending(false);
    }
  }

  return (
    <div className="maka-plan-panel">
      <div className="maka-plan-shell agents-inner-view-clamp">
        <PageHeader
          as_wrapper="div"
          className="maka-plan-hero"
          as="h2"
          title={props.hubHeader?.title ?? copy.page.title}
          subtitle={props.hubHeader?.subtitle ?? copy.page.subtitle}
          badge={props.hubHeader?.badge}
          headingRowClassName={props.hubHeader ? 'maka-module-hub-heading' : undefined}
          contentClassName="maka-plan-heading"
          actions={
            <div className="maka-plan-top-actions" aria-label={copy.page.actionsAriaLabel}>
              <UiButton
                variant="primary"
                onClick={openCreateReminderDialog}
                icon={<Plus size={15} aria-hidden="true" />}
                label={copy.page.create}
              />
              <DropdownMenu
                button={{
                  label: copy.page.pageSettings,
                  icon: <MoreHorizontal size={16} aria-hidden="true" />,
                  isIconOnly: true,
                  variant: 'ghost',
                  size: 'md',
                }}
                className="maka-plan-page-menu"
              >
                  <DropdownMenuItem
                    onClick={() => void refreshFromPanel()}
                    isDisabled={!props.onRefresh || refreshPending}
                    icon={<RefreshCcw size={14} aria-hidden="true" />}
                    label={refreshPending ? copy.page.refreshing : copy.page.refresh}
                  />
                  {keepSystemAwakeSupported && (
                    <>
                      <Divider orientation="horizontal" />
                      <DropdownMenuCheckboxItem
                        label={copy.page.keepAwake}
                        value={keepSystemAwakeChecked}
                        isDisabled={keepSystemAwakePending}
                        onChange={(next) => void toggleKeepSystemAwake(next)}
                      />
                    </>
                  )}
              </DropdownMenu>
            </div>
          }
        />

        <TabsRoot
          className="maka-plan-tabs"
          value={planView}
          onValueChange={(value) => {
            if (value === 'tasks' || value === 'runs') setPlanView(value);
          }}
        >
          <div className="maka-plan-tabs-bar">
            <TabsList variant="underline" className="maka-plan-tabs-list" aria-label={copy.page.viewsAriaLabel}>
              <TabsTrigger className="maka-plan-tab" value="tasks">
                {copy.page.tasks}
              </TabsTrigger>
              <TabsTrigger className="maka-plan-tab" value="runs">
                {copy.page.runs}
              </TabsTrigger>
            </TabsList>
            {planView === 'tasks' ? (
              showListControls ? (
                <div className="maka-plan-toolbar" aria-label={copy.page.filtersAriaLabel}>
                  <div className="maka-plan-compact-select maka-plan-sort-select">
                    <Selector
                      value={listSort}
                      onChange={(value) => setListSort(value as typeof listSort)}
                      label={copy.page.sort}
                      width="100%"
                      options={copy.page.sortOptions.map(([value, label]) => ({ value, label }))}
                    />
                  </div>
                  <div className="maka-plan-search">
                    <TextInput
                      label={copy.page.searchLabel}
                      isLabelHidden
                      width="100%"
                      value={listQuery}
                      onChange={(value) => setListQuery(value.slice(0, 120))}
                      placeholder={copy.page.searchPlaceholder}
                    />
                  </div>
                  <div className="maka-plan-compact-select">
                    <Selector
                      value={listFilter}
                      onChange={(value) => setListFilter(value as PlanReminderListFilter)}
                      label={copy.page.state}
                      width="100%"
                      options={[
                        { value: 'active', label: copy.page.filterOption(copy.page.active, filterCounts.active) },
                        { value: 'all', label: copy.page.filterOption(copy.page.all, filterCounts.all) },
                        {
                          value: 'scheduled',
                          label: copy.page.filterOption(copy.status.scheduled, filterCounts.scheduled),
                        },
                        { value: 'paused', label: copy.page.filterOption(copy.status.paused, filterCounts.paused) },
                        {
                          value: 'completed',
                          label: copy.page.filterOption(copy.status.completed, filterCounts.completed),
                        },
                      ]}
                    />
                  </div>
                </div>
              ) : null
            ) : (
              <div className="maka-plan-toolbar maka-plan-toolbar-compact" aria-label={copy.page.runsFilterAriaLabel}>
                <div className="maka-plan-compact-select">
                  <Selector
                    value={runRange}
                    onChange={(value) => setRunRange(value as typeof runRange)}
                    label={copy.page.range}
                    width="100%"
                    options={copy.page.rangeOptions.map(([value, label]) => ({ value, label }))}
                  />
                </div>
              </div>
            )}
          </div>

          <TabsPanel className="maka-plan-tab-panel" value="tasks">
            {normalizedListQuery && (
              <div className="maka-plan-search-summary" role="status" aria-live="polite">
                <span>{copy.page.searchMatches(searchMatchedReminders.length)}</span>
                <UiButton variant="ghost" size="sm" onClick={() => setListQuery('')} label={copy.page.clearSearch} />
              </div>
            )}
            {props.reminders.length === 0 ? (
              <EmptyState
                Icon={Clock}
                title={copy.page.emptyTitle}
                body={copy.page.emptyBody}
                extraClassName="maka-plan-empty"
              />
            ) : sortedReminders.length === 0 ? (
              <EmptyState
                Icon={Clock}
                title={normalizedListQuery ? copy.page.noSearchTitle : copy.page.noFilterTitle}
                body={normalizedListQuery ? copy.page.noSearchBody : copy.page.noFilterBody}
                secondaryCta={{ label: copy.page.clearSearch, onClick: () => setListQuery(''), disabled: !normalizedListQuery }}
                extraClassName="maka-plan-empty"
              />
            ) : (
              <div className="maka-plan-list" aria-label={copy.page.listAriaLabel}>
                {sortedReminders.map((reminder) => {
                  const reminderActionPrefix = `${reminder.id}:`;
                  const reminderActionPending = Array.from(pendingActionKeys).some((key) => key.startsWith(reminderActionPrefix));
                  return (
                    <article
                      key={reminder.id}
                      className="maka-plan-card"
                      data-status={reminder.status}
                    >
                      <div className="maka-plan-card-main">
                        <div className="maka-plan-card-title-row">
                          <h3 className="maka-plan-card-title">{reminder.title}</h3>
                          {reminder.status !== 'scheduled' && (
                            <Badge
                              variant={reminder.status === 'paused' ? 'warning' : 'neutral'}
                              label={planReminderStatusLabel(reminder.status, locale)}
                            />
                          )}
                        </div>
                        <p className="maka-plan-card-note">
                          {reminder.note || copy.delivery.fallback(formatPlanReminderDeliveryTargetLabel(reminder.delivery, locale))}
                        </p>
                      </div>
                      <div className="maka-plan-card-context">
                        <div className="maka-plan-card-schedule">
                          <span>{formatPlanRecurrence(reminder, locale)}</span>
                          <span className="maka-plan-card-schedule-separator" aria-hidden="true">
                            ·
                          </span>
                          <span>
                            {reminder.nextRunAt ? (
                              <>
                                {copy.page.nextRun(formatReminderTime(reminder.nextRunAt, locale))}
                                <span className="maka-plan-card-countdown">{formatReminderCountdown(reminder.nextRunAt, locale)}</span>
                              </>
                            ) : reminder.lastRun ? (
                              copy.page.recentRun(formatReminderTime(reminder.lastRun.at, locale))
                            ) : (
                              copy.page.unscheduled
                            )}
                          </span>
                        </div>
                        {reminder.lastRun && (
                          <div className="maka-plan-card-run">
                            <Chip size="sm" variant={planRunStatusChipTone(reminder.lastRun.status)}>
                              {runStatusLabel(reminder.lastRun.status, locale)}
                            </Chip>
                            <span>{reminder.lastRun.message}</span>
                          </div>
                        )}
                      </div>
                      <div className="maka-plan-card-controls">
                        {reminder.status !== 'completed' && (
                          <Switch
                            value={reminder.enabled}
                            isDisabled={reminderActionPending}
                            label={`${reminder.enabled ? copy.page.pause : copy.page.enable}: ${reminder.title}`}
                            isLabelHidden
                            onChange={() => void runPlanReminderAction(`${reminder.id}:toggle`, () => props.onToggle?.(reminder.id, !reminder.enabled))}
                          />
                        )}
                        <DropdownMenu
                          isMenuOpen={openReminderMenuId === reminder.id}
                          onOpenChange={(open) =>
                            handleReminderMenuOpenChange(reminder.id, open)
                          }
                          button={{
                            label: `${copy.page.reminderActions}: ${reminder.title}`,
                            icon: <MoreHorizontal size={16} aria-hidden="true" />,
                            isIconOnly: true,
                            variant: 'ghost',
                            size: 'sm',
                            ref: (el) => {
                              if (el) reminderMenuTriggerRefs.current.set(reminder.id, el);
                              else reminderMenuTriggerRefs.current.delete(reminder.id);
                            },
                          }}
                          className="maka-plan-card-menu"
                        >
                            <DropdownMenuItem
                              onClick={() =>
                                runReminderMenuIntentAfterClose(() => editReminder(reminder))
                              }
                              isDisabled={reminderActionPending || reminder.status === 'completed'}
                              icon={<Pencil size={14} aria-hidden="true" />}
                              label={copy.page.edit}
                            />
                            <DropdownMenuItem
                              onClick={() =>
                                runReminderMenuIntentAfterClose(() => duplicateReminder(reminder))
                              }
                              isDisabled={reminderActionPending}
                              icon={<Copy size={14} aria-hidden="true" />}
                              label={copy.page.duplicate}
                            />
                            <DropdownMenuItem
                              onClick={() => void runPlanReminderAction(`${reminder.id}:trigger`, () => props.onTriggerNow?.(reminder.id))}
                              isDisabled={reminderActionPending || !reminder.enabled}
                              icon={<RefreshCcw size={14} aria-hidden="true" />}
                              label={pendingActionKeys.has(`${reminder.id}:trigger`) ? copy.page.triggering : copy.page.triggerNow}
                            />
                            <DropdownMenuItem
                              onClick={() => void runPlanReminderAction(`${reminder.id}:snooze`, () => props.onSnooze?.(reminder.id))}
                              isDisabled={reminderActionPending || !reminder.enabled || reminder.status !== 'scheduled' || typeof reminder.nextRunAt !== 'number'}
                              icon={<Clock size={14} aria-hidden="true" />}
                              label={pendingActionKeys.has(`${reminder.id}:snooze`) ? copy.page.snoozing : copy.page.snooze}
                            />
                            <DropdownMenuItem
                              onClick={() =>
                                runReminderMenuIntentAfterClose(() => {
                                  void runPlanReminderAction(
                                    `${reminder.id}:clear-runs`,
                                    () => props.onClearRunHistory?.(reminder.id),
                                  );
                                })
                              }
                              isDisabled={reminderActionPending || reminder.runs.length === 0 || reminder.status === 'completed'}
                              icon={<ArchiveRestore size={14} aria-hidden="true" />}
                              label={pendingActionKeys.has(`${reminder.id}:clear-runs`) ? copy.page.clearing : copy.page.clearRuns}
                            />
                            <DropdownMenuItem
                              onClick={() =>
                                runReminderMenuIntentAfterClose(() => {
                                  void runPlanReminderAction(
                                    `${reminder.id}:delete`,
                                    () => props.onDelete?.(reminder.id),
                                  );
                                })
                              }
                              isDisabled={reminderActionPending}
                              icon={<Trash2 size={14} aria-hidden="true" />}
                              label={pendingActionKeys.has(`${reminder.id}:delete`) ? copy.page.deleting : copy.page.delete}
                              style={{ color: 'var(--destructive-text)' }}
                            />
                        </DropdownMenu>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </TabsPanel>

          <TabsPanel className="maka-plan-tab-panel" value="runs">
            {visibleRunEntries.length === 0 ? (
              <EmptyState
                Icon={Clock}
                title={copy.page.noRunsTitle}
                body={copy.page.noRunsBody}
                extraClassName="maka-plan-empty maka-plan-runs-empty"
              />
            ) : (
              <div className="maka-plan-run-list" aria-label={copy.page.runsAriaLabel}>
                {visibleRunEntries.map(({ reminder, run }) => (
                  <article key={`${reminder.id}:${run.id}`} className="maka-plan-run-row">
                    <Chip
                      size="sm"
                      variant={planRunStatusChipTone(run.status)}
                      className="maka-plan-run-status"
                      data-status={run.status}
                    >
                      {runStatusLabel(run.status, locale)}
                    </Chip>
                    <div className="maka-plan-run-main">
                      <strong>{reminder.title}</strong>
                      <span>{run.message}</span>
                    </div>
                    <time>{formatReminderTime(run.at, locale)}</time>
                  </article>
                ))}
              </div>
            )}
          </TabsPanel>
        </TabsRoot>
      </div>

      <PlanReminderFormDialog
        key={formNonce}
        open={formDialogOpen}
        seed={formSeed}
        reminders={props.reminders}
        onOpenChange={setFormDialogOpen}
        onCreate={props.onCreate}
        onUpdate={props.onUpdate}
      />
    </div>
  );
}
