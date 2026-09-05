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
import { searchWorkspaceFiles } from './workspace-file-search.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';

export interface WorkspaceSearchIpcDeps {
  ipcMain?: ReconnectableReadIpcMain;
  getProjectRoot(sessionId: unknown, projectId: unknown): Promise<string>;
  allowLocalWorkspace?: boolean;
}

export function registerWorkspaceSearchIpc(deps: WorkspaceSearchIpcDeps): void {
  const ipcMain = deps.ipcMain ?? electronIpcMain;
  // Composer `@` mention popup: active sessions resolve from their persisted
  // cwd; the new-task surface resolves from the app project root. Git repos
  // honor .gitignore + untracked via `git ls-files`; other trees fall back to
  // a bounded walk. See workspace-file-search.ts.
  handleReconnectableRead(ipcMain, 'workspace:searchFiles', async (_event, input: unknown) => {
    if (deps.allowLocalWorkspace === false) return [];
    const request = (input ?? {}) as {
      query?: unknown;
      limit?: unknown;
      sessionId?: unknown;
      projectId?: unknown;
    };
    const projectPath = await deps.getProjectRoot(request.sessionId, request.projectId);
    return searchWorkspaceFiles(projectPath, { query: request.query, limit: request.limit });
  });
}
