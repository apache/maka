import { join } from 'node:path';
import { arch as osArch, homedir, release as osRelease } from 'node:os';
import { app, ipcMain, shell } from 'electron';
import { resolveOperationalStateDatabasePath } from '@maka/storage';
import { resolveProjectGitInfo } from '@maka/runtime/system-prompt/project-context';
import type { createMainWindowController } from './main-window.js';
import type { ProjectRootController } from './project-root-controller.js';
import { resolveOpenPath, type OpenPathResult } from './open-path-guard.js';
import { getE2eFixtureState, type resolveE2eFixture } from './e2e-fixture.js';
import type { resolveBuildInfo } from './build-info.js';
import type {
  AppUpdateInstallRequest,
  AppUpdateService,
  AppUpdateStatus,
} from './app-update-service.js';
import type { ProjectManagementService } from './project-management-service.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';

type MainWindowController = ReturnType<typeof createMainWindowController>;
type E2eFixture = ReturnType<typeof resolveE2eFixture>;
type BuildInfo = ReturnType<typeof resolveBuildInfo>;

export interface AppIpcDeps {
  mainWindowController: MainWindowController;
  projectRoot: ProjectRootController;
  getSessionProjectRoot(sessionId: string): Promise<string>;
  getProjectRoot(sessionId: unknown): Promise<string>;
  workspaceRoot: string;
  buildInfo: BuildInfo;
  e2eFixture: E2eFixture;
  projectManagement: ProjectManagementService;
  updateService: AppUpdateService;
}

