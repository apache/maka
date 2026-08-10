import { app, clipboard, dialog, ipcMain, powerSaveBlocker, shell } from "electron";
import { randomUUID } from "node:crypto";
import { arch as osArch, homedir, release as osRelease } from "node:os";
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
  SCHEDULED_TASK_AUTHORITY_SERVICE_ID,
  SCHEDULED_TASK_AUTHORITY_SERVICE_VERSION,
  buildMcpTools,
  type BotIncomingMessage,
} from "@maka/runtime";
import { loadOrCreateRuntimeHostClientInstanceId } from "@maka/runtime-host/client";
import type { WorkspaceTarget } from "@maka/runtime-host/protocol";
import { McpClientManager } from "@maka/mcp";
import {
  createSettingsStore,
  createMcpConfigStore,
  createSqliteScheduledTaskStore,
} from "@maka/storage";
import { resolveStorageRoot } from "@maka/storage/root-authority";
import { registerAppIpc } from "./app-ipc-main.js";
import { createAppQuitCoordinator } from "./app-quit-coordinator.js";
import { createAppUpdateService } from "./app-update-service.js";
import { createAttachmentApprovalRegistry } from "./attachment-approval.js";
import { renderAttachmentPreview, resizeImageForAttachment } from "./attachment-resize-native.js";
import { registerAttachmentPreviewIpc } from "./attachment-preview.js";
import { readFileCapped } from "./attachment-ingest.js";
import { registerBrowserIpc } from "./browser-ipc-main.js";
import { releaseBrowserSession } from "./browser/session.js";
import { createE2eFixtureBotOnboardingAdapters } from "./bot-onboarding-e2e-fixture.js";
import { resolveBuildInfo } from "./build-info.js";
import { computerUseServiceHealth } from "./computer-use-host.js";
import { registerDesktopDiagnosticsIpc } from "./desktop-diagnostics-ipc-main.js";
import { assembleDesktopNativeCapabilities } from "./desktop-native-capability-assembly.js";
import { buildRiveWorkflowTool } from "./rive-workflow-tool.js";
import { installDesktopShellPresentation } from "./desktop-shell-presentation.js";
import {
  resolveE2eFixture,
  seedE2eFixture,
} from "./e2e-fixture.js";
import { createKeepSystemAwakeController } from "./keep-system-awake.js";
import {
  readWithFallback,
  type ReconnectableReadIpcMain,
} from "./ipc-reconnect-policy.js";
import { createMainWindowController } from "./main-window.js";
import { mainProcessLogBuffer } from "./main-process-diagnostics.js";
import {
  resolveDesktopSessionWorkspace,
} from "./new-session-project.js";
import { registerMcpIpcMain } from "./mcp-ipc-main.js";
import { createOnboardingService } from "./onboarding-service.js";
import { registerOnboardingIpc } from "./onboarding-ipc-main.js";
import {
  createDesktopTaskSubmissionReadinessService,
  registerTaskSubmissionReadinessIpc,
  type DesktopModelTargetResolution,
} from "./task-submission-readiness-main.js";
import { registerNotificationsIpc } from "./notifications-ipc-main.js";
import { registerScheduledTaskIpc } from "./scheduled-tasks-ipc-main.js";
import { createScheduledTaskMainService } from "./scheduled-tasks-main.js";
import { registerPetPackIpc } from "./pet-pack-import.js";
import {
  createPermissionOverlayMain,
  registerPermissionOverlayIpc,
} from "./permission-overlay/permission-overlay-main.js";
import { resolveProjectContextRoot } from "./project-context-root.js";
import { resolveDefaultPermissionMode } from "./permission-mode-default.js";
import { createProjectManagementService } from "./project-management-service.js";
import type { ProjectManagementService } from "./project-management-service.js";
import { createProjectRootController } from "./project-root-controller.js";
import { createSessionCopyCleanupAuthority } from "./quote-companion-cleanup.js";
import {
  projectHostConnections,
  registerRuntimeHostConnectionsIpc,
} from "./runtime-host-connections-ipc-main.js";
import { registerRuntimeHostConfigIpc } from "./runtime-host-config-ipc-main.js";
import { createCapabilityRevisionPublisher } from "./runtime-host-capability-revision-publisher.js";
import { buildClientSettingsTools } from "./client-settings-tools.js";
import { createClientSettingsEffects } from "./client-settings-effects.js";
import { startClientSettingsWatcher } from "./client-settings-watcher.js";
import { registerRuntimeHostGitHubCopilotIpc } from "./runtime-host-github-copilot-ipc-main.js";
import { registerRuntimeHostArtifactsIpc } from "./runtime-host-artifacts-ipc-main.js";
import { registerRuntimeHostDailyReviewIpc } from "./runtime-host-daily-review-ipc-main.js";
import { registerRuntimeHostInspectorIpc } from "./runtime-host-inspector-ipc-main.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";
import type { DesktopRuntimeHostCandidateControls } from "./runtime-host-desktop-candidate.js";
import {
  RuntimeHostUpgradeCancelledError,
  startRuntimeHostDesktopOwner,
  type RuntimeHostDesktopOwner,
} from "./runtime-host-desktop-owner.js";
import { runtimeHostUpgradePrompts } from "./runtime-host-upgrade-dialog.js";
import { registerRuntimeHostMemoryIpc } from "./runtime-host-memory-ipc-main.js";
import { registerRuntimeHostOAuthIpc } from "./runtime-host-oauth-ipc-main.js";
import { RuntimeHostOAuthPresentation } from "./runtime-host-oauth-presentation.js";
import { registerRuntimeHostPermissionsIpc } from "./runtime-host-permissions-ipc-main.js";
import { registerRuntimeHostSearchIpc } from "./runtime-host-search-ipc-main.js";
import { createRuntimeHostProjectCatalog } from "./runtime-host-project-catalog.js";
import { toDesktopHostSessionSummary } from "./runtime-host-session-catalog-ipc-main.js";
import {
  loadRuntimeHostSettings,
  registerRuntimeHostSettingsIpc,
  updateRuntimeHostSettings,
} from "./runtime-host-settings-ipc-main.js";
import { registerRuntimeHostSkillsIpc } from "./runtime-host-skills-ipc-main.js";
import { registerRuntimeHostUsageIpc } from "./runtime-host-usage-ipc-main.js";
import { registerRuntimeHostWebSearchIpc } from "./runtime-host-web-search-ipc-main.js";
import { registerRuntimeHostWorkspaceIpc } from "./runtime-host-workspace-ipc-main.js";
import { resolveShellEnv } from "./shell-env.js";
import {
  registerSettingsBotsIpc,
  type SettingsBotsIpcHandle,
} from "./settings-bots-ipc-main.js";
import {
  isComputerUseRealModelE2e,
  isE2e,
  isIsolatedE2e,
} from "./startup-context.js";
import { resolveDesktopStorageRoot } from "./storage-root-startup.js";
import { startupStep, whileAwaitingPerson } from "./startup-step.js";
import { registerWorkspaceSearchIpc } from "./workspace-search-ipc-main.js";

