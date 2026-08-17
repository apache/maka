import { app, clipboard, dialog, ipcMain, powerSaveBlocker, shell } from "electron";
import { randomUUID } from "node:crypto";
import { arch as osArch, homedir, release as osRelease } from "node:os";
import { basename, join } from "node:path";
import { type ConnectionEvent } from '@maka/core/connections';
import type { UsageRange } from '@maka/core/settings';
import { type SessionChangedEvent, type SessionChangedReason } from '@maka/core/session';
import { isBotDeliveryProvider } from '@maka/core/bot-chat-settings';
import { resolveSystemUiLocale, resolveUiLocale } from '@maka/core/ui-locale';
import {
  PROVIDER_DEFAULTS,
  providerAuthRequiresSecret,
} from "@maka/core/llm-connections";
import { BotRegistry, type BotIncomingMessage } from '@maka/runtime/bots';
import {
  SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_ID,
  SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_VERSION,
} from '@maka/runtime/scheduled-task-tools';
import { buildMcpTools } from '@maka/runtime/mcp-tools';
import {
  LOCAL_RUNTIME_HOST_PROFILE,
  loadOrCreateRuntimeHostClientInstanceId,
} from "@maka/runtime-host/client";
import type { WorkspaceTarget } from "@maka/runtime-host/protocol";
import { McpClientManager } from "@maka/mcp";
import {
  createSettingsStore,
  createMcpConfigStore,
} from "@maka/storage";
import { resolveStorageRoot } from "@maka/storage/root-authority";
import { registerAppClientIpc, registerAppIpc } from "./app-ipc-main.js";
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
import { registerMarkdownSaveIpc } from "./markdown-save-ipc-main.js";
import { registerPetPackIpc } from "./pet-pack-import.js";
import {
  createPermissionOverlayMain,
  registerPermissionOverlayIpc,
} from "./permission-overlay/permission-overlay-main.js";
import { resolveProjectContextRoot } from "./project-context-root.js";
import { resolveDefaultPermissionMode } from "./permission-mode-default.js";
import { createProjectManagementService } from "./project-management-service.js";
import type { ProjectManagementService } from "./project-management-service.js";
import {
  createProjectRootController,
  type ProjectRootController,
} from "./project-root-controller.js";
import { createSessionCopyCleanupAuthority } from "./quote-companion-cleanup.js";
import {
  projectHostConnections,
  registerRuntimeHostConnectionsIpc,
} from "./runtime-host-connections-ipc-main.js";
import { registerRuntimeHostConfigIpc } from "./runtime-host-config-ipc-main.js";
import { createCapabilityRevisionPublisher } from "./runtime-host-capability-revision-publisher.js";
import { buildClientSettingsTools } from "./client-settings-tools.js";
import { createClientSettingsEffects } from "./client-settings-effects.js";
import { registerClientSettingsIpc } from "./client-settings-ipc-main.js";
import { startClientSettingsWatcher } from "./client-settings-watcher.js";
import { registerRuntimeHostGitHubCopilotIpc } from "./runtime-host-github-copilot-ipc-main.js";
import { registerRuntimeHostArtifactsIpc } from "./runtime-host-artifacts-ipc-main.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";
import type {
  DesktopRuntimeHostCandidateControls,
  DesktopRuntimeHostTargetPolicy,
} from "./runtime-host-desktop-candidate.js";
import {
  RuntimeHostUpgradeCancelledError,
  startRuntimeHostDesktopManager,
  type RuntimeHostDesktopManager,
} from "./runtime-host-desktop-manager.js";
import { runtimeHostUpgradePrompts } from "./runtime-host-upgrade-dialog.js";
import { registerRuntimeHostMemoryIpc } from "./runtime-host-memory-ipc-main.js";
import {
  createDesktopRuntimeHostProfileService,
  registerDesktopRuntimeHostProfileIpc,
  resolveDesktopRuntimeHostStartup,
} from "./runtime-host-profile-service.js";
import { createDesktopRuntimeHostSshTerminal } from "./runtime-host-ssh-terminal.js";
import { registerRuntimeHostOAuthIpc } from "./runtime-host-oauth-ipc-main.js";
import { RuntimeHostOAuthPresentation } from "./runtime-host-oauth-presentation.js";
import { registerRuntimeHostPermissionsIpc } from "./runtime-host-permissions-ipc-main.js";
import { registerRuntimeHostRendererIpc } from "./runtime-host-renderer-ipc-main.js";
import { registerRuntimeHostSearchIpc } from "./runtime-host-search-ipc-main.js";
import { createRuntimeHostProjectCatalog } from "./runtime-host-project-catalog.js";
import { createRuntimeHostDefaultRecovery } from "./runtime-host-default-recovery.js";
import { toDesktopHostSessionSummary } from "./runtime-host-session-catalog-ipc-main.js";
import {
  loadRuntimeHostSettings,
  registerRuntimeHostSettingsIpc,
  updateRuntimeHostSettings,
} from "./runtime-host-settings-ipc-main.js";
import { registerRuntimeHostSkillsIpc } from "./runtime-host-skills-ipc-main.js";
import { registerRuntimeHostUsageIpc } from "./runtime-host-usage-ipc-main.js";
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
import {
  projectDesktopUsageStats,
} from "../shared/desktop-session-projection.js";
import {
  parseDesktopSessionResourceKey,
  requireDesktopTargetScope,
  type DesktopTargetScope,
} from "../shared/runtime-host-identity.js";

