import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  Button as UiButton,
  EmptyState,
  Selector,
  StatusDot,
  Switch,
  Tab,
  TabList,
  Toolbar,
} from '@astryxdesign/core';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';
import { Divider } from '@astryxdesign/core/Divider';
import { PageHeader } from './primitives/page-header.js';
import { TextInput } from '@astryxdesign/core';
import type { ModuleHubHeader } from './module-hub-selector.js';
import type {
  PlanReminderDraftInput,
  PlanReminderUpdatePatch,
} from './module-panel-types.js';
import { getPlanReminderCopy } from './plan-reminder-copy.js';
import { useUiLocale } from './locale-context.js';

// Run-history status tone. triggered = it fired (informational accent, not a
// health signal), blocked = intentionally skipped (warning), failed =
// delivery error. Exception-only: no success green for a plain "it ran"
// record — and rows only surface the exceptional states at all.
function planRunStatusDotVariant(
  status: NonNullable<PlanReminder['lastRun']>['status'],
): 'accent' | 'warning' | 'error' {
  if (status === 'blocked') return 'warning';
  if (status === 'failed') return 'error';
  return 'accent';
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
  const pendingReminderMenuIntentRef = useRef<((trigger?: HTMLButtonElement) => void) | null>(null);
  const reminderMenuTriggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const formDialogTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Issue #1044: all create/edit form fields + submit moved into
  // PlanReminderFormDialog. The panel owns its open state and seed;
  // `formNonce` gives Astryx a fresh native dialog for each form session.
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

  // Put the product action that opened the form back in focus before Astryx
  // Dialog's passive effect captures its opener. Astryx still owns opening,
  // Escape handling, trapping, and focus restoration on close.
  useLayoutEffect(() => {
    if (!formDialogOpen) return;
    formDialogTriggerRef.current?.focus();
    formDialogTriggerRef.current = null;
  }, [formDialogOpen, formNonce]);

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

  function openReminderDialog(seed: PlanReminderFormSeed, trigger?: HTMLButtonElement) {
    formDialogTriggerRef.current = trigger ?? null;
    setFormSeed(seed);
    setFormNonce((nonce) => nonce + 1);
    setFormDialogOpen(true);
  }

  function openCreateReminderDialog() {
    openReminderDialog(createPlanReminderFormSeed());
  }

  function editReminder(reminder: PlanReminder, trigger?: HTMLButtonElement) {
    openReminderDialog(planReminderEditSeed(reminder), trigger);
  }

  function duplicateReminder(reminder: PlanReminder, trigger?: HTMLButtonElement) {
    openReminderDialog(planReminderDuplicateSeed(reminder, locale), trigger);
  }

  function runReminderMenuIntentAfterClose(intent: (trigger?: HTMLButtonElement) => void) {
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
        intent(reminderMenuTriggerRefs.current.get(reminderId));
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
    <div className="maka-plan-panel" data-form-open={formDialogOpen ? 'true' : undefined}>
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

        <div className="maka-plan-tabs">
          <div className="maka-plan-tabs-bar">
            <TabList
              value={planView}
              onChange={(value) => {
                if (value === 'tasks' || value === 'runs') setPlanView(value);
              }}
              hasDivider
              aria-label={copy.page.viewsAriaLabel}
            >
              <Tab value="tasks" label={copy.page.tasks} />
              <Tab value="runs" label={copy.page.runs} />
            </TabList>
            {planView === 'tasks' ? (
              showListControls ? (
                <Toolbar
                  size="sm"
                  label={copy.page.filtersAriaLabel}
                  className="maka-plan-toolbar"
                  startContent={(
                    <>
                      <TextInput
                        label={copy.page.searchLabel}
                        isLabelHidden
                        width={260}
                        value={listQuery}
                        onChange={(value) => setListQuery(value.slice(0, 120))}
                        placeholder={copy.page.searchPlaceholder}
                      />
                    </>
                  )}
                  endContent={(
                    <>
                      <Selector
                        value={listSort}
                        onChange={(value) => setListSort(value as typeof listSort)}
                        label={copy.page.sort}
                        isLabelHidden
                        width={172}
                        options={copy.page.sortOptions.map(([value, label]) => ({ value, label }))}
                      />
                      <Selector
                        value={listFilter}
                        onChange={(value) => setListFilter(value as PlanReminderListFilter)}
                        label={copy.page.state}
                        isLabelHidden
                        width={148}
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
                    </>
                  )}
                />
              ) : null
            ) : (
              <Toolbar
                size="sm"
                label={copy.page.runsFilterAriaLabel}
                className="maka-plan-toolbar"
                endContent={(
                  <Selector
                    value={runRange}
                    onChange={(value) => setRunRange(value as typeof runRange)}
                    label={copy.page.range}
                    isLabelHidden
                    width={148}
                    options={copy.page.rangeOptions.map(([value, label]) => ({ value, label }))}
                  />
                )}
              />
            )}
          </div>

          {planView === 'tasks' ? (
            <div className="maka-plan-tab-panel">
              {normalizedListQuery && (
              <div className="maka-plan-search-summary" role="status" aria-live="polite">
                <span>{copy.page.searchMatches(searchMatchedReminders.length)}</span>
                <UiButton variant="ghost" size="sm" onClick={() => setListQuery('')} label={copy.page.clearSearch} />
              </div>
              )}
            {props.reminders.length === 0 ? (
              <EmptyState
                icon={<Clock />}
                title={copy.page.emptyTitle}
                description={copy.page.emptyBody}
                actions={<UiButton variant="primary" onClick={openCreateReminderDialog} label={copy.page.create} />}
              />
            ) : sortedReminders.length === 0 ? (
              <EmptyState
                icon={<Clock />}
                title={normalizedListQuery ? copy.page.noSearchTitle : copy.page.noFilterTitle}
                description={normalizedListQuery ? copy.page.noSearchBody : copy.page.noFilterBody}
                actions={<UiButton variant="ghost" label={copy.page.clearSearch} onClick={() => setListQuery('')} isDisabled={!normalizedListQuery} />}
              />
            ) : (
              <div className="maka-plan-list" aria-label={copy.page.listAriaLabel}>
                {sortedReminders.map((reminder) => {
                  const reminderActionPrefix = `${reminder.id}:`;
                  const reminderActionPending = Array.from(pendingActionKeys).some((key) => key.startsWith(reminderActionPrefix));
                  return (
                    /* Premium-checklist row (rules 6/11/16): a two-line
                       edge-to-edge row — leading switch, title + exception-only
                       status dots, one supporting schedule line, a live
                       relative Timestamp trailing. The per-row Badges
                       (countdown pill, run status) and the note preview are
                       gone: durations are supporting text, run details live in
                       the 执行记录 tab. */
                    <article
                      key={reminder.id}
                      className="maka-plan-list-row"
                      data-status={reminder.status}
                    >
                      {reminder.status !== 'completed' ? (
                        <Switch
                          value={reminder.enabled}
                          isDisabled={reminderActionPending}
                          label={`${reminder.enabled ? copy.page.pause : copy.page.enable}: ${reminder.title}`}
                          isLabelHidden
                          onChange={() => void runPlanReminderAction(`${reminder.id}:toggle`, () => props.onToggle?.(reminder.id, !reminder.enabled))}
                        />
                      ) : (
                        <span className="maka-plan-list-row-switch-ghost" aria-hidden="true" />
                      )}
                      <div className="maka-plan-list-row-main">
                        <div className="maka-plan-list-row-title">
                          <h3>{reminder.title}</h3>
                          {reminder.status !== 'scheduled' && (
                            <span className="maka-plan-status">
                              <StatusDot
                                variant={reminder.status === 'paused' ? 'warning' : 'neutral'}
                                label={planReminderStatusLabel(reminder.status, locale)}
                              />
                              <span>{planReminderStatusLabel(reminder.status, locale)}</span>
                            </span>
                          )}
                          {reminder.lastRun && reminder.lastRun.status !== 'triggered' && (
                            <span className="maka-plan-status">
                              <StatusDot
                                variant={planRunStatusDotVariant(reminder.lastRun.status)}
                                label={runStatusLabel(reminder.lastRun.status, locale)}
                              />
                              <span>{runStatusLabel(reminder.lastRun.status, locale)}</span>
                            </span>
                          )}
                        </div>
                        <p className="maka-plan-list-row-meta">
                          {formatPlanRecurrence(reminder, locale)}
                          <span aria-hidden="true"> · </span>
                          {reminder.nextRunAt
                            ? copy.page.nextRun(formatReminderTime(reminder.nextRunAt, locale))
                            : reminder.lastRun
                              ? copy.page.recentRun(formatReminderTime(reminder.lastRun.at, locale))
                              : copy.page.unscheduled}
                        </p>
                      </div>
                      {typeof reminder.nextRunAt === 'number' && (
                        /* Duration as quiet supporting text (checklist rule 16)
                           — the locale-aware formatter, not Astryx Timestamp,
                           which renders Intl relative time in English only. */
                        <span className="maka-plan-list-row-countdown">
                          {formatReminderCountdown(reminder.nextRunAt, locale)}
                        </span>
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
                                runReminderMenuIntentAfterClose((trigger) => editReminder(reminder, trigger))
                              }
                              isDisabled={reminderActionPending || reminder.status === 'completed'}
                              icon={<Pencil size={14} aria-hidden="true" />}
                              label={copy.page.edit}
                            />
                            <DropdownMenuItem
                              onClick={() =>
                                runReminderMenuIntentAfterClose((trigger) => duplicateReminder(reminder, trigger))
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
                    </article>
                  );
                })}
              </div>
            )}
            </div>
          ) : null}

          {planView === 'runs' ? (
            <div className="maka-plan-tab-panel">
              {visibleRunEntries.length === 0 ? (
              <EmptyState
                icon={<Clock />}
                title={copy.page.noRunsTitle}
                description={copy.page.noRunsBody}
              />
            ) : (
              <div className="maka-plan-run-list" aria-label={copy.page.runsAriaLabel}>
                {visibleRunEntries.map(({ reminder, run }) => (
                  <article key={`${reminder.id}:${run.id}`} className="maka-plan-run-row">
                    <span className="maka-plan-status" data-status={run.status}>
                      <StatusDot variant={planRunStatusDotVariant(run.status)} label={runStatusLabel(run.status, locale)} />
                      <span>{runStatusLabel(run.status, locale)}</span>
                    </span>
                    <div className="maka-plan-run-main">
                      <strong>{reminder.title}</strong>
                      <span>{run.message}</span>
                    </div>
                    <time>{formatReminderTime(run.at, locale)}</time>
                  </article>
                ))}
              </div>
              )}
            </div>
          ) : null}
        </div>
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
