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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { findProjectByIdentity, type ProjectRecord } from '@maka/core/project';
import type { WorkBoardItem } from '@maka/core/work-board';
import {
  runtimeHostProfileUsesHostWorkspace,
  type RuntimeHostProfileKind,
} from '@maka/runtime-host/profile-kind';
import {
  getConversationCopy,
  type WorkspacePickerModel,
  useUiLocale,
} from '@maka/ui';
import { getShellCopy, localizedShellErrorMessage } from '../../../locales/shell-copy.js';
import {
  isReadyTaskEntryHost,
  prepareTaskEntryDraft,
  resolveProjectSelection,
  selectAvailableProfile,
  taskEntryDraftKey,
  type ReadyTaskEntryHost,
} from '../model/task-entry-selection.js';
import { resolveWorkBoardStartTarget, type WorkBoardStartTargetResult } from '../model/work-board-target.js';
import type {
  TaskEntryCatalog,
  TaskEntryError,
  TaskEntryHostRef,
  TaskEntryProjectMutationResult,
  TaskEntryTarget,
  TaskEntryProjectScope,
} from '../ports.js';
import { useTaskEntryServices } from '../services-context.js';
import type { TaskEntryHostModel } from '../ui/task-entry-host.js';
import { runtimeHostProjectKey } from '../../../application/contracts/runtime-host-project-key.js';

export interface UseTaskEntryControllerInput {
  reportError(error: TaskEntryError): void;
  manageProjects(profileId: string): void;
}

export interface TaskEntryControllerSelectors {
  readonly target?: TaskEntryTarget;
  readonly draftKey: string;
  readonly projectPath?: string;
  readonly selectedHost?: {
    readonly profileId: string;
    readonly hostId: string;
    readonly name: string;
    readonly kind: RuntimeHostProfileKind;
    readonly chatDefaults: ReadyTaskEntryHost['chatDefaults'];
  };
  readonly selectedProfileId?: string;
  readonly defaultProfileId: string;
  readonly usesDefaultHost: boolean;
  readonly workspacePicker: WorkspacePickerModel;
  readonly canAddProject: boolean;
  /** Every ready Host's Projects, with the owning Host retained as identity. */
  readonly projectScopes: readonly TaskEntryProjectScope[];
}

export interface TaskEntryControllerCommands {
  refresh(): Promise<void>;
  selectLocalProject(projectId: string): boolean;
  selectProject(projectKey: string): boolean;
  renameProject(projectKey: string, name: string): Promise<void>;
  archiveProject(projectKey: string): Promise<void>;
  restoreProject(projectKey: string): Promise<void>;
  relinkProject(projectKey: string): Promise<void>;
  /** `name` is what the New project dialog collected, when there was one. */
  addProject(name?: string): void;
  openNewProject(): void;
  chooseProjectForProfile(profileId: string): Promise<void>;
  resolveWorkBoardTarget(item: WorkBoardItem): WorkBoardStartTargetResult;
  prepareWorkBoardDraft(target: TaskEntryTarget, draft: string): string | undefined;
}

export interface TaskEntryController {
  readonly host: TaskEntryHostModel;
  readonly commands: TaskEntryControllerCommands;
  readonly selectors: TaskEntryControllerSelectors;
}

const EMPTY_CATALOG: TaskEntryCatalog = {
  defaultProfileId: 'local',
  hosts: [],
};

type DirectoryHandoff = TaskEntryHostRef & {
  readonly name: string;
  /** The name typed in the New project dialog, applied once a folder is picked. */
  readonly projectName?: string;
};

function directoryHandoffForHost(
  host: ReadyTaskEntryHost,
  projectName?: string,
): DirectoryHandoff {
  return {
    profileId: host.profile.id,
    hostId: host.hostId,
    name: host.profile.name,
    ...(projectName ? { projectName } : {}),
  };
}

