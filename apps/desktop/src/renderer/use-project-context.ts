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
import type { ProjectRecord } from '@maka/core/project';
import type { RuntimeHostProfileKind } from '@maka/runtime-host/profile-kind';
import type {
  DesktopProjectCapabilities,
  DesktopRuntimeHostRef,
} from '../preload/bridge-contract.js';
import {
  runIfDefaultRuntimeHostCurrent,
  runOnDefaultRuntimeHost,
} from './platform/desktop/default-runtime-host-operation.js';

type RefBox<T> = { current: T };

interface RendererAppInfo {
  projectId?: string | null;
  projectPath: string;
  projectGit: { isGitRepo: boolean; branch?: string };
}

interface SessionProjectInfoState extends RendererAppInfo {
  sessionId: string;
}

const NO_PROJECT_CAPABILITIES: DesktopProjectCapabilities = {
  chooseClientDirectory: false,
  chooseHostDirectory: false,
  selectNoProject: false,
  setLocalDefault: false,
  viewClientPath: false,
};

/**
 * The read-only project projection the root composes into the titlebar,
 * Workbar, Module Hub, command palette and mentions: the owner Session's
 * project (path, Git state, current project, capabilities) and, with no
 * Session, the default Host's. Project mutations and the open-folder
 * commands belong to Task Entry.
 */
export function useAppShellProjectContext(options: {
  rendererMountedRef: RefBox<boolean>;
  sessionId?: string;
  sessionCwd?: string;
  sessionProjectId?: string | null;
  sessionProfileKind?: RuntimeHostProfileKind;
}): {
  /** Re-reads the default Host's project context; resolves to its projects. */
  refreshProjects(): Promise<ProjectRecord[]>;
  projectInfo: RendererAppInfo | null;
  projectCapabilities: DesktopProjectCapabilities;
  activeProjectCapabilities: DesktopProjectCapabilities;
  currentProjectId: string | null | undefined;
  currentProject: ProjectRecord | undefined;
} {
  const {
    rendererMountedRef,
    sessionId,
    sessionCwd,
    sessionProjectId,
    sessionProfileKind,
  } = options;
  const [appInfo, setAppInfo] = useState<RendererAppInfo | null>(null);
  const [sessionProjectInfo, setSessionProjectInfo] = useState<SessionProjectInfoState | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectCapabilities, setProjectCapabilities] =
    useState<DesktopProjectCapabilities>(NO_PROJECT_CAPABILITIES);
  const [sessionProjectSnapshot, setSessionProjectSnapshot] = useState<{
    sessionId: string;
    projects: ProjectRecord[];
    capabilities: DesktopProjectCapabilities;
  } | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null | undefined>(undefined);
  const defaultRefreshGenerationRef = useRef(0);

  const refreshDefaultProjectState = async (
    host: DesktopRuntimeHostRef,
  ): Promise<ProjectRecord[]> => {
    const generation = ++defaultRefreshGenerationRef.current;
    const { snapshot, info } = await window.maka.projects.getDefaultContext(host);
    if (
      !rendererMountedRef.current ||
      generation !== defaultRefreshGenerationRef.current
    ) {
      return [];
    }
    const nextProjects = [...snapshot.projects];
    let committed = false;
    await runIfDefaultRuntimeHostCurrent(host, () => {
      if (
        !rendererMountedRef.current ||
        generation !== defaultRefreshGenerationRef.current
      ) {
        return;
      }
      setProjects(nextProjects);
      setProjectCapabilities(snapshot.capabilities);
      setAppInfo({
        projectId: info.projectId,
        projectPath: info.projectPath,
        projectGit: info.projectGit,
      });
      setSelectedProjectId(info.projectId);
      committed = true;
    });
    return committed ? nextProjects : [];
  };

  useEffect(() => {
    const refresh = () =>
      void runOnDefaultRuntimeHost((host) => refreshDefaultProjectState(host)).catch(() => {
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
  // Read through an effect event by the bootstrap subscriptions, so a fresh
  // identity per render costs nothing.
  const refreshProjects = async (): Promise<ProjectRecord[]> =>
    (await runOnDefaultRuntimeHost((host) => refreshDefaultProjectState(host))).value;

  return {
    refreshProjects,
    projectInfo,
    projectCapabilities,
    activeProjectCapabilities,
    currentProjectId,
    currentProject,
  };
}
