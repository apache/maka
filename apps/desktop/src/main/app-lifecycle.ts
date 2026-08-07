import { app } from 'electron';
import { mkdir } from 'node:fs/promises';
import { setActiveProxy } from '@maka/runtime';
import {
  resolveBootstrapConnections,
  resolveOpenCodeFreeBootstrapMigration,
} from '@maka/core';
import type {
  AgentGraphCoordinator,
  AgentGraphSupervisorWakeCoordinator,
  BotRegistry,
  SessionManager,
  ShellRunProcessManager,
} from '@maka/runtime';
import type { McpClientManager } from '@maka/mcp';
import { backfillSessionProjects } from '@maka/storage';
import type {
  createConnectionStore,
  createProjectCatalog,
  createSessionStore,
  createSettingsStore,
  createSqliteArtifactStore,
  createSqliteModelCallLedger,
  createSqliteTelemetryRepo,
  openRuntimeEventPersistence,
} from '@maka/storage';
import type { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import type { createFileCredentialStore } from './credential-store.js';
import { startConfigFileWatcher, type ConfigFileWatcher } from './config-file-watcher.js';
import { toContractNetworkSettings } from './network-settings-main.js';
import type { resolveE2eFixture } from './e2e-fixture.js';
import type { KeepSystemAwakeController } from './keep-system-awake.js';
import type { createPlanReminderMainService } from './plan-reminders-main.js';
import type { createDailyReviewMainService } from './daily-review-main.js';
import type { createMainAutomationWiring } from './automation-wiring.js';
import type { createMainGoalWiring } from './goal-wiring.js';
import type { createMainWindowController } from './main-window.js';
import type { DesktopExecutionStoreWiring } from './execution-store-wiring.js';
import type { assembleDesktopTools } from './tool-assembly.js';
import type { StreamEvents } from './session-stream.js';
import type { SettingsIpcHandle } from './settings-ipc-main.js';
import type { AppUpdateService } from './app-update-service.js';
import { createAppQuitCoordinator } from './app-quit-coordinator.js';
import { installDesktopShellPresentation } from './desktop-shell-presentation.js';
import { resumeSafeBoundaryContinuationsOnStartup } from './startup-safe-boundary-resume.js';
import { retireCursorSubscriptionCredentials } from './oauth/cursor-subscription-retirement.js';

type AssembledTools = ReturnType<typeof assembleDesktopTools>;
export interface AppLifecycleDeps {
  // Whether this run stays out of the developer's way. boot.ts owns the
  // condition; the dock icon follows it so window visibility and dock
  // presence can never drift apart. A fixture window someone asked to see
  // (MAKA_E2E_SHOW_WINDOW) opts out of both together: as an accessory app it
  // has no dock tile and no Cmd+Tab entry, so switching away during a manual
  // review would leave no way back.
  startHidden: boolean;
  e2eFixture: ReturnType<typeof resolveE2eFixture>;
  userDataDir: string;
  workspaceRoot: string;
  sessionStore: ReturnType<typeof createSessionStore>;
  projectCatalog: ReturnType<typeof createProjectCatalog>;
  credentialStore: ReturnType<typeof createFileCredentialStore>;
  connectionStore: ReturnType<typeof createConnectionStore>;
  settingsStore: ReturnType<typeof createSettingsStore>;
  telemetryRepo: ReturnType<typeof createSqliteTelemetryRepo>;
  artifactStore: ReturnType<typeof createSqliteArtifactStore>;
  modelCallLedger: ReturnType<typeof createSqliteModelCallLedger>;
  ensureUsageReady: () => Promise<void>;
  keepSystemAwake: KeepSystemAwakeController;
  botRegistry: BotRegistry;
  planReminders: ReturnType<typeof createPlanReminderMainService>;
  dailyReview: ReturnType<typeof createDailyReviewMainService>;
  updateService: AppUpdateService;
  automationWiring: ReturnType<typeof createMainAutomationWiring>;
  goalWiring: ReturnType<typeof createMainGoalWiring>;
  computerUse: AssembledTools['computerUse'];
  computerUseOverlay: AssembledTools['computerUseOverlay'];
  /** The Computer Use mirror, torn down on the same two paths as the cursor. */
  computerUsePip: AssembledTools['computerUsePip'];
  /**
   * Retired at quit, not at window close: the item reports on runs, and a run
   * can outlive the window it was started from. Destroying it is also what
   * gives back the keep-awake assertion, so it is the last backstop against
   * leaving one held.
   */
  computerUseStatusItem: AssembledTools['computerUseStatusItem'];
  /**
   * Same reason, and one more: `dispose()` makes the guard answer "unlocked"
   * forever, so doing it any earlier would silently switch the lock guard off
   * for the rest of the process.
   */
  computerUseScreenLock: AssembledTools['computerUseScreenLock'];
  shellRuns: ShellRunProcessManager;
  mcpManager: McpClientManager;
  runtimePersistence: Awaited<ReturnType<typeof openRuntimeEventPersistence>>;
  executionStoreWiring: DesktopExecutionStoreWiring;
  closeWorkflowStores: () => Promise<void>;
  mainWindowController: ReturnType<typeof createMainWindowController>;
  runtime: SessionManager;
  agentGraphCoordinator: AgentGraphCoordinator;
  agentGraphSupervisorWakeCoordinator: AgentGraphSupervisorWakeCoordinator;
  agentGraphControlStore: ReturnType<typeof createAgentGraphControlStore>;
  streamEvents: StreamEvents;
  /** Focus-or-create for the main window; stays in boot.ts next to the
   *  controller and is registered here on `second-instance` / `activate`. */
  focusOrCreateMainWindow: (signal: AbortSignal) => void;
  emitConnectionListChanged: () => void;
  emitSessionsChanged: (reason: 'migrated') => void;
  handleExternalSettingsChange: () => Promise<void>;
  /** Accessor for the settings IPC handle, which is assigned inside
   *  boot.ts's `registerIpc()`; teardown disposes it if present. */
  getSettingsIpc: () => SettingsIpcHandle | undefined;
}

/**
 * Startup / lifecycle cluster extracted from main.ts (arch R6). Pure move of the
 * post-`registerIpc()` tail: the `app.whenReady()` startup flow (dock icon,
 * fixture seeding, window creation, background startup),
 * `runBackgroundStartup` / `ensureBootstrapConnection` /
 * `recoverInterruptedSessionsOnStartup`, the `window-all-closed` and `before-quit`
 * handlers, and `runBeforeQuitCleanup`. Startup ORDER is the product, so the
 * bodies stay behaviorally identical to their in-main.ts originals; every
 * process-scoped collaborator is injected. The single-instance lock stays in
 * main.ts; the `registerIpc()` anchor stays in boot.ts. Call this once, at
 * the same point the inline `app.whenReady()` used to sit (immediately after
 * `registerIpc()`).
 */
export function wireAppLifecycle(deps: AppLifecycleDeps): void {
  const {
    startHidden,
    e2eFixture,
    userDataDir,
    workspaceRoot,
    sessionStore,
    projectCatalog,
    credentialStore,
    connectionStore,
    settingsStore,
    telemetryRepo,
    artifactStore,
    modelCallLedger,
    ensureUsageReady,
    keepSystemAwake,
    botRegistry,
    planReminders,
    dailyReview,
    updateService,
    automationWiring,
    goalWiring,
    computerUse,
    computerUseOverlay,
    computerUsePip,
    computerUseStatusItem,
    computerUseScreenLock,
    shellRuns,
    mcpManager,
    runtimePersistence,
    executionStoreWiring,
    closeWorkflowStores,
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

  async function resolveSessionProjectsOnStartup(): Promise<void> {
    try {
      const result = await backfillSessionProjects({
        sessions: sessionStore,
        catalog: projectCatalog,
      });
      for (const failure of result.failures) {
        console.error(`[projects] could not resolve ${failure.cwd}: ${failure.reason}`);
      }
      if (result.resolved > 0) emitSessionsChanged('migrated');
    } catch (error) {
      // Best-effort: an unresolved project only affects sidebar grouping, and
      // the sessions themselves must still reach the renderer.
      console.error('[projects] session project resolution failed:', error);
    }
  }

  async function ensureBootstrapConnection(): Promise<void> {
    await mkdir(workspaceRoot, { recursive: true });
    const existingConnections = await connectionStore.list();
    let migrated = false;
    for (const connection of existingConnections) {
      const patch = resolveOpenCodeFreeBootstrapMigration(connection);
      if (!patch) continue;
      const updated = await connectionStore.updateIfUnchanged(
        connection.slug,
        connection.updatedAt,
        patch,
      );
      migrated ||= updated !== null;
    }
    if (migrated) emitConnectionListChanged();
    if (existingConnections.length > 0) return;

    // opencode-free is seeded unconditionally so a fresh install is usable with
    // zero credentials; env-keyed providers layer on top and take the default
    // when present (Anthropic before OpenAI). See resolveBootstrapConnections.
    const seeds = resolveBootstrapConnections({
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    });
    for (const seed of seeds) {
      await connectionStore.create({
        slug: seed.slug,
        name: seed.name,
        providerType: seed.providerType,
        defaultModel: seed.defaultModel,
        ...(seed.enabledModelIds ? { enabledModelIds: [...seed.enabledModelIds] } : {}),
        extras: seed.extras,
      });
      const envApiKey =
        seed.providerType === 'anthropic'
          ? process.env.ANTHROPIC_API_KEY
          : seed.providerType === 'openai'
            ? process.env.OPENAI_API_KEY
            : undefined;
      if (envApiKey) await credentialStore.setSecret(seed.slug, 'api_key', envApiKey);
      if (seed.isDefault) await connectionStore.setDefault(seed.slug);
    }
    // Bootstrap runs in BACKGROUND startup (#456): the renderer may have
    // already seeded its connection list from the onboarding snapshot,
    // so push the change or the model picker stays empty until an
    // unrelated action refreshes it.
    if (seeds.length > 0) emitConnectionListChanged();
  }

  app.whenReady().then(async () => {
    updateService.start();

    // The renderer's first IPC calls (session enumeration, settings read,
    // connection listing)
    // all read from stores that are initialized synchronously at module load,
    // so they succeed regardless of whether background startup has
    // settled. Any state that background startup mutates is pushed to the
    // renderer via the existing `sessions:changed` / `connections:event`
    // / `settings:bots:statusChanged` channels, so the UI converges lazily.
    // E2E fixture workspaces are wiped and seeded before stores open in
    // boot.ts. SQLite keeps live file handles, so resetting the workspace
    // here after store construction would detach the canonical database.
    const initialWindowSignal = quitCoordinator.getWindowCreationSignal();
    if (!initialWindowSignal) return;
    // The application menu is app-scoped, not window-scoped: install it once
    // here (before the first window, surviving window close on macOS) instead
    // of inside createWindow. A null menu on macOS leaves Cmd+Q and the Edit
    // roles without any handler; Windows/Linux keep it suppressed so the
    // renderer's shell chrome and Ctrl+N / Ctrl+, shortcuts stay untouched.
    // Menu commands route to the renderer through one typed channel when a
    // window exists, or re-create the window when there is none (quit-phase
    // no-op via the coordinator).
    installDesktopShellPresentation({
      startHidden,
      mainWindowController,
      focusOrCreateWindow: quitCoordinator.focusOrCreateWindow,
      onIconError: (error) =>
        console.error('[icon] failed to set dock icon:', error),
    });
    app.on('second-instance', quitCoordinator.focusOrCreateWindow);
    app.on('activate', quitCoordinator.focusOrCreateWindow);
    backgroundStartup = runBackgroundStartup();
    await mainWindowController.createWindow(initialWindowSignal);
    // Keep the process alive until background work settles so schedulers
    // / bridges aren't torn down mid-start by a fast window-all-closed.
    await backgroundStartup;
  });

  /**
   * Non-critical startup work that must NOT block the first window paint.
   *
   * `setActiveProxy` must be applied before any network-bearing step
   * (`botRegistry.applySettings`); usage readiness opens the operational SQLite
   * telemetry authority. Everything here is best-effort and logged on failure —
   * none of it should prevent the user from seeing and interacting with the app shell.
   */
  async function runBackgroundStartup(): Promise<void> {
    // Each step stands alone, because the doc comment above is a promise the
    // old shape could not keep: this was a run of bare `await`s, so the first
    // rejection skipped every step after it, silently.
    //
    // A malformed telemetry record must not prevent session recovery, plan
    // reminders, the daily review scheduler, the config watcher, or the
    // Automation scheduler from starting.
    const step = async (name: string, run: () => unknown): Promise<boolean> => {
      try {
        await run();
        return true;
      } catch (error) {
        console.error(`[startup] ${name} failed; continuing:`, error);
        return false;
      }
    };

    // E2e-fixture seeding happens synchronously in `whenReady` before the
    // window opens (see there for why); only the real bootstrap runs here.
    await step('retired Cursor credentials', () =>
      retireCursorSubscriptionCredentials({ userDataDir, credentialStore }),
    );
    if (!e2eFixture) {
      await step('bootstrap connection', () => ensureBootstrapConnection());
    }
    // The settings read is the one genuine dependency: three steps below take
    // their argument from it, and guessing a default for any of them would be
    // worse than not running them.
    let settings: Awaited<ReturnType<typeof settingsStore.get>> | undefined;
    await step('settings read', async () => {
      settings = await settingsStore.get();
    });
    if (settings) {
      const resolved = settings;
      await step('proxy', () => setActiveProxy(toContractNetworkSettings(resolved.network).proxy));
      // Re-hold the power-save blocker at launch if the user left it enabled, so
      // scheduled tasks survive machine sleep across restarts.
      await step('keep-awake', () => keepSystemAwake.apply(resolved.system.keepSystemAwake));
    }
    await step('usage readiness', () => ensureUsageReady());
    await step('session recovery', () => recoverInterruptedSessionsOnStartup());
    // After recovery: an interrupted session must come back before the sidebar
    // learns how to group it, and resolution costs a git probe per directory.
    await step('project resolution', () => resolveSessionProjectsOnStartup());
    let botRegistryReady = false;
    if (settings) {
      const resolved = settings;
      botRegistryReady = await step(
        'bot registry',
        () => botRegistry.applySettings(resolved.botChat),
      );
    }
    if (botRegistryReady) {
      await step('plan reminders', () => planReminders.refreshTimers());
    } else {
      console.error('[startup] plan reminders not started; bot registry is not ready');
    }
    await step('daily review scheduler', () => dailyReview.startScheduler());
    await step('config watcher', () => {
      configWatcher = startConfigFileWatcher(workspaceRoot, {
        onConnectionsChanged: () => emitConnectionListChanged(),
        onSettingsChanged: () => void handleExternalSettingsChange(),
      });
    });
    await step('automation scheduler', () => automationWiring.scheduler.start());
  }

  app.on('window-all-closed', () => {
    computerUseOverlay.destroyAll();
    computerUsePip.destroyAll();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', quitCoordinator.handleBeforeQuit);

  async function runBeforeQuitCleanup(): Promise<void> {
    updateService.dispose();
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
      Promise.resolve().then(() => computerUsePip.destroyAll()),
      Promise.resolve().then(() => computerUseStatusItem.destroy()),
      Promise.resolve().then(() => computerUseScreenLock.dispose()),
      Promise.resolve().then(() => computerUse.backend?.dispose?.()),
      botRegistry.stopAll(),
      Promise.resolve(mainWindowController.disposeBrowserViews()),
      shellRuns.terminateAll(),
      mcpManager.close(),
      agentGraphCoordinator.close(),
      agentGraphSupervisorWakeCoordinator.close(),
      telemetryRepo.close(),
      Promise.resolve().then(() => artifactStore.close?.()),
      modelCallLedger.close(),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') console.error('[shutdown] cleanup failed:', result.reason);
    }
    try {
      await closeWorkflowStores();
    } catch (error) {
      console.error('[shutdown] cleanup failed:', error);
    }
    runtimePersistence.close();
    executionStoreWiring.close();
    agentGraphControlStore.close();
    await sessionStore.close?.();
  }
}
