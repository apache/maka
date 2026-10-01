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

import { useMemo } from 'react';
import { formatCompactTimestamp } from '@maka/core/relative-time';
import { EmptyState, IconButton, useUiLocale } from '@maka/ui';
import { Archive, ICON_SIZE, Trash2, Unarchive } from '@maka/ui/icons';
import { List, ListItem } from '@astryxdesign/core/List';
import type {
  ArchivedTaskProjectScope,
  ArchivedTaskScopeView,
  SessionNavigationRowActions,
} from '../features/session-navigation';
import type { DesktopSessionSummary } from '../../preload/bridge-contract.js';
import type { SessionCatalogController } from '../application/contracts/session-catalog/session-catalog-state.js';
import { getSettingsTasksCopy } from '../locales/settings-tasks-copy.js';
import { getStorageUsageCopy } from '../locales/storage-usage-copy.js';
import { TaskStorageSize, StorageRetentionSection } from '../features/storage-usage/index.js';
import { SettingsPage, SettingsSection } from './settings-section';
import { isOrphanedSubagentTask } from './task-catalog-rows';

/**
 * Everything this page needs from the shell's session catalog, as one prop so
 * the three components between the shell and this page forward a value they do
 * not have to understand.
 */
export interface ArchivedTasksBridge {
  catalog: SessionCatalogController;
  /** Every Host's Projects, keyed by Host the way the rail groups tasks. */
  projectScopes: readonly ArchivedTaskProjectScope[];
  /**
   * The rail's row actions: restore, delete, and the bulk delete, which
   * previews, confirms and sweeps only the tasks still archived.
   */
  commands: { readonly current: SessionNavigationRowActions | null };
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
 * changed. What is genuinely new here is finding a task by name, project or
 * age, and clearing a set of them in one pass; the rail's `ArchivedTaskScope`
 * owns that scope and hands this page the rows it keeps.
 */
export function TasksSettingsPage(
  props: ArchivedTasksBridge & {
    sessions: readonly DesktopSessionSummary[];
    scope: ArchivedTaskScopeView<DesktopSessionSummary>;
  },
) {
  const locale = useUiLocale();
  const copy = getSettingsTasksCopy(locale);
  const { visible, purging, projectLabelOf } = props.scope;

  const knownSessionIds = useMemo(
    () => new Set(props.sessions.map((session) => session.id)),
    [props.sessions],
  );
  // Nothing archived at all is a different situation from a search that
  // matched nothing, and only one of them replaces the whole page.
  if (props.scope.rows.length === 0) {
    return (
      <SettingsPage>
        <StorageRetentionSection />
        <EmptyState title={copy.emptyTitle} description={copy.emptyBody} />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage as="section" aria-label={copy.listAria}>
      <StorageRetentionSection />
      {props.scope.controls}
      <SettingsSection description={getStorageUsageCopy(locale).taskSizeNote}>
        {visible.length === 0 ? (
          <EmptyState isCompact title={copy.noMatchTitle} description={copy.noMatchBody} />
        ) : (
          <List density="balanced" hasDividers aria-label={copy.listAria}>
            {visible.map((session) => {
              const now = Date.now();
              const updated = session.lastMessageAt
                ? formatCompactTimestamp(session.lastMessageAt, now, locale)
                : undefined;
              const description = [
                isOrphanedSubagentTask(session, knownSessionIds)
                  ? copy.deletedParent
                  : undefined,
                projectLabelOf(session),
                updated,
                // An unknown time is said as such, never borrowed from the
                // last message, which the row already shows as its own fact.
                session.archivedAt === undefined
                  ? copy.archiveTimeUnknown
                  : copy.archivedAt(formatCompactTimestamp(session.archivedAt, now, locale)),
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
                      <TaskStorageSize sessionId={session.id} />
                      <IconButton
                        variant="ghost"
                        size="sm"
                        isDisabled={purging}
                        clickAction={() =>
                          void props.commands.current?.unarchiveSession(session.id)
                        }
                        label={copy.unarchiveTask(session.name)}
                        tooltip={copy.unarchive}
                        icon={<Unarchive size={ICON_SIZE.control} aria-hidden="true" />}
                      />
                      {/* No 打开 here. An archived task has no rail row to
                          land on, and giving it one would make "the open task
                          is always visible in the rail" an invariant the rail
                          does not otherwise hold. Unarchive first. */}
                      <IconButton
                        variant="ghost"
                        size="sm"
                        isDisabled={purging}
                        clickAction={() => void props.commands.current?.deleteSession(session.id)}
                        label={copy.deleteTask(session.name)}
                        tooltip={copy.delete}
                        icon={<Trash2 size={ICON_SIZE.control} aria-hidden="true" />}
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