await resolveShellEnv();

const buildInfo = resolveBuildInfo(app.isPackaged, app.getAppPath());
const userDataDir = app.getPath("userData");
const runtimeHostClientInstanceId = await loadOrCreateRuntimeHostClientInstanceId(
  join(userDataDir, "runtime-host-client.json"),
);
const runtimeHostGeneration = app.isPackaged ? app.getVersion() : randomUUID();
const e2eFixture = resolveDesktopE2eFixture();
const useBotOnboardingFixture = e2eFixture?.scenario === "settings-bots-onboarding";
const workspaceRoot = join(
  userDataDir,
  "workspaces",
  e2eFixture?.workspaceName ?? "default",
);
if (e2eFixture) {
  console.log(
    `[e2e-fixture] scenario=${e2eFixture.scenario} workspace=${workspaceRoot}`,
  );
  await seedE2eFixture({ workspaceRoot, fixture: e2eFixture });
}
const storageRoot = e2eFixture
  ? await resolveStorageRoot({ path: workspaceRoot, kind: "interactive" })
  : await startupStep(
    "storage root",
    resolveDesktopStorageRoot(workspaceRoot, {
      confirmRepair: () => confirmDesktopStorageRootRepair(workspaceRoot),
    }),
  );
if (!storageRoot) {
  app.exit(0);
  await new Promise<never>(() => {});
  throw new Error("Desktop storage root resolution did not complete");
}
const settingsStore = createSettingsStore(workspaceRoot);
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
const scheduledTaskStore = createSqliteScheduledTaskStore(workspaceRoot);
const keepSystemAwake = createKeepSystemAwakeController(powerSaveBlocker);
const startHidden =
  (Boolean(e2eFixture) || isIsolatedE2e) &&
  process.env.MAKA_E2E_SHOW_WINDOW !== "1";
