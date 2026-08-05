import { app, ipcMain, powerSaveBlocker, shell } from "electron";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import {
  type ConnectionEvent,
  type SessionChangedEvent,
  type SessionChangedReason,
  resolveSystemUiLocale,
  resolveUiLocale,
} from "@maka/core";
import {
  PROVIDER_DEFAULTS,
  providerAuthRequiresSecret,
} from "@maka/core/llm-connections";
import {
  BotRegistry,
  buildMcpTools,
  type BotIncomingMessage,
} from "@maka/runtime";
import { McpClientManager } from "@maka/mcp";
import {
  createSettingsStore,
  createMcpConfigStore,
  createProjectCatalog,
  createSqlitePlanReminderStore,
} from "@maka/storage";
import { registerAppIpc } from "./app-ipc-main.js";
import { createAppUpdateService } from "./app-update-service.js";
import { createAttachmentApprovalRegistry } from "./attachment-approval.js";
import { resizeImageForAttachment } from "./attachment-resize-native.js";
import { registerBrowserIpc } from "./browser-ipc-main.js";
import { releaseBrowserSession } from "./browser/session.js";
import { resolveBuildInfo } from "./build-info.js";
import { computerUseServiceHealth } from "./computer-use-host.js";
import { assembleDesktopNativeCapabilities } from "./desktop-native-capability-assembly.js";
import { installDesktopShellPresentation } from "./desktop-shell-presentation.js";
import { createKeepSystemAwakeController } from "./keep-system-awake.js";
import { createMainWindowController } from "./main-window.js";
import { registerMcpIpcMain } from "./mcp-ipc-main.js";
import { createOnboardingService } from "./onboarding-service.js";
import { registerOnboardingIpc } from "./onboarding-ipc-main.js";
import { registerNotificationsIpc } from "./notifications-ipc-main.js";
import { registerPlanReminderIpc } from "./plan-reminders-ipc-main.js";
import { createPlanReminderMainService } from "./plan-reminders-main.js";
import {
  createPermissionOverlayMain,
  registerPermissionOverlayIpc,
} from "./permission-overlay/permission-overlay-main.js";
import { resolveProjectContextRoot } from "./project-context-root.js";
import { createProjectManagementService } from "./project-management-service.js";
import { createProjectRootController } from "./project-root-controller.js";
import {
  projectHostConnections,
  registerRuntimeHostConnectionsIpc,
} from "./runtime-host-connections-ipc-main.js";
import { registerRuntimeHostConfigIpc } from "./runtime-host-config-ipc-main.js";
import { createCapabilityRevisionPublisher } from "./runtime-host-capability-revision-publisher.js";
import { registerRuntimeHostGitHubCopilotIpc } from "./runtime-host-github-copilot-ipc-main.js";
import { registerRuntimeHostArtifactsIpc } from "./runtime-host-artifacts-ipc-main.js";
import { registerRuntimeHostDailyReviewIpc } from "./runtime-host-daily-review-ipc-main.js";
import { registerRuntimeHostInspectorIpc } from "./runtime-host-inspector-ipc-main.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";
import type { DesktopRuntimeHostCandidateControls } from "./runtime-host-desktop-candidate.js";
import {
  startRuntimeHostDesktopOwner,
  type RuntimeHostDesktopOwner,
} from "./runtime-host-desktop-owner.js";
import { registerRuntimeHostMemoryIpc } from "./runtime-host-memory-ipc-main.js";
import { registerRuntimeHostOAuthIpc } from "./runtime-host-oauth-ipc-main.js";
import { RuntimeHostOAuthPresentation } from "./runtime-host-oauth-presentation.js";
import { registerRuntimeHostPermissionsIpc } from "./runtime-host-permissions-ipc-main.js";
import { registerRuntimeHostSearchIpc } from "./runtime-host-search-ipc-main.js";
import { createRuntimeHostProjectSessionCatalog } from "./runtime-host-project-session-catalog.js";
import { toDesktopHostSessionSummary } from "./runtime-host-session-catalog-ipc-main.js";
import {
  loadRuntimeHostSettings,
  registerRuntimeHostSettingsIpc,
  updateRuntimeHostSettings,
} from "./runtime-host-settings-ipc-main.js";
import { registerRuntimeHostSkillsIpc } from "./runtime-host-skills-ipc-main.js";
import { hasRuntimeHostInterruptibleWork } from "./runtime-host-update-activity.js";
import { registerRuntimeHostUsageIpc } from "./runtime-host-usage-ipc-main.js";
import { registerRuntimeHostVoiceIpc } from "./runtime-host-voice-ipc-main.js";
import { registerRuntimeHostWebSearchIpc } from "./runtime-host-web-search-ipc-main.js";
import { resolveShellEnv } from "./shell-env.js";
import {
  registerSettingsBotsIpc,
  type SettingsBotsIpcHandle,
} from "./settings-bots-ipc-main.js";
import { registerWorkspaceSearchIpc } from "./workspace-search-ipc-main.js";

