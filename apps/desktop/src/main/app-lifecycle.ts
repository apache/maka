import { app, nativeImage, safeStorage } from 'electron';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setActiveProxy } from '@maka/runtime';
import type {
  AgentGraphCoordinator,
  AgentGraphSupervisorWakeCoordinator,
  BotRegistry,
  SessionManager,
  ShellRunProcessManager,
} from '@maka/runtime';
import type { McpClientManager } from '@maka/mcp';
import type {
  createConnectionStore,
  createProjectCatalog,
  createSessionStore,
  createSettingsStore,
  createTelemetryRepo,
  openRuntimeEventPersistence,
} from '@maka/storage';
import type { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import { migrateLegacyCredentials } from './credential-store.js';
import type { createFileCredentialStore } from './credential-store.js';
import { startConfigFileWatcher, type ConfigFileWatcher } from './config-file-watcher.js';
import { toContractNetworkSettings } from './network-settings-main.js';
import { importLegacyOAuthTokenFiles } from './oauth/shared-credential-bridge.js';
import type { resolveE2eFixture } from './e2e-fixture.js';
import type { OpenGatewayService } from './open-gateway.js';
import type { KeepSystemAwakeController } from './keep-system-awake.js';
import type { createPlanReminderMainService } from './plan-reminders-main.js';
import type { createDailyReviewMainService } from './daily-review-main.js';
import type { createMainAutomationWiring } from './automation-wiring.js';
import type { createMainGoalWiring } from './goal-wiring.js';
import type { createMainWindowController } from './main-window.js';
import type { assembleDesktopTools } from './tool-assembly.js';
import type { StreamEvents } from './session-stream.js';
import type { SettingsIpcHandle } from './settings-ipc-main.js';
import { runProjectStartupMigration } from './project-startup-migration.js';
import { createAppQuitCoordinator } from './app-quit-coordinator.js';
import { resumeSafeBoundaryContinuationsOnStartup } from './startup-safe-boundary-resume.js';

type AssembledTools = ReturnType<typeof assembleDesktopTools>;
export interface AppLifecycleDeps {
  isIsolatedE2e: boolean;
  e2eFixture: ReturnType<typeof resolveE2eFixture>;
  workspaceRoot: string;
  sessionStore: ReturnType<typeof createSessionStore>;
  projectCatalog: ReturnType<typeof createProjectCatalog>;
  credentialStore: ReturnType<typeof createFileCredentialStore>;
  connectionStore: ReturnType<typeof createConnectionStore>;
  settingsStore: ReturnType<typeof createSettingsStore>;
  telemetryRepo: ReturnType<typeof createTelemetryRepo>;
  ensureUsageReady: () => Promise<void>;
  keepSystemAwake: KeepSystemAwakeController;
  botRegistry: BotRegistry;
  openGateway: OpenGatewayService;
  planReminders: ReturnType<typeof createPlanReminderMainService>;
  dailyReview: ReturnType<typeof createDailyReviewMainService>;
  automationWiring: ReturnType<typeof createMainAutomationWiring>;
  goalWiring: ReturnType<typeof createMainGoalWiring>;
  computerUse: AssembledTools['computerUse'];
  computerUseOverlay: AssembledTools['computerUseOverlay'];
  shellRuns: ShellRunProcessManager;
  mcpManager: McpClientManager;
  runtimePersistence: Awaited<ReturnType<typeof openRuntimeEventPersistence>>;
  mainWindowController: ReturnType<typeof createMainWindowController>;
  runtime: SessionManager;
  agentGraphCoordinator: AgentGraphCoordinator;
  agentGraphSupervisorWakeCoordinator: AgentGraphSupervisorWakeCoordinator;
  agentGraphControlStore: ReturnType<typeof createAgentGraphControlStore>;
  streamEvents: StreamEvents;
  /** Focus-or-create for the main window; stays in main.ts next to the
   *  controller and is registered here on `second-instance` / `activate`. */
  focusOrCreateMainWindow: (signal: AbortSignal) => void;
  emitConnectionListChanged: () => void;
  emitSessionsChanged: (reason: 'migrated') => void;
  handleExternalSettingsChange: () => Promise<void>;
  /** Accessor for the settings IPC handle, which is assigned inside
   *  main.ts's `registerIpc()`; teardown disposes it if present. */
  getSettingsIpc: () => SettingsIpcHandle | undefined;
}

/**
 * Startup / lifecycle cluster extracted from main.ts (arch R6). Pure move of the
 * post-`registerIpc()` tail: the `app.whenReady()` startup flow (dock icon,
 * fixture seeding, credential startup, window creation, background startup),
 * `runCredentialStartup` / `runBackgroundStartup` / `ensureBootstrapConnection` /
 * `recoverInterruptedSessionsOnStartup`, the `window-all-closed` and `before-quit`
 * handlers, and `runBeforeQuitCleanup`. Startup ORDER is the product, so the
 * bodies stay behaviorally identical to their in-main.ts originals; every
 * process-scoped collaborator is injected. The single-instance lock and
 * `registerIpc()` anchor stay in main.ts. Call this once, at the same point the
 * inline `app.whenReady()` used to sit (immediately after `registerIpc()`).
 */
export function wireAppLifecycle(deps: AppLifecycleDeps): void {
  const {
    isIsolatedE2e,
    e2eFixture,
    workspaceRoot,
    sessionStore,
    projectCatalog,
    credentialStore,
    connectionStore,
    settingsStore,
    telemetryRepo,
    ensureUsageReady,
    keepSystemAwake,
    botRegistry,
    openGateway,
    planReminders,
    dailyReview,
    automationWiring,
    goalWiring,
    computerUse,
    computerUseOverlay,
    shellRuns,
    mcpManager,
    runtimePersistence,
    mainWindowController,
    runtime,
    agentGraphCoordinator,
    agentGraphSupervisorWakeCoordinator,
    agentGraphControlStore,
    streamEvents,
    focusOrCreateMainWindow,
    emitConnectionListChanged,
    emitSessionsChanged,
    handleExternalSettingsChange,
    getSettingsIpc,
  } = deps;

  let backgroundStartup: Promise<void> | undefined;
  let configWatcher: ConfigFileWatcher | undefined;
  const quitCoordinator = createAppQuitCoordinator({
    cleanup: runBeforeQuitCleanup,
    focusOrCreateWindow: focusOrCreateMainWindow,
    onCleanupError: (error) => console.error('[shutdown] cleanup failed:', error),
    resumeQuit: () => app.quit(),
  });

  async function recoverInterruptedSessionsOnStartup(): Promise<void> {
    try {
      await runtime.recoverInterruptedSessions();
      await agentGraphSupervisorWakeCoordinator.recover();
      await agentGraphCoordinator.recover();
      if (process.env.MAKA_RUNTIME_SAFE_BOUNDARY_RESUME !== '1') return;
      await resumeSafeBoundaryContinuationsOnStartup(runtime, streamEvents, console.error);
    } catch {
      // Best-effort: startup should still reach the renderer so users can inspect
      // and repair any remaining local session state.
    }
  }

  async function migrateSessionProjectsOnStartup(): Promise<void> {
    await runProjectStartupMigration({
      sessions: sessionStore,
      catalog: projectCatalog,
      emitSessionsChanged,
      logError: console.error,
    });
  }

  async function ensureBootstrapConnection(): Promise<void> {
    await mkdir(workspaceRoot, { recursive: true });
    if ((await connectionStore.list()).length > 0) return;

    if (process.env.ANTHROPIC_API_KEY) {
      const slug = 'env-anthropic';
      await connectionStore.create({
        slug,
        name: 'Anthropic (env)',
        providerType: 'anthropic',
        defaultModel: 'claude-sonnet-4-5-20250929',
      });
      await credentialStore.setSecret(slug, 'api_key', process.env.ANTHROPIC_API_KEY);
      await connectionStore.setDefault(slug);
      // Bootstrap runs in BACKGROUND startup (#456): the renderer may have
      // already seeded its connection list from the onboarding snapshot,
      // so push the change or the model picker stays empty until an
      // unrelated action refreshes it.
      emitConnectionListChanged();
      return;
    }

    if (process.env.OPENAI_API_KEY) {
      const slug = 'env-openai';
      await connectionStore.create({
        slug,
        name: 'OpenAI (env)',
        providerType: 'openai',
        defaultModel: 'gpt-4o-mini',
      });
      await credentialStore.setSecret(slug, 'api_key', process.env.OPENAI_API_KEY);
      await connectionStore.setDefault(slug);
      emitConnectionListChanged();
    }
  }

  app.whenReady().then(async () => {
    // PR-GRAY-CARD-LIFT-0 (WAWQAQ msg `0eb99429` 2026-06-20): set the
    // app's dock icon (macOS) so the dev `npm start` run shows Maka's
    // brand mark instead of the generic Electron icon. Packaged
    // builds get the icon via .app bundle Info.plist; this covers the
    // dev path.
    if (process.platform === 'darwin' && app.dock) {
      if (process.env.MAKA_E2E_FIXTURE || isIsolatedE2e) {
        // PR-VISUAL-SMOKE-HEADLESS: hide the dock icon so the spawned
        // Electron runs as an accessory app — no dock bounce, and it
        // never becomes frontmost / steals focus from the developer's
        // active window during a capture run or an E2E run.
        app.dock.hide();
      } else {
        try {
          const iconPath = join(import.meta.dirname, '..', '..', 'assets', 'icon.png');
          app.dock.setIcon(nativeImage.createFromPath(iconPath));
        } catch (error) {
          console.error('[icon] failed to set dock icon:', error);
        }
      }
    }

    // Credential migration is the one startup phase that must finish before an
    // interactive window exists: OAuth logout is otherwise able to race the
    // one-shot legacy import. The work is local and normally a missing-file
    // check; all non-critical startup below still runs behind the first paint.
    // The renderer's first
    // IPC calls (session enumeration, settings read, connection listing)
    // all read from stores that are initialized synchronously at module load,
    // so they succeed regardless of whether background startup has
    // settled. Any state that background startup mutates is pushed to the
    // renderer via the existing `sessions:changed` / `connections:event`
    // / `settings:bots:statusChanged` channels, so the UI converges lazily.
    // E2E fixture workspaces are wiped and seeded before stores open in
    // main.ts. SQLite keeps live file handles, so resetting the workspace
    // here after store construction would detach the canonical database.
    await runCredentialStartup();
    const initialWindowSignal = quitCoordinator.getWindowCreationSignal();
    if (!initialWindowSignal) return;
    app.on('second-instance', quitCoordinator.focusOrCreateWindow);
    app.on('activate', quitCoordinator.focusOrCreateWindow);
    backgroundStartup = runBackgroundStartup();
    await mainWindowController.createWindow(initialWindowSignal);
    // Keep the process alive until background work settles so schedulers
    // / bridges aren't torn down mid-start by a fast window-all-closed.
    await backgroundStartup;
  });

  async function runCredentialStartup(): Promise<void> {
    // One-time migration of credentials.json off Electron safeStorage so
    // the pure-Node runtime can read it (issue #32). Runs before any
    // credential read/write below; failure is non-fatal (legacy file is
    // left intact and later credential reads fail closed with guidance).
    try {
      await migrateLegacyCredentials(workspaceRoot, safeStorage);
    } catch (error) {
      console.error('[credentials] migration off safeStorage failed; legacy file left intact:', error);
    }
    // One-shot import of pre-#1125 safeStorage-encrypted OAuth token
    // files into the shared CredentialStore, which is the only token
    // authority from here on. Best-effort like the migration above:
    // files that cannot be decrypted are left intact for a later start.
    try {
      const userDataDir = app.getPath('userData');
      const reports = await importLegacyOAuthTokenFiles({
        credentialStore,
        decryptor: safeStorage,
        files: [
          { slug: 'claude-subscription', filePath: join(userDataDir, '.claude_subscription_token') },
          { slug: 'codex-subscription', filePath: join(userDataDir, '.codex_subscription_token') },
          { slug: 'cursor-subscription', filePath: join(userDataDir, '.cursor_subscription_token') },
          { slug: 'antigravity-subscription', filePath: join(userDataDir, '.antigravity_subscription_token') },
        ],
      });
      for (const report of reports) {
        const log = report.outcome === 'failed' ? console.error : console.log;
        log(`[credentials] legacy OAuth token file for ${report.slug}: ${report.outcome}`, report.error ?? '');
      }
    } catch (error) {
      console.error('[credentials] legacy OAuth token import failed; files left intact:', error);
    }
  }

  /**
   * Non-critical startup work that must NOT block the first window paint.
   *
   * `setActiveProxy` must be applied before any network-bearing step
   * (`botRegistry.applySettings`, `openGateway.sync`); usage readiness loads
   * the embedded telemetry compatibility repo. Everything here is best-effort and logged on
   * failure — none of it should prevent the user from seeing and interacting
   * with the app shell.
   */
  async function runBackgroundStartup(): Promise<void> {
    // E2e-fixture seeding happens synchronously in `whenReady` before the
    // window opens (see there for why); only the real bootstrap runs here.
    if (!e2eFixture) {
      await ensureBootstrapConnection();
    }
    const settings = await settingsStore.get();
    setActiveProxy(toContractNetworkSettings(settings.network).proxy);
    // Re-hold the power-save blocker at launch if the user left it enabled, so
    // scheduled tasks survive machine sleep across restarts.
    keepSystemAwake.apply(settings.system.keepSystemAwake);
    await ensureUsageReady();
    await migrateSessionProjectsOnStartup();
    await recoverInterruptedSessionsOnStartup();
    await botRegistry.applySettings(settings.botChat);
    await openGateway.sync(settings.openGateway);
    await planReminders.refreshTimers();
    dailyReview.startScheduler();
    configWatcher = startConfigFileWatcher(workspaceRoot, {
      onConnectionsChanged: () => emitConnectionListChanged(),
      onSettingsChanged: () => void handleExternalSettingsChange(),
    });
    automationWiring.scheduler.start();
  }

  app.on('window-all-closed', () => {
    computerUseOverlay.destroyAll();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', quitCoordinator.handleBeforeQuit);

  async function runBeforeQuitCleanup(): Promise<void> {
    try {
      await backgroundStartup;
    } catch (error) {
      console.error('[shutdown] background startup failed:', error);
    }
    automationWiring.scheduler.dispose();
    goalWiring.coordinator.dispose();
    goalWiring.manager.dispose();
    configWatcher?.stop();
    planReminders.stopTimers();
    dailyReview.stopScheduler();
    getSettingsIpc()?.dispose();
    const results = await Promise.allSettled([
      Promise.resolve().then(() => computerUseOverlay.destroyAll()),
      Promise.resolve().then(() => computerUse.backend?.dispose?.()),
      botRegistry.stopAll(),
      openGateway.stop(),
      Promise.resolve(mainWindowController.disposeBrowserViews()),
      shellRuns.terminateAll(),
      mcpManager.close(),
      agentGraphCoordinator.close(),
      agentGraphSupervisorWakeCoordinator.close(),
      telemetryRepo.close(),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') console.error('[shutdown] cleanup failed:', result.reason);
    }
    runtimePersistence.close();
    agentGraphControlStore.close();
    await sessionStore.close?.();
  }
}
