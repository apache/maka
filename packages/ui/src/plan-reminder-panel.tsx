import { useEffect, useRef, useState } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import { useToast } from './toast.js';
import { Clock, MoreHorizontal, Plus, RefreshCcw } from './icons.js';
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
import { planReminderStatusDotVariant, planRunStatusDotVariant } from './plan-reminder-status.js';
import { PlanReminderFormDialog } from './plan-reminder-form-dialog.js';
import { PlanReminderInspector } from './plan-reminder-inspector.js';
import { useRovingRowFocus } from './use-roving-row-focus.js';
import {
  Button as UiButton,
  EmptyState,
  List,
  ListItem,
  SegmentedControl,
  SegmentedControlItem,
  Selector,
  StatusDot,
  Text,
  TextInput,
  Toolbar,
} from '@astryxdesign/core';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';
import { Divider } from '@astryxdesign/core/Divider';
import { ModulePage } from './primitives/module-page.js';
import type { ModuleHubHeader } from './module-hub-selector.js';
import type {
  PlanReminderDraftInput,
  PlanReminderUpdatePatch,
} from './module-panel-types.js';
import { getPlanReminderCopy } from './plan-reminder-copy.js';
import { useUiLocale } from './locale-context.js';

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
  // Issue #1044: all create/edit form fields + submit live in
  // PlanReminderFormDialog. The panel owns its open state and seed;
  // `formNonce` gives Astryx a fresh native dialog for each form session.
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [formSeed, setFormSeed] = useState<PlanReminderFormSeed>(() => createPlanReminderFormSeed());
  const [formNonce, setFormNonce] = useState(0);
  // Astryx's Dialog does not return focus to whatever opened it, and `key`ing
  // the dialog per session means there is nothing left to restore from. Capture
  // the opener ourselves so Escape lands back on 编辑 / 新建定时任务.
  const formDialogOpenerRef = useRef<HTMLElement | null>(null);
  // Set when a delete starts, consumed once the row has actually left the list
  // — which only happens when the main process pushes the new set back.
  const rowsContainerRef = useRef<HTMLDivElement | null>(null);
  const focusRowAfterRemovalRef = useRef<number | null>(null);
  // One tab stop for the whole task list: without it, reaching the inspector
  // from row k of N costs N−k presses, because the inspector renders after the
  // list and every row is its own stop.
  const rovingRows = useRovingRowFocus(rowsContainerRef);
  const [planView, setPlanView] = useState<PlanReminderView>('tasks');
  const [runRange, setRunRange] = useState<PlanReminderRunRange>('week');
  const [listFilter, setListFilter] = useState<PlanReminderListFilter>('all');
  const [listSort, setListSort] = useState<PlanReminderSort>('created-desc');
  const [listQuery, setListQuery] = useState('');
  const [selectedReminderId, setSelectedReminderId] = useState<string | null>(null);
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
  const activeCount = props.reminders.filter((reminder) => reminder.status !== 'completed').length;
  // Derived, not stored: whatever hides the row — deletion, a filter, the
  // 执行记录 view — closes the inspector without a reconciliation step, and the
  // panel always reads the freshest copy of the reminder. Note the id itself
  // survives, so clearing a filter re-opens the same selection; a deleted id
  // can never re-match, so only the reversible cases come back.
  const selectedReminder = planView === 'tasks'
    ? sortedReminders.find((reminder) => reminder.id === selectedReminderId) ?? null
    : null;
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

  // Astryx's Dialog does restore focus on close, but it captures the opener in
  // an Effect — after the commit that opened the dialog — and by then the
  // inspector button that was clicked has been re-rendered, so what it captures
  // is `body`. Capturing at click time instead is what actually gets focus back
  // to 编辑. Deleting this effect fails the e2e Escape-restore assertion, which
  // is the check that keeps the duplication honest.
  useEffect(() => {
    if (formDialogOpen) return;
    const opener = formDialogOpenerRef.current;
    formDialogOpenerRef.current = null;
    if (opener?.isConnected) opener.focus();
  }, [formDialogOpen]);

  // Synchronising focus with the DOM once the list it points into has been
  // re-rendered — an external system, which is what an Effect is for.
  useEffect(() => {
    const index = focusRowAfterRemovalRef.current;
    if (index == null) return;
    focusRowAfterRemovalRef.current = null;
    // A frame later, not now: the confirm dialog is still closing, and Astryx
    // restores focus to ITS trigger — the 删除 button being removed — on the
    // way out. Claiming focus before that lands means losing it again.
    const frame = requestAnimationFrame(() => {
      const rows = rowsContainerRef.current?.querySelectorAll<HTMLElement>('li button');
      if (!rows?.length) return;
      rows[Math.min(index, rows.length - 1)]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [props.reminders]);

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
    formDialogOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setFormSeed(seed);
    setFormNonce((nonce) => nonce + 1);
    setFormDialogOpen(true);
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

  const listControls = showListControls ? (
    <>
      <TextInput
        label={copy.page.searchLabel}
        isLabelHidden
        width={220}
        value={listQuery}
        onChange={(value) => setListQuery(value.slice(0, 120))}
        placeholder={copy.page.searchPlaceholder}
      />
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
          { value: 'scheduled', label: copy.page.filterOption(copy.status.scheduled, filterCounts.scheduled) },
          { value: 'paused', label: copy.page.filterOption(copy.status.paused, filterCounts.paused) },
          { value: 'completed', label: copy.page.filterOption(copy.status.completed, filterCounts.completed) },
        ]}
      />
    </>
  ) : null;

  return (
    <>
      <ModulePage
        title={props.hubHeader?.title ?? copy.page.title}
        meta={copy.page.activeCount(activeCount)}
        inspectorLabel={copy.detail.label}
        inspectorAutoSaveId="maka-plan-inspector"
        onInspectorDismiss={() => setSelectedReminderId(null)}
        inspector={selectedReminder ? (
          <PlanReminderInspector
            reminder={selectedReminder}
            pendingActionKeys={pendingActionKeys}
            onToggle={(enabled) => void runPlanReminderAction(
              `${selectedReminder.id}:toggle`,
              () => props.onToggle?.(selectedReminder.id, enabled),
            )}
            onEdit={() => openReminderDialog(planReminderEditSeed(selectedReminder))}
            onDuplicate={() => openReminderDialog(planReminderDuplicateSeed(selectedReminder, locale))}
            onTriggerNow={() => void runPlanReminderAction(
              `${selectedReminder.id}:trigger`,
              () => props.onTriggerNow?.(selectedReminder.id),
            )}
            onSnooze={() => void runPlanReminderAction(
              `${selectedReminder.id}:snooze`,
              () => props.onSnooze?.(selectedReminder.id),
            )}
            onClearRunHistory={() => void runPlanReminderAction(
              `${selectedReminder.id}:clear-runs`,
              () => props.onClearRunHistory?.(selectedReminder.id),
            )}
            onDelete={() => {
              // The 删除 button is about to unmount with the whole inspector,
              // and nothing else would claim focus — it would fall to `body`,
              // dropping a keyboard user at the top of the document. Hand it
              // to the row that takes the deleted one's place.
              focusRowAfterRemovalRef.current = sortedReminders.findIndex(
                (reminder) => reminder.id === selectedReminder.id,
              );
              void runPlanReminderAction(
                `${selectedReminder.id}:delete`,
                () => props.onDelete?.(selectedReminder.id),
              );
            }}
          />
        ) : undefined}
        actions={
          <>
            <UiButton
              variant="primary"
              onClick={() => openReminderDialog(createPlanReminderFormSeed())}
              icon={<Plus size={15} aria-hidden="true" />}
              label={copy.page.create}
            />
            <DropdownMenu
              button={{
                label: copy.page.pageSettings,
                icon: <MoreHorizontal size={16} aria-hidden="true" />,
                isIconOnly: true,
                variant: 'ghost',
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
          </>
        }
        toolbar={(
          <div className="maka-module-page-bar">
            {props.hubHeader?.badge}
            <Toolbar
              size="sm"
              label={copy.page.filtersAriaLabel}
              startContent={
                <SegmentedControl
                  value={planView}
                  onChange={(value) => {
                    if (value !== 'tasks' && value !== 'runs') return;
                    setPlanView(value);
                  }}
                  label={copy.page.viewsAriaLabel}
                  size="sm"
                >
                  <SegmentedControlItem value="tasks" label={copy.page.tasks} />
                  <SegmentedControlItem value="runs" label={copy.page.runs} />
                </SegmentedControl>
              }
              endContent={planView === 'tasks' ? listControls : (
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
          </div>
        )}
      >
        {planView === 'tasks' ? (
          <div className="maka-module-page-panel" ref={rowsContainerRef} {...rovingRows}>
            {/* Selecting a row moves no focus — a mouse user did not ask to
                leave the list — so nothing else would tell a screen reader
                that the details opened. This says so, politely, after
                whatever the activation itself announced. Placement is left
                unnamed: below the breakpoint the same content is a sheet
                that announces itself, and this must not contradict it. */}
            <p className="maka-visually-hidden" role="status" aria-live="polite">
              {selectedReminder ? copy.page.inspectorOpened(selectedReminder.title) : ''}
            </p>
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
                actions={(
                  <UiButton
                    variant="primary"
                    onClick={() => openReminderDialog(createPlanReminderFormSeed())}
                    label={copy.page.create}
                  />
                )}
              />
            ) : sortedReminders.length === 0 ? (
              <EmptyState
                icon={<Clock />}
                title={normalizedListQuery ? copy.page.noSearchTitle : copy.page.noFilterTitle}
                description={normalizedListQuery ? copy.page.noSearchBody : copy.page.noFilterBody}
                actions={<UiButton variant="ghost" label={copy.page.clearSearch} onClick={() => setListQuery('')} isDisabled={!normalizedListQuery} />}
              />
            ) : (
              /* Selectable, otherwise inert rows: every control that used to
                 ride the row now lives in the inspector, which is what Astryx
                 asks for — no interactive elements inside an interactive
                 list item. The leading StatusDot also fixes the alignment the
                 old hand-held 40px switch placeholder kept getting wrong. */
              <List density="balanced" hasDividers className="maka-module-page-rows" aria-label={copy.page.listAriaLabel}>
                {sortedReminders.map((reminder) => (
                  <ListItem
                    key={reminder.id}
                    label={reminder.title}
                    /* An exceptional lifecycle state leads the line as TEXT,
                       not only as the dot's colour: the dot sits outside the
                       row's button, so tabbing a row would otherwise announce
                       no state at all, and colour alone fails WCAG 1.4.1.
                       待触发 stays silent — it is the normal case, and naming
                       it on every row is the noise this list is built to
                       avoid. */
                    description={[
                      reminder.status === 'scheduled'
                        ? null
                        : planReminderStatusLabel(reminder.status, locale),
                      formatPlanRecurrence(reminder, locale),
                      reminder.nextRunAt
                        ? copy.page.nextRun(formatReminderTime(reminder.nextRunAt, locale))
                        : reminder.lastRun
                          ? copy.page.recentRun(formatReminderTime(reminder.lastRun.at, locale))
                          : copy.page.unscheduled,
                    ].filter(Boolean).join(' · ')}
                    startContent={(
                      <StatusDot
                        variant={planReminderStatusDotVariant(reminder.status)}
                        label={planReminderStatusLabel(reminder.status, locale)}
                      />
                    )}
                    endContent={typeof reminder.nextRunAt === 'number' ? (
                      <Text type="supporting" color="secondary" className="maka-plan-countdown">
                        {formatReminderCountdown(reminder.nextRunAt, locale)}
                      </Text>
                    ) : undefined}
                    isSelected={selectedReminderId === reminder.id}
                    onClick={() => setSelectedReminderId(
                      selectedReminderId === reminder.id ? null : reminder.id,
                    )}
                  />
                ))}
              </List>
            )}
          </div>
        ) : (
          <div className="maka-module-page-panel">
            {visibleRunEntries.length === 0 ? (
              <EmptyState icon={<Clock />} title={copy.page.noRunsTitle} description={copy.page.noRunsBody} />
            ) : (
              <List density="balanced" hasDividers className="maka-module-page-rows" aria-label={copy.page.runsAriaLabel}>
                {visibleRunEntries.map(({ reminder, run }) => (
                  <ListItem
                    key={`${reminder.id}:${run.id}`}
                    label={reminder.title}
                    description={run.message}
                    startContent={(
                      <StatusDot
                        variant={planRunStatusDotVariant(run.status)}
                        label={runStatusLabel(run.status, locale)}
                      />
                    )}
                    endContent={(
                      <Text type="supporting" color="secondary" className="maka-plan-countdown">
                        {formatReminderTime(run.at, locale)}
                      </Text>
                    )}
                  />
                ))}
              </List>
            )}
          </div>
        )}
      </ModulePage>

      <PlanReminderFormDialog
        key={formNonce}
        open={formDialogOpen}
        seed={formSeed}
        reminders={props.reminders}
        onOpenChange={setFormDialogOpen}
        onCreate={props.onCreate}
        onUpdate={props.onUpdate}
      />
    </>
  );
}
