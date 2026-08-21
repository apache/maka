import { useEffect, useRef, useState } from 'react';
import type { ProjectRecord } from '@maka/core/project';
import type { UiLocale } from '@maka/core/ui-locale';
import type { DesktopProjectCapabilities } from '../preload/bridge-contract.js';
import {
  createAppShellProjectActions,
  type AppShellProjectActions,
  type RendererAppInfo,
  type SessionProjectInfoState,
} from './app-shell-project-actions';

type RefBox<T> = { current: T };

type ToastApi = {
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
};

const NO_PROJECT_CAPABILITIES: DesktopProjectCapabilities = {
  chooseClientDirectory: false,
  chooseHostDirectory: false,
  selectNoProject: false,
  setLocalDefault: false,
  viewClientPath: false,
};

/**
 * Owns the workspace / project-picker cluster: the new-task project, active
 * session project projection, the persistent project catalog, and the
 * project-picker pending state / dedup refs. Seeds appInfo from the persisted composer defaults so the home view
 * is populated before the async `app:info`
 * round-trip completes on mount.
 *
 * The picker refs are returned so AppShell can hand them to the bootstrap
 * unmount cleanup (which cancels an in-flight pick), and the action helpers
 * (createAppShellProjectActions) are created here so their setters never
 * have to be threaded back out through AppShell.
 */
export function useAppShellProjectContext(options: {
  uiLocale: UiLocale;
  rendererMountedRef: RefBox<boolean>;
  sessionId?: string;
  sessionCwd?: string;
  sessionProjectId?: string | null;
  sessionProfileKind?: 'local' | 'remote';
  onProjectSelected(ownerSessionId?: string): void;
  toastApi: ToastApi;
}): AppShellProjectActions & {
  projectInfo: RendererAppInfo | null;
  projects: ProjectRecord[];
  projectCapabilities: DesktopProjectCapabilities;
  activeProjectCapabilities: DesktopProjectCapabilities;
  localProjects: readonly ProjectRecord[];
  selectedProjectId: string | null | undefined;
  currentProjectId: string | null | undefined;
  currentProject: ProjectRecord | undefined;
  projectPickerPending: boolean;
  projectPickerPendingRef: RefBox<boolean>;
  projectPickerRequestRef: RefBox<number>;
} {
  const {
    uiLocale,
    rendererMountedRef,
    sessionId,
    sessionCwd,
    sessionProjectId,
    sessionProfileKind,
    onProjectSelected,
    toastApi,
  } = options;
  const [appInfo, setAppInfo] = useState<RendererAppInfo | null>(null);
  const [sessionProjectInfo, setSessionProjectInfo] = useState<SessionProjectInfoState | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectCapabilities, setProjectCapabilities] =
    useState<DesktopProjectCapabilities>(NO_PROJECT_CAPABILITIES);
  const [localHostProjects, setLocalHostProjects] = useState<ProjectRecord[]>([]);
  const [sessionProjectSnapshot, setSessionProjectSnapshot] = useState<{
    sessionId: string;
    projects: ProjectRecord[];
    capabilities: DesktopProjectCapabilities;
  } | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null | undefined>(undefined);
  const [projectPickerPending, setProjectPickerPending] = useState(false);
  const projectPickerPendingRef = useRef(false);
  const projectPickerRequestRef = useRef(0);
  const defaultRefreshGenerationRef = useRef(0);

  const refreshDefaultProjectState = async (): Promise<ProjectRecord[]> => {
    const generation = ++defaultRefreshGenerationRef.current;
    const { snapshot, info } = await window.maka.projects.getDefaultContext();
    if (
      !rendererMountedRef.current ||
      generation !== defaultRefreshGenerationRef.current
    ) {
      return [];
    }
    const nextProjects = [...snapshot.projects];
    setProjects(nextProjects);
    setProjectCapabilities(snapshot.capabilities);
    setAppInfo({
      projectId: info.projectId,
      projectPath: info.projectPath,
      projectGit: info.projectGit,
    });
    setSelectedProjectId(info.projectId);
    return nextProjects;
  };

  useEffect(() => {
    const refresh = () => void refreshDefaultProjectState().catch(() => {
      // Project management failures surface at the next user action.
    });
    const unsubscribe = window.maka.projects.subscribeChanges(refresh);
    refresh();
    return () => {
      defaultRefreshGenerationRef.current += 1;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let refreshGeneration = 0;
    const refresh = () => {
      const generation = ++refreshGeneration;
      return window.maka.projects.getLocalSnapshot().then(
        (snapshot) => {
          if (cancelled || generation !== refreshGeneration) return;
          setLocalHostProjects([...snapshot.projects]);
        },
        () => {
          // The Local Host may be reconnecting; its ready event retries this read.
        },
      );
    };
    const unsubscribe = window.maka.projects.subscribeLocalChanges(() => void refresh());
    void refresh();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setSessionProjectSnapshot(null);
      return;
    }
    let cancelled = false;
    let refreshGeneration = 0;
    const refresh = () => {
      const generation = ++refreshGeneration;
      return window.maka.projects.getSnapshot(sessionId).then(
        (snapshot) => {
          if (cancelled || generation !== refreshGeneration) return;
          setSessionProjectSnapshot({
            sessionId,
            projects: [...snapshot.projects],
            capabilities: snapshot.capabilities,
          });
        },
        () => undefined,
      );
    };
    const unsubscribe = window.maka.projects.subscribeChanges(() => void refresh(), sessionId);
    void refresh();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || sessionProfileKind !== 'local') return;
    let cancelled = false;
    void window.maka.app.sessionProjectInfo(sessionId).then(
      (info) => {
        if (!cancelled) setSessionProjectInfo({ sessionId, ...info });
      },
      () => {
        // The persisted cwd below remains visible when the directory vanished;
        // operations and send surface the actionable error at their boundaries.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, sessionCwd, sessionProfileKind]);

  const resolvedSessionProjectInfo =
    sessionId &&
    sessionProjectInfo?.sessionId === sessionId &&
    (!sessionCwd || sessionProjectInfo.projectPath === sessionCwd)
      ? sessionProjectInfo
      : null;
  const projectInfo = sessionId
    ? (resolvedSessionProjectInfo ??
      (sessionCwd ? { projectPath: sessionCwd, projectGit: { isGitRepo: false } } : null))
    : appInfo;
  const currentProjectId = sessionId ? (sessionProjectId ?? null) : selectedProjectId;
  const activeProjectSnapshot = sessionProjectSnapshot?.sessionId === sessionId
    ? sessionProjectSnapshot
    : null;
  const activeProjectCapabilities = sessionId
    ? (activeProjectSnapshot?.capabilities ?? NO_PROJECT_CAPABILITIES)
    : projectCapabilities;
  const activeProjects = sessionId ? (activeProjectSnapshot?.projects ?? []) : projects;
  const currentProject = !activeProjectCapabilities.viewClientPath
    ? undefined
    : activeProjects.find(
        (project) =>
          project.id === currentProjectId || project.aliases?.includes(currentProjectId ?? ''),
      );
  const actions = createAppShellProjectActions({
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
  });

  return {
    projectInfo,
    projects,
    projectCapabilities,
    activeProjectCapabilities,
    localProjects: localHostProjects,
    selectedProjectId,
    currentProjectId,
    currentProject,
    projectPickerPending,
    projectPickerPendingRef,
    projectPickerRequestRef,
    ...actions,
  };
}
