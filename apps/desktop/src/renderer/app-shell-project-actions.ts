import type { Dispatch, SetStateAction } from 'react';
import type { ProjectRecord, UiLocale } from '@maka/core';
import { openPathActionErrorMessage } from './app-shell-copy';
import { openPathActionLabel, openPathFailureCopy } from './open-path';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';
import { saveComposerDefaults } from './composer-defaults';
import { isSessionWorkspaceUnavailableError, showSessionWorkspaceUnavailableToast } from './session-workspace-errors';

export interface RendererAppInfo {
  projectPath: string;
  projectGit: { isGitRepo: boolean; branch?: string };
}

export interface SessionProjectInfoState extends RendererAppInfo {
  sessionId: string;
}

export interface ProjectBranchListState {
  contextKey: string | null;
  branches: string[];
  current?: string;
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
  selectNoProject(): void;
  prepareDefaultProject(): Promise<boolean>;
  prepareProject(projectId: string): Promise<boolean>;
  relinkProject(projectId: string, selectAfter?: boolean): Promise<ProjectRecord | null>;
  renameProject(projectId: string, name: string): Promise<void>;
  archiveProject(projectId: string): Promise<void>;
  restoreProject(projectId: string): Promise<void>;
  openProjectFolder(): Promise<void>;
  openWorkspaceFolder(): Promise<void>;
  openSkillsFolder(): Promise<void>;
  listGitBranches(sessionId?: string): Promise<{ branches: string[]; current?: string } | null>;
  checkoutGitBranch(branch: string, sessionId?: string): Promise<void>;
}

export function createAppShellProjectActions(deps: {
  uiLocale: UiLocale;
  projectPickerPendingRef: RefBox<boolean>;
  projectPickerRequestRef: RefBox<number>;
  rendererMountedRef: RefBox<boolean>;
  setAppInfo: Dispatch<SetStateAction<RendererAppInfo | null>>;
  setSessionProjectInfo: Dispatch<SetStateAction<SessionProjectInfoState | null>>;
  setProjectPickerPending: Dispatch<SetStateAction<boolean>>;
  setBranchPending: Dispatch<SetStateAction<boolean>>;
  setBranchList: Dispatch<SetStateAction<ProjectBranchListState | null>>;
  setProjects: Dispatch<SetStateAction<ProjectRecord[]>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null | undefined>>;
  selectedProjectId: string | null | undefined;
  projects: readonly ProjectRecord[];
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
    setBranchPending,
    setBranchList,
    setProjects,
    setSelectedProjectId,
    selectedProjectId,
    projects,
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
        projectPath: next.projectPath,
        projectGit: next.projectGit,
      });
    } catch (error) {
      toastApi.error(
        copy.readPathFailedTitle,
        localizedShellErrorMessage(error, copy.readPathFailedFallback, uiLocale),
      );
    }
  }

  async function refreshProjects(): Promise<ProjectRecord[]> {
    const next = await window.maka.projects.list();
    setProjects(next);
    return next;
  }

  async function applySelectedProject(
    project: ProjectRecord,
    path: string,
    notify: boolean,
  ): Promise<boolean> {
    const info = await window.maka.app.resolveProjectGitInfo(path);
    if (!info.ok) throw new Error(copy.selectedPathUnreadable);
    setAppInfo({ projectPath: info.projectPath, projectGit: info.projectGit });
    setSelectedProjectId(project.id);
    setBranchList(null);
    saveComposerDefaults({ projectPath: info.projectPath });
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
    return applySelectedProject(selected.project, selected.path, notify);
  }

  async function addProject(): Promise<ProjectRecord | null> {
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

  function selectNoProject(): void {
    setSelectedProjectId(null);
    setBranchList(null);
    onProjectSelected(sessionId);
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
      const candidates = projects.length > 0 ? projects : await refreshProjects();
      const project = candidates.find(
        (candidate) => candidate.archivedAt === undefined && candidate.available,
      );
      if (!project) {
        setSelectedProjectId(null);
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
    try {
      const result = await window.maka.projects.relink(projectId);
      if (!result.ok) return null;
      if (selectAfter) await selectProjectRecord(result.project, true);
      else await refreshProjects();
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
      const next = await refreshProjects();
      if (selectedProjectId === projectId) {
        const fallback = next.find(
          (project) => project.archivedAt === undefined && project.available,
        );
        if (fallback) await selectProjectRecord(fallback, false);
        else setSelectedProjectId(null);
      }
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

  async function listGitBranches(sessionId?: string): Promise<{ branches: string[]; current?: string } | null> {
    try {
      const result = await window.maka.app.listGitBranches(sessionId);
      if (!result.ok || !result.branches) {
        if (result.reason && result.reason !== 'not-a-repo') {
          toastApi.error(copy.branchListFailedTitle, result.message ?? copy.branchListFallback);
        }
        return null;
      }
      const next = { branches: result.branches, current: result.current };
      setBranchList({ contextKey: sessionId ?? null, ...next });
      return next;
    } catch (error) {
      if (isSessionWorkspaceUnavailableError(error)) {
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
      } else {
        toastApi.error(
          copy.branchListFailedTitle,
          localizedShellErrorMessage(error, copy.branchListFallback, uiLocale),
        );
      }
      return null;
    }
  }

  async function checkoutGitBranch(branch: string, sessionId?: string): Promise<void> {
    if (!branch) return;
    setBranchPending(true);
    try {
      const result = await window.maka.app.checkoutGitBranch(branch, sessionId);
      if (!result.ok) {
        toastApi.error(copy.branchCheckoutFailedTitle, result.message ?? copy.branchCheckoutFallback(branch));
        return;
      }
      const nextBranch = result.branch ?? branch;
      setAppInfo((prev) =>
        prev && prev.projectPath === projectInfo?.projectPath
          ? { ...prev, projectGit: { isGitRepo: true, branch: nextBranch } }
          : prev,
      );
      setSessionProjectInfo((prev) =>
        prev && prev.projectPath === projectInfo?.projectPath
          ? { ...prev, projectGit: { isGitRepo: true, branch: nextBranch } }
          : prev,
      );
      setBranchList((prev) => (prev?.contextKey === (sessionId ?? null) ? { ...prev, current: nextBranch } : prev));
      toastApi.success(copy.branchCheckoutSuccessTitle, nextBranch);
    } catch (error) {
      if (isSessionWorkspaceUnavailableError(error)) {
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
      } else {
        toastApi.error(
          copy.branchCheckoutFailedTitle,
          localizedShellErrorMessage(error, copy.branchCheckoutFallback(branch), uiLocale),
        );
      }
    } finally {
      setBranchPending(false);
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
    listGitBranches,
    checkoutGitBranch,
  };
}
