import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectRecord } from '@maka/core/project';
import type { SessionSummary } from '@maka/core/session';
import { formatCompactTimestamp } from '@maka/core/relative-time';
import { Badge, Button, EmptyState, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { HStack, List, ListItem, Text } from '@astryxdesign/core';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { getSettingsTasksCopy } from '../locales/settings-tasks-copy.js';
import { ExternalSessionImportDialog } from '../external-session-import-dialog.js';
import { createSessionListRefresher } from '../session-read-state.js';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsActions, SettingsPage, SettingsSection } from './settings-section';
import { SettingsSkeletonStack } from './settings-skeleton';
import { projectTaskRows, type TaskScope } from './task-catalog-rows';
import { useActionGuard } from './use-action-guard';

type BatchAction = 'restore' | 'archive' | 'delete';

export interface TasksSettingsPageProps {
  onOpenSession?: (sessionId: string) => void;
}

/**
 * Settings · 活动 · 任务 — the management view of the task catalog.
 *
 * The rail is a navigator: single selection, 260px, always on screen. Managing
 * tasks is the opposite shape — you act on several at once, you need to see
 * the project and the date to decide, and you do it rarely. That work never
 * fit in the rail, which is why archived tasks lived there as a filter row
 * that could only ever restore one task at a time.
 *
 * This page reads the same catalog the rail does, through the same refresher
 * and the same row projection (`projectTaskRows`), so a row here means exactly
 * what a row there means. Mutations reach the rail through the shared
 * `sessions.subscribeChanges` broadcast; neither surface pushes state at the
 * other.
 */
