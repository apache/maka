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

import type { ProjectRowActions } from '@maka/ui';
import type { SessionSummary } from '@maka/core/session';

export type SessionNavigationSearchTarget = {
  sessionId: string;
  turnId: string;
  sequence?: number;
  nonce: number;
};

export interface SessionOpenCommandDeps {
  activateSession(sessionId: string): void;
  exitWorkHub(): void;
  selectSessionSurface(): void;
  setSearchTarget(target: SessionNavigationSearchTarget | null): void;
}

/**
 * Opening a Session is four intents in one order, spelled out.
 *
 * Leave the Work Hub, show the Session surface, move the selection, then aim
 * the search scroll — or clear it, when no turn was named. The rail calls this;
 * it subscribes to none of the four. Keeping the composition in one named
 * factory is what lets the order stay asserted after the controller's call site
 * moved below the shell (#4109).
 */
let nextNavigation = 0;

export function createSessionOpenCommand(deps: SessionOpenCommandDeps) {
  return (sessionId: string, turnId?: string, sequence?: number): void => {
    deps.exitWorkHub();
    deps.selectSessionSurface();
    deps.activateSession(sessionId);
    deps.setSearchTarget(
      turnId ? { sessionId, turnId, sequence, nonce: ++nextNavigation } : null,
    );
  };
}

/** Window routing and rail/new-task navigation share the same local surface commands. */
export function createSessionNavigationCommands<Owner>(deps: Omit<SessionOpenCommandDeps, 'exitWorkHub'> & {
  setWorkHubActive(value: boolean): void;
  closeSettings(): void;
  window: {
    openSession(navigation: { sessionId: string; turnId?: string; sequence?: number }, activate: () => void): boolean;
    requestNewTask(activate: () => void): void;
    bootstrap(refresh: () => Promise<SessionSummary[]>, revision: () => number, open: (id: string) => void): Promise<void>;
  };
  newTask: { prepare(): void; start(): Owner; resetPlanMode(): void; focus(): void };
  projects: {
    selectProject(key: string): boolean;
    renameProject(key: string, name: string): Promise<void>;
    archiveProject(key: string): Promise<void>;
    restoreProject(key: string): Promise<void>;
    relinkProject(key: string): Promise<void>;
  };
  hasProjects: boolean;
  refreshSessions(): Promise<SessionSummary[]>;
  readSelectionRevision(): number;
}) {
  const exitWorkHub = () => deps.setWorkHubActive(false);
  const enableWorkHub = () => { deps.setWorkHubActive(true); deps.selectSessionSurface(); };
  const openWorkHub = () => { deps.closeSettings(); deps.selectSessionSurface(); deps.setWorkHubActive(true); };
  const openLocalSession = createSessionOpenCommand({ ...deps, exitWorkHub });
  const openSession = (sessionId: string, turnId?: string, sequence?: number) =>
    deps.window.openSession({ sessionId, turnId, sequence }, () => openLocalSession(sessionId, turnId, sequence));
  const clearLocal = () => { deps.selectSessionSurface(); deps.setSearchTarget(null); };
  const openNewTaskSurface = () => {
    deps.newTask.prepare();
    const owner = deps.newTask.start();
    deps.newTask.resetPlanMode();
    clearLocal();
    requestAnimationFrame(deps.newTask.focus);
    return owner;
  };
  const projectRowActions: ProjectRowActions | undefined = deps.hasProjects ? {
    onNew: (key) => { if (deps.projects.selectProject(key)) openNewTaskSurface(); },
    onRename: deps.projects.renameProject,
    onArchive: deps.projects.archiveProject,
    onRestore: deps.projects.restoreProject,
    onRelink: deps.projects.relinkProject,
  } : undefined;
  return { openSession, clearLocal, openNewTaskSurface, projectRowActions, exitWorkHub, enableWorkHub, openWorkHub,
    openLocal: (navigation: { sessionId: string; turnId?: string; sequence?: number }) => openLocalSession(navigation.sessionId, navigation.turnId, navigation.sequence),
    createSession: async () => { deps.window.requestNewTask(openNewTaskSurface); },
    bootstrapSessions: () => deps.window.bootstrap(deps.refreshSessions, deps.readSelectionRevision, openSession),
  };
}
