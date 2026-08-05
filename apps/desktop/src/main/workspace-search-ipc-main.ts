import { ipcMain as electronIpcMain, type IpcMain } from 'electron';
import { searchWorkspaceFiles } from './workspace-file-search.js';

export interface WorkspaceSearchIpcDeps {
  ipcMain?: Pick<IpcMain, 'handle'>;
  getProjectRoot(sessionId: unknown): Promise<string>;
}

export function registerWorkspaceSearchIpc(deps: WorkspaceSearchIpcDeps): void {
  const ipcMain = deps.ipcMain ?? electronIpcMain;
  // Composer `@` mention popup: active sessions resolve from their persisted
  // cwd; the new-task surface resolves from the app project root. Git repos
  // honor .gitignore + untracked via `git ls-files`; other trees fall back to
  // a bounded walk. See workspace-file-search.ts.
  ipcMain.handle('workspace:searchFiles', async (_event, input: unknown) => {
    const request = (input ?? {}) as { query?: unknown; limit?: unknown; sessionId?: unknown };
    const projectPath = await deps.getProjectRoot(request.sessionId);
    return searchWorkspaceFiles(projectPath, { query: request.query, limit: request.limit });
  });
}
