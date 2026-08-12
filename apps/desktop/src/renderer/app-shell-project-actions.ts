import type { Dispatch, SetStateAction } from 'react';
import type { ProjectRecord } from '@maka/core/project';
import type { UiLocale } from '@maka/core/ui-locale';
import type { DesktopProjectCapabilities } from '../preload/bridge-contract.js';
import { openPathActionErrorMessage } from './app-shell-copy';
import { openPathActionLabel, openPathFailureCopy } from './open-path';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';
import { isSessionWorkspaceUnavailableError, showSessionWorkspaceUnavailableToast } from './session-workspace-errors';

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
  error(title: string, description?: string): void;
};

export interface AppShellProjectActions {
  refreshAppInfo(): Promise<void>;
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
  setAppInfo: Dispatch<SetStateAction<RendererAppInfo | null>>;
  setSessionProjectInfo: Dispatch<SetStateAction<SessionProjectInfoState | null>>;
  setProjectPickerPending: Dispatch<SetStateAction<boolean>>;
  setProjects: Dispatch<SetStateAction<ProjectRecord[]>>;
  setProjectCapabilities: Dispatch<SetStateAction<DesktopProjectCapabilities>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null | undefined>>;
  selectedProjectId: string | null | undefined;
  projects: readonly ProjectRecord[];
  projectCapabilities: DesktopProjectCapabilities;
  projectInfo: RendererAppInfo | null;
  sessionId?: string;
  onProjectSelected(ownerSessionId?: string): void;
  toastApi: ToastApi;
}): AppShellProjectActions {
  const {
    uiLocale,
    projectPickerPendingRef,
    projectPickerRequestRef,
    rendererMountedRef,
    setAppInfo,
    setSessionProjectInfo,
    setProjectPickerPending,
    setProjects,
    setProjectCapabilities,
    setSelectedProjectId,
    selectedProjectId,
    projects,
    projectCapabilities,
    projectInfo,
    sessionId,
    onProjectSelected,
    toastApi,
  } = deps;
  const copy = getShellCopy(uiLocale).projectActions;

  async function refreshAppInfo() {
    try {
      const next = await window.maka.app.info();
      setAppInfo({
        projectId: next.projectId,
        projectPath: next.projectPath,
        projectGit: next.projectGit,
      });
      setSelectedProjectId(next.projectId);
    } catch (error) {
      toastApi.error(
        copy.readPathFailedTitle,
        localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale),
      );
    }
  }

  async function refreshProjects(): Promise<ProjectRecord[]> {
    const [snapshot, info] = await Promise.all([
      window.maka.projects.getSnapshot(),
      window.maka.app.info(),
    ]);
    setProjects([...snapshot.projects]);
    setProjectCapabilities(snapshot.capabilities);
    setAppInfo({
      projectId: info.projectId,
      projectPath: info.projectPath,
      projectGit: info.projectGit,
    });
    setSelectedProjectId(info.projectId);
    return [...snapshot.projects];
  }

  async function applySelectedProject(
    project: ProjectRecord,
    path: string,
    notify: boolean,
  ): Promise<boolean> {
    if (project.preferredPath) {
      const info = await window.maka.app.resolveProjectGitInfo(path);
      if (!info.ok) throw new Error(copy.selectedPathUnreadable);
      setAppInfo({
        projectId: project.id,
        projectPath: info.projectPath,
        projectGit: info.projectGit,
      });
    } else {
      setAppInfo({
        projectId: project.id,
        projectPath: '',
        projectGit: { isGitRepo: false },
      });
    }
    setSelectedProjectId(project.id);
    await refreshProjects();
    if (notify) {
      onProjectSelected(sessionId);
      toastApi.success(copy.directorySwitchedTitle, project.name);
    }
    return true;
  }

  async function selectProjectRecord(project: ProjectRecord, notify: boolean): Promise<boolean> {
    if (!project.available || project.archivedAt !== undefined) return false;
    const selected = await window.maka.projects.select(project.id);
    if (!selected.project) return false;
    return applySelectedProject(selected.project, selected.path, notify);
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
      const result = await window.maka.projects.add();
      if (!isCurrentProjectPickerRequest()) return null;
      if (!result.ok) return null;
      await applySelectedProject(result.project, result.path, true);
      return result.project;
    } catch (error) {
      if (isCurrentProjectPickerRequest()) {
        toastApi.error(
          copy.selectDirectoryFailedTitle,
          localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale),
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
      return await selectProjectRecord(project, true);
    } catch (error) {
      toastApi.error(copy.selectDirectoryFailedTitle, localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale));
      return false;
    }
  }

  async function selectNoProject(): Promise<void> {
    if (!projectCapabilities.selectNoProject) return;
    try {
      const selection = await window.maka.projects.select(null);
      setSelectedProjectId(null);
      setAppInfo((current) =>
        current
          ? { ...current, projectId: null, projectPath: selection.path }
          : current,
      );
      onProjectSelected(sessionId);
    } catch (error) {
      toastApi.error(
        copy.selectDirectoryFailedTitle,
        localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale),
      );
    }
  }

  async function prepareProject(projectId: string): Promise<boolean> {
    try {
      const project = projects.find((candidate) => candidate.id === projectId);
      return project ? await selectProjectRecord(project, false) : false;
    } catch (error) {
      toastApi.error(copy.selectDirectoryFailedTitle, localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale));
      return false;
    }
  }

  async function prepareDefaultProject(): Promise<boolean> {
    try {
      if (selectedProjectId === null && projectCapabilities.selectNoProject) return true;
      const candidates = projects.length > 0 ? projects : await refreshProjects();
      const project = candidates.find(
        (candidate) => candidate.archivedAt === undefined && candidate.available,
      );
      if (!project) {
        if (!projectCapabilities.selectNoProject) return false;
        await selectNoProject();
        return true;
      }
      return await selectProjectRecord(project, false);
    } catch (error) {
      toastApi.error(
        copy.selectDirectoryFailedTitle,
        localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale),
      );
      return false;
    }
  }

  async function relinkProject(projectId: string, selectAfter = false): Promise<ProjectRecord | null> {
    if (!projectCapabilities.chooseClientDirectory) return null;
    try {
      const result = await window.maka.projects.relink(projectId);
      if (!result.ok) return null;
      if (selectAfter) await selectProjectRecord(result.project, true);
      else {
        if (
          selectedProjectId !== null &&
          (selectedProjectId === projectId ||
            result.project.locations.some(
              (location) => location.path === projectInfo?.projectPath,
            ))
        ) {
          setSelectedProjectId(result.project.id);
        }
        await refreshProjects();
      }
      return result.project;
    } catch (error) {
      toastApi.error(copy.selectDirectoryFailedTitle, localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale));
      return null;
    }
  }

  async function renameProject(projectId: string, name: string): Promise<void> {
    try {
      await window.maka.projects.rename(projectId, name);
      await refreshProjects();
    } catch (error) {
      toastApi.error(
        copy.projectUpdateFailedTitle,
        localizedShellErrorMessage(error, copy.projectUpdateFailedFallback, uiLocale),
      );
    }
  }

  async function archiveProject(projectId: string): Promise<void> {
    try {
      await window.maka.projects.archive(projectId);
      await refreshProjects();
    } catch (error) {
      toastApi.error(
        copy.projectUpdateFailedTitle,
        localizedShellErrorMessage(error, copy.projectUpdateFailedFallback, uiLocale),
      );
    }
  }

  async function restoreProject(projectId: string): Promise<void> {
    try {
      await window.maka.projects.restore(projectId);
      await refreshProjects();
    } catch (error) {
      toastApi.error(
        copy.projectUpdateFailedTitle,
        localizedShellErrorMessage(error, copy.projectUpdateFailedFallback, uiLocale),
      );
    }
  }

  async function openSkillsFolder() {
    try {
      const result = await window.maka.app.openPath('skills');
      if (!result.ok) {
        toastApi.error(
          copy.openFailedTitle(openPathActionLabel('skills', uiLocale)),
          openPathFailureCopy(result.reason, uiLocale),
        );
      }
    } catch (error) {
      toastApi.error(
        copy.openFailedTitle(openPathActionLabel('skills', uiLocale)),
        openPathActionErrorMessage(error, 'skills', uiLocale),
      );
    }
  }

  async function openProjectFolder() {
    try {
      const result = await window.maka.app.openPath('project', sessionId);
      if (!result.ok) {
        toastApi.error(
          copy.openFailedTitle(openPathActionLabel('project', uiLocale)),
          openPathFailureCopy(result.reason, uiLocale),
        );
      }
    } catch (error) {
      if (isSessionWorkspaceUnavailableError(error)) {
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
      } else {
        toastApi.error(
          copy.openFailedTitle(openPathActionLabel('project', uiLocale)),
          openPathActionErrorMessage(error, 'project', uiLocale),
        );
      }
    }
  }

  async function openWorkspaceFolder() {
    try {
      const result = await window.maka.app.openPath('workspace');
      if (!result.ok) {
        toastApi.error(
          copy.openFailedTitle(openPathActionLabel('workspace', uiLocale)),
          openPathFailureCopy(result.reason, uiLocale),
        );
      }
    } catch (error) {
      toastApi.error(
        copy.openFailedTitle(openPathActionLabel('workspace', uiLocale)),
        openPathActionErrorMessage(error, 'workspace', uiLocale),
      );
    }
  }

  return {
    refreshAppInfo,
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
