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

import type { Dispatch, SetStateAction } from 'react';
import type { ProjectRecord } from '@maka/core/project';
import type { UiLocale } from '@maka/core/ui-locale';
import type {
  DesktopProjectCapabilities,
  DesktopRuntimeHostRef,
} from '../preload/bridge-contract.js';
import { openPathActionErrorMessage } from './app-shell-copy';
import { openPathActionLabel, openPathFailureCopy } from './open-path';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';
import { isSessionWorkspaceUnavailableError, showSessionWorkspaceUnavailableToast } from './session-workspace-errors';
import {
  defaultRuntimeHostDiagnosticTarget,
  runOnDefaultRuntimeHost,
} from './default-runtime-host-operation.js';

export interface RendererAppInfo {
  projectId?: string | null;
  projectPath: string;
  projectGit: { isGitRepo: boolean; branch?: string };
}

export interface SessionProjectInfoState extends RendererAppInfo {
  sessionId: string;
}

type RefBox<T> = { current: T };

type ToastApi = {
  success(title: string, description?: string): void;
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string } | { profileId: string },
  ): void;
};

export interface AppShellProjectActions {
  refreshProjects(): Promise<ProjectRecord[]>;
  addProject(): Promise<ProjectRecord | null>;
  selectProject(projectId: string): Promise<boolean>;
  selectNoProject(): Promise<void>;
  prepareDefaultProject(): Promise<boolean>;
  prepareProject(projectId: string): Promise<boolean>;
  relinkProject(projectId: string, selectAfter?: boolean): Promise<ProjectRecord | null>;
  renameProject(projectId: string, name: string): Promise<void>;
  archiveProject(projectId: string): Promise<void>;
  restoreProject(projectId: string): Promise<void>;
  openProjectFolder(): Promise<void>;
  openWorkspaceFolder(): Promise<void>;
  openSkillsFolder(): Promise<void>;
}

