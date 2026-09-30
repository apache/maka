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

import { type ReactNode, useMemo, useState } from 'react';
import type { SessionSummary } from '@maka/core/session';
import { Button, formatBytes, useMountedRef, useUiLocale } from '@maka/ui';
import { Search } from '@maka/ui/icons';
import { HStack, StackItem, VStack } from '@astryxdesign/core';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { getSettingsSharedCopy } from '../../../locales/settings-shared-copy.js';
import { getSettingsTasksCopy } from '../../../locales/settings-tasks-copy.js';
import {
  ARCHIVED_AGE_DAYS,
  type ArchivedAgeDays,
  type ArchivedProjectFilter,
  type ArchivedTaskProject,
  archivedProjectOptions,
  availableProjectFilter,
  isArchivedTaskScopeNarrowed,
  scopeArchivedTasks,
} from '../model/archived-task-scope.js';
import {
  createPurgeConfirmationController,
  describePurgeConfirmation,
  type PurgeConfirmation,
} from '../model/purge-confirmation.js';
import { useOptionalArchivedTaskCleanupServices } from '../services-context.js';

const ANY_AGE = 'any';
const ALL_PROJECTS = '*all';
const NO_PROJECT = '*none';
const PROJECT_PREFIX = '=';

/**
 * Settings › Archived tasks: search, the age and project filters, and the one
 * bulk delete, which always acts on exactly the rows on screen.
 *
 * The page keeps the rows' presentation; this surface decides which rows those
 * are and hands them back through `children`. A delete opens a confirm that
 * names the count at once and fills in the Host's preview of what else goes
 * when it arrives. The set it deletes is the one it previewed, frozen at the
 * click.
 */
export function ArchivedTaskScopeSurface<T extends SessionSummary>(props: {
  readonly rows: readonly T[];
  readonly projectOf: (session: T) => ArchivedTaskProject;
  /** Deletes exactly these tasks and reports the outcome; the list is busy until it settles. */
  readonly onPurge: (sessionIds: readonly string[]) => Promise<void>;
  readonly children: (scope: {
    readonly visible: readonly T[];
    readonly purging: boolean;
  }) => ReactNode;
}) {
  const locale = useUiLocale();
  const copy = getSettingsTasksCopy(locale);
  const services = useOptionalArchivedTaskCleanupServices();
  const mountedRef = useMountedRef();
  const [query, setQuery] = useState('');
  const [minAgeDays, setMinAgeDays] = useState<ArchivedAgeDays | undefined>(undefined);
  const [chosenProject, setChosenProject] = useState<ArchivedProjectFilter>({ kind: 'all' });
  const [confirmation, setConfirmation] = useState<PurgeConfirmation | undefined>(undefined);
  const [purging, setPurging] = useState(false);

  const controller = useMemo(
    () =>
      createPurgeConfirmationController({
        ...(services ? { previewRemovals: (ids) => services.previewRemovals(ids) } : {}),
        onChange: (next) => {
          if (mountedRef.current) setConfirmation(next);
        },
      }),
    [mountedRef, services],
  );

  const projectOptions = useMemo(
    () => archivedProjectOptions(props.rows, props.projectOf),
    [props.projectOf, props.rows],
  );
  const scope = {
    query,
    ...(minAgeDays === undefined ? {} : { minAgeDays }),
    project: availableProjectFilter(chosenProject, projectOptions),
  };
  const narrowed = isArchivedTaskScopeNarrowed(scope);
  const { visible, unknownArchiveTime } = scopeArchivedTasks(props.rows, scope, {
    now: Date.now(),
    projectOf: props.projectOf,
    noProjectLabel: copy.noProject,
  });

  async function confirmPurge() {
    const sessionIds = controller.confirm();
    if (!sessionIds) return;
    setPurging(true);
    try {
      await props.onPurge(sessionIds);
    } finally {
      if (mountedRef.current) setPurging(false);
    }
  }

  const dialog = confirmation
    ? describePurgeConfirmation(confirmation, copy, (bytes) => formatBytes(bytes, locale))
    : undefined;

  return (
    <VStack gap={2}>
      {/* Search and the delete button share one row: as a section action the
          button landed a full 32px page rhythm below the box. */}
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
        {/* While anything narrows the list the button deletes what is on
            screen. One that said 全部 and deleted a set the reader could not
            see would be answering a question nobody asked. */}
        <Button
          variant="destructive"
          isDisabled={purging || confirmation !== undefined || visible.length === 0}
          clickAction={() =>
            controller.open(
              visible.map((session) => session.id),
              narrowed,
            )
          }
          label={narrowed ? copy.purgeShown(visible.length) : copy.purgeAll}
        />
      </HStack>
      <HStack gap={2} vAlign="center">
        <Selector
          label={copy.ageFilterLabel}
          isLabelHidden
          size="sm"
          value={minAgeDays === undefined ? ANY_AGE : String(minAgeDays)}
          options={[
            { value: ANY_AGE, label: copy.ageAny },
            ...ARCHIVED_AGE_DAYS.map((days) => ({
              value: String(days),
              label: copy.ageOlderThan(days),
            })),
          ]}
          onChange={(value) =>
            setMinAgeDays(ARCHIVED_AGE_DAYS.find((days) => String(days) === value))
          }
        />
        <Selector
          label={copy.projectFilterLabel}
          isLabelHidden
          size="sm"
          value={projectFilterValue(scope.project)}
          options={[
            { value: ALL_PROJECTS, label: copy.allProjects },
            ...projectOptions.projects.map((project) => ({
              value: `${PROJECT_PREFIX}${project.key}`,
              label: project.label,
            })),
            ...(projectOptions.hasNoProject ? [{ value: NO_PROJECT, label: copy.noProject }] : []),
          ]}
          onChange={(value) => setChosenProject(projectFilterOf(value))}
        />
      </HStack>
      {unknownArchiveTime > 0 ? (
        <Text type="supporting" size="sm" color="secondary">
          {copy.unknownArchiveTimeExcluded(unknownArchiveTime)}
        </Text>
      ) : null}
      {props.children({ visible, purging })}
      {confirmation && dialog ? (
        <AlertDialog
          isOpen
          title={dialog.title}
          description={dialog.description}
          cancelLabel={getSettingsSharedCopy(locale).cancel}
          actionLabel={copy.purgeConfirmAction}
          actionVariant="destructive"
          // The count is known at once; the delete waits for the preview so
          // the reader sees what else goes, or learns it could not be said.
          isActionLoading={confirmation.preview.kind === 'loading'}
          onAction={() => void confirmPurge()}
          onOpenChange={(isOpen) => {
            if (!isOpen) controller.cancel();
          }}
        />
      ) : null}
    </VStack>
  );
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