let onMainWindowClose = (): void => {};
const mainWindowController = createMainWindowController({
  workspaceRoot,
  e2eFixture,
  settingsStore,
  startHidden,
  onClose: () => onMainWindowClose(),
});
const native = assembleDesktopNativeCapabilities({
  isComputerUseRealModelE2e,
  settings: settingsStore,
  keepSystemAwake,
  mainWindow: mainWindowController,
});
const riveWorkflowTool = buildRiveWorkflowTool();
const completeComputerUseTurn = (sessionId: string): void => {
  native.computerUseOverlay.clearForSession(sessionId);
  native.computerUsePip.complete(sessionId);
  native.computerUseStatusItem.clearForSession(sessionId);
  native.computerUseScreenLock.clearForSession(sessionId);
  native.computerUseTools.clearSession(sessionId);
};
const releaseComputerUseSession = (sessionId: string): void => {
  native.computerUseOverlay.clearForSession(sessionId);
  native.computerUsePip.clearForSession(sessionId);
  native.computerUseStatusItem.clearForSession(sessionId);
  native.computerUseScreenLock.clearForSession(sessionId);
  native.computerUseTools.clearSession(sessionId);
};
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
  rootId: storageRoot.rootId,
  preferenceFile: join(workspaceRoot, "project-preferences.json"),
  legacySelectionFile: join(workspaceRoot, "last-project-path.json"),
  fallbackRoots: () => [process.cwd(), app.getAppPath()],
});
const attachmentApprovals = createAttachmentApprovalRegistry();
const oauthPresentation = new RuntimeHostOAuthPresentation((url) => shell.openExternal(url));
let owner: RuntimeHostDesktopOwner | undefined;
let runtimePolicyClient: DesktopRuntimeHostClient | undefined;
const projectCatalog = createRuntimeHostProjectCatalog(() => {
  if (!runtimePolicyClient) throw new Error("Runtime Host client is unavailable");
  return runtimePolicyClient;
});
const projectManagement: ProjectManagementService = createProjectManagementService({
  catalog: projectCatalog,
  chooseDirectory: async () => {
    const result = await mainWindowController.showOpenDialog({
      title: "Add project",
      properties: ["openDirectory"],
    });
    return result.canceled ? undefined : result.filePaths[0];
  },
  selection: projectRoot,
});
const currentDesktopWorkspaceTarget = async (): Promise<WorkspaceTarget> => {
  const current = await projectManagement.current();
  return typeof current.projectId === "string"
    ? { kind: "project", projectId: current.projectId }
    : { kind: "host_path", path: current.path };
};
const mcpCapabilityPublisher = createCapabilityRevisionPublisher(() =>
  mcpManager.toolSnapshot().revision,
);
let settingsBotsIpc: SettingsBotsIpcHandle | undefined;
const botRegistry = new BotRegistry({
  onIncomingMessage: (message: BotIncomingMessage) => {
    void owner
      ?.handleBotIncomingMessage(message)
      .catch((error) => console.error("[runtime-host] bot message failed:", error));
  },
  onStatusChange: (status) => {
    mainWindowController.send("settings:bots:statusChanged", status);
  },
});
const clientSettingsEffects = createClientSettingsEffects({
  settingsStore,
  applyKeepSystemAwake: async (enabled) => {
    keepSystemAwake.apply(enabled);
  },
  applyBotSettings: useBotOnboardingFixture
    ? async () => undefined
    : (settings) => botRegistry.applySettings(settings),
  emitExternalChanged: () =>
    mainWindowController.send("settings:externalChanged", { ts: Date.now() }),
});
const clientSettingsTools = buildClientSettingsTools({
  read: () => settingsStore.get(),
  update: async (patch) => {
    const settings = await settingsStore.update(patch);
    await clientSettingsEffects.apply(settings, true);
    return settings;
  },
  confirm: async (changes) => {
    const result = await dialog.showMessageBox({
      type: "question",
      message: "Allow Maka to update this client's settings?",
      detail: changes.join("\n"),
      buttons: ["Apply changes", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return result.response === 0;
  },
});
const clientSettingsWatcher = startClientSettingsWatcher(
  workspaceRoot,
  () => {
    void clientSettingsEffects.refresh(true).catch((error) =>
      console.error("[runtime-host] Client settings refresh failed:", error),
    );
  },
  {
    onError: (error) =>
      console.error("[runtime-host] Client settings watcher failed:", error),
  },
);
const updateMockState =
  process.env.MAKA_UPDATE_MOCK_STATE === "available" ||
  process.env.MAKA_UPDATE_MOCK_STATE === "downloading" ||
  process.env.MAKA_UPDATE_MOCK_STATE === "downloaded"
    ? process.env.MAKA_UPDATE_MOCK_STATE
    : undefined;
const updateService = createAppUpdateService({
  currentVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  mockLatestVersion: process.env.MAKA_UPDATE_MOCK_VERSION,
  mockState: updateMockState,
  onStatusChange: (status) =>
    mainWindowController.send("app:updateStatusChanged", status),
  prepareInstall: async (input) => {
    if (!owner) throw new Error("Runtime Host owner is unavailable");
    return owner.prepareForUpdate(input.allowInterruptActiveTasks);
  },
});
const scheduledTasks = createScheduledTaskMainService({
  store: scheduledTaskStore,
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
  startAgentRun: async ({ task, sessionId, turnId }) => {
    if (!runtimePolicyClient) throw new Error("Runtime Host client is unavailable");
    if (task.effect.kind !== "agent_run") {
      throw new Error("Task effect is not agent_run");
    }
    const execution = task.effect.execution;
    const hostClient = runtimePolicyClient;
    const workspace =
      execution.projectId != null && execution.projectId !== ""
        ? ({ kind: "project" as const, projectId: execution.projectId })
        : ({ kind: "host_path" as const, path: execution.cwd });
    await hostClient.createSession({
      sessionId,
      workspace,
      name: task.title,
      labels: ["scheduled-task"],
      modelTarget: {
        kind: "explicit",
        connectionSlug: execution.llmConnectionSlug,
        model: execution.model,
      },
      ...(execution.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: execution.thinkingLevel }),
      permissionMode: execution.permissionMode,
      collaborationMode: execution.collaborationMode,
      orchestrationMode: execution.orchestrationMode,
    } as never);
    const started = await hostClient.startTurn({
      sessionId,
      turnId,
      content: { text: task.intent.body },
    });
    if (started.kind !== "started") {
      throw new Error("Scheduled task agent turn was blocked");
    }
    return { sessionId, runId: started.turn.runId };
  },
  resolveDefaultAgentExecution: async () => {
    if (!runtimePolicyClient) return null;
    const sessions = await runtimePolicyClient.listSessions();
    const live = sessions.find((session) => !session.isArchived);
    if (!live) return null;
    const cwd =
      "workspace" in live && live.workspace && typeof live.workspace === "object"
        ? (live.workspace as { hostCwd?: string }).hostCwd
        : undefined;
    if (!cwd || typeof live.llmConnectionSlug !== "string" || typeof live.model !== "string") {
      return null;
    }
    const projectId =
      "projectId" in live && typeof (live as { projectId?: unknown }).projectId === "string"
        ? (live as { projectId: string }).projectId
        : undefined;
    return {
      cwd,
      ...(projectId ? { projectId } : {}),
      backend: (live.backend as "ai-sdk" | "fake" | "pi-agent" | undefined) ?? "ai-sdk",
      llmConnectionSlug: live.llmConnectionSlug,
      model: live.model,
      ...(live.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: live.thinkingLevel }),
      permissionMode: live.permissionMode,
      collaborationMode: live.collaborationMode ?? "agent",
      orchestrationMode: live.orchestrationMode ?? "default",
    };
  },
  emitChanged: (reason, task) => {
    mainWindowController.send("scheduled-tasks:changed", {
      type: "scheduled_tasks_changed",
      reason,
      taskId: task.id,
      ts: Date.now(),
    });
  },
  emitFired: (task) => mainWindowController.send("scheduled-tasks:fired", task),
});
mcpManager.onChange(() => {
  mainWindowController.send("mcp:changed", mcpManager.statuses());
  void mcpCapabilityPublisher.refreshIfChanged().catch((error) =>
    console.error("[runtime-host] MCP capability refresh failed:", error),
  );
});

registerPersistentClientIpc();
registerPetPackIpc({ ipcMain, workspaceRoot, mainWindowController, settingsStore });
registerBrowserIpc({ mainWindowController });
registerNotificationsIpc({
  ipcMain,
  settingsStore,
  mainWindowController,
  e2e: isE2e,
});

const sessionCopyOwnerProcessId = randomUUID();
owner = await startRuntimeHostDesktopOwner(
  {
    rootPath: workspaceRoot,
    clientInstanceId: runtimeHostClientInstanceId,
    generation: runtimeHostGeneration,
    candidateEntrypoint: new URL(
      import.meta.resolve(
        isE2e
          ? "@maka/runtime-host/desktop-e2e-execution-candidate-main"
          : "@maka/runtime-host/execution-candidate-main",
      ),
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
        const mcpTools = buildMcpTools(mcpManager);
        return [
          {
            offerId: "desktop_settings",
            label: "Client settings",
            description:
              "Read or update UI and operating-system settings owned by this Desktop client.",
            tools: clientSettingsTools,
          },
          {
            offerId: "desktop_rive",
            label: "Rive",
            description:
              "Use durable Rive workflows through this Desktop client.",
            tools: [riveWorkflowTool],
          },
          ...(mcpTools.length === 0
            ? []
            : [
                {
                  offerId: "desktop_mcp",
                  label: "MCP",
                  description:
                    "Use MCP tools connected by this Desktop client.",
                  tools: mcpTools,
                },
              ]),
        ];
      },
      additionalServices: () => [
        {
          serviceId: SCHEDULED_TASK_AUTHORITY_SERVICE_ID,
          version: SCHEDULED_TASK_AUTHORITY_SERVICE_VERSION,
          async call(method, input) {
            if (method === "list") return { tasks: await scheduledTasks.list() };
            if (method === "create") {
              return { task: await scheduledTasks.create(input.payload) };
            }
            if (method !== "pause" && method !== "resume" && method !== "delete") {
              throw new Error(`Unknown ScheduledTask authority method: ${method}`);
            }
            const id = requireScheduledTaskServiceId(input.id);
            if (method === "pause") return { task: await scheduledTasks.pause(id) };
            if (method === "resume") return { task: await scheduledTasks.resume(id) };
            await scheduledTasks.remove(id);
            return { ok: true };
          },
        },
      ],
      oauthPresentation,
      releaseComputerUseSession,
    },
    botRegistry,
    resolveBotCreateTarget: async () => ({
      workspace: await currentDesktopWorkspaceTarget(),
    }),
    resolveSessionCreateProject: async (input) => {
      return resolveDesktopSessionWorkspace(
        input,
        {
          ...projectManagement,
          defaultProjectId: async () =>
            (await settingsStore.get()).projects.defaultProjectId,
        },
        projectCatalog,
      );
    },
    emitSessionsChanged,
    emitModeChanged: (sessionId) =>
      emitSessionsChanged("mode-change", sessionId),
    completeComputerUseTurn,
    createSessionCopyCleanup: ({ removeSession, resumeSessionCopy }) =>
      createSessionCopyCleanupAuthority({
        workspaceRoot,
        removeSession,
        resumeSessionCopy,
        processId: sessionCopyOwnerProcessId,
      }),
    sendToRenderer: (channel, payload) =>
      mainWindowController.send(channel, payload),
    onError: (error) =>
      console.error("[runtime-host] projection refresh failed:", error),
    registerClientIpc: registerHostClientIpc,
  },
  {
    upgradePrompts: runtimeHostUpgradePrompts,
    onFatalError: (error) => {
      if (error instanceof RuntimeHostUpgradeCancelledError) {
        app.quit();
        return;
      }
      console.error("[runtime-host] fatal:", error);
      app.quit();
    },
  },
).catch((error: unknown) => {
  if (error instanceof RuntimeHostUpgradeCancelledError) {
    app.exit(0);
    return new Promise<never>(() => undefined);
  }
  throw error;
});

