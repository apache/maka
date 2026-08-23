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
import { findProjectByIdentity, type ProjectRecord } from '@maka/core/project';
import type { UiLocale } from '@maka/core/ui-locale';
import type {
  DesktopNewTaskCatalog,
  DesktopNewTaskHost,
  DesktopRuntimeHostRef,
} from '../preload/bridge-contract.js';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';

type ReadyHost = Extract<
  DesktopNewTaskHost,
  { readonly readiness: 'ready'; readonly state: 'available' }
>;

type ToastApi = {
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { profileId: string },
  ): void;
};

export function useNewTaskTarget(options: {
  uiLocale: UiLocale;
  toastApi: ToastApi;
}) {
  const copy = getShellCopy(options.uiLocale).projectActions;
  const [catalog, setCatalog] = useState<DesktopNewTaskCatalog>({
    defaultProfileId: 'local',
    hosts: [],
  });
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [projectSelections, setProjectSelections] = useState(
    () => new Map<string, string | null>(),
  );
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string>();
  const [directoryHost, setDirectoryHost] = useState<ReadyHost>();
  const directoryOpenerRef = useRef<HTMLElement | null>(null);
  const refreshSequence = useRef(0);

  async function refresh(): Promise<DesktopNewTaskCatalog> {
    const sequence = ++refreshSequence.current;
    setRefreshing(true);
    try {
      const next = await window.maka.newTasks.getCatalog();
      if (refreshSequence.current !== sequence) return next;
      setCatalog(next);
      setError(undefined);
      setSelectedProfileId((current) => selectAvailableProfile(next, current));
      return next;
    } catch (cause) {
      if (refreshSequence.current === sequence) {
        setError(localizedShellErrorMessage(
          cause,
          copy.catalogUnavailable,
          options.uiLocale,
        ));
      }
      throw cause;
    } finally {
      if (refreshSequence.current === sequence) setRefreshing(false);
    }
  }

  useEffect(() => {
    const unsubscribe = window.maka.newTasks.subscribeChanges(() => {
      void refresh().catch(() => undefined);
    });
    void refresh().catch(() => undefined);
    return () => {
      refreshSequence.current += 1;
      unsubscribe();
    };
  }, [options.uiLocale]);

  const selectedHost = catalog.hosts.find(
    (host): host is ReadyHost =>
      host.profile.id === selectedProfileId &&
      host.readiness === 'ready' &&
      host.state === 'available',
  );
  const selectedProjectId = selectedHost
    ? resolveProjectSelection(selectedHost, projectSelections.get(selectedHost.profile.id))
    : undefined;
  const target = selectedHost && selectedProjectId !== undefined
    ? {
        profileId: selectedHost.profile.id,
        hostId: selectedHost.hostId,
        projectId: selectedProjectId,
      }
    : undefined;
  const currentProject = selectedHost && typeof selectedProjectId === 'string'
    ? findProjectByIdentity(selectedHost.projects, selectedProjectId)
    : undefined;
  const projectPath = currentProject?.preferredPath ??
    (selectedProjectId === null ? selectedHost?.projectPath : undefined);
  const localHost = catalog.hosts.find(
    (host): host is ReadyHost =>
      host.profile.kind === 'local' &&
      host.readiness === 'ready' &&
      host.state === 'available',
  );

  const selectProject = (host: ReadyHost, projectId: string): void => {
    const project = findProjectByIdentity(host.projects, projectId);
    if (!project?.available || project.archivedAt !== undefined) return;
    setSelectedProfileId(host.profile.id);
    setProjectSelections((current) =>
      new Map(current).set(host.profile.id, project.id),
    );
  };

  const selectNoProject = (host: ReadyHost): void => {
    if (!host.capabilities.selectNoProject) return;
    setSelectedProfileId(host.profile.id);
    setProjectSelections((current) => new Map(current).set(host.profile.id, null));
  };

  async function addProject(host: ReadyHost): Promise<void> {
    if (pending) return;
    if (host.capabilities.chooseHostDirectory) {
      directoryOpenerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDirectoryHost(host);
      return;
    }
    if (!host.capabilities.chooseClientDirectory) return;
    setPending(true);
    try {
      const result = await window.maka.newTasks.addProject({
        profileId: host.profile.id,
        hostId: host.hostId,
      });
      if (!result.ok) return;
      setSelectedProfileId(host.profile.id);
      setProjectSelections((current) =>
        new Map(current).set(host.profile.id, result.project.id),
      );
      await refresh();
    } catch (error) {
      options.toastApi.error(
        copy.selectDirectoryFailedTitle,
        localizedShellErrorMessage(error, copy.readPathFailedFallback, options.uiLocale),
        undefined,
        { profileId: host.profile.id },
      );
    } finally {
      setPending(false);
    }
  }

  async function chooseProjectForProfile(profileId: string): Promise<void> {
    const next = await refresh();
    const host = next.hosts.find(
      (candidate): candidate is ReadyHost =>
        candidate.profile.id === profileId &&
        candidate.readiness === 'ready' &&
        candidate.state === 'available',
    );
    if (!host) {
      options.toastApi.error(
        copy.catalogUnavailable,
        undefined,
        undefined,
        { profileId },
      );
      return;
    }
    setSelectedProfileId(profileId);
    if (host.capabilities.chooseHostDirectory) setDirectoryHost(host);
  }

  async function acceptRegisteredProject(
    project: ProjectRecord,
    registeredHost: DesktopRuntimeHostRef,
  ): Promise<void> {
    const host = directoryHost;
    if (
      !host ||
      host.profile.id !== registeredHost.profileId ||
      host.hostId !== registeredHost.hostId
    ) return;
    setDirectoryHost(undefined);
    setSelectedProfileId(host.profile.id);
    setProjectSelections((current) => new Map(current).set(host.profile.id, project.id));
    await refresh();
  }

  async function relinkProject(host: ReadyHost, projectId: string): Promise<void> {
    if (!host.capabilities.chooseClientDirectory || pending) return;
    setPending(true);
    try {
      const result = await window.maka.newTasks.relinkProject(
        { profileId: host.profile.id, hostId: host.hostId },
        projectId,
      );
      if (!result.ok) return;
      setSelectedProfileId(host.profile.id);
      setProjectSelections((current) =>
        new Map(current).set(host.profile.id, result.project.id),
      );
      await refresh();
    } catch (error) {
      options.toastApi.error(
        copy.selectDirectoryFailedTitle,
        localizedShellErrorMessage(error, copy.readPathFailedFallback, options.uiLocale),
        undefined,
        { profileId: host.profile.id },
      );
    } finally {
      setPending(false);
    }
  }

  return {
    catalog,
    selectedProfileId,
    selectedHost,
    selectedProjectId,
    target,
    currentProject,
    projectPath,
    localHost,
    pending,
    refreshing,
    error,
    directoryHost,
    directoryOpener: directoryOpenerRef.current,
    refresh,
    selectProject,
    selectNoProject,
    addProject,
    chooseProjectForProfile,
    closeDirectoryPicker: () => setDirectoryHost(undefined),
    acceptRegisteredProject,
    relinkProject,
  };
}