await resolveShellEnv();

const buildInfo = resolveBuildInfo(app.isPackaged, app.getAppPath());
const userDataDir = app.getPath("userData");
const workspaceRoot = join(userDataDir, "workspaces", "default");
const settingsStore = createSettingsStore(workspaceRoot);
const projectCatalog = createProjectCatalog(workspaceRoot, {
  onLegacyImportFailure: (error) =>
    console.error("[projects] projects.json could not be imported:", error),
});
const mcpConfigStore = createMcpConfigStore(workspaceRoot);
const mcpManager = new McpClientManager({
  clientName: "maka-desktop",
  clientVersion: app.getVersion(),
});
let mcpStartup: Promise<void> | undefined;
function ensureMcpReady(): Promise<void> {
  if (!mcpStartup) {
    const startup = mcpConfigStore
      .get()
      .then((config) => mcpManager.sync(config));
    mcpStartup = startup;
    void startup.catch(() => {
      if (mcpStartup === startup) mcpStartup = undefined;
    });
  }
  return mcpStartup;
}
const planReminderStore = createSqlitePlanReminderStore(workspaceRoot);
const keepSystemAwake = createKeepSystemAwakeController(powerSaveBlocker);
let onMainWindowClose = (): void => {};
const mainWindowController = createMainWindowController({
  workspaceRoot,
  e2eFixture: null,
  settingsStore,
  startHidden: false,
  onClose: () => onMainWindowClose(),
});
const native = assembleDesktopNativeCapabilities({
  isComputerUseRealModelE2e: false,
  settings: settingsStore,
  keepSystemAwake,
  mainWindow: mainWindowController,
});
const permissionOverlay = createPermissionOverlayMain({
  resolveLocale: async () => {
    const settings = await settingsStore.get();
    return resolveUiLocale(
      settings.personalization.uiLocale,
      resolveSystemUiLocale(app.getPreferredSystemLanguages()),
    );
  },
});
onMainWindowClose = () => {
  native.computerUseOverlay.destroyAll();
  native.computerUsePip.destroyAll();
};

const projectRoot = createProjectRootController({
  lastProjectPathFile: join(workspaceRoot, "last-project-path.json"),
  fallbackRoots: () => [process.cwd(), app.getAppPath()],
});
const attachmentApprovals = createAttachmentApprovalRegistry();
const oauthPresentation = new RuntimeHostOAuthPresentation((url) =>
  shell.openExternal(url),
);
let owner: RuntimeHostDesktopOwner | undefined;
let runtimePolicyClient: DesktopRuntimeHostClient | undefined;
const mcpCapabilityPublisher = createCapabilityRevisionPublisher(() =>
  mcpManager.toolSnapshotRevision(),
);
let settingsBotsIpc: SettingsBotsIpcHandle | undefined;
const botRegistry = new BotRegistry({
  onIncomingMessage: (message: BotIncomingMessage) => {
    void owner?.handleBotIncomingMessage(message);
  },
  onStatusChange: (status) => {
    mainWindowController.send("settings:bots:statusChanged", status);
  },
});
const updateMockState =
  process.env.MAKA_UPDATE_MOCK_STATE === "available" ||
  process.env.MAKA_UPDATE_MOCK_STATE === "downloading" ||
  process.env.MAKA_UPDATE_MOCK_STATE === "downloaded"
    ? process.env.MAKA_UPDATE_MOCK_STATE
    : undefined;