const stopComputerUseSession = (sessionId: string): void => {
  void owner
    ?.stopSession(sessionId)
    .catch((error) => console.error("[runtime-host] stop failed:", error));
};
native.computerUsePip.setStopHandler(stopComputerUseSession);
native.computerUseStatusItem.setStopHandler(stopComputerUseSession);

await scheduledTasks.refreshTimers();
updateService.start();
void ensureMcpReady()
  .then(() => mcpCapabilityPublisher.refreshIfChanged())
  .catch((error) => console.error("[runtime-host] MCP startup failed:", error));

void clientSettingsEffects
  .refresh(false)
  .catch((error) =>
    console.error("[runtime-host] Client settings startup failed:", error),
  );

wireLifecycle();

function registerHostClientIpc(
  client: DesktopRuntimeHostClient,
  scopedIpc: ReconnectableReadIpcMain,
  controls: DesktopRuntimeHostCandidateControls,
): () => Promise<void> {
  const unsubscribeConfigurationChanges = client.subscribeConfigurationChanges(() => {
    emitConnectionListChanged();
    mainWindowController.send("settings:externalChanged", { ts: Date.now() });
  });
  const unsubscribeSessionCatalogChanges = client.subscribeSessionCatalogChanges(
    ({ sessionId }) => emitSessionsChanged("updated", sessionId),
  );
  const unsubscribeProjectCatalogChanges = client.subscribeProjectCatalogChanges(() => {
    mainWindowController.send("projects:changed");
  });
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
    publishCapabilities: mcpCapabilityPublisher.refreshIfChanged,
    onPublicationError: (error) =>
      console.error("[runtime-host] MCP capability publication failed:", error),
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
    applyClientSettings: async (settings) => {
      await clientSettingsEffects.apply(settings, true);
    },
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
      await clientSettingsEffects.apply(settings, true);
    },
    productVersion: app.getVersion(),
    openExternal: (url) => shell.openExternal(url),
    ...(useBotOnboardingFixture
      ? {
          botOnboardingAdapters: createE2eFixtureBotOnboardingAdapters(),
          botOnboardingReadChannelStatus: () => ({ running: true }),
        }
      : {}),
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
    getCurrentWorkspaceTarget: currentDesktopWorkspaceTarget,
    getDefaultPermissionMode: () =>
      resolveDefaultPermissionMode(() => loadRuntimeHostSettings(settingsIpcDeps)),
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
  registerRuntimeHostWorkspaceIpc({ ipcMain: scopedIpc, client });
  registerScheduledTaskIpc({
    ipcMain: scopedIpc,
    scheduledTasks,
    getWorkspacePrivacyContext: async () => ({
      incognitoActive: (await client.queryRuntimePolicy()).policy.privacy
        .incognitoActive,
    }),
  });
  const resolveProjectRootForContext = (sessionId: unknown): Promise<string> =>
    resolveProjectContextRoot(sessionId, {
      currentProjectRoot: () => projectRoot.current(),
      readSessionCwd: async (id) => {
        const session = await client.getSession(id);
        if (!session) throw new Error(`No such Session: ${id}`);
        return session.workspace.hostCwd;
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
      e2eFixture,
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
    hasCredential: (connection) =>
      readWithFallback(async () => {
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
      }, false),
  });
  const taskSubmissionReadinessService = createDesktopTaskSubmissionReadinessService({
    workspaceRoot,
    runtimeState: () => ({ state: client.lifecycleState, checkedAt: Date.now() }),
    resolveModelTarget: (requestedSlug) =>
      readWithFallback<DesktopModelTargetResolution>(async () => {
        const catalog = await client.loadConnectionCatalog();
        const connections = projectHostConnections(catalog);
        const connectionSlug = requestedSlug ?? (catalog.defaultTarget === null
          ? undefined
          : catalog.connections.find(
              ({ connectionId }) => connectionId === catalog.defaultTarget?.connectionId,
            )?.slug);
        if (!connectionSlug) return { kind: "missing_default" } as const;
        const connection = connections.find(({ slug }) => slug === connectionSlug);
        if (!connection) return { kind: "connection_missing", connectionSlug } as const;
        if (!providerAuthRequiresSecret(connection.providerType)) {
          return { kind: "resolved", connection, hasSecret: true } as const;
        }
        const entry = catalog.connections.find(({ slug }) => slug === connection.slug);
        if (!entry) return { kind: "connection_missing", connectionSlug } as const;
        const authKind = PROVIDER_DEFAULTS[entry.providerType].authKind;
        const hasSecret = await client.queryCredential({
          scope: "connection",
          connectionId: entry.connectionId,
          kind: authKind === "oauth_token" ? "oauth_token" : "api_key",
        }).then((status) => status?.configured === true);
        return { kind: "resolved", connection, hasSecret } as const;
      }, { kind: "unknown" }),
  });
  registerOnboardingIpc({ onboardingService, ipcMain: scopedIpc });
  registerTaskSubmissionReadinessIpc(taskSubmissionReadinessService, scopedIpc);
  return async () => {
    unsubscribeConfigurationChanges();
    unsubscribeSessionCatalogChanges();
    unsubscribeProjectCatalogChanges();
    candidateSettingsBotsIpc.dispose();
    if (settingsBotsIpc === candidateSettingsBotsIpc) {
      settingsBotsIpc = undefined;
    }
    if (runtimePolicyClient === client) runtimePolicyClient = undefined;
    capabilityBinding.dispose();
    await capabilityBinding.aligned.catch(() => undefined);
  };
}

