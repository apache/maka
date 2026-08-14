import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProjectRecord } from '@maka/core/project';
import type { SessionSummary } from '@maka/core/session';
import { formatCompactTimestamp } from '@maka/core/relative-time';
import {
  Badge,
  Button,
  EmptyState,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { HStack, List, ListItem, Text } from '@astryxdesign/core';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { getSettingsTasksCopy } from '../locales/settings-tasks-copy.js';
import { ExternalSessionImportDialog } from '../external-session-import-dialog.js';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsPage, SettingsSection } from './settings-section';
import { useActionGuard } from './use-action-guard';

type TaskScope = 'all' | 'archived';

/**
 * Settings · 活动 · 任务 — the management view of the task catalog.
 *
 * The rail is a navigator: single selection, 260px, always on screen. Cleaning
 * up archived tasks is the opposite shape — you act on several at once, you
 * need to see the project and the date to decide, and you do it rarely. That
 * work never fit in the rail, which is why archived tasks lived there as a
 * filter row that could only ever restore one task at a time.
 *
 * This page does not own a second copy of the catalog. `window.maka.sessions`
 * is the same authority the rail lists from; the rail scopes itself to
 * unarchived tasks and this page can see all of them. Mutations here reach the
 * rail through the same `sessions.subscribeChanges` broadcast every other
 * writer uses, so neither surface pushes state at the other.
 */
export function TasksSettingsPage() {
  const locale = useUiLocale();
  const copy = getSettingsTasksCopy(locale);
  const toast = useToast();
  const mountedRef = useMountedRef();
  // One latch for the whole page: restore and delete both act on the same
  // selection, so letting them overlap would race over rows that the first
  // action is already removing.
  const guard = useActionGuard<'restore' | 'delete'>();
  const [scope, setScope] = useState<TaskScope>('archived');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projects, setProjects] = useState<readonly ProjectRecord[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [loadFailed, setLoadFailed] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [pending, setPending] = useState<'restore' | 'delete' | null>(null);

  const load = useCallback(async () => {
    try {
      // No `isArchived` means no predicate — the store returns every task, and
      // the archived-only view narrows it. Linked subagent sessions stay out
      // either way: they are opt-in through `subagentParentSessionId`.
      const [list, snapshot] = await Promise.all([
        window.maka.sessions.list(),
        window.maka.projects.getSnapshot(),
      ]);
      if (!mountedRef.current) return;
      setSessions(list);
      setProjects(snapshot.projects);
      setLoadFailed(false);
    } catch {
      if (mountedRef.current) setLoadFailed(true);
    }
  }, [mountedRef]);

  useEffect(() => {
    void load();
    // Every writer in the app broadcasts here, including the rail's own row
    // menu, so this page stays correct while it is open behind the modal.
    const unsubscribe = window.maka.sessions.subscribeChanges(() => void load());
    return unsubscribe;
  }, [load]);

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects) names.set(project.id, project.name);
    return names;
  }, [projects]);

  const visible = useMemo(() => {
    const rows = scope === 'archived' ? sessions.filter((s) => s.isArchived) : sessions;
    return [...rows].sort((a, b) => {
      const delta = (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
      return delta || a.id.localeCompare(b.id);
    });
  }, [scope, sessions]);

  // Selection survives a background refresh but not a scope switch: the rows
  // you were acting on are no longer the rows on screen.
  const visibleIds = useMemo(() => new Set(visible.map((s) => s.id)), [visible]);
  const effectiveSelection = useMemo(
    () => [...selected].filter((id) => visibleIds.has(id)),
    [selected, visibleIds],
  );
  const restorable = useMemo(
    () => effectiveSelection.filter((id) => sessions.find((s) => s.id === id)?.isArchived),
    [effectiveSelection, sessions],
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
    action: 'restore' | 'delete',
    ids: readonly string[],
    run: (sessionId: string) => Promise<void>,
    failureTitle: string,
    success: (count: number) => string,
  ) {
    if (ids.length === 0 || !guard.begin(action)) return;
    setPending(action);
    try {
      // Sequential, not Promise.all: each call is a versioned write against
      // the session store, and a failure partway through should leave the
      // tasks it already reached done rather than half-applied across all.
      for (const id of ids) await run(id);
      if (mountedRef.current) setSelected(new Set());
      toast.success(success(ids.length));
    } catch (error) {
      toast.error(failureTitle, settingsActionErrorMessage(error, locale));
    } finally {
      guard.finish();
      if (mountedRef.current) setPending(null);
      await load();
    }
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
        {loadFailed ? (
          <EmptyState title={copy.loadFailed} />
        ) : visible.length === 0 ? (
          <EmptyState
            title={scope === 'archived' ? copy.emptyArchivedTitle : copy.emptyAllTitle}
            description={scope === 'archived' ? copy.emptyArchivedBody : copy.emptyAllBody}
          />
        ) : (
          <>
            <div className="settingsFieldRow settingsActionRow">
              <CheckboxInput
                label={copy.selectAllAria}
                isLabelHidden
                value={
                  allSelected ? true : effectiveSelection.length > 0 ? 'indeterminate' : false
                }
                onChange={(checked) => toggleAll(checked)}
              />
              <Text type="supporting" size="sm" color="secondary">
                {effectiveSelection.length > 0
                  ? copy.selectedCount(effectiveSelection.length)
                  : null}
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
                  <Button
                    variant="destructive"
                    size="sm"
                    isDisabled={busy}
                    clickAction={() => void deleteSelected()}
                    label={pending === 'delete' ? copy.deleting : copy.delete}
                  />
                </>
              )}
            </div>
            <List>
              {visible.map((session) => (
                <ListItem
                  key={session.id}
                  label={session.name}
                  startContent={
                    <CheckboxInput
                      label={copy.selectRowAria(session.name)}
                      isLabelHidden
                      value={selected.has(session.id)}
                      onChange={(checked) => toggleRow(session.id, checked)}
                    />
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
        )}
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
