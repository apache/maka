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

import { useEffect, useRef, useState } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import { useToast } from './toast.js';
import { ICON_SIZE, Clock, MoreHorizontal, Plus, RefreshCcw } from './icons.js';
import type { ScheduledTask, ScheduledTaskStatus } from '@maka/core/scheduled-task';
import {
  generalizedErrorMessage,
  generalizedErrorMessageChinese,
} from '@maka/core/redaction';
import {
  type ScheduledTaskFormSeed,
  compareScheduledTaskBySort,
  createScheduledTaskFormSeed,
  formatScheduledTaskRecurrence,
  formatTaskCountdown,
  formatTaskTime,
  normalizeScheduledTaskSearchQuery,
  scheduledTaskDuplicateSeed,
  scheduledTaskEditSeed,
  scheduledTaskMatchesSearch,
  scheduledTaskRunRangeStart,
  scheduledTaskStatusLabel,
  runStatusLabel,
} from './scheduled-task-helpers.js';
import { scheduledTaskStatusDotVariant, scheduledTaskRunStatusDotVariant } from './scheduled-task-status.js';
import { ScheduledTaskFormDialog } from './scheduled-task-form-dialog.js';
import { ScheduledTaskInspector } from './scheduled-task-inspector.js';
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
  ScheduledTaskDraftInput,
  ScheduledTaskUpdatePatch,
} from './module-panel-types.js';
import { getScheduledTaskCopy } from './scheduled-task-copy.js';
import { useUiLocale } from './locale-context.js';