function requireScheduledTaskServiceId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("ScheduledTask authority requires an id");
  }
  return value;
}

function registerPersistentClientIpc(): void {
  registerDesktopDiagnosticsIpc({
    ipcMain,
    environment: () => ({
      appVersion: app.getVersion(),
      buildMode: buildInfo.mode,
      buildCommit: buildInfo.commit,
      electronVersion: process.versions.electron ?? "",
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome ?? "",
      platform: process.platform,
      arch: osArch(),
      osRelease: osRelease(),
      locale: app.getLocale(),
      workspacePath: workspaceRoot,
      homePath: homedir(),
      processUptimeSeconds: process.uptime(),
    }),
    mainLogs: () => mainProcessLogBuffer.snapshot(),
    getRuntimeHostDiagnostics: async () => {
      if (!runtimePolicyClient) throw new Error("Runtime Host is unavailable");
      return runtimePolicyClient.queryHostDiagnostics();
    },
    writeClipboard: (report) => clipboard.writeText(report),
  });
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
  registerAttachmentPreviewIpc({
    ipcMain,
    approvals: attachmentApprovals,
    readFile: readFileCapped,
    renderPreview: renderAttachmentPreview,
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
  const quitCoordinator = createAppQuitCoordinator({
    cleanup: closeRuntimeHostDesktop,
    focusOrCreateWindow: (signal) => {
      if (mainWindowController.hasOpenWindows()) mainWindowController.focus();
      else void mainWindowController.createWindow(signal);
    },
    onCleanupError: (error) =>
      console.error("[runtime-host] shutdown failed:", error),
    resumeQuit: () => app.quit(),
  });
  installDesktopShellPresentation({
    startHidden,
    mainWindowController,
    focusOrCreateWindow: quitCoordinator.focusOrCreateWindow,
    onIconError: (error) =>
      console.error("[icon] failed to set dock icon:", error),
  });
  app.on("second-instance", quitCoordinator.focusOrCreateWindow);
  app.on("activate", quitCoordinator.focusOrCreateWindow);
  app.on("browser-window-focus", () => {
    void updateService.checkForUpdatesOnFocus();
  });
  app.on("window-all-closed", () => {
    native.computerUseOverlay.destroyAll();
    native.computerUsePip.destroyAll();
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", quitCoordinator.handleBeforeQuit);
  const initialWindowSignal = quitCoordinator.getWindowCreationSignal();
  if (initialWindowSignal) void mainWindowController.createWindow(initialWindowSignal);
}

async function closeRuntimeHostDesktop(): Promise<void> {
  clientSettingsWatcher.stop();
  scheduledTasks.stopTimers();
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
    scheduledTaskStore.ready().then(() => scheduledTaskStore.close()),
  ]);
  for (const result of results) {
    if (result.status === "rejected")
      console.error("[runtime-host] shutdown failed:", result.reason);
  }
}

function resolveDesktopE2eFixture(): ReturnType<typeof resolveE2eFixture> {
  try {
    return resolveE2eFixture(
      process.env.MAKA_E2E_FIXTURE,
      app.isPackaged,
      process.env.MAKA_E2E_FIXTURE_REDUCED_MOTION,
      process.env.MAKA_E2E_FIXTURE_THEME,
      process.env.MAKA_E2E_FIXTURE_LOCALE,
      process.env.MAKA_E2E_FIXTURE_TIMEZONE,
      process.env.MAKA_E2E_FIXTURE_PLATFORM,
    );
  } catch (error) {
    if (!process.env.MAKA_E2E_FIXTURE) throw error;
    console.error(
      `[e2e-fixture] fatal: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

async function confirmDesktopStorageRootRepair(
  workspaceRoot: string,
): Promise<boolean> {
  console.log(
    "[storage-root] root-identity conflict; parking at repair dialog",
  );
  const isChinese =
    resolveSystemUiLocale(app.getPreferredSystemLanguages()) === "zh";
  const { response } = await whileAwaitingPerson(
    dialog.showMessageBox({
      type: "warning",
      title: isChinese ? "Maka 工作区需要修复" : "Maka workspace needs repair",
      message: isChinese
        ? "Maka 无法验证这个工作区。"
        : "Maka cannot verify this workspace.",
      detail: isChinese
        ? `系统中的磁盘标识可能发生了变化。仅当这是本机原来的 Maka 工作区、而不是复制出的工作区时，才选择修复。\n\n${workspaceRoot}`
        : `The disk identity may have changed. Repair only if this is the original Maka workspace on this computer, not a copied workspace.\n\n${workspaceRoot}`,
      buttons: isChinese
        ? ["修复工作区", "退出"]
        : ["Repair Workspace", "Exit"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    }),
  );
  return response === 0;
}
