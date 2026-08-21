import { useCallback, useMemo, useState } from 'react';
import type { ProjectRecord } from '@maka/core/project';
import { formatCompactTimestamp } from '@maka/core/relative-time';
import { Button, EmptyState, MoreMenu, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { Archive, ICON_SIZE, Search } from '@maka/ui/icons';
import { HStack, StackItem } from '@astryxdesign/core';
import { List, ListItem } from '@astryxdesign/core/List';
import { TextInput } from '@astryxdesign/core/TextInput';
import type { SessionPurgeOutcome } from '../app-shell-session-row-actions.js';
import type { DesktopSessionSummary } from '../../preload/bridge-contract.js';
import { getSettingsSharedCopy } from '../locales/settings-shared-copy.js';
import { getSettingsTasksCopy } from '../locales/settings-tasks-copy.js';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsPage, SettingsSection } from './settings-section';
import {
  archivedTaskRows,
  isOrphanedSubagentTask,
  matchesArchivedTaskQuery,
} from './task-catalog-rows';

/**
 * Everything this page needs from the shell's session catalog, as one prop so
 * the three components between the shell and this page forward a value they do
 * not have to understand.
 */
export interface ArchivedTasksBridge {
  sessions: readonly DesktopSessionSummary[];
  projects: readonly ProjectRecord[];
  onRestore(sessionId: string): void;
  onDelete(sessionId: string): void;
  /**
   * Deletes the tasks that are still archived when the sweep reaches them, and
   * reports what it could confirm. It never touches an id outside this set.
   */
  onPurge(sessionIds: readonly string[]): Promise<SessionPurgeOutcome>;
}

/**
 * Settings · 活动 · 已归档任务 — where archived tasks are restored or deleted.
 *
 * The rail is a navigator for active tasks: single selection, 260px, always on
 * screen. Cleaning up archived ones is the opposite shape — you need the
 * project and the date to decide, and you do it rarely.
 *
 * The carrier is the entity-list one this repo already uses for projects, the
 * permission centre and the provider catalog: `SettingsSection` over a
 * `List`/`ListItem` group. An archived task is an entity, not a preference.
 *
 * This page owns no session state. Rows come from the shell's catalog through
 * the rail's own projection, and restoring or deleting one calls the rail's own
 * row action — the same confirm, the same cleanup, the same toasts. A second
 * copy of that machinery would drift from the rail's the first time either side
 * changed. What is genuinely new here is finding a task by name or project, and
 * clearing a set of them in one pass.
 */