export function ScheduledTaskPanel(props: {
  tasks: ScheduledTask[];
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
  onCreate?(input: ScheduledTaskDraftInput): boolean | Promise<boolean> | void | Promise<void>;
  onUpdate?(id: string, patch: ScheduledTaskUpdatePatch): boolean | Promise<boolean> | void | Promise<void>;
  onToggle?(id: string, enabled: boolean): void | Promise<void>;
  onTriggerNow?(id: string): void | Promise<void>;
  onSnooze?(id: string): void | Promise<void>;
  onClearRunHistory?(id: string): void | Promise<void>;
  onDelete?(id: string): void | Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getScheduledTaskCopy(locale);
  // 'active' = scheduled + paused. The low-volume default is 'all' so
  // completed tasks remain manageable even before filters are justified.
  type ScheduledTaskListFilter = 'current' | 'all' | ScheduledTaskStatus;
  type ScheduledTaskView = 'tasks' | 'runs';
  type ScheduledTaskRunRange = 'day' | 'week' | 'month' | 'all';
  type ScheduledTaskSort = 'created-desc' | 'next-run-asc' | 'updated-desc';
  const [pendingActionKeys, setPendingActionKeys] = useState<ReadonlySet<string>>(() => new Set());
  const scheduledTaskMountedRef = useMountedRef();
  const refreshPendingRef = useRef(false);
  const pendingActionKeysRef = useRef<Set<string>>(new Set());
  // Issue #1044: all create/edit form fields + submit live in
  // ScheduledTaskFormDialog. The panel owns its open state and seed;
  // `formNonce` gives Astryx a fresh native dialog for each form session.
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [formSeed, setFormSeed] = useState<ScheduledTaskFormSeed>(() => createScheduledTaskFormSeed());
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
  const [taskView, setTaskView] = useState<ScheduledTaskView>('tasks');
  const [runRange, setRunRange] = useState<ScheduledTaskRunRange>('week');
  const [listFilter, setListFilter] = useState<ScheduledTaskListFilter>('all');
  const [listSort, setListSort] = useState<ScheduledTaskSort>('created-desc');
  const [listQuery, setListQuery] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
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
  const normalizedListQuery = normalizeScheduledTaskSearchQuery(listQuery);
  const showListControls =
    props.tasks.length >= 8 ||
    normalizedListQuery.length > 0 ||
    listFilter !== 'all' ||
    listSort !== 'created-desc';
  const searchMatchedTasks = normalizedListQuery
    ? props.tasks.filter((task) => scheduledTaskMatchesSearch(task, normalizedListQuery, locale))
    : props.tasks;
  const visibleTasks = listFilter === 'all'
    ? searchMatchedTasks
    : listFilter === 'current'
      ? searchMatchedTasks.filter((task) => task.status === 'active' || task.status === 'paused')
      : searchMatchedTasks.filter((task) => task.status === listFilter);
  const sortedTasks = [...visibleTasks].sort((a, b) => compareScheduledTaskBySort(a, b, listSort, locale));
  const runRangeStart = scheduledTaskRunRangeStart(runRange, Date.now());
  const visibleRunEntries = props.tasks
    .flatMap((task) => task.runs.map((run) => ({ task, run })))
    .filter((entry) => runRangeStart === null || entry.run.at >= runRangeStart)
    .sort((a, b) => b.run.at - a.run.at);
  const activeCount = props.tasks.filter((task) => task.status === 'active').length;
  // Derived, not stored: whatever hides the row — deletion, a filter, the
  // 执行记录 view — closes the inspector without a reconciliation step, and the
  // panel always reads the freshest copy of the task. Note the id itself
  // survives, so clearing a filter re-opens the same selection; a deleted id
  // can never re-match, so only the reversible cases come back.
  const selectedTask = taskView === 'tasks'
    ? sortedTasks.find((task) => task.id === selectedTaskId) ?? null
    : null;
  const filterCounts: Record<ScheduledTaskListFilter, number> = {
    current: searchMatchedTasks.filter((task) => task.status === 'active' || task.status === 'paused').length,
    all: searchMatchedTasks.length,
    active: searchMatchedTasks.filter((task) => task.status === 'active').length,
    paused: searchMatchedTasks.filter((task) => task.status === 'paused').length,
    completed: searchMatchedTasks.filter((task) => task.status === 'completed').length,
    expired: searchMatchedTasks.filter((task) => task.status === 'expired').length,
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
    openTaskDialog(createScheduledTaskFormSeed());
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
  }, [props.tasks]);

  async function toggleKeepSystemAwake(next: boolean) {
    if (!props.onKeepSystemAwakeChange || keepSystemAwakePendingRef.current) return;
    keepSystemAwakePendingRef.current = true;
    setKeepSystemAwakePending(true);
    setKeepSystemAwakeChecked(next); // optimistic
    try {
      await props.onKeepSystemAwakeChange(next);
    } catch (error) {
      // Revert to reflect REALITY, and surface the failure in Chinese.
      if (scheduledTaskMountedRef.current) setKeepSystemAwakeChecked(!next);
      toast.error(copy.page.keepAwakeErrorTitle, locale === 'zh'
        ? generalizedErrorMessageChinese(error, copy.page.keepAwakeErrorFallback)
        : generalizedErrorMessage(error, copy.page.keepAwakeErrorFallback));
    } finally {
      keepSystemAwakePendingRef.current = false;
      if (scheduledTaskMountedRef.current) setKeepSystemAwakePending(false);
    }
  }

  function openTaskDialog(seed: ScheduledTaskFormSeed) {
    formDialogOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setFormSeed(seed);
    setFormNonce((nonce) => nonce + 1);
    setFormDialogOpen(true);
  }

  async function runScheduledTaskAction(
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
      if (scheduledTaskMountedRef.current) setPendingActionKeys(pendingWithoutAction);
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
      if (scheduledTaskMountedRef.current) setRefreshPending(false);
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
        onChange={(value) => setListFilter(value as ScheduledTaskListFilter)}
        label={copy.page.state}
        isLabelHidden
        width={148}
        options={[
          { value: 'current', label: copy.page.filterOption(copy.page.active, filterCounts.current) },
          { value: 'all', label: copy.page.filterOption(copy.page.all, filterCounts.all) },
          { value: 'active', label: copy.page.filterOption(copy.status.active, filterCounts.active) },
          { value: 'paused', label: copy.page.filterOption(copy.status.paused, filterCounts.paused) },
          { value: 'completed', label: copy.page.filterOption(copy.status.completed, filterCounts.completed) },
          { value: 'expired', label: copy.page.filterOption(copy.status.expired, filterCounts.expired) },
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
        inspectorAutoSaveId="maka-scheduled-task-inspector"
        onInspectorDismiss={() => setSelectedTaskId(null)}
        inspector={selectedTask ? (
          <ScheduledTaskInspector
            task={selectedTask}
            pendingActionKeys={pendingActionKeys}
            onToggle={(enabled) => void runScheduledTaskAction(
              `${selectedTask.id}:toggle`,
              () => props.onToggle?.(selectedTask.id, enabled),
            )}
            onEdit={() => openTaskDialog(scheduledTaskEditSeed(selectedTask))}
            onDuplicate={() => openTaskDialog(scheduledTaskDuplicateSeed(selectedTask, locale))}
            onTriggerNow={() => void runScheduledTaskAction(
              `${selectedTask.id}:trigger`,
              () => props.onTriggerNow?.(selectedTask.id),
            )}
            onSnooze={() => void runScheduledTaskAction(
              `${selectedTask.id}:snooze`,
              () => props.onSnooze?.(selectedTask.id),
            )}
            onClearRunHistory={() => void runScheduledTaskAction(
              `${selectedTask.id}:clear-runs`,
              () => props.onClearRunHistory?.(selectedTask.id),
            )}
            onDelete={() => {
              // The 删除 button is about to unmount with the whole inspector,
              // and nothing else would claim focus — it would fall to `body`,
              // dropping a keyboard user at the top of the document. Hand it
              // to the row that takes the deleted one's place.
              focusRowAfterRemovalRef.current = sortedTasks.findIndex(
                (task) => task.id === selectedTask.id,
              );
              void runScheduledTaskAction(
                `${selectedTask.id}:delete`,
                () => props.onDelete?.(selectedTask.id),
              );
            }}
          />
        ) : undefined}
        actions={
          <>
            <UiButton
              variant="primary"
              onClick={() => openTaskDialog(createScheduledTaskFormSeed())}
              icon={<Plus size={ICON_SIZE.control} aria-hidden="true" />}
              label={copy.page.create}
            />
            <DropdownMenu
              button={{
                label: copy.page.pageSettings,
                icon: <MoreHorizontal size={ICON_SIZE.chrome} aria-hidden="true" />,
                isIconOnly: true,
                variant: 'ghost',
              }}
              className="maka-scheduled-task-page-menu"
            >
              <DropdownMenuItem
                onClick={() => void refreshFromPanel()}
                isDisabled={!props.onRefresh || refreshPending}
                icon={<RefreshCcw size={ICON_SIZE.control} aria-hidden="true" />}
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
                  value={taskView}
                  onChange={(value) => {
                    if (value !== 'tasks' && value !== 'runs') return;
                    setTaskView(value);
                  }}
                  label={copy.page.viewsAriaLabel}
                  size="sm"
                >
                  <SegmentedControlItem value="tasks" label={copy.page.tasks} />
                  <SegmentedControlItem value="runs" label={copy.page.runs} />
                </SegmentedControl>
              }
              endContent={taskView === 'tasks' ? listControls : (
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
        {taskView === 'tasks' ? (
          <div className="maka-module-page-panel" ref={rowsContainerRef} {...rovingRows}>
            {/* Selecting a row moves no focus — a mouse user did not ask to
                leave the list — so nothing else would tell a screen reader
                that the details opened. This says so, politely, after
                whatever the activation itself announced. Placement is left
                unnamed: below the breakpoint the same content is a sheet
                that announces itself, and this must not contradict it. */}
            <p className="maka-visually-hidden" role="status" aria-live="polite">
              {selectedTask ? copy.page.inspectorOpened(selectedTask.title) : ''}
            </p>
            {normalizedListQuery && (
              <div className="maka-scheduled-task-search-summary" role="status" aria-live="polite">
                <span>{copy.page.searchMatches(searchMatchedTasks.length)}</span>
                <UiButton variant="ghost" size="sm" onClick={() => setListQuery('')} label={copy.page.clearSearch} />
              </div>
            )}
            {props.tasks.length === 0 ? (
              <EmptyState
                icon={<Clock size={ICON_SIZE.empty} />}
                title={copy.page.emptyTitle}
                description={copy.page.emptyBody}
                actions={(
                  <UiButton
                    variant="primary"
                    onClick={() => openTaskDialog(createScheduledTaskFormSeed())}
                    label={copy.page.create}
                  />
                )}
              />
            ) : sortedTasks.length === 0 ? (
              /* Filter empty (DESIGN.md §10): the clear action resets both
                 dimensions the reader may have narrowed — query and state. */
              (<EmptyState
                icon={<Clock size={ICON_SIZE.empty} />}
                title={normalizedListQuery ? copy.page.noSearchTitle : copy.page.noFilterTitle}
                description={normalizedListQuery ? copy.page.noSearchBody : copy.page.noFilterBody}
                actions={<UiButton variant="ghost" size="sm" label={copy.page.clearSearch} onClick={() => { setListQuery(''); setListFilter('all'); }} />}
              />)
            ) : (
              /* Selectable, otherwise inert rows: every control that used to
                 ride the row now lives in the inspector, which is what Astryx
                 asks for — no interactive elements inside an interactive
                 list item. The leading StatusDot also fixes the alignment the
                 old hand-held 40px switch placeholder kept getting wrong. */
              (<List density="balanced" hasDividers className="maka-module-page-rows" aria-label={copy.page.listAriaLabel}>
                {sortedTasks.map((task) => {
                  // `triggered` is a plain "it ran" record, not a health
                  // signal — only blocked and failed earn the row's attention.
                  const lastRun = task.runs[0];
                  const runException = lastRun && lastRun.outcome !== 'ok'
                    ? lastRun
                    : null;
                  return (
                  <ListItem
                    key={task.id}
                    label={task.title}
                    /* An exceptional state leads the line as TEXT, not only as
                       the dot's colour: the dot sits outside the row's button,
                       so tabbing a row would otherwise announce no state at
                       all, and colour alone fails WCAG 1.4.1.
                       待触发 stays silent — it is the normal case, and naming
                       it on every row is the noise this list is built to
                       avoid.

                       A failed or blocked LAST RUN counts as exceptional here
                       even while the task's own lifecycle reads
                       `scheduled`: those are two different questions ("is it
                       still on?" vs "did it work?"), and a delivery that
                       failed is exactly what someone scanning this page came
                       to find. Reporting only the lifecycle made a broken
                       task and a healthy one identical on the row, so the
                       page could only be read by opening every entry. */
                    description={[
                      task.effect.kind !== 'notify' ? copy.detail.agentSource : null,
                      runException
                        ? runStatusLabel(runException.outcome, locale)
                        : task.status === 'active'
                          ? null
                          : scheduledTaskStatusLabel(task.status, locale),
                      formatScheduledTaskRecurrence(task, locale),
                      task.nextFireAt
                        ? copy.page.nextRun(formatTaskTime(task.nextFireAt, locale))
                        : lastRun
                          ? copy.page.recentRun(formatTaskTime(lastRun.at, locale))
                          : copy.page.unscheduled,
                    ].filter(Boolean).join(' · ')}
                    startContent={(
                      <StatusDot
                        variant={runException
                          ? scheduledTaskRunStatusDotVariant(runException.outcome)
                          : scheduledTaskStatusDotVariant(task.status)}
                        label={runException
                          ? runStatusLabel(runException.outcome, locale)
                          : scheduledTaskStatusLabel(task.status, locale)}
                      />
                    )}
                    endContent={task.nextFireAt !== null ? (
                      <Text type="supporting" color="secondary" className="maka-scheduled-task-countdown">
                        {formatTaskCountdown(task.nextFireAt, locale)}
                      </Text>
                    ) : undefined}
                    isSelected={selectedTaskId === task.id}
                    onClick={() => setSelectedTaskId(
                      selectedTaskId === task.id ? null : task.id,
                    )}
                  />
                  );
                })}
              </List>)
            )}
          </div>
        ) : (
          <div className="maka-module-page-panel">
            {visibleRunEntries.length === 0 ? (
              /* A narrowed range that matches nothing carries the widen action
                 (DESIGN.md §10) — the reader caused this state and must exit. */
              (<EmptyState
                icon={<Clock size={ICON_SIZE.empty} />}
                title={copy.page.noRunsTitle}
                description={copy.page.noRunsBody}
                actions={runRange !== 'all' ? (
                  <UiButton variant="ghost" size="sm" label={copy.page.showAllTime} onClick={() => setRunRange('all')} />
                ) : undefined}
              />)
            ) : (
              <List density="balanced" hasDividers className="maka-module-page-rows" aria-label={copy.page.runsAriaLabel}>
                {visibleRunEntries.map(({ task, run }) => (
                  <ListItem
                    key={`${task.id}:${run.id}`}
                    label={task.title}
                    description={run.message}
                    startContent={(
                      <StatusDot
                        variant={scheduledTaskRunStatusDotVariant(run.outcome)}
                        label={runStatusLabel(run.outcome, locale)}
                      />
                    )}
                    endContent={(
                      <Text type="supporting" color="secondary" className="maka-scheduled-task-countdown">
                        {formatTaskTime(run.at, locale)}
                      </Text>
                    )}
                  />
                ))}
              </List>
            )}
          </div>
        )}
      </ModulePage>
      <ScheduledTaskFormDialog
        key={formNonce}
        open={formDialogOpen}
        seed={formSeed}
        tasks={props.tasks}
        onOpenChange={setFormDialogOpen}
        onCreate={props.onCreate}
        onUpdate={props.onUpdate}
      />
    </>
  );
}