await resolveShellEnv();

const buildInfo = resolveBuildInfo(app.isPackaged, app.getAppPath());
const userDataDir = app.getPath("userData");
const runtimeHostClientInstanceId = await loadOrCreateRuntimeHostClientInstanceId(
  join(userDataDir, "runtime-host-client.json"),
);
const runtimeHostStartup = await resolveDesktopRuntimeHostStartup(userDataDir);
let runtimeHostManager: RuntimeHostDesktopManager | undefined;
function activeRuntimeHostRef(): DesktopTargetScope | undefined {
  const current = runtimeHostManager?.current();
  return current?.hostId
    ? { hostId: current.hostId, targetEpoch: current.epoch }
    : undefined;
}
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
const resolveLocalStorageRoot = () =>
  e2eFixture
    ? resolveStorageRoot({ path: workspaceRoot, kind: "interactive" })
    : startupStep(
        "storage root",
        resolveDesktopStorageRoot(workspaceRoot, {
          confirmRepair: () => confirmDesktopStorageRootRepair(workspaceRoot),
        }),
      );
const startupLocalStorageRoot =
  await resolveLocalStorageRoot();
if (!startupLocalStorageRoot) {
  app.exit(0);
  await new Promise<never>(() => {});
  throw new Error("Desktop storage root resolution did not complete");
}
const localRuntimeHostId = startupLocalStorageRoot.rootId;
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
const runtimeHostSshTerminal = createDesktopRuntimeHostSshTerminal({
  ipcMain,
  send: (channel, event) => mainWindowController.send(channel, event),
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
const attachmentApprovals = createAttachmentApprovalRegistry();
const oauthPresentation = new RuntimeHostOAuthPresentation((url) => shell.openExternal(url));
const runtimeHostProfileService = createDesktopRuntimeHostProfileService({
  clientDataRoot: userDataDir,
  startup: runtimeHostStartup,
  states: () => runtimeHostManager?.entries() ?? [],
  enable: async (target) => {
    if (target.profile.kind !== "remote" || !target.credential) {
      throw new Error("A resolved remote Runtime Host profile is required");
    }
    if (!runtimeHostManager) throw new Error("Runtime Host manager is unavailable");
    await runtimeHostManager.enable({
      profile: target.profile,
      credential: target.credential,
      ...(target.profile.transport.kind === "ssh"
        ? { sshInteraction: "terminal" as const }
        : {}),
    });
  },
  disable: async (profileId) => {
    if (!runtimeHostManager) throw new Error("Runtime Host manager is unavailable");
    await runtimeHostManager.disable(profileId);
  },
  setDefault: (profileId) => {
    if (!runtimeHostManager) throw new Error("Runtime Host manager is unavailable");
    runtimeHostManager.setDefaultProfile(profileId);
  },
});
const defaultRuntimeHostRecovery = createRuntimeHostDefaultRecovery({
  defaultProfileId: () =>
    runtimeHostManager?.defaultProfileId() ??
    runtimeHostStartup.preferences.defaultProfileId,
  prompt: promptForDefaultRuntimeHostRecovery,
  retry: async (profileId) => {
    try {
      const snapshot = await runtimeHostProfileService.setEnabled(profileId, true);
      const entry = snapshot.entries.find((candidate) => candidate.profile.id === profileId);
      return entry?.readiness === "unavailable"
        ? new Error(entry.message ?? "Runtime Host is unavailable")
        : undefined;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  },
  useLocal: async () => {
    await runtimeHostProfileService.setDefault(LOCAL_RUNTIME_HOST_PROFILE.id);
  },
  onError: (error) =>
    console.error("[runtime-host] default Host recovery failed:", error),
});
interface DesktopRuntimeHostTargetContext {
  readonly client: DesktopRuntimeHostClient;
  readonly policy: DesktopRuntimeHostTargetPolicy;
  readonly scope: DesktopTargetScope;
  readonly projectCatalog: ReturnType<typeof createRuntimeHostProjectCatalog>;
  readonly projectManagement: ProjectManagementService;
  readonly isActive: () => boolean;
}

const runtimePolicyTargets = new WeakMap<
  DesktopRuntimeHostTargetPolicy,
  DesktopRuntimeHostTargetContext
>();
const runtimePolicyTargetsByEpoch = new Map<string, DesktopRuntimeHostTargetContext>();
const selectedDesktopWorkspaceTarget = async (
  target: DesktopRuntimeHostTargetPolicy,
): Promise<WorkspaceTarget | undefined> => {
  const currentTarget = requireRuntimePolicyTarget(target);
  const current = await currentTarget.projectManagement.current();
  if (typeof current.projectId === "string") {
    return { kind: "project", projectId: current.projectId };
  }
  if (target.kind === "remote") return undefined;
  return { kind: "host_path", path: current.path };
};
const currentDesktopWorkspaceTarget = async (
  target: DesktopRuntimeHostTargetPolicy,
): Promise<WorkspaceTarget> => {
  const workspace = await selectedDesktopWorkspaceTarget(target);
  if (!workspace) {
    throw new Error("Select a project from the remote Runtime Host first");
  }
  return workspace;
};
const mcpCapabilityPublisher = createCapabilityRevisionPublisher(() =>
  mcpManager.toolSnapshot().revision,
);
let settingsBotsIpc: SettingsBotsIpcHandle | undefined;
const botRegistry = new BotRegistry({
  onIncomingMessage: (message: BotIncomingMessage) => {
    void runtimeHostManager
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
  emitExternalChanged: () => {
    mainWindowController.send("settings:clientChanged");
    sendActiveRuntimeHostEvent("settings:externalChanged", { ts: Date.now() });
  },
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
    if (!runtimeHostManager) throw new Error("Runtime Host manager is unavailable");
    return runtimeHostManager.prepareForUpdate(input.allowInterruptActiveTasks);
  },
});
mcpManager.onChange(() => {
  sendActiveRuntimeHostEvent("mcp:changed", mcpManager.statuses());
  void mcpCapabilityPublisher.refreshIfChanged().catch((error) =>
    console.error("[runtime-host] MCP capability refresh failed:", error),
  );
});

registerPersistentClientIpc();
registerPetPackIpc({ ipcMain, workspaceRoot, mainWindowController, settingsStore });
const browserIpc = registerBrowserIpc({
  mainWindowController,
  isHostActive: (scope) => runtimeHostManager?.ownsScope(scope) === true,
});
registerNotificationsIpc({
  ipcMain,
  settingsStore,
  mainWindowController,
  e2e: isE2e,
});

const sessionCopyOwnerProcessId = randomUUID();
runtimeHostManager = await startRuntimeHostDesktopManager(
  {
    rootPath: workspaceRoot,
    clientInstanceId: runtimeHostClientInstanceId,
    generation: runtimeHostGeneration,
    candidateEntrypoint: new URL(
      import.meta.resolve("@maka/runtime-host/execution-candidate-main"),
    ),
    ...(isE2e ? { desktopE2e: true } : {}),
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
      additionalServices: (scope) => [
        {
          serviceId: SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_ID,
          version: SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_VERSION,
          async call(method, input) {
            if (method === "notify_local") {
              const taskId = requireScheduledTaskEffectString(input.taskId, "taskId");
              const title = requireScheduledTaskEffectString(input.title, "title");
              mainWindowController.send("scheduled-tasks:fired", scope, {
                id: taskId,
                title,
              });
              return { ok: true };
            }
            if (method === "notify_bot") {
              const platform = input.platform;
              if (!isBotDeliveryProvider(platform)) {
                throw new Error("ScheduledTask bot platform is invalid");
              }
              const chatId = requireScheduledTaskEffectString(input.chatId, "chatId");
              const title = requireScheduledTaskEffectString(input.title, "title");
              const body = typeof input.body === "string" ? input.body.trim() : "";
              const text = [`【定时任务】${title}`, ...(body ? ["", body] : [])].join("\n");
              const sent = await botRegistry.sendMessage(platform, chatId, text);
              if (!sent) throw new Error("ScheduledTask bot channel is unavailable");
              return { ok: true };
            }
            throw new Error(`Unknown ScheduledTask native effect: ${method}`);
          },
        },
      ],
      oauthPresentation,
      releaseComputerUseSession,
    },
    botRegistry,
    resolveBotCreateTarget: async (target) => ({
      workspace: await currentDesktopWorkspaceTarget(target),
    }),
    resolveSessionCreateProject: async (input, target) => {
      const currentTarget = requireRuntimePolicyTarget(target);
      return resolveDesktopSessionWorkspace(
        input,
        {
          ...currentTarget.projectManagement,
          ...(target.kind === "local"
            ? {
                defaultProjectId: async () =>
                  (await settingsStore.get()).projects.defaultProjectId,
              }
            : {}),
        },
        currentTarget.projectCatalog,
        { allowHostPath: target.kind === "local" },
      );
    },
    emitSessionsChanged,
    completeComputerUseTurn,
    createSessionCopyCleanup: ({ removeSession, resumeSessionCopy }) =>
      createSessionCopyCleanupAuthority({
        workspaceRoot,
        removeSession,
        resumeSessionCopy,
        processId: sessionCopyOwnerProcessId,
      }),
    renderer: mainWindowController,
    onError: (error) =>
      console.error("[runtime-host] projection refresh failed:", error),
    registerClientIpc: registerHostClientIpc,
    openSshTunnel: runtimeHostSshTerminal.openSshTunnel,
  },
  {
    upgradePrompts: runtimeHostUpgradePrompts,
    onTargetStateChanged: (state) => {
      const hostId = state.readiness === "ready"
        ? state.candidate.client.hostId
        : state.hostId;
      mainWindowController.send("runtime-host-profiles:changed", {
        epoch: state.epoch,
        profileId: state.target.profile.id,
        profileName: state.target.profile.name,
        profileKind: state.target.profile.kind,
        ...(hostId ? { hostId } : {}),
        readiness: state.readiness,
        isDefault:
          (runtimeHostManager?.defaultProfileId() ??
            runtimeHostStartup.preferences.defaultProfileId) === state.target.profile.id,
      });
      if (state.readiness === "unavailable" && state.hostId) {
        void browserIpc.retireTarget({
          hostId: state.hostId,
          targetEpoch: state.epoch,
        }).catch((error) =>
          console.error("[runtime-host] Browser target retirement failed:", error),
        );
      }
      if (state.readiness === "unavailable") {
        defaultRuntimeHostRecovery.offer({
          profileId: state.target.profile.id,
          profileName: state.target.profile.name,
          error: state.error,
        });
      }
      if (state.readiness === "ready") {
        const scope = { hostId: state.candidate.client.hostId, targetEpoch: state.epoch };
        mainWindowController.send("projects:changed", scope);
        emitConnectionListChanged(scope);
      }
    },
    onTargetRemoved: (state) => {
      const hostId = state.readiness === "ready"
        ? state.candidate.client.hostId
        : state.hostId;
      mainWindowController.send("runtime-host-profiles:changed", {
        epoch: state.epoch,
        profileId: state.target.profile.id,
        profileName: state.target.profile.name,
        profileKind: state.target.profile.kind,
        ...(hostId ? { hostId } : {}),
        readiness: "unavailable",
        isDefault:
          (runtimeHostManager?.defaultProfileId() ??
            runtimeHostStartup.preferences.defaultProfileId) === state.target.profile.id,
        removed: true,
      });
      const scope = hostId ? { hostId, targetEpoch: state.epoch } : undefined;
      if (scope) {
        void browserIpc.retireTarget(scope).catch((error) =>
          console.error("[runtime-host] Browser target retirement failed:", error),
        );
      }
    },
    onDefaultProfileChanged: (profileId) => {
      const state = runtimeHostManager?.entries().find(
        (candidate) => candidate.target.profile.id === profileId,
      );
      mainWindowController.send("runtime-host-profiles:changed", {
        epoch: state?.epoch ?? randomUUID(),
        profileId,
        profileName: state?.target.profile.name ?? profileId,
        profileKind: state?.target.profile.kind ?? "remote",
        ...(state?.readiness === "ready"
          ? { hostId: state.candidate.client.hostId }
          : state?.readiness !== "unavailable" && state && "hostId" in state && state.hostId
            ? { hostId: state.hostId }
            : {}),
        readiness: state?.readiness ?? "unavailable",
        isDefault: true,
      });
    },
    onFatalError: (error, target) => {
      if (error instanceof RuntimeHostUpgradeCancelledError) {
        if (target.profile.kind === "local") app.quit();
        return;
      }
      console.error("[runtime-host] fatal:", error);
      if (target.profile.kind === "local") app.quit();
    },
  },
).catch((error: unknown) => {
  if (error instanceof RuntimeHostUpgradeCancelledError) {
    app.exit(0);
    return new Promise<never>(() => undefined);
  }
  throw error;
});
wireLifecycle();
runtimeHostManager.setDefaultProfile(runtimeHostStartup.preferences.defaultProfileId);
const unavailableDefault = runtimeHostStartup.unavailable.get(
  runtimeHostStartup.preferences.defaultProfileId,
);
if (unavailableDefault) {
  void runtimeHostProfileService
    .getSnapshot()
    .then((snapshot) => {
      const entry = snapshot.entries.find((candidate) => candidate.isDefault);
      defaultRuntimeHostRecovery.offer({
        profileId: runtimeHostStartup.preferences.defaultProfileId,
        profileName:
          entry?.profile.name ?? runtimeHostStartup.preferences.defaultProfileId,
        error: unavailableDefault,
      });
    })
    .catch((error) =>
      console.error("[runtime-host] failed to resolve unavailable default Host:", error),
    );
}
// Startup may present one interactive SSH prompt without serializing every
// enabled Host behind it. Other SSH targets fail batch-mode and remain retryable.
for (const target of runtimeHostStartup.remotes) {
  if (target.profile.kind !== "remote" || !target.credential) continue;
  void runtimeHostManager
    .enable({
      profile: target.profile,
      credential: target.credential,
      ...(target.profile.transport.kind === "ssh" &&
      target.profile.id === runtimeHostStartup.preferences.defaultProfileId
        ? { sshInteraction: "terminal" as const }
        : {}),
    })
    .catch((error) =>
      console.error(`[runtime-host] ${target.profile.name} is unavailable:`, error),
    );
}

const stopComputerUseSession = (sessionId: string): void => {
  const ref = parseDesktopSessionResourceKey(sessionId);
  void runtimeHostManager
    ?.stopSession(ref)
    .catch((error) => console.error("[runtime-host] stop failed:", error));
};
native.computerUsePip.setStopHandler(stopComputerUseSession);
native.computerUseStatusItem.setStopHandler(stopComputerUseSession);

updateService.start();
void ensureMcpReady()
  .then(() => mcpCapabilityPublisher.refreshIfChanged())
  .catch((error) => console.error("[runtime-host] MCP startup failed:", error));

void clientSettingsEffects
  .refresh(false)
  .catch((error) =>
    console.error("[runtime-host] Client settings startup failed:", error),
  );

function registerHostClientIpc(
  client: DesktopRuntimeHostClient,
  scopedIpc: ReconnectableReadIpcMain,
  controls: DesktopRuntimeHostCandidateControls,
  target: DesktopRuntimeHostTargetPolicy,
  scope: DesktopTargetScope,
  isTargetActive: () => boolean,
): () => Promise<void> {
  const sendToRenderer = (channel: string, ...args: unknown[]): void => {
    if (isTargetActive()) mainWindowController.send(channel, scope, ...args);
  };
  const emitTargetConnectionListChanged = (): void => {
    if (isTargetActive()) emitConnectionListChanged(scope);
  };
  const emitTargetSessionsChanged = (
    reason: SessionChangedReason,
    sessionId?: string,
    extra?: Pick<SessionChangedEvent, "connectionSlug" | "modelId" | "turnId">,
  ): void => {
    if (isTargetActive()) emitSessionsChanged(scope, reason, sessionId, extra);
  };
  const targetProjectRoot = createProjectRootController({
    rootId: target.rootId,
    preferenceFile: join(workspaceRoot, "project-preferences.json"),
    fallbackRoots: () => [process.cwd(), app.getAppPath()],
  });
  const targetProjectCatalog = createRuntimeHostProjectCatalog(() => ({
    client,
    includeHostPaths: target.kind === "local",
  }));
  const targetProjectManagement = createProjectManagementService({
    catalog: targetProjectCatalog,
    directoryCatalog: targetProjectCatalog,
    chooseDirectory: async () => {
      const result = await mainWindowController.showOpenDialog({
        title: "Add project",
        properties: ["openDirectory"],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    selection: targetProjectRoot,
    capabilities: target.kind === "local"
      ? {
          chooseClientDirectory: true,
          chooseHostDirectory: false,
          selectNoProject: true,
          setLocalDefault: true,
          viewClientPath: true,
        }
      : {
          chooseClientDirectory: false,
          chooseHostDirectory: true,
          selectNoProject: false,
          setLocalDefault: false,
          viewClientPath: false,
        },
  });
  const targetContext = {
    client,
    policy: target,
    scope,
    projectCatalog: targetProjectCatalog,
    projectManagement: targetProjectManagement,
    isActive: isTargetActive,
  };
  runtimePolicyTargets.set(target, targetContext);
  runtimePolicyTargetsByEpoch.set(scope.targetEpoch, targetContext);
  const unsubscribeConfigurationChanges = client.subscribeConfigurationChanges(() => {
    emitTargetConnectionListChanged();
    sendToRenderer("settings:externalChanged", { ts: Date.now() });
  });
  const unsubscribeSessionCatalogChanges = client.subscribeSessionCatalogChanges(
    ({ sessionId }) => emitTargetSessionsChanged("updated", sessionId),
  );
  const unsubscribeProjectCatalogChanges = client.subscribeProjectCatalogChanges(() => {
    sendToRenderer("projects:changed");
  });
  const unsubscribeScheduledTaskChanges = client.subscribeScheduledTaskChanges((frame) => {
    if (!isTargetActive()) return;
    sendToRenderer("scheduled-tasks:changed", {
      type: "scheduled_tasks_changed",
      reason: frame.reason,
      taskId: frame.taskId,
      ts: Date.now(),
    });
    if (frame.reason !== "fired") return;
    void client
      .request('scheduled-task.query', { kind: 'get', taskId: frame.taskId })
      .then((result) => {
        const task = result.kind === 'task' ? result.task : null;
        if (!task) return;
        if (task.effect.kind !== "notify" || task.effect.channel === "bot") {
          sendToRenderer("scheduled-tasks:fired", task);
        }
      })
      .catch(() => undefined);
  });
  const capabilityBinding = mcpCapabilityPublisher.bind(
    controls.refreshClientCapabilities,
  );
  void capabilityBinding.aligned.catch((error) =>
    console.error("[runtime-host] MCP capability alignment failed:", error),
  );
  registerMcpIpcMain({
    ipcMain: scopedIpc,
    store: mcpConfigStore,
    manager: mcpManager,
    ensureReady: ensureMcpReady,
    publishCapabilities: mcpCapabilityPublisher.refreshIfChanged,
    onPublicationError: (error) =>
      console.error("[runtime-host] MCP capability publication failed:", error),
    emitChanged: (statuses) =>
      sendToRenderer("mcp:changed", statuses),
  });
  registerRuntimeHostConnectionsIpc({
    ipcMain: scopedIpc,
    client,
    emitConnectionListChanged: emitTargetConnectionListChanged,
  });
  registerRuntimeHostRendererIpc({ ipcMain: scopedIpc, client });
  registerRuntimeHostArtifactsIpc({
    ipcMain: scopedIpc,
    client,
    mainWindowController,
    sendToRenderer,
    showItemInFolder: (path) => shell.showItemInFolder(path),
  });
  registerRuntimeHostOAuthIpc({
    ipcMain: scopedIpc,
    client,
    presentation: oauthPresentation,
    emitConnectionListChanged: emitTargetConnectionListChanged,
  });
  registerRuntimeHostGitHubCopilotIpc({
    ipcMain: scopedIpc,
    client,
    emitConnectionListChanged: emitTargetConnectionListChanged,
  });
  registerRuntimeHostMemoryIpc({
    ipcMain: scopedIpc,
    client,
    workspaceRoot,
    openPath: (path) => shell.openPath(path),
    allowLocalPaths: target.kind === "local",
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
    emitConnectionsChanged: emitTargetConnectionListChanged,
  });
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
    getSelectedWorkspaceTarget: () => selectedDesktopWorkspaceTarget(target),
    resolveNewSessionWorkspaceTarget: async (projectId) => {
      if (typeof projectId === "string") {
        return { kind: "project", projectId };
      }
      if (projectId === null) {
        if (target.kind === "remote") return undefined;
        return {
          kind: "host_path",
          path: (await requireRuntimePolicyTarget(target).projectManagement.current()).path,
        };
      }
      return selectedDesktopWorkspaceTarget(target);
    },
    getDefaultPermissionMode: () =>
      resolveDefaultPermissionMode(() => loadRuntimeHostSettings(settingsIpcDeps)),
    openPath: (path) => shell.openPath(path),
    allowLocalPaths: target.kind === "local",
  });
  registerRuntimeHostSearchIpc({ ipcMain: scopedIpc, client });
  registerRuntimeHostUsageIpc({
    ipcMain: scopedIpc,
    client,
    sendToRenderer,
  });
  registerRuntimeHostWorkspaceIpc({
    ipcMain: scopedIpc,
    client,
    allowLocalWorkspace: target.kind === "local",
  });
  const resolveProjectRootForContext = (sessionId: unknown): Promise<string> =>
    resolveProjectContextRoot(sessionId, {
      currentProjectRoot: () => targetProjectRoot.current(),
      readSessionCwd: async (id) => {
        const session = await client.getSession(id);
        if (!session) throw new Error(`No such Session: ${id}`);
        return session.workspace.hostCwd;
      },
    });
  registerAppIpc(
    {
      projectRoot: targetProjectRoot,
      getSessionProjectRoot: (sessionId) =>
        resolveProjectRootForContext(sessionId),
      getProjectRoot: resolveProjectRootForContext,
      workspaceRoot,
      buildInfo,
      e2eFixture,
      projectManagement: targetProjectManagement,
      allowLocalProjectPaths: target.kind === "local",
    },
    scopedIpc,
  );
  registerWorkspaceSearchIpc({
    ipcMain: scopedIpc,
    getProjectRoot: async (sessionId, projectId) => {
      if (typeof projectId !== "string") {
        return resolveProjectRootForContext(sessionId);
      }
      const path = await targetProjectManagement.pathFor(projectId);
      if (!path) throw new Error(`Project is unavailable: ${projectId}`);
      return path;
    },
    allowLocalWorkspace: target.kind === "local",
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
    ...(target.kind === "remote"
      ? { inspectWorkspace: async () => "ready" as const }
      : {}),
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
    unsubscribeScheduledTaskChanges();
    runtimePolicyTargets.delete(target);
    if (runtimePolicyTargetsByEpoch.get(scope.targetEpoch) === targetContext) {
      runtimePolicyTargetsByEpoch.delete(scope.targetEpoch);
    }
    capabilityBinding.dispose();
    await capabilityBinding.aligned.catch(() => undefined);
  };
}

function requireScheduledTaskEffectString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`ScheduledTask native effect requires ${label}`);
  }
  return value.trim();
}

function registerPersistentClientIpc(): void {
  registerAppClientIpc({
    mainWindowController,
    e2eFixture,
    updateService,
  });
  registerMarkdownSaveIpc({ ipcMain, mainWindowController });
  registerDesktopRuntimeHostProfileIpc(ipcMain, runtimeHostProfileService);
  registerClientSettingsIpc({
    ipcMain,
    settingsStore,
    apply: async (settings) => {
      await clientSettingsEffects.apply(settings, true);
    },
  });
  settingsBotsIpc = registerSettingsBotsIpc({
    ipcMain,
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
  ipcMain.handle("settings:usageStats", async (_event, range?: UsageRange) =>
    projectDesktopUsageStats(
      { hostId: localRuntimeHostId },
      await settingsStore.usageStats(range),
    ),
  );
  ipcMain.handle("sessions:unobserve", async (_event, observerId: unknown) => {
    if (typeof observerId !== "string" || observerId.length === 0 || observerId.length > 256) {
      throw new Error("Invalid Session observer identity");
    }
    await runtimeHostManager?.unobserveSession(observerId);
  });
  ipcMain.handle('sessions:transcript:close', async (event, consumerId: unknown) => {
    if (typeof consumerId !== 'string' || consumerId.length === 0 || consumerId.length > 256) {
      throw new Error('Invalid transcript consumer identity');
    }
    await runtimeHostManager?.closeTranscript(consumerId, event.sender.id);
  });
  ipcMain.handle(
    'sessions:transcript:ack',
    (event, scope: unknown, consumerId: unknown, generation: unknown, deliverySequence: unknown) => {
      const target = requireDesktopTargetScope(scope);
      if (typeof consumerId !== 'string' || consumerId.length === 0 || consumerId.length > 256) {
        throw new Error('Invalid transcript consumer identity');
      }
      if (typeof generation !== 'string' || generation.length === 0 || generation.length > 256) {
        throw new Error('Invalid transcript generation');
      }
      if (!Number.isSafeInteger(deliverySequence) || Number(deliverySequence) < 0) {
        throw new Error('Invalid transcript delivery');
      }
      runtimeHostManager?.acknowledgeTranscript(
        target,
        consumerId,
        generation,
        Number(deliverySequence),
        event.sender.id,
      );
    },
  );
  ipcMain.handle("runtime-host:activeIdentity", () => {
    const current = runtimeHostManager?.current();
    if (!current?.hostId) {
      throw new Error("Desktop Runtime Host identity is unavailable");
    }
    return {
      hostId: current.hostId,
      targetEpoch: current.epoch,
      profileId: current.target.profile.id,
      profileName: current.target.profile.name,
      profileKind: current.target.profile.kind,
      readiness: current.readiness,
    };
  });
  ipcMain.handle("runtime-host:identities", () =>
    (runtimeHostManager?.entries() ?? []).flatMap((state) => {
      const hostId = state.readiness === "ready"
        ? state.candidate.client.hostId
        : state.readiness === "reconnecting"
          ? state.hostId
          : undefined;
      if (!hostId) return [];
      return [{
        hostId,
        targetEpoch: state.epoch,
        profileId: state.target.profile.id,
        profileName: state.target.profile.name,
        profileKind: state.target.profile.kind,
        readiness: state.readiness,
      }];
    }),
  );
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
    resolveRuntimeHost: resolveRuntimeHostDiagnostics,
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

function requireRuntimePolicyTarget(target: DesktopRuntimeHostTargetPolicy) {
  const current = runtimePolicyTargets.get(target);
  if (!current || !current.isActive()) {
    throw new Error("Runtime Host target generation is no longer active");
  }
  return current;
}

function resolveRuntimeHostDiagnostics(scope: DesktopTargetScope) {
  if (!runtimeHostManager?.ownsScope(scope)) {
    throw new Error("Desktop Runtime Host request belongs to a different target");
  }
  const current = runtimePolicyTargetsByEpoch.get(scope.targetEpoch);
  if (!current || !current.isActive()) return undefined;
  const client = current.client;
  return {
    getDiagnostics: () => client.queryHostDiagnostics(),
    getTurnTrace: async (sessionId: string, turnId: string) => {
      const result = await client.request('execution.inspect.query', {
        kind: "turn_trace",
        sessionId,
        turnId,
      });
      return result.kind === "turn_trace" ? result.turn : undefined;
    },
  };
}

function sendActiveRuntimeHostEvent(channel: string, ...args: unknown[]): void {
  const scope = activeRuntimeHostRef();
  if (scope) mainWindowController.send(channel, scope, ...args);
}

function emitConnectionListChanged(scope: DesktopTargetScope): void {
  const event: ConnectionEvent = {
    type: "connection_list_changed",
    id: randomUUID(),
    ts: Date.now(),
  };
  mainWindowController.send("connections:event", scope, event);
}

function emitSessionsChanged(
  scope: DesktopTargetScope,
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
  mainWindowController.send("sessions:changed", scope, event);
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
  updateService.dispose();
  settingsBotsIpc?.dispose();
  permissionOverlay.dismiss();
  const results = await Promise.allSettled([
    runtimeHostManager?.close(),
    runtimeHostSshTerminal.close(),
    botRegistry.stopAll(),
    mcpManager.close(),
    mainWindowController.disposeBrowserViews(),
    Promise.resolve().then(() => native.computerUseOverlay.destroyAll()),
    Promise.resolve().then(() => native.computerUsePip.destroyAll()),
    Promise.resolve().then(() => native.computerUseStatusItem.destroy()),
    Promise.resolve().then(() => native.computerUseScreenLock.dispose()),
    Promise.resolve().then(() => native.computerUse.backend?.dispose?.()),
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
      process.env.MAKA_E2E_FIXTURE_SCROLL_MOTION,
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

async function promptForDefaultRuntimeHostRecovery(input: {
  readonly profileName: string;
  readonly error: Error;
}): Promise<"retry" | "use_local" | "keep_offline"> {
  const isChinese =
    resolveSystemUiLocale(app.getPreferredSystemLanguages()) === "zh";
  const { response } = await whileAwaitingPerson(
    dialog.showMessageBox({
      type: "warning",
      title: isChinese
        ? "默认 Runtime Host 无法连接"
        : "Default Runtime Host is unavailable",
      message: isChinese
        ? `无法连接 ${input.profileName}`
        : `Could not connect to ${input.profileName}`,
      detail: isChinese
        ? `${input.error.message}\n\n你可以重试、改用 Local 作为默认 Host，或保持当前选择并稍后在设置中处理。`
        : `${input.error.message}\n\nRetry, use Local as the default Host, or keep the current selection and resolve it later in Settings.`,
      buttons: isChinese
        ? ["重试", "改用 Local", "保持离线"]
        : ["Retry", "Use Local", "Keep Offline"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    }),
  );
  return response === 0 ? "retry" : response === 1 ? "use_local" : "keep_offline";
}
