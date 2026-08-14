import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectRecord } from '@maka/core/project';
import type { SessionSummary } from '@maka/core/session';
import { formatCompactTimestamp } from '@maka/core/relative-time';
import { Button, EmptyState, MoreMenu, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { Archive, ICON_SIZE, Search } from '@maka/ui/icons';
import { HStack, StackItem } from '@astryxdesign/core';
import { List, ListItem } from '@astryxdesign/core/List';
import { TextInput } from '@astryxdesign/core/TextInput';
import { getSettingsTasksCopy, type SettingsTasksCopy } from '../locales/settings-tasks-copy.js';
import { createSessionListRefresher } from '../session-read-state.js';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsPage, SettingsSection } from './settings-section';
import { SettingsSkeletonStack } from './settings-skeleton';
import { archivedTaskRows, matchesArchivedTaskQuery } from './task-catalog-rows';
import { useActionGuard } from './use-action-guard';

type TaskAction = 'restore' | 'delete' | 'purge';

export interface TasksSettingsPageProps {
  onOpenSession?: (sessionId: string) => void;
}

/**
 * Settings · 活动 · 已归档任务 — where archived tasks are restored or deleted.
 *
 * The rail is a navigator for active tasks: single selection, 260px, always on
 * screen. Cleaning up archived ones is the opposite shape — you need the
 * project and the date to decide, and you do it rarely. That work never fit in
 * the rail, which is why archived tasks lived there as a filter row that could
 * only ever restore one task at a time.
 *
 * The carrier is the entity-list one this repo already uses for projects, the
 * permission centre and the provider catalog: `SettingsSection` over a
 * `List`/`ListItem` group. An archived task is an entity, not a preference,
 * and the settings surface should not have one page speaking a different
 * visual language from the other six.
 *
 * Actions are per row — `恢复` in the open, `打开` and `彻底删除` behind the
 * row menu — plus one section-level `清空全部`. There is no multi-select: the
 * middle case it would serve (restore five of eleven) is rare enough that it
 * does not pay for a checkbox column, a select-all cell, and a strip of batch
 * buttons that shifts the list down the moment you tick a row.
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
  // One latch for the whole page: 清空全部 walks the same tasks the row
  // actions write to, so letting two overlap would race over rows the first
  // is already removing.
  const guard = useActionGuard<TaskAction>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projects, setProjects] = useState<readonly ProjectRecord[]>([]);
  const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);

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

  const projectNameOf = useCallback(
    (session: SessionSummary) =>
      session.projectId ? (projectNames.get(session.projectId) ?? copy.noProject) : copy.noProject,
    [copy.noProject, projectNames],
  );

  // Store order is already recency-first with a stable id tie-break, and the
  // projection preserves it, so there is nothing left to sort here.
  const archived = useMemo(() => archivedTaskRows(sessions), [sessions]);
  const visible = useMemo(
    () => archived.filter((session) => matchesArchivedTaskQuery(session, query, projectNameOf)),
    [archived, projectNameOf, query],
  );

  async function runTaskAction(
    action: TaskAction,
    run: () => Promise<void>,
    failureTitle: string,
    successMessage: string,
  ) {
    if (!guard.begin(action)) return;
    setBusy(true);
    try {
      await run();
      toast.success(successMessage);
    } catch (error) {
      toast.error(failureTitle, settingsActionErrorMessage(error, locale));
    } finally {
      guard.finish();
      if (mountedRef.current) setBusy(false);
    }
    await load();
  }

  async function restoreTask(session: SessionSummary) {
    await runTaskAction(
      'restore',
      // `revisionFamily` matches the rail's own row action: a task and its
      // revisions archive and restore as one unit, never half a family.
      () => window.maka.sessions.unarchive(session.id, { revisionFamily: true }),
      copy.restoreFailedTitle,
      copy.restoredToast,
    );
  }

  async function deleteTask(session: SessionSummary) {
    const confirmed = await toast.confirm({
      title: copy.deleteConfirmTitle(session.name),
      description: copy.deleteConfirmBody,
      confirmLabel: copy.deleteConfirmAction,
      cancelLabel: copy.cancel,
      destructive: true,
    });
    if (!confirmed) return;
    await runTaskAction(
      'delete',
      () => window.maka.sessions.remove(session.id, { revisionFamily: true }),
      copy.deleteFailedTitle,
      copy.deletedToast,
    );
  }

  /**
   * Clears every archived task, not the search result: the button says 全部,
   * and one that quietly stopped at what the box happens to match would
   * delete a different set than the one it named.
   */
  async function purgeAll() {
    const ids = archived.map((session) => session.id);
    if (ids.length === 0) return;
    const confirmed = await toast.confirm({
      title: copy.purgeConfirmTitle(ids.length),
      description: copy.purgeConfirmBody,
      confirmLabel: copy.deleteConfirmAction,
      cancelLabel: copy.cancel,
      destructive: true,
    });
    if (!confirmed || !guard.begin('purge')) return;
    setBusy(true);
    // Sequential, and each task is isolated: these are versioned writes, and
    // one task failing is no reason to abandon the rest.
    let firstError: unknown;
    let failed = 0;
    for (const id of ids) {
      try {
        await window.maka.sessions.remove(id, { revisionFamily: true });
      } catch (error) {
        failed += 1;
        firstError ??= error;
      }
    }
    guard.finish();
    if (mountedRef.current) setBusy(false);
    if (failed === ids.length) {
      toast.error(copy.purgeFailedTitle, settingsActionErrorMessage(firstError, locale));
    } else if (failed > 0) {
      toast.error(copy.purgeFailedTitle, copy.partialFailure(failed));
    } else {
      toast.success(copy.purgedToast(ids.length));
    }
    await load();
  }

  if (!loaded) {
    return (
      <SettingsPage>
        <SettingsSkeletonStack label={copy.loadingLabel} />
      </SettingsPage>
    );
  }

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

  // Nothing archived at all is a different situation from a search that
  // matched nothing, and only one of them replaces the whole page.
  if (archived.length === 0) {
    return (
      <SettingsPage>
        <EmptyState title={copy.emptyTitle} description={copy.emptyBody} />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage as="section" aria-label={copy.listAria}>
      {/* Search and 清空全部 share one row: as a section action the button
          landed a full 32px page rhythm below the box, alone on its own line. */}
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <TextInput
            label={copy.searchLabel}
            isLabelHidden
            placeholder={copy.searchPlaceholder}
            value={query}
            onChange={setQuery}
            startIcon={Search}
            hasClear
            width="100%"
          />
        </StackItem>
        <Button
          variant="destructive"
          isDisabled={busy}
          clickAction={() => void purgeAll()}
          label={copy.purge}
        />
      </HStack>
      <SettingsSection>
        {visible.length === 0 ? (
          <EmptyState isCompact title={copy.noMatchTitle} description={copy.noMatchBody} />
        ) : (
          <List density="balanced" hasDividers aria-label={copy.listAria}>
            {visible.map((session) => (
              <ArchivedTaskRow
                key={session.id}
                session={session}
                project={projectNameOf(session)}
                copy={copy}
                locale={locale}
                isBusy={busy}
                onRestore={() => void restoreTask(session)}
                onDelete={() => void deleteTask(session)}
                onOpen={onOpenSession ? () => onOpenSession(session.id) : undefined}
              />
            ))}
          </List>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}

function ArchivedTaskRow(props: {
  session: SessionSummary;
  project: string;
  copy: SettingsTasksCopy;
  locale: ReturnType<typeof useUiLocale>;
  isBusy: boolean;
  onRestore: () => void;
  onDelete: () => void;
  onOpen?: () => void;
}) {
  const { copy, session } = props;
  const updated = session.lastMessageAt
    ? formatCompactTimestamp(session.lastMessageAt, Date.now(), props.locale)
    : undefined;
  return (
    <ListItem
      label={session.name}
      description={updated ? `${props.project} · ${updated}` : props.project}
      startContent={<Archive size={ICON_SIZE.control} aria-hidden="true" />}
      endContent={
        <>
          <Button
            variant="secondary"
            size="sm"
            isDisabled={props.isBusy}
            clickAction={props.onRestore}
            label={copy.restore}
          />
          <MoreMenu
            label={copy.moreActions(session.name)}
            size="sm"
            items={[
              ...(props.onOpen ? [{ label: copy.open, onClick: props.onOpen }] : []),
              { label: copy.delete, onClick: props.onDelete },
            ]}
          />
        </>
      }
    />
  );
}
