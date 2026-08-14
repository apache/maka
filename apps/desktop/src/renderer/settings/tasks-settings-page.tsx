import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectRecord } from '@maka/core/project';
import type { SessionSummary } from '@maka/core/session';
import { formatCompactTimestamp } from '@maka/core/relative-time';
import { Button, EmptyState, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { ChevronRight, ICON_SIZE, Search } from '@maka/ui/icons';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { HStack, List, ListItem, Text } from '@astryxdesign/core';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Selector } from '@astryxdesign/core/Selector';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Toolbar } from '@astryxdesign/core/Toolbar';
import { getSettingsTasksCopy, type SettingsTasksCopy } from '../locales/settings-tasks-copy.js';
import { createSessionListRefresher } from '../session-read-state.js';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsPage, SettingsSection } from './settings-section';
import { SettingsSkeletonStack } from './settings-skeleton';
import { archivedTaskRows, filterArchivedTasks, NO_PROJECT_FILTER } from './task-catalog-rows';
import { useActionGuard } from './use-action-guard';

type BatchAction = 'restore' | 'delete' | 'purge';

export interface TasksSettingsPageProps {
  onOpenSession?: (sessionId: string) => void;
}

/**
 * Settings · 活动 · 已归档任务 — where archived tasks are restored or deleted.
 *
 * The rail is a navigator for active tasks: single selection, 260px, always on
 * screen. Cleaning up archived ones is the opposite shape — you act on several
 * at once, you need the project and the date to decide, and you do it rarely.
 * That work never fit in the rail, which is why archived tasks lived there as
 * a filter row that could only ever restore one task at a time.
 *
 * The page lists only archived tasks. An all/archived switch would be a false
 * choice: archived is a subset of all, so the two scopes overlap and every row
 * then needs a badge to say which one it is. One scope needs no badge, and the
 * batch actions stop depending on what happens to be selected — restore and
 * delete, always both, always meaningful.
 *
 * It reads the catalog through the same refresher and the same projection the
 * rail uses (`archivedTaskRows`), so a row here means what a row there means.
 * Mutations reach the rail through the shared `sessions.subscribeChanges`
 * broadcast; neither surface pushes state at the other.
 */
