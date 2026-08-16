import { ipcMain as electronIpcMain } from 'electron';
import { searchWorkspaceFiles } from './workspace-file-search.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';

export interface WorkspaceSearchIpcDeps {
  ipcMain?: ReconnectableReadIpcMain;
  getProjectRoot(sessionId: unknown): Promise<string>;
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
    const request = (input ?? {}) as { query?: unknown; limit?: unknown; sessionId?: unknown };
    const projectPath = await deps.getProjectRoot(request.sessionId);
    return searchWorkspaceFiles(projectPath, { query: request.query, limit: request.limit });
  });
}
