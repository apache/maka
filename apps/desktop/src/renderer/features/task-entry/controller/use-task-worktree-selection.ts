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

import { useCallback, useEffect, useRef, useState } from 'react';
import { getWorktreeCopy, useUiLocale, type WorkspacePickerWorktreeMenu } from '@maka/ui';
import type { TaskWorktreeSelection, WorktreeProject } from '@maka/core/worktree';
import type { TaskEntryCatalog, TaskEntryError, TaskEntryHostRef, TaskEntryServices, TaskEntryTarget } from '../ports.js';
import { isReadyTaskEntryHost } from '../model/task-entry-selection.js';
import { localizedShellErrorMessage } from '../../../locales/shell-copy.js';

const MAIN_SELECTION = { kind: 'main' } as const;

function hostKey(host: TaskEntryHostRef) {
  return JSON.stringify([host.profileId, host.hostId]);
}
function projectKey(host: TaskEntryHostRef, projectId: string) {
  return JSON.stringify([host.profileId, host.hostId, projectId]);
}

export function useTaskWorktreeSelection(
  target: TaskEntryTarget | undefined,
  service: TaskEntryServices['worktrees'],
  catalog: TaskEntryCatalog,
  reportError: (error: TaskEntryError) => void,
) {
  const locale = useUiLocale();
  const copy = getWorktreeCopy(locale);
  const reportErrorRef = useRef(reportError);
  reportErrorRef.current = reportError;
  const [loaded, setLoaded] = useState<Record<string, {
    catalog: TaskEntryCatalog;
    state: 'ready' | 'error';
    projects?: WorktreeProject[];
  }>>({});
  const [selections, setSelections] = useState<Record<string, TaskWorktreeSelection>>({});
  useEffect(() => {
    if (!service) return;
    let live = true;
    for (const host of catalog.hosts) {
      if (!isReadyTaskEntryHost(host)) continue;
      const ref = { profileId: host.profile.id, hostId: host.hostId };
      void service.query(undefined, ref).then(
        (snapshot) => {
          if (live) setLoaded((previous) => ({
            ...previous,
            [hostKey(ref)]: { catalog, state: 'ready', projects: snapshot.projects },
          }));
        },
        (error) => {
          if (!live) return;
          setLoaded((previous) => ({
            ...previous,
            [hostKey(ref)]: { catalog, state: 'error', projects: previous[hostKey(ref)]?.projects },
          }));
          reportErrorRef.current({
            title: copy.error,
            description: localizedShellErrorMessage(error, copy.error, locale),
            profileId: ref.profileId,
          });
        },
      );
    }
    return () => { live = false; };
  }, [service, catalog, copy.error, locale]);

  const select = useCallback((host: TaskEntryHostRef, projectId: string, value: string) => {
    const selection: TaskWorktreeSelection = value === 'main' || value === 'new'
      ? { kind: value }
      : { kind: 'existing', path: value };
    setSelections((previous) => ({
      ...previous,
      [projectKey(host, projectId)]: selection,
    }));
    service?.writeSelection?.(host, projectId, selection);
  }, [service]);

  const selectionForProject = useCallback((host: TaskEntryHostRef, projectId: string) => {
    const choice = selections[projectKey(host, projectId)]
      ?? service?.readSelection?.(host, projectId)
      ?? MAIN_SELECTION;
    const snapshot = loaded[hostKey(host)];
    // Keep the last successful validation during refreshes and failures. An
    // unresolved first read cannot invalidate a preference; a later failed read
    // cannot resurrect a checkout already known to be missing or locked.
    if (!snapshot?.projects) return choice;
    const project = snapshot.projects.find((item) => item.id === projectId);
    if (!project) return MAIN_SELECTION;
    if (choice.kind === 'existing' && !project.worktrees.some((item) =>
      item.path === choice.path && !item.isMain && item.available && !item.locked,
    )) return MAIN_SELECTION;
    return choice;
  }, [selections, service, loaded]);

  const forProject = useCallback((host: TaskEntryHostRef, projectId: string): Omit<WorkspacePickerWorktreeMenu, 'onSelect'> | undefined => {
    if (!service) return undefined;
    const snapshot = loaded[hostKey(host)];
    const current = snapshot?.catalog === catalog ? snapshot : undefined;
    const project = snapshot?.projects?.find((item) => item.id === projectId);
    const choice = selectionForProject(host, projectId);
    return {
      mainPath: project?.mainPath,
      pending: !current,
      value: choice?.kind === 'existing' ? choice.path : choice?.kind ?? 'main',
      options: [
        { value: 'main', label: copy.main },
        ...(project || choice.kind === 'new' ? [
          { value: 'new', label: copy.newWorktree },
          ...(project?.worktrees ?? []).filter((item) => !item.isMain && item.available && !item.locked).map((item) => ({
            value: item.path,
            label: item.name,
            description: item.path,
          })),
        ] : []),
        ...(choice.kind === 'existing' && !project?.worktrees.some((item) => item.path === choice.path)
          ? [{ value: choice.path, label: choice.path, description: choice.path, disabled: true }]
          : []),
      ],
    };
  }, [service, loaded, catalog, selectionForProject, copy]);

  const project = target?.projectId
    ? loaded[hostKey(target)]?.projects?.find((item) => item.id === target.projectId)
    : undefined;
  const choice = service && target?.projectId
    ? selectionForProject(target, target.projectId)
    : undefined;
  const existing = choice?.kind === 'existing'
    ? project?.worktrees.find((item) => item.path === choice.path)
    : undefined;
  return {
    choice, select, forProject,
    hasError: catalog.hosts.some((host) => {
      if (!isReadyTaskEntryHost(host)) return false;
      const snapshot = loaded[hostKey({ profileId: host.profile.id, hostId: host.hostId })];
      return snapshot?.catalog === catalog && snapshot.state === 'error';
    }),
    branch: existing?.branch,
    path: choice?.kind === 'existing' ? choice.path : project?.mainPath,
  };
}