export function TasksSettingsPage({ onOpenSession }: TasksSettingsPageProps) {
  const locale = useUiLocale();
  const copy = getSettingsTasksCopy(locale);
  const toast = useToast();
  const mountedRef = useMountedRef();
  // One latch for the whole page: both batches act on the same selection, so
  // letting them overlap would race over rows the first is already removing.
  const guard = useActionGuard<BatchAction>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projects, setProjects] = useState<readonly ProjectRecord[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<BatchAction | null>(null);

  const sessionsRef = useRef<SessionSummary[]>([]);
  const refresherRef = useRef<ReturnType<typeof createSessionListRefresher> | null>(null);
  if (refresherRef.current === null) {
    // The same seam the rail lists through: single-flight with a generation
    // guard, so a burst of change events collapses into one trailing read and
    // a slow response can never overwrite a newer one. Read boundaries stay
    // empty because this page shows no unread state.
    refresherRef.current = createSessionListRefresher({
      listSessions: () => window.maka.sessions.list(),
      readBoundaries: () => ({}),
      currentSessions: () => sessionsRef.current,
      commitSessions: (next) => {
        sessionsRef.current = next;
        if (mountedRef.current) {
          setSessions(next);
          setLoadFailed(false);
        }
      },
      onError: () => {
        if (mountedRef.current) setLoadFailed(true);
      },
    });
  }

  const load = useCallback(async () => {
    await refresherRef.current?.refresh();
    try {
      const snapshot = await window.maka.projects.getSnapshot();
      if (mountedRef.current) setProjects(snapshot.projects);
    } catch {
      // A missing project snapshot costs a row its project name, not the page.
    }
    if (mountedRef.current) setLoaded(true);
  }, [mountedRef]);

  useEffect(() => {
    void load();
    // Every writer in the app broadcasts here, including the rail's own row
    // menu, so this page stays correct while it is open behind the modal.
    const unsubscribeSessions = window.maka.sessions.subscribeChanges(() => void load());
    const unsubscribeProjects = window.maka.projects.subscribeChanges(() => void load());
    return () => {
      unsubscribeSessions();
      unsubscribeProjects();
    };
  }, [load]);

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects) names.set(project.id, project.name);
    return names;
  }, [projects]);

  // Store order is already recency-first with a stable id tie-break, and the
  // projection preserves it, so there is nothing left to sort here.
  const archived = useMemo(() => archivedTaskRows(sessions), [sessions]);
  const visible = useMemo(
    () =>
      filterArchivedTasks(archived, { query, projectId: projectFilter }, (id) =>
        projectNames.get(id),
      ),
    [archived, projectFilter, projectNames, query],
  );

  // Only projects that actually hold an archived task: a filter offering
  // choices that all resolve to an empty list is not a filter.
  const projectOptions = useMemo(() => {
    const ids = new Set<string>();
    let hasUnassigned = false;
    for (const session of archived) {
      if (session.projectId) ids.add(session.projectId);
      else hasUnassigned = true;
    }
    const options = [...ids].map((id) => ({ value: id, label: projectNames.get(id) ?? id }));
    options.sort((a, b) => a.label.localeCompare(b.label));
    if (hasUnassigned) options.push({ value: NO_PROJECT_FILTER, label: copy.noProject });
    return options;
  }, [archived, copy.noProject, projectNames]);

  // Selection survives a background refresh, but only over rows still on
  // screen: restoring a task takes it off this page, and so does typing a
  // query that excludes it.
  const visibleIds = useMemo(() => new Set(visible.map((s) => s.id)), [visible]);
  const effectiveSelection = useMemo(
    () => [...selected].filter((id) => visibleIds.has(id)),
    [selected, visibleIds],
  );

  function toggleRow(sessionId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(visible.map((s) => s.id)) : new Set());
  }

  async function runBatch(
    action: BatchAction,
    ids: readonly string[],
    run: (sessionId: string) => Promise<void>,
    failureTitle: string,
    success: (count: number) => string,
  ) {
    if (ids.length === 0 || !guard.begin(action)) return;
    setPending(action);
    // Sequential, and each task is isolated: these are versioned writes, and
    // one task failing is no reason to abandon the rest of the selection.
    let firstError: unknown;
    let failed = 0;
    for (const id of ids) {
      try {
        await run(id);
      } catch (error) {
        failed += 1;
        firstError ??= error;
      }
    }
    guard.finish();
    if (mountedRef.current) {
      setSelected(new Set());
      setPending(null);
    }
    if (failed === ids.length) {
      toast.error(failureTitle, settingsActionErrorMessage(firstError, locale));
    } else if (failed > 0) toast.error(failureTitle, copy.partialFailure(failed));
    else toast.success(success(ids.length));
    await load();
  }

  async function restoreSelected() {
    await runBatch(
      'restore',
      effectiveSelection,
      // `revisionFamily` matches the rail's own row action: a task and its
      // revisions archive and restore as one unit, never half a family.
      (id) => window.maka.sessions.unarchive(id, { revisionFamily: true }),
      copy.restoreFailedTitle,
      copy.restoredToast,
    );
  }

  async function confirmDelete(action: BatchAction, ids: readonly string[], title: string) {
    if (ids.length === 0) return;
    const confirmed = await toast.confirm({
      title,
      description: copy.deleteConfirmBody,
      confirmLabel: copy.deleteConfirmAction,
      cancelLabel: copy.cancel,
      destructive: true,
    });
    if (!confirmed) return;
    await runBatch(
      action,
      ids,
      (id) => window.maka.sessions.remove(id, { revisionFamily: true }),
      copy.deleteFailedTitle,
      copy.deletedToast,
    );
  }

  async function deleteSelected() {
    await confirmDelete('delete', effectiveSelection, copy.deleteConfirmTitle(effectiveSelection.length));
  }

  // Clears what is on screen, not the whole archive. The list is the filter's
  // result, so emptying it must mean emptying that result — a button that
  // silently reached past the filter would delete tasks the person cannot see.
  async function purgeVisible() {
    const ids = visible.map((session) => session.id);
    await confirmDelete('purge', ids, copy.purgeConfirmTitle(ids.length));
  }

  if (!loaded) return <SettingsPage>{<SettingsSkeletonStack label={copy.loadingLabel} />}</SettingsPage>;

  if (loadFailed) {
    return (
      <SettingsPage>
        <EmptyState
          title={copy.loadFailed}
          actions={
            <Button
              variant="secondary"
              size="sm"
              clickAction={() => void load()}
              label={copy.retry}
            />
          }
        />
      </SettingsPage>
    );
  }

  // Nothing archived at all is a different situation from a filter that
  // matched nothing, and only one of them is worth a page-level empty state.
  if (archived.length === 0) {
    return (
      <SettingsPage>
        <EmptyState title={copy.emptyTitle} description={copy.emptyBody} />
      </SettingsPage>
    );
  }

  const allSelected = visible.length > 0 && effectiveSelection.length === visible.length;
  const hasSelection = effectiveSelection.length > 0;
  const busy = pending !== null;

  return (
    <SettingsPage>
      <SettingsSection variant="rows">
        {/* Always mounted, never conditional: a toolbar that appears on first
            selection pushes the list it belongs to down the page. The filters
            hold the start slot; the end slot swaps between clearing what the
            filters produced and acting on what is selected, inside a stable
            height. */}
        <Toolbar
          label={copy.batchActionsAria}
          size="sm"
          variant="muted"
          dividers={['bottom']}
          startContent={
            <>
              <CheckboxInput
                label={copy.selectAllAria}
                isLabelHidden
                value={allSelected ? true : hasSelection ? 'indeterminate' : false}
                onChange={(checked) => toggleAll(checked)}
              />
              <TextInput
                label={copy.searchLabel}
                isLabelHidden
                placeholder={copy.searchPlaceholder}
                value={query}
                onChange={setQuery}
                startIcon={Search}
                hasClear
                width={240}
              />
              {projectOptions.length > 1 && (
                <Selector
                  label={copy.projectFilterLabel}
                  isLabelHidden
                  variant="ghost"
                  placeholder={copy.allProjects}
                  hasClear
                  value={projectFilter}
                  onChange={setProjectFilter}
                  options={projectOptions}
                  width={180}
                />
              )}
            </>
          }
          endContent={
            hasSelection ? (
              <>
                <Text type="supporting" size="sm" color="secondary">
                  {copy.selectedCount(effectiveSelection.length)}
                </Text>
                <Button
                  variant="ghost"
                  isDisabled={busy}
                  clickAction={() => void restoreSelected()}
                  label={pending === 'restore' ? copy.restoring : copy.restore}
                />
                <Button
                  variant="destructive"
                  isDisabled={busy}
                  clickAction={() => void deleteSelected()}
                  label={pending === 'delete' ? copy.deleting : copy.delete}
                />
              </>
            ) : (
              <>
                <Text type="supporting" size="sm" color="secondary">
                  {copy.totalCount(visible.length)}
                </Text>
                {visible.length > 0 && (
                  <Button
                    variant="ghost"
                    isDisabled={busy}
                    clickAction={() => void purgeVisible()}
                    label={pending === 'purge' ? copy.deleting : copy.purge}
                  />
                )}
              </>
            )
          }
        />
        {visible.length === 0 ? (
          <EmptyState isCompact title={copy.noMatchTitle} description={copy.noMatchBody} />
        ) : (
          <List density="balanced" hasDividers>
            {visible.map((session) => (
              <TaskRow
                key={session.id}
                session={session}
                copy={copy}
                locale={locale}
                projectName={session.projectId ? projectNames.get(session.projectId) : undefined}
                isSelected={selected.has(session.id)}
                onToggle={(checked) => toggleRow(session.id, checked)}
                onOpen={onOpenSession ? () => onOpenSession(session.id) : undefined}
              />
            ))}
          </List>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}

/**
 * One archived task.
 *
 * The row surface selects rather than opens. Astryx's `interactiveRef` makes
 * the whole row an enlarged tap target for the checkbox it already contains,
 * which is the accessible way to do this: a row-level `onClick` plus a nested
 * checkbox would be two tab stops for one option. Opening the task is the
 * secondary action, so it gets the explicit affordance at the end of the row.
 */
function TaskRow({
  session,
  copy,
  locale,
  projectName,
  isSelected,
  onToggle,
  onOpen,
}: {
  session: SessionSummary;
  copy: SettingsTasksCopy;
  locale: ReturnType<typeof useUiLocale>;
  projectName: string | undefined;
  isSelected: boolean;
  onToggle: (checked: boolean) => void;
  onOpen: (() => void) | undefined;
}) {
  const checkboxRef = useRef<HTMLInputElement>(null);
  return (
    <ListItem
      label={session.name}
      isSelected={isSelected}
      interactiveRef={checkboxRef}
      startContent={
        <CheckboxInput
          ref={checkboxRef}
          label={copy.selectRowAria(session.name)}
          isLabelHidden
          value={isSelected}
          onChange={onToggle}
        />
      }
      endContent={
        <HStack gap={2} vAlign="center">
          <Text type="supporting" size="sm" color="secondary">
            {projectName ?? copy.noProject}
          </Text>
          <Text type="supporting" size="sm" color="secondary">
            {session.lastMessageAt
              ? formatCompactTimestamp(session.lastMessageAt, Date.now(), locale)
              : '—'}
          </Text>
          {onOpen && (
            <IconButton
              variant="ghost"
              size="sm"
              label={copy.openTaskAria(session.name)}
              icon={<ChevronRight size={ICON_SIZE.control} aria-hidden="true" />}
              onClick={onOpen}
            />
          )}
        </HStack>
      }
    />
  );
}