const updateService = createAppUpdateService({
  currentVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  openExternal: (url) => shell.openExternal(url),
  mockLatestVersion: process.env.MAKA_UPDATE_MOCK_VERSION,
  mockState: updateMockState,
  onStatusChange: (status) =>
    mainWindowController.send("app:updateStatusChanged", status),
  hasActiveTasks: () => {
    if (!runtimePolicyClient) {
      throw new Error("Runtime Host activity is unavailable");
    }
    return hasRuntimeHostInterruptibleWork(runtimePolicyClient);
  },
});
const planReminders = createPlanReminderMainService({
  store: planReminderStore,
  getPrivacyContext: async () => {
    if (!runtimePolicyClient) {
      throw new Error("Runtime Host policy is unavailable");
    }
    return {
      incognitoActive: (await runtimePolicyClient.queryRuntimePolicy()).policy
        .privacy.incognitoActive,
    };
  },
  sendBotMessage: (platform, chatId, text) =>
    botRegistry.sendMessage(platform, chatId, text),
  emitChanged: (reason, reminder) => {
    mainWindowController.send("plans:changed", {
      type: "plans_changed",
      reason,
      reminderId: reminder.id,
      ts: Date.now(),
    });
  },
  emitDue: (reminder) => mainWindowController.send("plans:due", reminder),
});
mcpManager.onChange(() => {
  mainWindowController.send("mcp:changed", mcpManager.statuses());
  void mcpCapabilityPublisher.refreshIfChanged().catch((error) =>
    console.error("[runtime-host] MCP capability refresh failed:", error),
  );
});

registerPersistentClientIpc();
registerBrowserIpc({ mainWindowController });
registerNotificationsIpc({
  ipcMain,
  settingsStore,
  mainWindowController,
  e2e: false,
});

owner = await startRuntimeHostDesktopOwner(
  {
    rootPath: workspaceRoot,
    candidateEntrypoint: new URL(
      import.meta.resolve("@maka/runtime-host/execution-candidate-main"),
    ),
    ipcMain,
    workspaceRoot,
    attachmentApprovals,
    stat: (path) => import("node:fs/promises").then(({ stat }) => stat(path)),
    resizeImage: resizeImageForAttachment,
    nativeCapabilities: {
      browserTools: native.browserTools,
      releaseBrowserSession,
      computerUseTools: native.computerUseTools,
      additionalGroups: () => {
        const tools = buildMcpTools(mcpManager);
        return tools.length === 0
          ? []
          : [
              {
                offerId: "desktop_mcp",
                label: "MCP",
                description: "Use MCP tools connected by this Desktop client.",
                tools,
              },
            ];
      },
      oauthPresentation,
      releaseComputerUseSession: (sessionId) => {
        native.computerUseOverlay.clearForSession(sessionId);
        native.computerUsePip.clearForSession(sessionId);
        native.computerUseStatusItem.clearForSession(sessionId);
        native.computerUseScreenLock.clearForSession(sessionId);
        native.computerUseTools.clearSession(sessionId);
      },
    },
    botRegistry,
    resolveBotCreateTarget: async () => ({ cwd: await projectRoot.current() }),
    emitSessionsChanged,
    emitModeChanged: (sessionId) =>
      emitSessionsChanged("mode-change", sessionId),
    sendToRenderer: (channel, payload) =>
      mainWindowController.send(channel, payload),
    onError: (error) =>
      console.error("[runtime-host] projection refresh failed:", error),
    registerClientIpc: registerHostClientIpc,
  },
  {
    onFatalError: (error) => {
      console.error("[runtime-host] fatal:", error);
      app.quit();
    },
  },
);

