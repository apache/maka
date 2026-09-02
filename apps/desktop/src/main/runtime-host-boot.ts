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

import {
  app,
  type BrowserWindow,
  clipboard,
  ipcMain,
  nativeTheme,
  powerSaveBlocker,
  shell,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
} from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ConnectionEvent } from '@maka/core/connections';
import { type SessionChangedEvent, type SessionChangedReason } from '@maka/core/session';
import { isBotDeliveryProvider } from '@maka/core/bot-chat-settings';
import { resolveSystemUiLocale } from '@maka/core/ui-locale';
import {
  PROVIDER_REGISTRY,
  providerAuthRequiresSecret,
} from "@maka/core/llm-connections";
import { BotRegistry, type BotIncomingMessage } from '@maka/runtime/bots';
import {
  SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_ID,
  SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_VERSION,
} from '@maka/runtime/scheduled-task-tools';
import { buildMcpTools } from '@maka/runtime/mcp-tools';
import {
  createClientRuntimeHostCredentialStore,
  createClientRuntimeHostProfileCatalog,
  createRuntimeHostCandidateLaunchBarrier,
  createRuntimeHostPeerClientFromEnvironment,
  LOCAL_RUNTIME_HOST_PROFILE,
  loadOrCreateRuntimeHostClientInstanceId,
  listRuntimeHostWslDistributions,
  runtimeHostProfileAccess,
  type ResolvedRuntimeHostProfile,
} from "@maka/runtime-host/client";
import { openRuntimeHostPeerMeshOwner } from '@maka/runtime-host/peer-mesh';
import type { WorkspaceTarget } from "@maka/runtime-host/protocol";
import { runtimeHostProfileUsesHostWorkspace } from "@maka/runtime-host/profile-kind";
import { createCredentialMcpOAuthStorage, McpClientManager } from "@maka/mcp";
import { createWorkBoardStore } from "@maka/storage/work-board-store";
import { createFileCredentialStore } from "@maka/storage/credential-store";
import { createMcpConfigStore } from "@maka/storage/mcp-config-store";
import { createSettingsStore } from "@maka/storage/settings-store";
import { resolveStorageRoot } from "@maka/storage/root-authority";