export function TasksSettingsPage(props: ArchivedTasksBridge) {
  const locale = useUiLocale();
  const copy = getSettingsTasksCopy(locale);
  const toast = useToast();
  const mountedRef = useMountedRef();
  const [query, setQuery] = useState('');
  const [purging, setPurging] = useState(false);

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of props.projects) names.set(project.id, project.name);
    return names;
  }, [props.projects]);

  /**
   * `无项目` is a fact about the task, not a stand-in for a project this page
   * failed to look up — a row that cannot resolve its project says nothing
   * rather than something false.
   */
  const projectLabelOf = useCallback(
    (session: DesktopSessionSummary): string | undefined => {
      if (session.profileKind === 'remote') return session.profileName;
      return session.projectId ? projectNames.get(session.projectId) : copy.noProject;
    },
    [copy.noProject, projectNames],
  );

  // Store order is already recency-first with a stable id tie-break, and the
  // projection preserves it, so there is nothing left to sort here.
  const archived = useMemo(() => archivedTaskRows(props.sessions), [props.sessions]);
  const knownSessionIds = useMemo(
    () => new Set(props.sessions.map((session) => session.id)),
    [props.sessions],
  );
  const isSearching = query.trim().length > 0;
  const visible = useMemo(
    () => archived.filter((session) => matchesArchivedTaskQuery(session, query, projectLabelOf)),
    [archived, projectLabelOf, query],
  );
  const purgeTargets = isSearching ? visible : archived;

  async function purge() {
    // Frozen at the click. A confirm names a number to a person, and a set
    // re-read afterwards can be larger than the one they agreed to — another
    // client archiving a task while the dialog is up would add it. Shrinking is
    // safe and happens at the other end: `onPurge` keeps anything restored
    // meanwhile and says so.
    const ids = purgeTargets.map((session) => session.id);
    const confirmed = await toast.confirm({
      title: isSearching
        ? copy.purgeMatchesConfirmTitle(ids.length)
        : copy.purgeAllConfirmTitle(ids.length),
      description: copy.purgeConfirmBody,
      confirmLabel: copy.purgeConfirmAction,
      cancelLabel: getSettingsSharedCopy(locale).cancel,
      destructive: true,
    });
    if (!confirmed) return;
    setPurging(true);
    try {
      const outcome = await props.onPurge(ids);
      // The person agreed to a number, so a sweep that lands on a smaller one
      // owes them the whole account rather than whichever single fact a branch
      // picked. Kept tasks and failures are independent — reporting one and
      // dropping the other is how a count quietly stops adding up.
      const kept =
        outcome.restored.length > 0 ? copy.purgeKeptRestored(outcome.restored.length) : undefined;
      if (!outcome.verified || outcome.remaining.length > 0) {
        // A reason beats a count: a task refuses to retire while its turn is
        // still running, and "N still there" gives the reader nothing to do.
        const reason = !outcome.verified
          ? copy.purgeUnverified
          : outcome.firstError
            ? settingsActionErrorMessage(outcome.firstError, locale)
            : copy.purgeFailedBody(outcome.remaining.length);
        toast.error(copy.purgeFailedTitle, kept ? `${reason} ${kept}` : reason);
      } else {
        toast.success(copy.purgedToast(outcome.removed), kept);
      }
    } finally {
      if (mountedRef.current) setPurging(false);
    }
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
      {/* Search and the clear button share one row: as a section action the
          button landed a full 32px page rhythm below the box, alone on its
          own line. */}
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <TextInput
            label={copy.searchLabel}
            isLabelHidden
            placeholder={copy.searchLabel}
            value={query}
            onChange={setQuery}
            startIcon={Search}
            hasClear
            width="100%"
          />
        </StackItem>
        {/* While a search is on screen the button deletes what is on screen.
            One that said 全部 and deleted a set the reader could not see would
            be answering a question nobody asked. */}
        <Button
          variant="destructive"
          isDisabled={purging || purgeTargets.length === 0}
          clickAction={() => void purge()}
          label={isSearching ? copy.purgeMatches(visible.length) : copy.purgeAll}
        />
      </HStack>
      <SettingsSection>
        {visible.length === 0 ? (
          <EmptyState isCompact title={copy.noMatchTitle} description={copy.noMatchBody} />
        ) : (
          <List density="balanced" hasDividers aria-label={copy.listAria}>
            {visible.map((session) => {
              const updated = session.lastMessageAt
                ? formatCompactTimestamp(session.lastMessageAt, Date.now(), locale)
                : undefined;
              const description = [
                isOrphanedSubagentTask(session, knownSessionIds)
                  ? copy.deletedParent
                  : undefined,
                projectLabelOf(session),
                updated,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <ListItem
                  key={session.id}
                  label={session.name}
                  description={description.length > 0 ? description : undefined}
                  startContent={<Archive size={ICON_SIZE.control} aria-hidden="true" />}
                  endContent={
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        isDisabled={purging}
                        clickAction={() => props.onRestore(session.id)}
                        label={copy.restore}
                        // Every row's button reads 恢复; only the accessible
                        // name can say which task it restores.
                        aria-label={copy.restoreTask(session.name)}
                      />
                      {/* No 打开 here. An archived task has no rail row to
                          land on, and giving it one would make "the open task
                          is always visible in the rail" an invariant the rail
                          does not otherwise hold. Restore first. */}
                      <MoreMenu
                        label={copy.moreActions(session.name)}
                        size="sm"
                        isDisabled={purging}
                        items={[{ label: copy.delete, onClick: () => props.onDelete(session.id) }]}
                      />
                    </>
                  }
                />
              );
            })}
          </List>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