export function createAppShellProjectActions(deps: {
  uiLocale: UiLocale;
  projectPickerPendingRef: RefBox<boolean>;
  projectPickerRequestRef: RefBox<number>;
  rendererMountedRef: RefBox<boolean>;
  setProjectPickerPending: Dispatch<SetStateAction<boolean>>;
  refreshDefaultProjectState(host: DesktopRuntimeHostRef): Promise<ProjectRecord[]>;
  selectedProjectId: string | null | undefined;
  projects: readonly ProjectRecord[];
  projectCapabilities: DesktopProjectCapabilities;
  sessionId?: string;
  onProjectSelected(ownerSessionId?: string): void;
  toastApi: ToastApi;
}): AppShellProjectActions {
  const {
    uiLocale,
    projectPickerPendingRef,
    projectPickerRequestRef,
    rendererMountedRef,
    setProjectPickerPending,
    refreshDefaultProjectState,
    selectedProjectId,
    projects,
    projectCapabilities,
    sessionId,
    onProjectSelected,
    toastApi,
  } = deps;
  const copy = getShellCopy(uiLocale).projectActions;
  const sessionDiagnosticTarget = sessionId ? { sessionId } : undefined;
  const showDefaultProjectError = (title: string, description: string | undefined, error: unknown) => {
    toastApi.error(
      title,
      description,
      undefined,
      defaultRuntimeHostDiagnosticTarget(error),
    );
  };
  const showSessionProjectError = (title: string, description?: string) => {
    toastApi.error(title, description, undefined, sessionDiagnosticTarget);
  };

  async function refreshProjects(): Promise<ProjectRecord[]> {
    return (
      await runOnDefaultRuntimeHost((host) => refreshDefaultProjectState(host))
    ).value;
  }

  async function applySelectedProject(
    project: ProjectRecord,
    path: string,
    notify: boolean,
    host: DesktopRuntimeHostRef,
  ): Promise<boolean> {
    if (project.preferredPath) {
      const info = await window.maka.app.resolveProjectGitInfo(path, host);
      if (!info.ok) throw new Error(copy.selectedPathUnreadable);
    }
    await refreshDefaultProjectState(host);
    if (notify) {
      onProjectSelected(sessionId);
      toastApi.success(copy.directorySwitchedTitle, project.name);
    }
    return true;
  }

  async function selectProjectRecord(
    project: ProjectRecord,
    notify: boolean,
    host: DesktopRuntimeHostRef,
  ): Promise<boolean> {
    if (!project.available || project.archivedAt !== undefined) return false;
    const selected = await window.maka.projects.select(project.id, host);
    if (!selected.project) return false;
    return applySelectedProject(selected.project, selected.path, notify, host);
  }

  async function addProject(): Promise<ProjectRecord | null> {
    if (!projectCapabilities.chooseClientDirectory) return null;
    if (projectPickerPendingRef.current) return null;
    const requestId = projectPickerRequestRef.current + 1;
    projectPickerRequestRef.current = requestId;
    projectPickerPendingRef.current = true;
    setProjectPickerPending(true);
    const isCurrentProjectPickerRequest = () =>
      rendererMountedRef.current && projectPickerRequestRef.current === requestId;
    try {
      const result = await runOnDefaultRuntimeHost(async (host) => {
        const added = await window.maka.projects.add(host);
        if (!added.ok) return added;
        await applySelectedProject(added.project, added.path, true, host);
        return added;
      });
      if (!isCurrentProjectPickerRequest()) return null;
      if (!result.value.ok) return null;
      return result.value.project;
    } catch (error) {
      if (isCurrentProjectPickerRequest()) {
        showDefaultProjectError(
          copy.selectDirectoryFailedTitle,
          localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale),
          error,
        );
      }
      return null;
    } finally {
      if (projectPickerRequestRef.current === requestId) {
        projectPickerPendingRef.current = false;
        if (rendererMountedRef.current) setProjectPickerPending(false);
      }
    }
  }

  async function selectProject(projectId: string): Promise<boolean> {
    try {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) return false;
      return (
        await runOnDefaultRuntimeHost((host) => selectProjectRecord(project, true, host))
      ).value;
    } catch (error) {
      showDefaultProjectError(copy.selectDirectoryFailedTitle, localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale), error);
      return false;
    }
  }

  async function selectNoProject(): Promise<void> {
    if (!projectCapabilities.selectNoProject) return;
    try {
      await runOnDefaultRuntimeHost(async (host) => {
        await window.maka.projects.select(null, host);
        await refreshDefaultProjectState(host);
        onProjectSelected(sessionId);
      });
    } catch (error) {
      showDefaultProjectError(
        copy.selectDirectoryFailedTitle,
        localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale),
        error,
      );
    }
  }

  async function prepareProject(projectId: string): Promise<boolean> {
    try {
      const project = projects.find((candidate) => candidate.id === projectId);
      return project
        ? (
            await runOnDefaultRuntimeHost((host) =>
              selectProjectRecord(project, false, host),
            )
          ).value
        : false;
    } catch (error) {
      showDefaultProjectError(copy.selectDirectoryFailedTitle, localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale), error);
      return false;
    }
  }

  async function prepareDefaultProject(): Promise<boolean> {
    try {
      return (
        await runOnDefaultRuntimeHost(async (host) => {
          if (selectedProjectId === null && projectCapabilities.selectNoProject) return true;
          const candidates = projects.length > 0
            ? projects
            : [...(await window.maka.projects.getDefaultContext(host)).snapshot.projects];
          const project = candidates.find(
            (candidate) => candidate.archivedAt === undefined && candidate.available,
          );
          if (project) return selectProjectRecord(project, false, host);
          if (!projectCapabilities.selectNoProject) return false;
          await window.maka.projects.select(null, host);
          await refreshDefaultProjectState(host);
          onProjectSelected(sessionId);
          return true;
        })
      ).value;
    } catch (error) {
      showDefaultProjectError(
        copy.selectDirectoryFailedTitle,
        localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale),
        error,
      );
      return false;
    }
  }

  async function relinkProject(projectId: string, selectAfter = false): Promise<ProjectRecord | null> {
    if (!projectCapabilities.chooseClientDirectory) return null;
    try {
      return (
        await runOnDefaultRuntimeHost(async (host) => {
          const result = await window.maka.projects.relink(projectId, host);
          if (!result.ok) return null;
          if (selectAfter) await selectProjectRecord(result.project, true, host);
          else await refreshDefaultProjectState(host);
          return result.project;
        })
      ).value;
    } catch (error) {
      showDefaultProjectError(copy.selectDirectoryFailedTitle, localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale), error);
      return null;
    }
  }

  async function renameProject(projectId: string, name: string): Promise<void> {
    try {
      await runOnDefaultRuntimeHost(async (host) => {
        await window.maka.projects.rename(projectId, name, host);
        await refreshDefaultProjectState(host);
      });
    } catch (error) {
      showDefaultProjectError(
        copy.projectUpdateFailedTitle,
        localizedShellErrorMessage(error, copy.projectUpdateFailedFallback, uiLocale),
        error,
      );
    }
  }

  async function archiveProject(projectId: string): Promise<void> {
    try {
      await runOnDefaultRuntimeHost(async (host) => {
        await window.maka.projects.archive(projectId, host);
        await refreshDefaultProjectState(host);
      });
    } catch (error) {
      showDefaultProjectError(
        copy.projectUpdateFailedTitle,
        localizedShellErrorMessage(error, copy.projectUpdateFailedFallback, uiLocale),
        error,
      );
    }
  }

  async function restoreProject(projectId: string): Promise<void> {
    try {
      await runOnDefaultRuntimeHost(async (host) => {
        await window.maka.projects.restore(projectId, host);
        await refreshDefaultProjectState(host);
      });
    } catch (error) {
      showDefaultProjectError(
        copy.projectUpdateFailedTitle,
        localizedShellErrorMessage(error, copy.projectUpdateFailedFallback, uiLocale),
        error,
      );
    }
  }

  async function openSkillsFolder() {
    try {
      const { value: result, diagnosticTarget } = await runOnDefaultRuntimeHost((host) =>
        window.maka.app.openPath('skills', undefined, host),
      );
      if (!result.ok) {
        toastApi.error(
          copy.openFailedTitle(openPathActionLabel('skills', uiLocale)),
          openPathFailureCopy(result.reason, uiLocale),
          undefined,
          diagnosticTarget,
        );
      }
    } catch (error) {
      showDefaultProjectError(
        copy.openFailedTitle(openPathActionLabel('skills', uiLocale)),
        openPathActionErrorMessage(error, 'skills', uiLocale),
        error,
      );
    }
  }

  async function openProjectFolder() {
    try {
      const { value: result, diagnosticTarget } = sessionId
        ? {
            value: await window.maka.app.openPath('project', sessionId),
            diagnosticTarget: { sessionId },
          }
        : await runOnDefaultRuntimeHost((host) =>
            window.maka.app.openPath('project', undefined, host),
          );
      if (!result.ok) {
        toastApi.error(
          copy.openFailedTitle(openPathActionLabel('project', uiLocale)),
          openPathFailureCopy(result.reason, uiLocale),
          undefined,
          diagnosticTarget,
        );
      }
    } catch (error) {
      if (sessionId && isSessionWorkspaceUnavailableError(error)) {
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale, sessionDiagnosticTarget);
      } else {
        toastApi.error(
          copy.openFailedTitle(openPathActionLabel('project', uiLocale)),
          openPathActionErrorMessage(error, 'project', uiLocale),
          undefined,
          sessionDiagnosticTarget ?? defaultRuntimeHostDiagnosticTarget(error),
        );
      }
    }
  }

  async function openWorkspaceFolder() {
    try {
      const { value: result, diagnosticTarget } = await runOnDefaultRuntimeHost((host) =>
        window.maka.app.openPath('workspace', undefined, host),
      );
      if (!result.ok) {
        toastApi.error(
          copy.openFailedTitle(openPathActionLabel('workspace', uiLocale)),
          openPathFailureCopy(result.reason, uiLocale),
          undefined,
          diagnosticTarget,
        );
      }
    } catch (error) {
      showDefaultProjectError(
        copy.openFailedTitle(openPathActionLabel('workspace', uiLocale)),
        openPathActionErrorMessage(error, 'workspace', uiLocale),
        error,
      );
    }
  }

  return {
    refreshProjects,
    addProject,
    selectProject,
    selectNoProject,
    prepareDefaultProject,
    prepareProject,
    relinkProject,
    renameProject,
    archiveProject,
    restoreProject,
    openProjectFolder,
    openWorkspaceFolder,
    openSkillsFolder,
  };
}