function selectAvailableProfile(
  catalog: DesktopNewTaskCatalog,
  current: string | undefined,
): string | undefined {
  const available = catalog.hosts.filter(
    (host): host is ReadyHost =>
      host.readiness === 'ready' && host.state === 'available',
  );
  if (current && available.some((host) => host.profile.id === current)) return current;
  if (available.some((host) => host.profile.id === catalog.defaultProfileId)) {
    return catalog.defaultProfileId;
  }
  return available[0]?.profile.id ??
    catalog.hosts.find((host) => host.profile.id === catalog.defaultProfileId)?.profile.id ??
    catalog.hosts[0]?.profile.id;
}

function resolveProjectSelection(
  host: ReadyHost,
  requested: string | null | undefined,
): string | null | undefined {
  if (requested === null && host.capabilities.selectNoProject) return null;
  if (typeof requested === 'string') {
    const project = findProjectByIdentity(host.projects, requested);
    if (project?.available && project.archivedAt === undefined) return project.id;
  }
  if (host.defaultProjectId) {
    const project = findProjectByIdentity(host.projects, host.defaultProjectId);
    if (project?.available && project.archivedAt === undefined) return project.id;
  }
  if (host.selectedProjectId === null && host.capabilities.selectNoProject) return null;
  if (typeof host.selectedProjectId === 'string') {
    const project = findProjectByIdentity(host.projects, host.selectedProjectId);
    if (project?.available && project.archivedAt === undefined) return project.id;
  }
  return host.capabilities.selectNoProject ? null : undefined;
}