export function registerAppIpc(
  deps: AppIpcDeps,
  targetIpc: ReconnectableReadIpcMain = ipcMain,
): void {
  const { mainWindowController, projectRoot, workspaceRoot, buildInfo, e2eFixture, updateService } = deps;
  // Call-time read of the shared project-root authority: every handler must
  // observe the latest selection, not a snapshot taken at registration.
  const currentProjectRoot = (): Promise<string> => projectRoot.current();

  targetIpc.handle('window:setTitlebarControlsVisible', (event, visible: unknown): void => {
    mainWindowController.setTitlebarControlsVisible(event.sender, visible);
  });
  // PR-SHOW-AFTER-FIRST-COMMIT: the renderer signals its first React commit so
  // the hidden window (main-window.ts show: false) is revealed only once real
  // content can paint. Idempotent + e2e-fixture-safe inside the controller.
  targetIpc.handle('window:notifyRendererReady', (): void => {
    mainWindowController.notifyRendererReady();
  });
  targetIpc.handle('window:setThemeSource', (event, themePref: unknown): void => {
    mainWindowController.setThemeSource(event.sender, themePref);
  });
  // PR-WINDOW-TITLEBAR-0: re-sync the native titleBarOverlay color when the
  // renderer resolves a new light/dark mode or palette. No-op outside Windows.
  targetIpc.handle('window:setTitleBarOverlayTheme', (event, theme: unknown): void => {
    mainWindowController.setTitleBarOverlayTheme(event.sender, theme);
  });
  targetIpc.handle('app:info', async () => {
    const selection = await deps.projectManagement.current();
    const projectPath = selection.path;
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      nodeVersion: process.versions.node ?? '',
      chromeVersion: process.versions.chrome ?? '',
      // #1312: fixture windows may force a platform so the renderer boots
      // natively into that platform's `data-os` CSS cascade (e.g. the darwin
      // glass overrides) on any host — see E2eFixture.platform.
      platform: e2eFixture?.platform ?? process.platform,
      arch: osArch(),
      osRelease: osRelease(),
      workspacePath: workspaceRoot,
      // Lets the renderer collapse a home prefix to `~` in displayed paths;
      // it has no other way to learn this.
      homePath: homedir(),
      // The exact on-disk path of the workspace's operational-state database,
      // resolved in main (node:path) — the one authority the renderer's
      // inspector row and the data-settings row both read. The renderer must
      // not reconstruct this (it cannot import @maka/storage, and guessing a
      // separator is wrong for POSIX paths containing a backslash).
      operationalStateDatabasePath: resolveOperationalStateDatabasePath(workspaceRoot),
      projectId: selection.projectId,
      projectPath,
      projectGit: await resolveProjectGitInfo(projectPath),
      buildMode: buildInfo.mode,
      buildCommit: buildInfo.commit,
    };
  });
  targetIpc.handle('app:updateStatus', (): AppUpdateStatus => updateService.getStatus());
  targetIpc.handle('app:checkForUpdates', () => updateService.checkForUpdatesNow());
  targetIpc.handle('app:retryUpdateDownload', () => updateService.retryUpdateDownload());
  targetIpc.handle('app:installUpdate', (_event, input: unknown) => {
    if (!isAppUpdateInstallRequest(input)) throw new TypeError('Invalid app update install request');
    return updateService.installUpdate(input);
  });
  handleReconnectableRead(targetIpc, 'projects:list', () => deps.projectManagement.list());
  targetIpc.handle('projects:add', () => deps.projectManagement.add());
  targetIpc.handle('projects:select', (_event, projectId: unknown) =>
    deps.projectManagement.select(projectId));
  targetIpc.handle('projects:relink', (_event, projectId: unknown) =>
    deps.projectManagement.relink(projectId));
  // Reveal takes an id, not a path: main asks the catalog where that project
  // lives, so a renderer cannot ask for an arbitrary directory to be opened.
  // The existing `project` open-path guard then re-checks the resolved
  // directory before it reaches the shell.
  targetIpc.handle('projects:reveal', async (_event, projectId: unknown): Promise<OpenPathResult> => {
    const projectPath = await deps.projectManagement.pathFor(projectId);
    if (!projectPath) return { ok: false, reason: 'missing' };
    const resolved = await resolveOpenPath({ key: 'project', workspaceRoot, projectRoot: projectPath });
    if (!resolved.ok) return resolved;
    const error = await shell.openPath(resolved.path);
    if (error) return { ok: false, reason: 'open-failed' };
    return { ok: true, opened: resolved.key };
  });
  targetIpc.handle('projects:rename', (_event, projectId: unknown, name: unknown) =>
    deps.projectManagement.rename(projectId, name));
  targetIpc.handle('projects:archive', (_event, projectId: unknown) =>
    deps.projectManagement.archive(projectId));
  targetIpc.handle('projects:restore', (_event, projectId: unknown) =>
    deps.projectManagement.restore(projectId));
  handleReconnectableRead(targetIpc, 'app:sessionProjectInfo', async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('Invalid project-context session id.');
    }
    const projectPath = await deps.getSessionProjectRoot(sessionId);
    return {
      projectPath,
      projectGit: await resolveProjectGitInfo(projectPath),
    };
  });
  targetIpc.handle('app:openPath', async (_event, key: string, sessionId: unknown): Promise<OpenPathResult> => {
    const projectPath = key === 'project'
      ? await deps.getProjectRoot(sessionId)
      : await currentProjectRoot();
    const resolved = await resolveOpenPath({ key, workspaceRoot, projectRoot: projectPath });
    if (!resolved.ok) return resolved;
    const error = await shell.openPath(resolved.path);
    if (error) return { ok: false, reason: 'open-failed' };
    return { ok: true, opened: resolved.key };
  });
  targetIpc.handle(
    'app:resolveProjectGitInfo',
    async (
      _event,
      projectPath: unknown,
    ): Promise<
      | { ok: true; projectPath: string; projectGit: Awaited<ReturnType<typeof resolveProjectGitInfo>> }
      | { ok: false; reason: 'invalid-path' | 'not-found' }
    > => {
      if (projectPath !== undefined) {
        const explicitRoot = await projectRoot.resolveExplicit(projectPath);
        if (!explicitRoot.ok) return explicitRoot;
        const resolved = explicitRoot.projectPath;
        return { ok: true, projectPath: resolved, projectGit: await resolveProjectGitInfo(resolved) };
      }
      const resolved = await currentProjectRoot();
      return { ok: true, projectPath: resolved, projectGit: await resolveProjectGitInfo(resolved) };
    },
  );
  targetIpc.handle('e2eFixture:getState', () => getE2eFixtureState(e2eFixture));
}

function isAppUpdateInstallRequest(input: unknown): input is AppUpdateInstallRequest {
  return typeof input === 'object' &&
    input !== null &&
    'allowInterruptActiveTasks' in input &&
    typeof input.allowInterruptActiveTasks === 'boolean';
}