export function TasksSettingsPage({ onOpenSession }: TasksSettingsPageProps) {
  const locale = useUiLocale();
  const copy = getSettingsTasksCopy(locale);
  const toast = useToast();
  const mountedRef = useMountedRef();
  // One latch for the whole page: every batch acts on the same selection, so
  // letting two overlap would race over rows the first is already removing.
  const guard = useActionGuard<BatchAction>();
  const [scope, setScope] = useState<TaskScope>('all');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projects, setProjects] = useState<readonly ProjectRecord[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
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
  const visible = useMemo(() => projectTaskRows(sessions, scope), [sessions, scope]);

  // Selection survives a background refresh but not a scope switch: the rows
  // you were acting on are no longer the rows on screen.
  const visibleById = useMemo(() => new Map(visible.map((s) => [s.id, s])), [visible]);
  const effectiveSelection = useMemo(
    () => [...selected].filter((id) => visibleById.has(id)),
    [selected, visibleById],
  );
  const restorable = useMemo(
    () => effectiveSelection.filter((id) => visibleById.get(id)?.isArchived),
    [effectiveSelection, visibleById],
  );
  const archivable = useMemo(
    () => effectiveSelection.filter((id) => !visibleById.get(id)?.isArchived),
    [effectiveSelection, visibleById],
  );

  function changeScope(next: TaskScope) {
    setScope(next);
    setSelected(new Set());
  }

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
    if (failed === ids.length) toast.error(failureTitle, settingsActionErrorMessage(firstError, locale));
    else if (failed > 0) toast.error(failureTitle, copy.partialFailure(failed));
    else toast.success(success(ids.length));
    await load();
  }

  async function restoreSelected() {
    await runBatch(
      'restore',
      restorable,
      // `revisionFamily` matches the rail's own row action: a task and its
      // revisions archive and restore as one unit, never half a family.
      (id) => window.maka.sessions.unarchive(id, { revisionFamily: true }),
      copy.restoreFailedTitle,
      copy.restoredToast,
    );
  }

  async function archiveSelected() {
    await runBatch(
      'archive',
      archivable,
      (id) => window.maka.sessions.archive(id, { revisionFamily: true }),
      copy.archiveFailedTitle,
      copy.archivedToast,
    );
  }

  async function deleteSelected() {
    const ids = effectiveSelection;
    if (ids.length === 0) return;
    const confirmed = await toast.confirm({
      title: copy.deleteConfirmTitle(ids.length),
      description: copy.deleteConfirmBody,
      confirmLabel: copy.deleteConfirmAction,
      cancelLabel: copy.cancel,
      destructive: true,
    });
    if (!confirmed) return;
    await runBatch(
      'delete',
      ids,
      (id) => window.maka.sessions.remove(id, { revisionFamily: true }),
      copy.deleteFailedTitle,
      copy.deletedToast,
    );
  }

  const allSelected = visible.length > 0 && effectiveSelection.length === visible.length;
  const busy = pending !== null;

  function taskList() {
    if (!loaded) return <SettingsSkeletonStack label={copy.loadingLabel} />;
    if (loadFailed) {
      return (
        <EmptyState
          title={copy.loadFailed}
          actions={<Button variant="secondary" size="sm" clickAction={() => void load()} label={copy.retry} />}
        />
      );
    }
    if (visible.length === 0) {
      return (
        <EmptyState
          title={scope === 'archived' ? copy.emptyArchivedTitle : copy.emptyAllTitle}
          description={scope === 'archived' ? copy.emptyArchivedBody : copy.emptyAllBody}
        />
      );
    }
    return (
      <>
        <SettingsActions aria-label={copy.filterAria}>
          <CheckboxInput
            label={copy.selectAllAria}
            isLabelHidden
            value={allSelected ? true : effectiveSelection.length > 0 ? 'indeterminate' : false}
            onChange={(checked) => toggleAll(checked)}
          />
          <Text type="supporting" size="sm" color="secondary">
            {effectiveSelection.length > 0 ? copy.selectedCount(effectiveSelection.length) : null}
          </Text>
          {effectiveSelection.length > 0 && (
            <>
              {restorable.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  isDisabled={busy}
                  clickAction={() => void restoreSelected()}
                  label={pending === 'restore' ? copy.restoring : copy.restore}
                />
              )}
              {archivable.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  isDisabled={busy}
                  clickAction={() => void archiveSelected()}
                  label={pending === 'archive' ? copy.archiving : copy.archive}
                />
              )}
              <Button
                variant="destructive"
                size="sm"
                isDisabled={busy}
                clickAction={() => void deleteSelected()}
                label={pending === 'delete' ? copy.deleting : copy.delete}
              />
            </>
          )}
        </SettingsActions>
        <List density="balanced" hasDividers>
          {visible.map((session) => (
            <ListItem
              key={session.id}
              label={session.name}
              onClick={onOpenSession ? () => onOpenSession(session.id) : undefined}
              aria-label={onOpenSession ? copy.openTaskAria(session.name) : undefined}
              startContent={
                // The row opens the task; the checkbox selects it. Without this
                // the checkbox would do both.
                <span onClick={(event) => event.stopPropagation()}>
                  <CheckboxInput
                    label={copy.selectRowAria(session.name)}
                    isLabelHidden
                    value={selected.has(session.id)}
                    onChange={(checked) => toggleRow(session.id, checked)}
                  />
                </span>
              }
              endContent={
                <HStack gap={2} vAlign="center">
                  {/* The archived badge only earns its place in the `all`
                      view, where archived and active rows sit together.
                      In the archived view every row carries it. */}
                  {scope === 'all' && session.isArchived && (
                    <Badge variant="neutral" label={copy.archivedBadge} />
                  )}
                  <Text type="supporting" size="sm" color="secondary">
                    {session.projectId
                      ? (projectNames.get(session.projectId) ?? copy.noProject)
                      : copy.noProject}
                  </Text>
                  <Text type="supporting" size="sm" color="secondary">
                    {session.lastMessageAt
                      ? formatCompactTimestamp(session.lastMessageAt, Date.now(), locale)
                      : '—'}
                  </Text>
                </HStack>
              }
            />
          ))}
        </List>
      </>
    );
  }

  return (
    <SettingsPage>
      <SettingsSection
        variant="bare"
        action={
          <SegmentedControl
            value={scope}
            onChange={(next) => changeScope(next as TaskScope)}
            label={copy.filterAria}
            size="sm"
          >
            <SegmentedControlItem value="all" label={copy.filterAll} />
            <SegmentedControlItem value="archived" label={copy.filterArchived} />
          </SegmentedControl>
        }
      >
        {taskList()}
      </SettingsSection>

      <SettingsSection title={copy.importTitle} description={copy.importDescription}>
        <Button
          variant="secondary"
          clickAction={() => setImportOpen(true)}
          label={copy.importAction}
        />
      </SettingsSection>

      {/* Self-contained here rather than routed through AppShell's overlay
          stack: importing from a management page should land the task in the
          catalog and stay put. AppShell's own entry opens the imported task in
          chat, which would throw you out of the page you are working in. */}
      <ExternalSessionImportDialog
        isOpen={importOpen}
        onOpenChange={setImportOpen}
        onImported={(session) => {
          toast.success(copy.importedToast(session.name));
          void load();
        }}
      />
    </SettingsPage>
  );
}