function reconcileDirectoryHandoff(
  catalog: TaskEntryCatalog,
  current: DirectoryHandoff | undefined,
): DirectoryHandoff | undefined {
  if (!current) return undefined;
  const host = catalog.hosts.find((candidate) =>
    candidate.profile.id === current.profileId
  );
  if (!host) return undefined;
  if (host.readiness !== 'ready') {
    return { ...current, name: host.profile.name };
  }
  return host.hostId === current.hostId
    ? { ...current, name: host.profile.name }
    : undefined;
}

/** Owns Task Entry Host/Project state, catalog subscriptions, and workspace selection. */
export function useTaskEntryController(
  input: UseTaskEntryControllerInput,
): TaskEntryController {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).projectActions;
  const conversationCopy = getConversationCopy(locale).workspace;
  const reportError = input.reportError;
  const manageProjects = input.manageProjects;
  const { catalog: service } = useTaskEntryServices();
  const [catalog, setCatalog] = useState<TaskEntryCatalog>(EMPTY_CATALOG);
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [projectSelections, setProjectSelections] = useState(
    () => new Map<string, string | null>(),
  );
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string>();
  const [directoryHost, setDirectoryHost] = useState<DirectoryHandoff>();
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const directoryOpenerRef = useRef<HTMLElement | null>(null);
  const committedCatalogRef = useRef<TaskEntryCatalog>(EMPTY_CATALOG);
  const refreshRequestSequenceRef = useRef(0);
  const refreshLifecycleRef = useRef(0);
  const refreshRunRef = useRef<Promise<TaskEntryCatalog | undefined> | undefined>(undefined);
  const projectMutationPendingRef = useRef(false);

  const commitCatalog = useCallback((next: TaskEntryCatalog): void => {
    committedCatalogRef.current = next;
    setCatalog(next);
    setSelectedProfileId((current) => selectAvailableProfile(next, current));
    setDirectoryHost((current) => reconcileDirectoryHandoff(next, current));
  }, []);

  const refresh = useCallback((): Promise<TaskEntryCatalog | undefined> => {
    refreshRequestSequenceRef.current += 1;
    const running = refreshRunRef.current;
    if (running) return running;

    const lifecycle = refreshLifecycleRef.current;
    setRefreshing(true);
    const run = (async (): Promise<TaskEntryCatalog | undefined> => {
      let latestSuccess: TaskEntryCatalog | undefined;
      let latestFailure: unknown;

      while (refreshLifecycleRef.current === lifecycle) {
        const requestedSequence = refreshRequestSequenceRef.current;
        try {
          latestSuccess = await service.getCatalog();
          latestFailure = undefined;
        } catch (cause) {
          latestFailure = cause;
        }
        if (refreshLifecycleRef.current !== lifecycle) {
          return undefined;
        }
        if (requestedSequence === refreshRequestSequenceRef.current) break;
      }

      if (latestSuccess) {
        commitCatalog(latestSuccess);
        setError(latestFailure === undefined
          ? undefined
          : localizedShellErrorMessage(latestFailure, copy.catalogUnavailable, locale));
        return latestSuccess;
      }

      setError(localizedShellErrorMessage(latestFailure, copy.catalogUnavailable, locale));
      throw latestFailure;
    })();
    refreshRunRef.current = run;

    const finish = (): void => {
      if (
        refreshRunRef.current === run &&
        refreshLifecycleRef.current === lifecycle
      ) {
        refreshRunRef.current = undefined;
        setRefreshing(false);
      }
    };
    void run.then(finish, finish);
    return run;
  }, [commitCatalog, copy.catalogUnavailable, locale, service]);

  useEffect(() => {
    const unsubscribe = service.subscribeChanges(() => {
      void refresh().catch(() => undefined);
    });
    void refresh().catch(() => undefined);
    return () => {
      refreshLifecycleRef.current += 1;
      refreshRequestSequenceRef.current += 1;
      refreshRunRef.current = undefined;
      unsubscribe();
    };
  }, [refresh, service]);

  const selectedHost = catalog.hosts.find(
    (host): host is ReadyTaskEntryHost =>
      host.profile.id === selectedProfileId && isReadyTaskEntryHost(host),
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
    (host): host is ReadyTaskEntryHost =>
      host.profile.kind === 'local' && isReadyTaskEntryHost(host),
  );

  const selectProject = useCallback((host: ReadyTaskEntryHost, projectId: string): void => {
    const project = findProjectByIdentity(host.projects, projectId);
    if (!project?.available || project.archivedAt !== undefined) return;
    setSelectedProfileId(host.profile.id);
    setProjectSelections((current) =>
      new Map(current).set(host.profile.id, project.id),
    );
  }, []);

  const selectNoProject = useCallback((host: ReadyTaskEntryHost): void => {
    if (!host.capabilities.selectNoProject) return;
    setSelectedProfileId(host.profile.id);
    setProjectSelections((current) => new Map(current).set(host.profile.id, null));
  }, []);

  const refreshAfterProjectMutation = useCallback(async (profileId: string): Promise<void> => {
    try {
      await refresh();
    } catch (cause) {
      reportError({
        title: copy.projectUpdateFailedTitle,
        description: localizedShellErrorMessage(
          cause,
          copy.projectUpdateFailedFallback,
          locale,
        ),
        profileId,
      });
    }
  }, [copy.projectUpdateFailedFallback, copy.projectUpdateFailedTitle, locale, refresh, reportError]);

  const addProjectForHost = useCallback(async (host: ReadyTaskEntryHost, name?: string): Promise<void> => {
    if (projectMutationPendingRef.current) return;
    if (host.capabilities.chooseHostDirectory) {
      directoryOpenerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDirectoryHost(directoryHandoffForHost(host, name));
      return;
    }
    if (!host.capabilities.chooseClientDirectory) return;
    projectMutationPendingRef.current = true;
    setPending(true);
    try {
      let result: TaskEntryProjectMutationResult;
      try {
        result = await service.addProject(
          {
            profileId: host.profile.id,
            hostId: host.hostId,
          },
          name,
        );
      } catch (cause) {
        reportError({
          title: copy.selectDirectoryFailedTitle,
          description: localizedShellErrorMessage(cause, copy.readPathFailedFallback, locale),
          profileId: host.profile.id,
        });
        return;
      }
      if (!result.ok) return;
      setSelectedProfileId(host.profile.id);
      setProjectSelections((current) =>
        new Map(current).set(host.profile.id, result.project.id),
      );
      await refreshAfterProjectMutation(host.profile.id);
    } finally {
      projectMutationPendingRef.current = false;
      setPending(false);
    }
  }, [copy.readPathFailedFallback, copy.selectDirectoryFailedTitle, locale, refreshAfterProjectMutation, reportError, service]);

  const chooseProjectForProfile = useCallback(async (profileId: string): Promise<void> => {
    let next: TaskEntryCatalog | undefined;
    try {
      next = await refresh();
    } catch (cause) {
      reportError({
        title: copy.catalogUnavailable,
        description: localizedShellErrorMessage(cause, copy.catalogUnavailable, locale),
        profileId,
      });
      return;
    }
    if (!next) return;
    const host = next.hosts.find(
      (candidate): candidate is ReadyTaskEntryHost =>
        candidate.profile.id === profileId && isReadyTaskEntryHost(candidate),
    );
    if (!host) {
      reportError({
        title: copy.catalogUnavailable,
        profileId,
      });
      return;
    }
    setSelectedProfileId(profileId);
    if (host.capabilities.chooseHostDirectory) {
      setDirectoryHost(directoryHandoffForHost(host));
    }
  }, [copy.catalogUnavailable, locale, refresh, reportError]);

  const acceptRegisteredProject = useCallback(async (
    project: ProjectRecord,
    registeredHost: TaskEntryHostRef,
  ): Promise<void> => {
    const host = directoryHost;
    if (
      !host ||
      host.profileId !== registeredHost.profileId ||
      host.hostId !== registeredHost.hostId
    ) return;
    setDirectoryHost(undefined);
    setSelectedProfileId(host.profileId);
    // Register names the project after the folder — the remote directory browser
    // has no name field of its own — so the name typed before the folder was
    // picked is applied here. A failed rename must not lose the project that was
    // just created, so it falls back to the folder-derived name.
    if (host.projectName) {
      await service
        .renameProject(registeredHost, project.id, host.projectName)
        .catch(() => undefined);
    }
    setProjectSelections((current) => new Map(current).set(host.profileId, project.id));
    await refreshAfterProjectMutation(host.profileId);
  }, [directoryHost, refreshAfterProjectMutation, service]);

  const relinkProject = useCallback(async (
    host: ReadyTaskEntryHost,
    projectId: string,
  ): Promise<void> => {
    if (!host.capabilities.chooseClientDirectory || projectMutationPendingRef.current) return;
    projectMutationPendingRef.current = true;
    setPending(true);
    try {
      let result: TaskEntryProjectMutationResult;
      try {
        result = await service.relinkProject(
          { profileId: host.profile.id, hostId: host.hostId },
          projectId,
        );
      } catch (cause) {
        reportError({
          title: copy.selectDirectoryFailedTitle,
          description: localizedShellErrorMessage(cause, copy.readPathFailedFallback, locale),
          profileId: host.profile.id,
        });
        return;
      }
      if (!result.ok) return;
      setSelectedProfileId(host.profile.id);
      setProjectSelections((current) =>
        new Map(current).set(host.profile.id, result.project.id),
      );
      await refreshAfterProjectMutation(host.profile.id);
    } finally {
      projectMutationPendingRef.current = false;
      setPending(false);
    }
  }, [copy.readPathFailedFallback, copy.selectDirectoryFailedTitle, locale, refreshAfterProjectMutation, reportError, service]);

  const workspacePicker = useMemo<WorkspacePickerModel>(() => {
    const selectedCatalogHost = catalog.hosts.find(
      (host) => host.profile.id === selectedProfileId,
    );
    const selectedProject = currentProject?.name ??
      (selectedProjectId === null && selectedHost?.capabilities.selectNoProject
        ? conversationCopy.noProject
        : undefined);
    const selectedBranch = selectedHost &&
        selectedProjectId === selectedHost.selectedProjectId
      ? selectedHost.branch
      : undefined;
    const catalogNeedsRetry = Boolean(error) || catalog.hosts.some(
      (host) => host.readiness === 'ready' && host.state === 'error',
    );
    return {
      label: selectedProject ?? selectedCatalogHost?.profile.name ??
        (error ? copy.catalogUnavailable : undefined),
      ...(selectedCatalogHost &&
      runtimeHostProfileUsesHostWorkspace(selectedCatalogHost.profile.kind)
        ? { hostBadge: selectedCatalogHost.profile.name }
        : {}),
      branch: selectedProjectId === null ? null : selectedBranch,
      pending: pending || (refreshing && catalog.hosts.length === 0),
      selectedGroupId: selectedProfileId,
      groups: catalog.hosts.map((host) => {
        if (!isReadyTaskEntryHost(host)) {
          return {
            id: host.profile.id,
            label: host.profile.name,
            status: host.readiness === 'ready'
              ? host.message
              : copy.runtimeHostReadiness[host.readiness],
            disabled: true,
            projects: [],
          };
        }
        const groupSelectedProjectId = host.profile.id === selectedProfileId
          ? selectedProjectId
          : host.selectedProjectId;
        return {
          id: host.profile.id,
          label: host.profile.name,
          projects: host.projects.filter((project) => project.archivedAt === undefined),
          selectedProjectId: groupSelectedProjectId,
          onSelectProject: (projectId: string) => selectProject(host, projectId),
          ...(host.capabilities.chooseClientDirectory || host.capabilities.chooseHostDirectory
            ? { onAdd: (name: string) => void addProjectForHost(host, name) }
            : {}),
          ...(host.capabilities.chooseClientDirectory
            ? { onRelink: (projectId: string) => void relinkProject(host, projectId) }
            : {}),
          ...(host.capabilities.selectNoProject
            ? { onSelectNoProject: () => selectNoProject(host) }
            : {}),
          onManage: () => manageProjects(host.profile.id),
        };
      }),
      ...(catalogNeedsRetry
        ? {
            retry: {
              label: copy.retryCatalog,
              onClick: () => void refresh().catch(() => undefined),
            },
          }
        : {}),
    };
  }, [
    addProjectForHost,
    catalog,
    conversationCopy.noProject,
    copy.catalogUnavailable,
    copy.retryCatalog,
    copy.runtimeHostReadiness,
    currentProject?.name,
    error,
    manageProjects,
    pending,
    refreshing,
    refresh,
    relinkProject,
    selectedHost,
    selectedProfileId,
    selectedProjectId,
    selectNoProject,
    selectProject,
  ]);

  const selectLocalProject = useCallback((projectId: string): boolean => {
    if (!localHost) return false;
    selectProject(localHost, projectId);
    return true;
  }, [localHost, selectProject]);
  const projectScopes = useMemo<readonly TaskEntryProjectScope[]>(
    () =>
      catalog.hosts.flatMap((host) =>
        isReadyTaskEntryHost(host)
          ? host.projects.map((project) => ({
              key: runtimeHostProjectKey(host.hostId, project.id),
              profileId: host.profile.id,
              hostId: host.hostId,
              profileName: host.profile.name,
              profileKind: host.profile.kind,
              project,
              capabilities: host.capabilities,
            }))
          : [],
      ),
    [catalog.hosts],
  );
  const projectScopesByKey = useMemo(
    () => new Map(projectScopes.map((scope) => [scope.key, scope])),
    [projectScopes],
  );
  const selectScopedProject = useCallback(
    (key: string): boolean => {
      const scope = projectScopesByKey.get(key);
      const host =
        scope &&
        catalog.hosts.find(
          (candidate): candidate is ReadyTaskEntryHost =>
            isReadyTaskEntryHost(candidate) &&
            candidate.hostId === scope.hostId,
        );
      if (!host || !scope) return false;
      const project = findProjectByIdentity(host.projects, scope.project.id);
      if (!project?.available || project.archivedAt !== undefined) return false;
      selectProject(host, project.id);
      return true;
    },
    [catalog.hosts, projectScopesByKey, selectProject],
  );
  const mutateScopedProject = useCallback(
    async (
      key: string,
      action: (scope: TaskEntryProjectScope) => Promise<unknown>,
    ): Promise<void> => {
      const scope = projectScopesByKey.get(key);
      if (!scope) return;
      try {
        await action(scope);
        await refreshAfterProjectMutation(scope.profileId);
      } catch (cause) {
        reportError({
          title: copy.projectUpdateFailedTitle,
          description: localizedShellErrorMessage(
            cause,
            copy.projectUpdateFailedFallback,
            locale,
          ),
          profileId: scope.profileId,
        });
      }
    },
    [
      copy.projectUpdateFailedFallback,
      copy.projectUpdateFailedTitle,
      locale,
      projectScopesByKey,
      refreshAfterProjectMutation,
      reportError,
    ],
  );
  const resolveWorkBoardTarget = useCallback(
    (item: WorkBoardItem): WorkBoardStartTargetResult =>
      resolveWorkBoardStartTarget(item, catalog),
    [catalog],
  );
  const prepareWorkBoardDraft = useCallback(
    (target: TaskEntryTarget, draft: string): string | undefined => {
      // The target was resolved by resolveWorkBoardStartTarget moments ago, so
      // the Host and project availability are already proven; only seed the
      // selection and persist the draft for the composer.
      if (target.projectId === null) return undefined;
      setSelectedProfileId(target.profileId);
      setProjectSelections((current) => new Map(current).set(target.profileId, target.projectId));
      return prepareTaskEntryDraft(target, draft);
    },
    [setProjectSelections, setSelectedProfileId],
  );
  const addSelectedProject = useCallback(
    (name?: string) => {
      // The workspace-readiness notice hands this straight to an onClick, so a
      // MouseEvent can arrive where a name is expected. Only a real string is a
      // name; anything else means "no name given".
      if (selectedHost) {
        void addProjectForHost(selectedHost, typeof name === 'string' ? name : undefined);
      }
    },
    [addProjectForHost, selectedHost],
  );
  const refreshCatalog = useCallback(async (): Promise<void> => {
    await refresh();
  }, [refresh]);
  const closeDirectoryPicker = useCallback(() => setDirectoryHost(undefined), []);
  const selectedHostProjection = useMemo(
    () => selectedHost
      ? {
          profileId: selectedHost.profile.id,
          hostId: selectedHost.hostId,
          name: selectedHost.profile.name,
          kind: selectedHost.profile.kind,
          chatDefaults: selectedHost.chatDefaults,
        }
      : undefined,
    [selectedHost],
  );

  const openNewProject = useCallback(() => setNewProjectOpen(true), []);
  const newProjectDialog = useMemo(() => newProjectOpen ? {
    close: () => setNewProjectOpen(false),
    submit: (name: string) => addSelectedProject(name),
  } : undefined, [newProjectOpen, addSelectedProject]);
  return useMemo(() => ({
    host: {
      ...(directoryHost
        ? {
            directoryHost: {
              profileId: directoryHost.profileId,
              hostId: directoryHost.hostId,
              name: directoryHost.name,
            },
          }
        : {}),
      newProjectDialog,
      directoryOpener: directoryOpenerRef.current,
      closeDirectoryPicker,
      acceptRegisteredProject,
    },
    commands: {
      refresh: refreshCatalog,
      selectLocalProject,
      selectProject: selectScopedProject,
      renameProject: (key, name) => mutateScopedProject(
        key,
        (scope) => service.renameProject(
          { profileId: scope.profileId, hostId: scope.hostId },
          scope.project.id,
          name,
        ),
      ),
      archiveProject: (key) => mutateScopedProject(
        key,
        (scope) => service.archiveProject(
          { profileId: scope.profileId, hostId: scope.hostId },
          scope.project.id,
        ),
      ),
      restoreProject: (key) => mutateScopedProject(
        key,
        (scope) => service.restoreProject(
          { profileId: scope.profileId, hostId: scope.hostId },
          scope.project.id,
        ),
      ),
      relinkProject: (key) => mutateScopedProject(key, async (scope) => {
        if (!scope.capabilities.chooseClientDirectory) return;
        await service.relinkProject(
          { profileId: scope.profileId, hostId: scope.hostId },
          scope.project.id,
        );
      }),
      addProject: addSelectedProject,
      openNewProject,
      chooseProjectForProfile,
      resolveWorkBoardTarget,
      prepareWorkBoardDraft,
    },
    selectors: {
      ...(target ? { target } : {}),
      draftKey: taskEntryDraftKey(target),
      ...(projectPath ? { projectPath } : {}),
      ...(selectedHostProjection ? { selectedHost: selectedHostProjection } : {}),
      ...(selectedProfileId ? { selectedProfileId } : {}),
      defaultProfileId: catalog.defaultProfileId,
      usesDefaultHost:
        catalog.hosts.length === 0 || selectedProfileId === catalog.defaultProfileId,
      workspacePicker,
      canAddProject: Boolean(
        selectedHost &&
          (selectedHost.capabilities.chooseClientDirectory ||
            selectedHost.capabilities.chooseHostDirectory),
      ),
      projectScopes,
    },
  }), [
    acceptRegisteredProject,
    addSelectedProject,
    newProjectDialog,
    openNewProject,
    catalog.defaultProfileId,
    catalog.hosts.length,
    chooseProjectForProfile,
    closeDirectoryPicker,
    directoryHost,
    projectPath,
    projectScopes,
    refreshCatalog,
    selectLocalProject,
    selectScopedProject,
    mutateScopedProject,
    service,
    resolveWorkBoardTarget,
    prepareWorkBoardDraft,
    selectedHost,
    selectedHostProjection,
    selectedProfileId,
    target,
    workspacePicker,
  ]);
}
