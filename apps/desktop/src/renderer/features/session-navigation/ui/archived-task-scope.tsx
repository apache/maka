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

import { type ReactNode, useMemo, useRef, useState } from 'react';
import { runtimeHostProfileUsesHostWorkspace } from '@maka/runtime-host/profile-kind';
import { Button, useMountedRef, useUiLocale } from '@maka/ui';
import { Search } from '@maka/ui/icons';
import { HStack, StackItem, VStack } from '@astryxdesign/core';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { getSettingsTasksCopy } from '../../../locales/settings-tasks-copy.js';
import type { SessionNavigationRowActions } from '../controller/session-row-actions.js';
import {
  ARCHIVED_AGE_DAYS,
  type ArchivedProjectFilter,
  type ArchivedTaskProjectScope,
  type ArchivedTaskScope as Scope,
  archivedAgeThresholdMs,
  archivedProjectOptions,
  archivedTaskProjectResolver,
  archivedTaskRows,
  availableProjectFilter,
  isArchivedTaskScopeNarrowed,
  scopeArchivedTasks,
  UNSCOPED_ARCHIVED_TASKS,
} from '../model/archived-task-scope.js';
import type { SessionNavigationSession } from '../ports.js';

const ANY_AGE = 'any';
const ALL_PROJECTS = '*all';
const NO_PROJECT = '*none';
const PROJECT_PREFIX = '=';

export interface ArchivedTaskScopeView<T> {
  /** Every archived task row, before any filter. */
  readonly rows: readonly T[];
  /** The rows on screen — exactly the set the bulk delete removes. */
  readonly visible: readonly T[];
  readonly purging: boolean;
  /** Search, filters and the bulk delete, for the page to place above its list. */
  readonly controls: ReactNode;
  /** What a row shows as its project, which is also what search matches. */
  projectLabelOf(session: T): string | undefined;
}

/**
 * Settings › Archived tasks' scope: search, the age and project filters, and
 * the one bulk delete, which always acts on exactly the rows on screen. It
 * owns that state so the page, a legacy Settings surface, holds none; the page
 * renders the rows this hands it.
 *
 * The delete itself is the rail's `purgeArchived` flow — preview, confirm,
 * sweep, report — run on the ids frozen at the click. A preview that settles
 * after the page closed or the scope changed opens no dialog.
 */
export function ArchivedTaskScope<T extends SessionNavigationSession>(props: {
  readonly sessions: readonly T[];
  readonly projectScopes: readonly ArchivedTaskProjectScope[];
  readonly commands: { readonly current: SessionNavigationRowActions | null };
  readonly children: (view: ArchivedTaskScopeView<T>) => ReactNode;
}) {
  const copy = getSettingsTasksCopy(useUiLocale());
  const mountedRef = useMountedRef();
  const [scope, setScope] = useState<Scope>(UNSCOPED_ARCHIVED_TASKS);
  const [purging, setPurging] = useState(false);
  // The click a pending confirm belongs to; any scope change retires it.
  const pendingPurgeRef = useRef<object | null>(null);

  const rows = useMemo(() => archivedTaskRows(props.sessions), [props.sessions]);
  const projectOf = useMemo(
    () => archivedTaskProjectResolver(props.projectScopes),
    [props.projectScopes],
  );
  // A Host-workspace task is labelled by its Host, as it always was here.
  const projectLabelOf = (session: T): string | undefined => {
    if (runtimeHostProfileUsesHostWorkspace(session.profileKind)) return session.profileName;
    const project = projectOf(session);
    return project === null ? copy.noProject : project?.label;
  };
  const projectOptions = useMemo(() => archivedProjectOptions(rows, projectOf), [projectOf, rows]);
  const effective = { ...scope, project: availableProjectFilter(scope.project, projectOptions) };
  const narrowed = isArchivedTaskScopeNarrowed(effective);
  const { visible, unknownArchiveTime } = scopeArchivedTasks(rows, effective, {
    now: Date.now(),
    projectOf,
    labelOf: projectLabelOf,
  });

  const updateScope = (patch: Partial<Scope>) => {
    pendingPurgeRef.current = null;
    setScope((current) => ({ ...current, ...patch }));
  };

  async function purge() {
    const commands = props.commands.current;
    if (!commands) return;
    const token = {};
    pendingPurgeRef.current = token;
    const requireArchivedForMs = archivedAgeThresholdMs(effective);
    setPurging(true);
    try {
      await commands.purgeArchived({
        sessionIds: visible.map((session) => session.id),
        narrowed,
        ...(requireArchivedForMs === undefined ? {} : { requireArchivedForMs }),
        isCurrent: () => mountedRef.current && pendingPurgeRef.current === token,
      });
    } finally {
      if (mountedRef.current) setPurging(false);
    }
  }

  const controls = (
    <VStack gap={2}>
      {/* Search and the delete button share one row: as a section action the
          button landed a full 32px page rhythm below the box. */}
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <TextInput
            label={copy.searchLabel}
            isLabelHidden
            placeholder={copy.searchLabel}
            value={scope.query}
            onChange={(query) => updateScope({ query })}
            startIcon={Search}
            hasClear
            width="100%"
          />
        </StackItem>
        {/* While anything narrows the list the button deletes what is on
            screen. One that said 全部 and deleted a set the reader could not
            see would be answering a question nobody asked. */}
        <Button
          variant="destructive"
          isLoading={purging}
          isDisabled={visible.length === 0}
          clickAction={() => void purge()}
          label={narrowed ? copy.purgeShown(visible.length) : copy.purgeAll}
        />
      </HStack>
      <HStack gap={2} vAlign="center">
        <Selector
          label={copy.ageFilterLabel}
          isLabelHidden
          size="sm"
          value={scope.minAgeDays === undefined ? ANY_AGE : String(scope.minAgeDays)}
          options={[
            { value: ANY_AGE, label: copy.ageAny },
            ...ARCHIVED_AGE_DAYS.map((days) => ({
              value: String(days),
              label: copy.ageOlderThan(days),
            })),
          ]}
          onChange={(value) =>
            updateScope({ minAgeDays: ARCHIVED_AGE_DAYS.find((days) => String(days) === value) })
          }
        />
        <Selector
          label={copy.projectFilterLabel}
          isLabelHidden
          size="sm"
          value={projectFilterValue(effective.project)}
          options={[
            { value: ALL_PROJECTS, label: copy.allProjects },
            ...projectOptions.projects.map((project) => ({
              value: `${PROJECT_PREFIX}${project.key}`,
              label: project.label,
            })),
            ...(projectOptions.hasNoProject ? [{ value: NO_PROJECT, label: copy.noProject }] : []),
          ]}
          onChange={(value) => updateScope({ project: projectFilterOf(value) })}
        />
      </HStack>
      {unknownArchiveTime > 0 ? (
        <Text type="supporting" size="sm" color="secondary">
          {copy.unknownArchiveTimeExcluded(unknownArchiveTime)}
        </Text>
      ) : null}
    </VStack>
  );

  return props.children({ rows, visible, purging, controls, projectLabelOf });
}

function projectFilterValue(filter: ArchivedProjectFilter): string {
  if (filter.kind === 'all') return ALL_PROJECTS;
  if (filter.kind === 'none') return NO_PROJECT;
  return `${PROJECT_PREFIX}${filter.key}`;
}

function projectFilterOf(value: string): ArchivedProjectFilter {
  if (value === NO_PROJECT) return { kind: 'none' };
  if (value.startsWith(PROJECT_PREFIX)) {
    return { kind: 'project', key: value.slice(PROJECT_PREFIX.length) };
  }
  return { kind: 'all' };
}