await planReminders.refreshTimers();
updateService.start();
void ensureMcpReady()
  .then(() => mcpCapabilityPublisher.refreshIfChanged())
  .catch((error) => console.error("[runtime-host] MCP startup failed:", error));

void settingsStore
  .get()
  .then(async (settings) => {
    await keepSystemAwake.apply(settings.system.keepSystemAwake);
    await botRegistry.applySettings(settings.botChat);
  })
  .catch((error) =>
    console.error("[runtime-host] Client settings startup failed:", error),
  );

wireLifecycle();

function registerHostClientIpc(
  client: DesktopRuntimeHostClient,
  scopedIpc: Pick<typeof ipcMain, "handle">,
  controls: DesktopRuntimeHostCandidateControls,
): () => Promise<void> {
  const capabilityBinding = mcpCapabilityPublisher.bind(
    controls.refreshClientCapabilities,
  );
  void capabilityBinding.aligned.catch((error) =>
    console.error("[runtime-host] MCP capability alignment failed:", error),
  );
  runtimePolicyClient = client;
  registerMcpIpcMain({
    ipcMain: scopedIpc,
    store: mcpConfigStore,
    manager: mcpManager,
    ensureReady: ensureMcpReady,
    refreshIdleBackends: mcpCapabilityPublisher.refreshIfChanged,
    emitChanged: (statuses) =>
      mainWindowController.send("mcp:changed", statuses),
  });
  registerRuntimeHostConnectionsIpc({
    ipcMain: scopedIpc,
    client,
    emitConnectionListChanged,
  });
  registerRuntimeHostArtifactsIpc({
    ipcMain: scopedIpc,
    client,
    mainWindowController,
    sendToRenderer: (channel, ...args) =>
      mainWindowController.send(channel, ...args),
    showItemInFolder: (path) => shell.showItemInFolder(path),
  });
  registerRuntimeHostDailyReviewIpc({
    ipcMain: scopedIpc,
    client,
    mainWindowController,
  });
  registerRuntimeHostInspectorIpc({ ipcMain: scopedIpc, client });
  registerRuntimeHostOAuthIpc({
    ipcMain: scopedIpc,
    client,
    presentation: oauthPresentation,
    emitConnectionListChanged,
  });
  registerRuntimeHostGitHubCopilotIpc({
    ipcMain: scopedIpc,
    client,
    emitConnectionListChanged,
  });
  registerRuntimeHostMemoryIpc({
    ipcMain: scopedIpc,
    client,
    workspaceRoot,
    openPath: (path) => shell.openPath(path),
  });
  const settingsIpcDeps = {
    ipcMain: scopedIpc,
    client,
    settingsStore,
    botRegistry,
    applyKeepSystemAwake: async (enabled) => {
      await keepSystemAwake.apply(enabled);
    },
    emitExternalChanged: () =>
      mainWindowController.send("settings:externalChanged", { ts: Date.now() }),
  } satisfies Parameters<typeof registerRuntimeHostSettingsIpc>[0];
  registerRuntimeHostSettingsIpc(settingsIpcDeps);
  registerRuntimeHostConfigIpc({
    ipcMain: scopedIpc,
    client,
    mainWindowController,
    appVersion: app.getVersion(),
    getSettings: () => loadRuntimeHostSettings(settingsIpcDeps),
    updateSettings: (patch) =>
      updateRuntimeHostSettings(settingsIpcDeps, patch),
    emitConnectionsChanged: emitConnectionListChanged,
  });
  const candidateSettingsBotsIpc = registerSettingsBotsIpc({
    ipcMain: scopedIpc,
    settingsStore,
    botRegistry,
    applySettingsRuntimeEffects: async (settings) => {
      await botRegistry.applySettings(settings.botChat);
    },
    productVersion: app.getVersion(),
    openExternal: (url) => shell.openExternal(url),
  });
  settingsBotsIpc = candidateSettingsBotsIpc;
  registerRuntimeHostPermissionsIpc({
    ipcMain: scopedIpc,
    client,
    getSettings: () => loadRuntimeHostSettings(settingsIpcDeps),
    listConnections: async () =>
      projectHostConnections(await client.loadConnectionCatalog()),
    botRegistry,
    getComputerUseCapabilityInput: () => {
      const executorState = native.computerUse.backend?.executorState?.();
      return {
        backendId: native.computerUse.backendId,
        health: computerUseServiceHealth(
          native.computerUse.backendId,
          executorState,
        ),
      };
    },
  });
  registerPermissionOverlayIpc({
    controller: permissionOverlay,
    ipcMain: scopedIpc,
  });
  registerRuntimeHostSkillsIpc({
    ipcMain: scopedIpc,
    client,
    workspaceRoot,
    mainWindowController,
    getCurrentProjectRoot: () => projectRoot.current(),
    openPath: (path) => shell.openPath(path),
  });
  registerRuntimeHostSearchIpc({ ipcMain: scopedIpc, client });
  registerRuntimeHostUsageIpc({
    ipcMain: scopedIpc,
    client,
    sendToRenderer: (channel, ...args) =>
      mainWindowController.send(channel, ...args),
  });
  registerRuntimeHostWebSearchIpc({ ipcMain: scopedIpc, client });
  registerRuntimeHostVoiceIpc({ ipcMain: scopedIpc, client, settingsStore });
  registerPlanReminderIpc({
    ipcMain: scopedIpc,
    planReminders,
    getWorkspacePrivacyContext: async () => ({
      incognitoActive: (await client.queryRuntimePolicy()).policy.privacy
        .incognitoActive,
    }),
  });
  const projectManagement = createProjectManagementService({
    catalog: projectCatalog,
    sessions: createRuntimeHostProjectSessionCatalog(client),
    chooseDirectory: async () => {
      const result = await mainWindowController.showOpenDialog({
        title: "Add project",
        properties: ["openDirectory"],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    selection: projectRoot,
  });
  const resolveProjectRootForContext = (sessionId: unknown): Promise<string> =>
    resolveProjectContextRoot(sessionId, {
      currentProjectRoot: () => projectRoot.current(),
      readSessionCwd: async (id) => {
        const session = await client.getSession(id);
        if (!session) throw new Error(`No such Session: ${id}`);
        return session.cwd;
      },
    });
  registerAppIpc(
    {
      mainWindowController,
      projectRoot,
      getSessionProjectRoot: (sessionId) =>
        resolveProjectRootForContext(sessionId),
      getProjectRoot: resolveProjectRootForContext,
      workspaceRoot,
      buildInfo,
      e2eFixture: null,
      projectManagement,
      updateService,
    },
    scopedIpc,
  );
  registerWorkspaceSearchIpc({
    ipcMain: scopedIpc,
    getProjectRoot: resolveProjectRootForContext,
  });
  const onboardingService = createOnboardingService({
    listConnections: async () =>
      projectHostConnections(await client.loadConnectionCatalog()),
    getDefaultSlug: async () => {
      const catalog = await client.loadConnectionCatalog();
      const target = catalog.defaultTarget;
      return target === null
        ? null
        : (catalog.connections.find(
            ({ connectionId }) => connectionId === target.connectionId,
          )?.slug ?? null);
    },
    listSessions: async () =>
      (await client.listSessions()).map(toDesktopHostSessionSummary),
    getMilestones: async () =>
      (await settingsStore.get()).onboarding.milestones,
    upsertMilestone: (id, status) =>
      settingsStore.upsertOnboardingMilestone(id, status),
    clearMilestone: (id) => settingsStore.clearOnboardingMilestone(id),
    hasCredential: async (connection) => {
      if (!providerAuthRequiresSecret(connection.providerType)) return true;
      const catalog = await client.loadConnectionCatalog();
      const entry = catalog.connections.find(
        ({ slug }) => slug === connection.slug,
      );
      if (!entry) return false;
      const authKind = PROVIDER_DEFAULTS[entry.providerType].authKind;
      const status = await client.queryCredential({
        scope: "connection",
        connectionId: entry.connectionId,
        kind: authKind === "oauth_token" ? "oauth_token" : "api_key",
      });
      return status?.configured === true;
    },
  });
  registerOnboardingIpc({ onboardingService, ipcMain: scopedIpc });
  return async () => {
    candidateSettingsBotsIpc.dispose();
    if (settingsBotsIpc === candidateSettingsBotsIpc) {
      settingsBotsIpc = undefined;
    }
    if (runtimePolicyClient === client) runtimePolicyClient = undefined;
    capabilityBinding.dispose();
    await capabilityBinding.aligned.catch(() => undefined);
  };
}

function registerPersistentClientIpc(): void {
  ipcMain.handle("attachments:pickFiles", async (event) => {
    const result = await mainWindowController.showOpenDialog({
      title: "Add attachments",
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || !result.filePaths[0])
      return { ok: false, reason: "cancelled" };
    const { stat } = await import("node:fs/promises");
    const chosen = await Promise.all(
      result.filePaths.map(async (path) => ({
        path,
        name: basename(path),
        size: (await stat(path)).size,
      })),
    );
    return {
      ok: true,
      files: attachmentApprovals.issueApprovals(event.sender.id, chosen),
    };
  });
}

function emitConnectionListChanged(): void {
  const event: ConnectionEvent = {
    type: "connection_list_changed",
    id: randomUUID(),
    ts: Date.now(),
  };
  mainWindowController.send("connections:event", event);
}

function emitSessionsChanged(
  reason: SessionChangedReason,
  sessionId?: string,
  extra?: Pick<SessionChangedEvent, "connectionSlug" | "modelId" | "turnId">,
): void {
  const event: SessionChangedEvent = {
    type: "sessions_changed",
    reason,
    ts: Date.now(),
    ...(sessionId ? { sessionId } : {}),
    ...(extra?.connectionSlug ? { connectionSlug: extra.connectionSlug } : {}),
    ...(extra?.modelId ? { modelId: extra.modelId } : {}),
    ...(extra?.turnId ? { turnId: extra.turnId } : {}),
  };
  mainWindowController.send("sessions:changed", event);
}

function wireLifecycle(): void {
  let quitting = false;
  const focusOrCreateWindow = () => {
    if (quitting) return;
    if (mainWindowController.hasOpenWindows()) mainWindowController.focus();
    else void mainWindowController.createWindow(new AbortController().signal);
  };
  installDesktopShellPresentation({
    startHidden: false,
    mainWindowController,
    focusOrCreateWindow,
    onIconError: (error) =>
      console.error("[icon] failed to set dock icon:", error),
  });
  app.on("second-instance", focusOrCreateWindow);
  app.on("activate", focusOrCreateWindow);
  app.on("window-all-closed", () => {
    native.computerUseOverlay.destroyAll();
    native.computerUsePip.destroyAll();
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void closeRuntimeHostDesktop().finally(() => app.quit());
  });
  void mainWindowController.createWindow(new AbortController().signal);
}

async function closeRuntimeHostDesktop(): Promise<void> {
  planReminders.stopTimers();
  updateService.dispose();
  settingsBotsIpc?.dispose();
  permissionOverlay.dismiss();
  const results = await Promise.allSettled([
    owner?.close(),
    botRegistry.stopAll(),
    mcpManager.close(),
    mainWindowController.disposeBrowserViews(),
    Promise.resolve().then(() => native.computerUseOverlay.destroyAll()),
    Promise.resolve().then(() => native.computerUsePip.destroyAll()),
    Promise.resolve().then(() => native.computerUseStatusItem.destroy()),
    Promise.resolve().then(() => native.computerUseScreenLock.dispose()),
    Promise.resolve().then(() => native.computerUse.backend?.dispose?.()),
    planReminderStore.ready().then(() => planReminderStore.close()),
  ]);
  for (const result of results) {
    if (result.status === "rejected")
      console.error("[runtime-host] shutdown failed:", result.reason);
  }
}