import { createMcpOAuthController } from "./mcp-oauth-controller.js";
import { registerAppClientIpc, registerAppIpc } from "./app-ipc-main.js";
import { createAppQuitCoordinator } from "./app-quit-coordinator.js";
import {
  desktopUpdateChannelFromManifest,
  verifyDownloadedUpdateAttestation,
} from "./app-update-attestation.js";
import { createAppUpdateService } from "./app-update-service.js";
import { createAttachmentApprovalRegistry } from "./attachment-approval.js";
import { renderAttachmentPreview, resizeImageForAttachment } from "./attachment-resize-native.js";
import { registerAttachmentPreviewIpc } from "./attachment-preview.js";
import { readFileCapped, resolvePickedAttachments } from "./attachment-ingest.js";
import { registerBrowserIpc } from "./browser-ipc-main.js";
import { browserViewHost } from "./browser/browser-host.js";
import { releaseBrowserSession } from "./browser/session.js";
import {
  isBrowserMessageBoxPresentationActive,
  showBrowserMessageBox,
  type BrowserMessageBoxAppearance,
} from "./browser-message-box.js";
import { createE2eFixtureBotOnboardingAdapters } from "./bot-onboarding-e2e-fixture.js";
import { resolveBuildInfo } from "./build-info.js";
import { computerUseServiceHealth } from "./computer-use-host.js";
import { registerDesktopDiagnosticsIpc } from "./desktop-diagnostics-ipc-main.js";
import { assembleDesktopNativeCapabilities } from "./desktop-native-capability-assembly.js";
import { clientSettingsConfirmation } from "./client-settings-confirmation-copy.js";
import { createDesktopLocaleAuthority } from "./desktop-locale-authority.js";
import { buildRiveWorkflowTool } from "./rive-workflow-tool.js";
import { applyAppIcon } from "./app-icon-surface.js";
import { registerAppIconIpc } from "./app-icon-ipc.js";
import { listAppIconPreviews } from "./app-icon-surface.js";
import { importCustomAppIcon } from "./custom-app-icons.js";
import { installDesktopShellPresentation } from "./desktop-shell-presentation.js";
import {
  resolveE2eFixture,
  seedE2eFixture,
} from "./e2e-fixture.js";
import { createKeepSystemAwakeController } from "./keep-system-awake.js";
import { isDarkAppearance } from "./theme-source.js";
import {
  readWithFallback,
  type ReconnectableReadIpcMain,
} from "./ipc-reconnect-policy.js";
import { createMainWindowController } from "./main-window.js";
import type { DesktopRuntimeHostIdentity } from "../preload/bridge-contract.js";
import {
  captureDesktopDiagnosticEnvironment,
  copyDesktopDiagnosticReport,
  createDesktopMainRendererDiagnosticInput,
  createDesktopStartupDiagnosticInput,
  mainProcessLogBuffer,
  runtimeHostProcessLogBuffer,
  type DesktopDiagnosticsDeps,
} from "./main-process-diagnostics.js";
import {
  defaultRuntimeHostRecoveryDialog,
  showMainRendererProcessGoneDialog,
  showMessageBoxWithDiagnostics,
  showRuntimeHostStartupRecoveryDialog,
} from "./native-diagnostic-dialog.js";
import { getNativeDiagnosticDialogCopy } from "./native-diagnostic-dialog-copy.js";
import {
  resolveDesktopSessionWorkspace,
} from "./new-session-project.js";
import { createMcpExclusiveLane, registerMcpIpcMain } from "./mcp-ipc-main.js";
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
import { registerWorkBoardIpc } from "./work-board-ipc-main.js";
import {
  createPermissionOverlayMain,
  registerPermissionOverlayIpc,
} from "./permission-overlay/permission-overlay-main.js";
import { resolveProjectContextRoot } from "./project-context-root.js";
import { resolveDefaultPermissionMode } from "./permission-mode-default.js";
import { createProjectManagementService } from "./project-management-service.js";
import { projectPickerTitle } from "./project-picker-copy.js";
import type { ProjectManagementService } from "./project-management-service.js";
import {
  createProjectRootController,
  type ProjectRootController,
} from "./project-root-controller.js";
import { createSessionCopyCleanupAuthority } from "@maka/storage/session-copy-cleanup";
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
import {
  canRepairManagedRuntimeHostStartup,
  DesktopRuntimeHostStartupRecoveryCancelledError,
  startDesktopRuntimeHostWithRecovery,
} from "./runtime-host-startup-recovery.js";
import { buildRuntimeHostQuitFailureDialog } from "./runtime-host-quit-copy.js";
import { createRuntimeHostUpgradePrompts } from "./runtime-host-upgrade-dialog.js";
import { registerRuntimeHostMemoryIpc } from "./runtime-host-memory-ipc-main.js";
import {
  createDesktopRuntimeHostProfileService,
  registerDesktopRuntimeHostProfileIpc,
  resolveDesktopRuntimeHostStartup,
} from "./runtime-host-profile-service.js";
import {
  createDesktopGuestSessionMountService,
  createGuestSessionMountStore,
  registerDesktopGuestSessionMountIpc,
} from './runtime-host-guest-session-mounts.js';
import {
  createDesktopRuntimeHostSshTerminal,
} from "./runtime-host-ssh-terminal.js";
import {
  runDesktopRuntimeHostWslManagement,
  runDesktopRuntimeHostWslSetup,
} from './runtime-host-wsl-controller.js';
import {
  createRuntimeHostSetupPackageResolver,
} from "./runtime-host-setup-package.js";
import {
  configureDesktopRuntimeHostPeerClient,
  readDesktopRuntimeHostWebRtcStunPolicy,
  writeDesktopRuntimeHostWebRtcStunPolicy,
} from './runtime-host-peer-client.js';
import { createDesktopRuntimeHostLocalOperator } from './runtime-host-local-operator.js';
import { createDesktopLocalRuntimeHostRemoteAccess } from './runtime-host-local-remote-access.js';
import { createDesktopRuntimeHostOnboarding } from "./runtime-host-onboarding.js";
import { createDesktopRuntimeHostManagement } from "./runtime-host-management.js";
import { createDesktopRuntimeHostLocalManagement } from './runtime-host-local-management.js';
import { createDesktopRuntimeHostPeerMeshManagement } from './runtime-host-peer-mesh-management.js';
import { registerRuntimeHostOAuthIpc } from "./runtime-host-oauth-ipc-main.js";
import { RuntimeHostOAuthPresentation } from "./runtime-host-oauth-presentation.js";
import { registerRuntimeHostPermissionsIpc } from "./runtime-host-permissions-ipc-main.js";
import { registerRuntimeHostRendererIpc } from "./runtime-host-renderer-ipc-main.js";
import { registerRuntimeHostSearchIpc } from "./runtime-host-search-ipc-main.js";
import { createRuntimeHostProjectCatalog } from "./runtime-host-project-catalog.js";
import { createRuntimeHostDefaultRecovery } from "./runtime-host-default-recovery.js";
import { toDesktopHostSessionSummary } from "./runtime-host-session-catalog-ipc-main.js";
import {
  createRuntimeHostSettingsModule,
  registerRuntimeHostSettingsIpc,
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
import { startupStep } from "./startup-step.js";
import { registerWorkspaceSearchIpc } from "./workspace-search-ipc-main.js";
import {
  parseDesktopSessionResourceKey,
  requireDesktopTargetScope,
  type DesktopTargetScope,
} from "../shared/runtime-host-identity.js";

await resolveShellEnv();

const MANAGED_UPDATE_RECONNECT_TIMEOUT_MS = 10_000;
const buildInfo = resolveBuildInfo(app.isPackaged, app.getAppPath());
const userDataDir = app.getPath("userData");
const runtimeHostPeerConfiguration = await configureDesktopRuntimeHostPeerClient({
  isPackaged: app.isPackaged,
  enableDevelopmentPeer: process.argv.includes('--runtime-host-peer'),
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
  clientDataRoot: userDataDir,
});
let runtimeHostPeerOwner: Awaited<ReturnType<typeof openRuntimeHostPeerMeshOwner>> | undefined;
let runtimeHostPeerMesh: Awaited<ReturnType<typeof openRuntimeHostPeerMeshOwner>>['mesh'] | undefined;
let runtimeHostPeerClient:
  | ReturnType<typeof createRuntimeHostPeerClientFromEnvironment>
  | undefined;
if (runtimeHostPeerConfiguration) {
  try {
    runtimeHostPeerOwner = await openRuntimeHostPeerMeshOwner({
      ...runtimeHostPeerConfiguration,
      dataRoot: join(userDataDir, 'peer-mesh'),
      endpointKind: 'client',
      onBackgroundReconcileError: (error) => {
        console.error('[runtime-host] Peer Mesh background synchronization failed:', error);
      },
    });
    runtimeHostPeerClient = runtimeHostPeerOwner.client;
    runtimeHostPeerMesh = runtimeHostPeerOwner.mesh;
    void runtimeHostPeerOwner.closed.catch((error) => {
      runtimeHostPeerMesh = undefined;
      console.error('[runtime-host] Peer Mesh stopped; Direct peer remains available:', error);
    });
  } catch (error) {
    console.error('[runtime-host] Peer Mesh is unavailable; continuing with Direct peer:', error);
    runtimeHostPeerClient = createRuntimeHostPeerClientFromEnvironment(process.env, {
      automaticRelayDiscovery: runtimeHostPeerConfiguration.automaticRelayDiscovery,
      webRtcStunUrls: runtimeHostPeerConfiguration.webRtcStunUrls,
    });
  }
}
const runtimeHostDirectPeerAvailable = runtimeHostPeerClient !== undefined;
const runtimeHostClientInstanceId = await loadOrCreateRuntimeHostClientInstanceId(
  join(userDataDir, "runtime-host-client.json"),
);
const runtimeHostCandidateLaunchBarrier = createRuntimeHostCandidateLaunchBarrier();
const runtimeHostCredentialStore = createClientRuntimeHostCredentialStore(userDataDir);
const runtimeHostProfileCatalog = createClientRuntimeHostProfileCatalog(
  userDataDir,
  runtimeHostCredentialStore,
);
const runtimeHostStartup = await resolveDesktopRuntimeHostStartup(userDataDir, {
  catalog: runtimeHostProfileCatalog,
  credentialStore: runtimeHostCredentialStore,
});
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
const desktopDiagnostics: DesktopDiagnosticsDeps = {
  environment: () =>
    captureDesktopDiagnosticEnvironment({
      appVersion: app.getVersion(),
      buildMode: buildInfo.mode,
      buildCommit: buildInfo.commit,
      locale: app.getLocale(),
      workspacePath: workspaceRoot,
    }),
  mainLogs: () => mainProcessLogBuffer.snapshot(),
  runtimeHostProcessLogs: () => runtimeHostProcessLogBuffer.snapshot(),
  resolveActiveRuntimeHost: () => {
    const scope = activeRuntimeHostRef();
    return scope ? resolveRuntimeHostDiagnostics(scope) : undefined;
  },
  resolveRuntimeHost: resolveRuntimeHostDiagnostics,
  writeClipboard: (report) => clipboard.writeText(report),
};
let resolveBrowserDialogParent = (): BrowserWindow | undefined => undefined;
let resolveBrowserDialogAppearance = async (): Promise<BrowserMessageBoxAppearance> => ({
  locale: resolveSystemUiLocale(app.getPreferredSystemLanguages()),
  palette: "default",
});

async function showDesktopMessageBox(
  options: MessageBoxOptions,
  override?: Partial<BrowserMessageBoxAppearance>,
): Promise<MessageBoxReturnValue> {
  const appearance = { ...(await resolveBrowserDialogAppearance()), ...override };
  return showBrowserMessageBox(options, resolveBrowserDialogParent(), appearance);
}

function showStartupDiagnosticDialog(
  options: MessageBoxOptions,
  locale: ReturnType<typeof resolveSystemUiLocale>,
  diagnosticDetails = options.detail,
): Promise<MessageBoxReturnValue> {
  return showMessageBoxWithDiagnostics(options, {
    locale,
    showMessageBox: (nextOptions) => showDesktopMessageBox(nextOptions, { locale }),
    copyDiagnostics: () =>
      copyDesktopDiagnosticReport(
        desktopDiagnostics,
        createDesktopStartupDiagnosticInput({
          title: options.title || options.message,
          description: options.message,
          ...(diagnosticDetails ? { details: diagnosticDetails } : {}),
        }),
      ),
  });
}
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
  app.quit();
  await new Promise<never>(() => {});
  throw new Error("Desktop storage root resolution did not complete");
}
const settingsStore = createSettingsStore(workspaceRoot);
const desktopLocale = createDesktopLocaleAuthority({
  readSettings: () => settingsStore.get(),
  preferredSystemLanguages: () => app.getPreferredSystemLanguages(),
});
resolveBrowserDialogAppearance = async () => {
  try {
    const settings = await settingsStore.get();
    return {
      locale: desktopLocale.observe(settings),
      palette: settings.appearance.palette,
      dark: isDarkAppearance(
        e2eFixture?.theme ?? settings.appearance.theme,
        nativeTheme.shouldUseDarkColors,
      ),
    };
  } catch {
    return { locale: desktopLocale.current(), palette: "default" };
  }
};
const mcpConfigStore = createMcpConfigStore(workspaceRoot);
const workBoardStore = createWorkBoardStore(workspaceRoot);
const mcpManager = new McpClientManager({
  clientName: "maka-desktop",
  clientVersion: app.getVersion(),
  oauthStorage: createCredentialMcpOAuthStorage(
    createFileCredentialStore(workspaceRoot),
  ),
});
// One lane shared by config transactions and login claims: "no login is
// active" checked inside a transaction cannot be invalidated by a claim
// landing between the check and the write.
const mcpExclusiveLane = createMcpExclusiveLane();
const mcpOAuthController = createMcpOAuthController({
  manager: mcpManager,
  claimLane: mcpExclusiveLane,
  openExternal: (url) => shell.openExternal(url),
  ensureReady: () => ensureMcpReady(),
  callbackPort: async (serverId) => {
    const server = (await mcpConfigStore.get()).mcpServers[serverId];
    return server && "url" in server ? server.oauth?.callbackPort : undefined;
  },
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
  onRendererProcessGone: async (details) => {
    const diagnosticInput = createDesktopMainRendererDiagnosticInput({
      title: "Maka main Renderer process exited unexpectedly",
      description: `Reason: ${details.reason}`,
      details: `Exit code: ${details.exitCode}`,
    });
    for (;;) {
      const locale = await desktopLocale.resolve();
      const decision = await showMainRendererProcessGoneDialog({
        locale,
        copyDiagnostics: () =>
          copyDesktopDiagnosticReport(desktopDiagnostics, diagnosticInput),
        // showBrowserMessageBox attaches only to a visible, non-minimized
        // parent. A pre-first-paint crash therefore gets a standalone window.
        showMessageBox: (options) => showDesktopMessageBox(options, { locale }),
      });
      if (decision !== "recover") break;
      if (await mainWindowController.reloadMainRenderer()) return;
      if (!mainWindowController.browserWindow()) break;
    }
    app.quit();
  },
});
resolveBrowserDialogParent = () => mainWindowController.browserWindow();
const runtimeHostSshTerminal = createDesktopRuntimeHostSshTerminal({
  ipcMain,
  send: (channel, event) => mainWindowController.send(channel, event),
});
const runtimeHostSetupPackage = createRuntimeHostSetupPackageResolver({
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  environment: process.env,
});
const localRuntimeHostOperator = createDesktopRuntimeHostLocalOperator();
const localRuntimeHostRemoteAccess = createDesktopLocalRuntimeHostRemoteAccess({
  ipcMain,
  clientDataRoot: userDataDir,
  rootPath: startupLocalStorageRoot.canonicalPath,
  rootId: startupLocalStorageRoot.rootId,
  directPeerAvailable: runtimeHostDirectPeerAvailable,
  manager: () => runtimeHostManager,
  resolveSetupPackage: (signal) => runtimeHostSetupPackage.resolveForThisDesktop(signal),
  operator: localRuntimeHostOperator,
});
const native = assembleDesktopNativeCapabilities({
  isComputerUseRealModelE2e,
  locale: desktopLocale,
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
  resolveLocale: () => desktopLocale.resolve(),
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
  catalog: runtimeHostProfileCatalog,
  credentialStore: runtimeHostCredentialStore,
  states: () => runtimeHostManager?.entries() ?? [],
  enable: async (target, sshInteraction, onPeerEndpoint) => {
    if (target.profile.kind === 'local') {
      throw new Error('A resolved non-local Runtime Host profile is required');
    }
    if (target.profile.kind === 'remote' && !target.credential) {
      throw new Error('A remote Runtime Host profile requires an access credential');
    }
    if (!runtimeHostManager) throw new Error("Runtime Host manager is unavailable");
    await runtimeHostManager.enable(
      {
        profile: target.profile,
        ...(target.credential ? { credential: target.credential } : {}),
        ...(target.profile.kind === 'remote' && target.profile.transport.kind === "ssh"
          ? { sshInteraction }
          : {}),
      },
      onPeerEndpoint
        ? (status) => {
            if (status.peerEndpoint) onPeerEndpoint(status.peerEndpoint);
          }
        : undefined,
    );
  },
  disable: async (profileId) => {
    if (!runtimeHostManager) throw new Error("Runtime Host manager is unavailable");
    await runtimeHostManager.disable(profileId);
  },
  finalizePairing: async (profileId) => {
    if (!runtimeHostManager) throw new Error("Runtime Host manager is unavailable");
    await runtimeHostManager.finalizePairing(profileId);
  },
  setDefault: (profileId) => {
    if (!runtimeHostManager) throw new Error("Runtime Host manager is unavailable");
    runtimeHostManager.setDefaultProfile(profileId);
  },
});
const guestSessionMountService = createDesktopGuestSessionMountService({
  store: createGuestSessionMountStore(runtimeHostCredentialStore),
  mount: async (target, signal, onConnectionPhase, onPeerEndpoint) => {
    if (target.profile.kind !== 'remote' || !target.credential) {
      throw new Error('A shared Session requires a remote Guest target');
    }
    if (!runtimeHostManager) throw new Error('Runtime Host manager is unavailable');
    await runtimeHostManager.mountGuest(
      { profile: target.profile, credential: target.credential },
      signal,
      onConnectionPhase,
      (status) => {
        if (status.peerEndpoint) onPeerEndpoint?.(status.peerEndpoint);
      },
    );
  },
  finalizeAccess: async (mountId, signal, onAccessActivated) => {
    if (!runtimeHostManager) throw new Error('Runtime Host manager is unavailable');
    await runtimeHostManager.finalizeGuestAccess(mountId, signal, onAccessActivated);
  },
  unmount: async (mountId) => {
    if (!runtimeHostManager) return;
    await runtimeHostManager.unmountGuest(mountId);
  },
});
const runtimeHostOnboarding = createDesktopRuntimeHostOnboarding({
  ipcMain,
  clientInstanceId: runtimeHostClientInstanceId,
  profiles: runtimeHostProfileService,
  runSetup: runtimeHostSshTerminal.runSetup,
  runWslSetup: runDesktopRuntimeHostWslSetup,
  listWslDistributions: listRuntimeHostWslDistributions,
  setupPackageMode: runtimeHostSetupPackage.mode,
  resolveSshDevelopmentPeerTarget: runtimeHostSshTerminal.resolveDevelopmentPeerTarget,
  resolveSetupPackage: runtimeHostSetupPackage.resolve,
  send: (snapshot) =>
    mainWindowController.send("runtime-host-onboarding:changed", snapshot),
});
const localRuntimeHostManagement = createDesktopRuntimeHostLocalManagement({
  remoteAccess: localRuntimeHostRemoteAccess,
  operator: localRuntimeHostOperator,
  rootPath: startupLocalStorageRoot.canonicalPath,
  resolveUpdatePackage: () => runtimeHostSetupPackage.resolveForThisDesktop(),
  currentHostEpoch: () =>
    runtimeHostManager?.current('local')?.candidate?.client.hostEpoch,
  awaitUpdatedConnection: async (previousHostEpoch, replacementExpected) => {
    if (!runtimeHostManager) throw new Error('Runtime Host manager is unavailable');
    await runtimeHostManager.waitUntilReady(
      'local',
      replacementExpected ? previousHostEpoch : undefined,
      AbortSignal.timeout(MANAGED_UPDATE_RECONNECT_TIMEOUT_MS),
    );
  },
});
const runtimeHostManagement = createDesktopRuntimeHostManagement({
  ipcMain,
  profiles: runtimeHostProfileService,
  runServiceManagement: runtimeHostSshTerminal.runServiceManagement,
  runWslManagement: runDesktopRuntimeHostWslManagement,
  runPeerManagement: runtimeHostSshTerminal.runPeerManagement,
  directPeerClientAvailable: runtimeHostDirectPeerAvailable,
  runUpdate: runtimeHostSshTerminal.runUpdate,
  runUpdatePolicy: runtimeHostSshTerminal.runUpdatePolicy,
  runUpdateReconciliation: runtimeHostSshTerminal.runUpdateReconciliation,
  setupPackageMode: runtimeHostSetupPackage.mode,
  resolveSshDevelopmentPeerTarget: runtimeHostSshTerminal.resolveDevelopmentPeerTarget,
  resolveUpdatePackage: runtimeHostSetupPackage.resolve,
  currentHostEpoch: (profileId) =>
    runtimeHostManager?.current(profileId)?.candidate?.client.hostEpoch,
  awaitUpdatedConnection: async (
    profileId,
    expectedHostId,
    previousHostEpoch,
    replacementExpected,
  ) => {
    if (!runtimeHostManager) throw new Error('Runtime Host manager is unavailable');
    const manager = runtimeHostManager;
    const expectedPrevious = replacementExpected ? previousHostEpoch : undefined;
    const reconnectExactTarget = async () => {
      await runtimeHostProfileService.reconnect(profileId, expectedHostId);
      const current = manager.current(profileId);
      if (
        current?.hostId !== expectedHostId ||
        !current.candidate ||
        (expectedPrevious !== undefined && current.candidate.client.hostEpoch === expectedPrevious)
      ) {
        throw new Error('Desktop reconnected to an unexpected Runtime Host generation');
      }
    };
    if (replacementExpected && previousHostEpoch === undefined) {
      await reconnectExactTarget();
      return;
    }
    try {
      await manager.waitUntilReady(
        profileId,
        expectedPrevious,
        AbortSignal.timeout(MANAGED_UPDATE_RECONNECT_TIMEOUT_MS),
      );
      if (manager.current(profileId)?.hostId !== expectedHostId) {
        throw new Error('Runtime Host profile changed while its service was updating');
      }
    } catch {
      await reconnectExactTarget();
    }
  },
  sendProgress: (progress) =>
    mainWindowController.send("runtime-host-management:progress", progress),
  runAccessManagement: runtimeHostSshTerminal.runAccessManagement,
  cleanupManagedDeployment: runtimeHostSshTerminal.cleanupManagedDeployment,
  providers: [localRuntimeHostManagement],
});
const runtimeHostPeerMeshManagement = createDesktopRuntimeHostPeerMeshManagement({
  ipcMain,
  localMesh: () => runtimeHostPeerMesh,
  localHost: localRuntimeHostRemoteAccess,
  runLocal: localRuntimeHostOperator.runPeerMesh,
  liveHost: (profileId) => runtimeHostManager?.current(profileId)?.candidate?.client,
  profiles: runtimeHostProfileService,
  runRemote: runtimeHostSshTerminal.runPeerMeshManagement,
  readConnectivityPolicy: () => readDesktopRuntimeHostWebRtcStunPolicy(userDataDir),
  writeConnectivityPolicy: (policy) =>
    writeDesktopRuntimeHostWebRtcStunPolicy(userDataDir, policy),
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
  if (runtimeHostProfileUsesHostWorkspace(target.kind)) return undefined;
  return { kind: "host_path", path: current.path };
};
const currentDesktopWorkspaceTarget = async (
  target: DesktopRuntimeHostTargetPolicy,
): Promise<WorkspaceTarget> => {
  const workspace = await selectedDesktopWorkspaceTarget(target);
  if (!workspace) {
    throw new Error("Select a project from the Runtime Host first");
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
  applyAppIcon: async (icon) => {
    applyAppIcon(icon, (error) =>
      console.error("[icon] failed to apply the app icon:", error),
    );
  },
  systemPrefersDark: () => nativeTheme.shouldUseDarkColors,
  observeLocale: (settings) => desktopLocale.observe(settings),
  emitExternalChanged: () => {
    mainWindowController.send("settings:clientChanged");
    sendActiveRuntimeHostEvent("settings:externalChanged", { ts: Date.now() });
  },
});
// An OS appearance flip changes no setting, so nothing else would notice it.
// Only the icon depends on the answer, and `refresh` re-resolves it and
// no-ops when the resolved tile is the one already applied — which is the
// case for every user who has not set a separate dark icon.
nativeTheme.on("updated", () => {
  void clientSettingsEffects.refresh(false).catch((error) => {
    console.error("[icon] failed to re-apply the app icon after a theme change:", error);
  });
});

const clientSettingsTools = buildClientSettingsTools({
  read: () => settingsStore.get(),
  update: async (patch) => {
    const settings = await settingsStore.update(patch);
    await clientSettingsEffects.apply(settings, true);
    return settings;
  },
  confirm: async (changes) => {
    const locale = await desktopLocale.resolve();
    const copy = clientSettingsConfirmation(changes, locale);
    const result = await showDesktopMessageBox(
      {
        type: "question",
        message: copy.message,
        detail: copy.detail,
        buttons: copy.buttons,
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      },
      { locale },
    );
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
const updateTestFeed = process.env.MAKA_UPDATE_TEST_FEED;
const desktopUpdateChannel = app.isPackaged
  ? desktopUpdateChannelFromManifest(
      JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")),
    )
  : "release";
const updateService = createAppUpdateService({
  currentVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  updateChannel: desktopUpdateChannel,
  testFeedUrl: updateTestFeed,
  mockLatestVersion: process.env.MAKA_UPDATE_MOCK_VERSION,
  mockState: updateMockState,
  onStatusChange: (status) =>
    mainWindowController.send("app:updateStatusChanged", status),
  // The loopback-only upgrade harness owns synthetic bytes that cannot carry
  // a GitHub Actions identity, so it tests updater mechanics rather than
  // provenance. Ordinary packaged launches have no override and always reach
  // the Sigstore verifier below.
  verifyDownloadedUpdate: updateTestFeed
    ? async () => {}
    : ({ downloadedFile, version, files }) =>
        verifyDownloadedUpdateAttestation({
          channel: desktopUpdateChannel,
          downloadedFile,
          version,
          files,
          trustRootCacheDirectory: join(userDataDir, "update-trust", "sigstore"),
        }),
  prepareInstall: async (input) => {
    if (!runtimeHostManager) throw new Error("Runtime Host manager is unavailable");
    const retirement = await runtimeHostManager.retireOwnedLocalHost(
      input.allowInterruptActiveTasks ? "interrupt_active_work" : "refuse_active_work",
    );
    if (retirement.kind === "active_tasks") return retirement;
    return {
      kind: "prepared",
      rollback: retirement.kind === "retired" ? retirement.resume : () => {},
    };
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
const workBoardIpc = registerWorkBoardIpc({
  ipcMain,
  workspaceRoot,
  mainWindowController,
  store: workBoardStore,
});
const browserIpc = registerBrowserIpc({
  mainWindowController,
  isHostActive: (scope) => runtimeHostManager?.ownsScope(scope) === true,
});
registerNotificationsIpc({
  ipcMain,
  settingsStore,
  locale: desktopLocale,
  mainWindowController,
  e2e: isE2e,
});

const sessionCopyOwnerProcessId = randomUUID();
const startLocalRuntimeHostManager = () => startRuntimeHostDesktopManager(
  {
    rootPath: workspaceRoot,
    clientInstanceId: runtimeHostClientInstanceId,
    generation: runtimeHostGeneration,
    candidateLaunchBarrier: runtimeHostCandidateLaunchBarrier,
    ...(runtimeHostPeerClient ? { peerClient: runtimeHostPeerClient } : {}),
    // The Desktop E2E composition lives behind its own entry module, which
    // release packaging drops: picking it here is what keeps FakeBackend and
    // the E2E bootstrap out of the shipped Runtime Host.
    candidateEntrypoint: new URL(
      import.meta.resolve(
        isE2e
          ? "@maka/runtime-host/test-only/execution-candidate-e2e-main"
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
      resolveBrowserUrl: ({ sessionId, toolName, arguments: args }) => {
        if (toolName === "browser_navigate") {
          if (typeof args.url !== "string") {
            throw new Error("Browser navigation URL is unavailable");
          }
          return args.url;
        }
        const url = browserViewHost().currentUrl(sessionId);
        if (!url) throw new Error("Browser session has no current URL");
        return url;
      },
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
          ...(!runtimeHostProfileUsesHostWorkspace(target.kind)
            ? {
                defaultProjectId: async () =>
                  (await settingsStore.get()).projects.defaultProjectId,
              }
            : {}),
        },
        currentTarget.projectCatalog,
        { allowHostPath: !runtimeHostProfileUsesHostWorkspace(target.kind) },
      );
    },
    emitSessionsChanged,
    completeComputerUseTurn,
    enableE2eControls: isE2e,
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
    activateSshOperator: runtimeHostSshTerminal.activateSshOperator,
    resolveLocalCollaborationConnectionTarget: () =>
      localRuntimeHostRemoteAccess.createCollaborationConnectionTarget(),
    resolveProfileCollaborationConnectionTarget: (profile) =>
      runtimeHostProfileService.resolveCollaborationConnectionTarget(profile),
  },
  {
    upgradePrompts: createRuntimeHostUpgradePrompts(
      () => desktopLocale.resolve(),
      showStartupDiagnosticDialog,
    ),
    onTargetStateChanged: (state) => {
      const hostId = state.readiness === "ready"
        ? state.candidate.client.hostId
        : state.hostId;
      mainWindowController.send("runtime-host-profiles:changed", {
        epoch: state.epoch,
        profileId: state.target.profile.id,
        profileName: state.target.profile.name,
        profileKind: state.target.profile.kind,
        profileAccess: runtimeHostProfileAccess(state.target.profile),
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
      if (
        state.readiness === 'unavailable' &&
        state.target.profile.id === runtimeHostManager?.defaultProfileId()
      ) {
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
        profileAccess: runtimeHostProfileAccess(state.target.profile),
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
        profileAccess: state ? runtimeHostProfileAccess(state.target.profile) : "owner",
        ...(state?.readiness === "ready"
          ? { hostId: state.candidate.client.hostId }
          : state?.readiness !== "unavailable" && state && "hostId" in state && state.hostId
            ? { hostId: state.hostId }
            : {}),
        readiness: state?.readiness ?? "unavailable",
        isDefault: true,
      });
    },
    recoverLocalHost: (signal) => localRuntimeHostRemoteAccess.recoverBeforeLocalHostStart(signal),
    resolveLocalHostReplacement: (registration, signal) =>
      localRuntimeHostRemoteAccess.resolveConflictingHostReplacement(registration, signal),
    onFatalError: (error, target) => {
      if (
        !runtimeHostManager &&
        target.profile.kind === "local" &&
        canRepairManagedRuntimeHostStartup(error)
      ) return;
      if (error instanceof RuntimeHostUpgradeCancelledError) {
        if (target.profile.kind === "local") app.quit();
        return;
      }
      console.error("[runtime-host] fatal:", error);
      if (target.profile.kind === "local") app.quit();
    },
  },
);
runtimeHostManager = await startDesktopRuntimeHostWithRecovery({
  start: async () => {
    await localRuntimeHostRemoteAccess.recoverBeforeLocalHostStart();
    return startLocalRuntimeHostManager();
  },
  repair: async ({ allowManualUpdate, allowInterruptActiveTasks }) => {
    console.warn('[runtime-host] repairing the managed Local Host before startup');
    const result = await localRuntimeHostRemoteAccess.repairManagedStartup({
      allowManualUpdate,
      allowInterruptActiveTasks,
    });
    console.log(`[runtime-host] managed Local Host repair result: ${result.kind}`);
    return result;
  },
  prompt: async (input) => {
    console.error('[runtime-host] managed Local Host startup recovery requires attention:', {
      startupError: input.startupError,
      repairError: input.repairError,
      activeTasks: input.activeTasks,
    });
    const locale = await desktopLocale.resolve();
    return showRuntimeHostStartupRecoveryDialog(input, {
      locale,
      showMessageBox: (options) => showDesktopMessageBox(options, { locale }),
      copyDiagnostics: () =>
        copyDesktopDiagnosticReport(
          desktopDiagnostics,
          createDesktopStartupDiagnosticInput({
            title: 'Runtime Host startup recovery',
            description: input.startupError.message,
            details: [input.startupError.stack, input.repairError?.stack]
              .filter(Boolean)
              .join('\n\n'),
          }),
        ),
    });
  },
}).catch((error: unknown) => {
  if (
    error instanceof RuntimeHostUpgradeCancelledError ||
    error instanceof DesktopRuntimeHostStartupRecoveryCancelledError
  ) {
    app.quit();
    return new Promise<never>(() => undefined);
  }
  throw error;
});
wireLifecycle();
runtimeHostManager.setDefaultProfile(runtimeHostStartup.preferences.defaultProfileId);
await guestSessionMountService.start().catch((error: unknown) => {
  console.error('[runtime-host] shared Sessions could not be restored:', error);
});
await localRuntimeHostRemoteAccess.recover().catch((error: unknown) => {
  console.error('[runtime-host] interrupted Local Host setup could not be recovered:', error);
});
void runtimeHostProfileService.startEnabledProfiles();
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
// A login round persists its verifier and callback port; if the app
// restarted mid-round, rebind the listener so the browser's redirect still
// lands instead of hitting a dead port. Deliberately NOT chained behind the
// connect/publish sequence above: a slow server or a publish failure must
// not delay or block the rebind — it needs only the persisted state, and
// the controller awaits readiness itself before the token exchange.
void mcpConfigStore
  .get()
  .then((config) => {
    for (const serverId of Object.keys(config.mcpServers)) {
      void mcpOAuthController
        .resumeLogin(serverId)
        // No explicit mcp:changed here: a successful resume ends in
        // finishAuthorization → reconnect, whose onChange handler already
        // emits AND refreshes capabilities — a second identical emit here
        // was strictly weaker.
        .catch((error) =>
          console.error(
            `[runtime-host] MCP login resume failed for ${serverId}:`,
            error,
          ),
        );
    }
  })
  .catch((error) =>
    console.error("[runtime-host] MCP login resume scan failed:", error),
  );

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
  const usesHostWorkspace = runtimeHostProfileUsesHostWorkspace(target.kind);
  const sendToRenderer = (channel: string, ...args: unknown[]): void => {
    if (isTargetActive()) mainWindowController.send(channel, scope, ...args);
  };
  const emitTargetConnectionListChanged = (): void => {
    if (isTargetActive()) emitConnectionListChanged(scope);
  };
  const emitTargetSessionsChanged = (
    reason: SessionChangedReason,
    sessionId?: string,
    extra?: Pick<SessionChangedEvent, "modelId" | "turnId">,
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
    includeHostPaths: !usesHostWorkspace,
  }));
  const targetProjectManagement = createProjectManagementService({
    catalog: targetProjectCatalog,
    directoryCatalog: targetProjectCatalog,
    chooseDirectory: async () => {
      const result = await mainWindowController.showOpenDialog({
        title: projectPickerTitle(await desktopLocale.resolve()),
        properties: ["openDirectory"],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    selection: targetProjectRoot,
    capabilities: !usesHostWorkspace
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
  // No `settings:externalChanged` here: the user's settings did not move, the
  // Host just resolved the same connections against a newer model catalog.
  const unsubscribeConnectionCatalogChanges = client.subscribeConnectionCatalogChanges(() => {
    emitTargetConnectionListChanged();
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
    oauth: mcpOAuthController,
    exclusiveLane: mcpExclusiveLane,
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
    allowLocalPaths: !usesHostWorkspace,
  });
  const runtimeHostSettings = createRuntimeHostSettingsModule({
    client,
    settingsStore,
    applyClientSettings: async (settings) => {
      await clientSettingsEffects.apply(settings, true);
    },
  });
  registerRuntimeHostSettingsIpc({
    ipcMain: scopedIpc,
    module: runtimeHostSettings,
  });
  registerRuntimeHostConfigIpc({
    ipcMain: scopedIpc,
    client,
    mainWindowController,
    appVersion: app.getVersion(),
    settingsModule: runtimeHostSettings,
    emitConnectionsChanged: emitTargetConnectionListChanged,
  });
  registerRuntimeHostPermissionsIpc({
    ipcMain: scopedIpc,
    client,
    getSettings: () => runtimeHostSettings.get(),
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
        if (usesHostWorkspace) return undefined;
        return {
          kind: "host_path",
          path: (await requireRuntimePolicyTarget(target).projectManagement.current()).path,
        };
      }
      return selectedDesktopWorkspaceTarget(target);
    },
    getDefaultPermissionMode: () =>
      resolveDefaultPermissionMode(() => runtimeHostSettings.get()),
    openPath: (path) => shell.openPath(path),
    allowLocalPaths: !usesHostWorkspace,
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
    allowLocalWorkspace: !usesHostWorkspace,
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
      allowLocalProjectPaths: !usesHostWorkspace,
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
    allowLocalWorkspace: !usesHostWorkspace,
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
        const authKind = PROVIDER_REGISTRY[entry.providerType].authKind;
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
    ...(usesHostWorkspace
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
        const authKind = PROVIDER_REGISTRY[entry.providerType].authKind;
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
    unsubscribeConnectionCatalogChanges();
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
  registerAppIconIpc({
    ipcMain,
    showOpenDialog: (options) => mainWindowController.showOpenDialog(options),
    listPreviews: () => listAppIconPreviews(),
    importArtwork: (source) => importCustomAppIcon(source),
    userDataPath: () => app.getPath('userData'),
    settingsStore,
    applySettings: async (settings) => {
      await clientSettingsEffects.apply(settings, true);
    },
  });
  registerMarkdownSaveIpc({ ipcMain, mainWindowController });
  registerDesktopRuntimeHostProfileIpc(ipcMain, runtimeHostProfileService);
  registerDesktopGuestSessionMountIpc(
    ipcMain,
    guestSessionMountService,
    () => clipboard.readText(),
  );
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
  const projectRuntimeHostIdentity = (
    epoch: string,
    target: ResolvedRuntimeHostProfile,
    readiness: 'ready' | 'reconnecting',
    hostId: string,
  ): DesktopRuntimeHostIdentity => ({
    hostId,
    targetEpoch: epoch,
    profileId: target.profile.id,
    profileName: target.profile.name,
    profileKind: target.profile.kind,
    profileAccess: runtimeHostProfileAccess(target.profile),
    readiness,
  });
  ipcMain.handle("runtime-host:activeIdentity", () => {
    const current = runtimeHostManager?.current();
    if (!current?.hostId) {
      throw new Error("Desktop Runtime Host identity is unavailable");
    }
    return projectRuntimeHostIdentity(
      current.epoch,
      current.target,
      current.readiness,
      current.hostId,
    );
  });
  ipcMain.handle("runtime-host:identities", () =>
    (runtimeHostManager?.entries() ?? []).flatMap((state) => {
      if (state.readiness !== "ready" && state.readiness !== "reconnecting") return [];
      const hostId = state.readiness === "ready" ? state.candidate.client.hostId : state.hostId;
      if (!hostId) return [];
      return [
        projectRuntimeHostIdentity(state.epoch, state.target, state.readiness, hostId),
      ];
    }),
  );
  registerDesktopDiagnosticsIpc({ ipcMain, ...desktopDiagnostics });
  ipcMain.handle('directories:pick', async () => {
    const local = runtimeHostManager?.entries().find(
      (state) => state.target.profile.kind === 'local',
    );
    if (!local || local.readiness !== 'ready') throw new Error('Local Runtime Host is unavailable');
    const hostId = local.candidate.client.hostId;
    const result = await mainWindowController.showOpenDialog({
      title: 'Reference folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, reason: 'cancelled' };
    return { ok: true, reference: { hostId, path: result.filePaths[0] } };
  });
  ipcMain.handle("attachments:pickFiles", async (event) => {
    const result = await mainWindowController.showOpenDialog({
      title: "Add attachments",
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || !result.filePaths[0])
      return { ok: false, reason: "cancelled" };
    const { stat } = await import("node:fs/promises");
    // Route by content, not the extension: each picked path is staged under the
    // kind its sniffed MIME implies, so a real image named `report.pdf` previews
    // and triggers the vision notice, and a disguised file does neither.
    const chosen = await resolvePickedAttachments(result.filePaths, (path) => stat(path));
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
    getTurnTrace: async (sessionId: string, turnId: string, timeoutMs: number) => {
      const result = await client.request('execution.inspect.query', {
        kind: "turn_trace",
        sessionId,
        turnId,
      }, timeoutMs);
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
  extra?: Pick<SessionChangedEvent, "modelId" | "turnId">,
): void {
  const event: SessionChangedEvent = {
    reason,
    ts: Date.now(),
    ...(sessionId ? { sessionId } : {}),
    ...(extra?.modelId ? { modelId: extra.modelId } : {}),
    ...(extra?.turnId ? { turnId: extra.turnId } : {}),
  };
  mainWindowController.send("sessions:changed", scope, event);
}

function wireLifecycle(): void {
  const quitCoordinator = createAppQuitCoordinator({
    prepareToQuit: prepareRuntimeHostDesktopQuit,
    cleanup: closeRuntimeHostDesktop,
    focusOrCreateWindow: (signal) => {
      if (mainWindowController.hasOpenWindows()) mainWindowController.focus();
      else return mainWindowController.createWindow(signal);
    },
    onPreparationError: (error) => {
      console.error("[runtime-host] quit retirement failed:", error);
      void showRuntimeHostQuitFailure(error).catch((dialogError) =>
        console.error("[runtime-host] quit failure dialog failed:", dialogError),
      );
    },
    onCleanupError: (error) =>
      console.error("[runtime-host] shutdown failed:", error),
    onWindowCreationError: (error) =>
      console.error("[window] creation failed:", error),
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
    if (process.platform !== "darwin" && !isBrowserMessageBoxPresentationActive()) app.quit();
  });
  app.on("before-quit", quitCoordinator.handleBeforeQuit);
  quitCoordinator.focusOrCreateWindow();
}

async function prepareRuntimeHostDesktopQuit(): Promise<void> {
  mainWindowController.browserWindow()?.destroy();
  const retirement = await runtimeHostManager?.retireOwnedLocalHost(
    "interrupt_active_work",
  );
  if (retirement?.kind === "active_tasks") {
    throw new Error("Runtime Host refused authorized quit retirement");
  }
}

async function showRuntimeHostQuitFailure(error: unknown): Promise<void> {
  const locale = await desktopLocale.resolve();
  await showDesktopMessageBox(buildRuntimeHostQuitFailureDialog(error, locale), { locale });
}

async function closeRuntimeHostDesktop(): Promise<void> {
  clientSettingsWatcher.stop();
  updateService.dispose();
  settingsBotsIpc?.dispose();
  permissionOverlay.dismiss();
  const guestMountShutdown = Promise.resolve().then(() => guestSessionMountService.close());
  const runtimeHostManagerShutdown = guestMountShutdown
    .catch(() => undefined)
    .then(() => runtimeHostManager?.close());
  const runtimeHostPeerShutdown = runtimeHostManagerShutdown
    .catch(() => undefined)
    .then(() => runtimeHostPeerOwner?.close() ?? runtimeHostPeerClient?.close());
  const results = await Promise.allSettled([
    Promise.resolve().then(() => runtimeHostManagement.close()),
    Promise.resolve().then(() => runtimeHostPeerMeshManagement.close()),
    guestMountShutdown,
    runtimeHostManagerShutdown,
    runtimeHostPeerShutdown,
    runtimeHostOnboarding.close(),
    localRuntimeHostRemoteAccess.close(),
    runtimeHostSetupPackage.close(),
    Promise.resolve().then(() => workBoardIpc.close()),
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
  const locale = resolveSystemUiLocale(app.getPreferredSystemLanguages());
  const copy = getNativeDiagnosticDialogCopy(locale).storageRootRepair;
  const { response } = await showStartupDiagnosticDialog(
    {
      type: "warning",
      title: copy.title,
      message: copy.message,
      detail: copy.detail(workspaceRoot),
      buttons: [copy.repair, copy.exit],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    },
    locale,
  );
  return response === 0;
}

async function promptForDefaultRuntimeHostRecovery(input: {
  readonly profileName: string;
  readonly error: Error;
}): Promise<"retry" | "use_local" | "keep_offline"> {
  const locale = await desktopLocale.resolve();
  const dialogInput = defaultRuntimeHostRecoveryDialog({ ...input, locale });
  const { response } = await showStartupDiagnosticDialog(
    dialogInput.options,
    locale,
    dialogInput.diagnosticDetails,
  );
  return response === 0 ? "retry" : response === 1 ? "use_local" : "keep_offline";
}
