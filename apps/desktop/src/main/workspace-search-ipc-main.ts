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

import { ipcMain as electronIpcMain } from 'electron';
import type { WorktreeSnapshot } from '@maka/core/worktree';
import { createWorkspaceFileSearcher } from './workspace-file-search.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';

export interface WorkspaceSearchIpcDeps {
  ipcMain?: ReconnectableReadIpcMain;
  getProjectRoot(sessionId: unknown, projectId: unknown): Promise<string>;
  queryWorktrees(projectId: string): Promise<WorktreeSnapshot>;
  allowLocalWorkspace?: boolean;
}

export function registerWorkspaceSearchIpc(deps: WorkspaceSearchIpcDeps): void {
  const ipcMain = deps.ipcMain ?? electronIpcMain;
  const searcher = createWorkspaceFileSearcher();
  // Composer `@` mention popup: active sessions resolve from their persisted
  // cwd; the new-task surface resolves from the project or selected worktree. Git repos
  // honor .gitignore + untracked via `git ls-files`; other trees fall back to
  // a bounded walk. See workspace-file-search.ts.
  handleReconnectableRead(ipcMain, 'workspace:searchFiles', async (_event, input: unknown) => {
    if (deps.allowLocalWorkspace === false) return [];
    const request = (input ?? {}) as {
      query?: unknown;
      limit?: unknown;
      sessionId?: unknown;
      projectId?: unknown;
      worktreePath?: unknown;
    };
    let projectPath: string;
    if (request.sessionId === undefined && request.worktreePath !== undefined) {
      if (typeof request.projectId !== 'string' || typeof request.worktreePath !== 'string')
        throw new Error('Invalid worktree search target');
      // Only search paths that the owning Host still recognizes as available.
      const snapshot = await deps.queryWorktrees(request.projectId);
      const worktree = snapshot.projects
        .find((project) => project.id === request.projectId)?.worktrees
        .find((item) => item.path === request.worktreePath && item.available && !item.locked);
      if (!worktree) throw new Error('Worktree is unavailable');
      projectPath = worktree.path;
    } else if (request.sessionId === undefined && typeof request.projectId === 'string') {
      // A project's preferredPath is its last-used checkout. New tasks without
      // an existing selection run in the Host's main directory instead.
      const snapshot = await deps.queryWorktrees(request.projectId);
      projectPath = snapshot.projects[0]?.mainPath
        ?? await deps.getProjectRoot(undefined, request.projectId);
    } else {
      projectPath = await deps.getProjectRoot(request.sessionId, request.projectId);
    }
    return searcher.search(projectPath, { query: request.query, limit: request.limit });
  });
}
