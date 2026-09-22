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

// The light startup slice: everything the main window needs — storage root,
// settings, locale, diagnostics, the window controller — and nothing else.
// runtime-host-boot imports this module first so the window loads while the
// heavy Runtime Host module graph is still evaluating.

import { join } from "node:path";
import {
  app,
  type BrowserWindow,
  clipboard,
  ipcMain,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  nativeTheme,
} from "electron";
import { resolveSystemUiLocale } from "@maka/core/ui-locale";
import { resolveStorageRoot } from "@maka/storage/root-authority";
import { createSettingsStore } from "@maka/storage/settings-store";
import { createAppQuitCoordinator } from "./app-quit-coordinator.js";
import { bootContext } from "./boot-context.js";
import { showBrowserMessageBox, type BrowserMessageBoxTheme } from "./browser-message-box.js";
import { resolveBuildInfo } from "./build-info.js";
import { createDesktopLocaleAuthority } from "./desktop-locale-authority.js";
import { resolveE2eFixture, seedE2eFixture } from "./e2e-fixture.js";
import {
  captureDesktopDiagnosticEnvironment,
  copyDesktopDiagnosticReport,
  createDesktopMainRendererDiagnosticInput,
  createDesktopStartupDiagnosticInput,
  mainProcessLogBuffer,
  runtimeHostProcessLogBuffer,
  type DesktopDiagnosticsDeps,
} from "./main-process-diagnostics.js";
import { createMainWindowController } from "./main-window.js";
import { getNativeDiagnosticDialogCopy } from "./native-diagnostic-dialog-copy.js";
import {
  showMainRendererProcessGoneDialog,
  showMessageBoxWithDiagnostics,
} from "./native-diagnostic-dialog.js";
import { resolveShellEnv } from "./shell-env.js";
import { revealMode } from "./startup-context.js";
import { resolveDesktopStorageRoot } from "./storage-root-startup.js";
import { startupStep } from "./startup-step.js";
import { isDarkAppearance } from "./theme-source.js";
import { desktopDiagnosticUpdateChannel } from "./app-update-attestation.js";

// The login-shell PATH probe spawns the user's interactive shell — a hundred
// milliseconds of .zshrc on a typical dev machine. Start it now but only
// await it where a child process is actually spawned; window creation and
// storage reads do not need it.
export const shellEnvReady = resolveShellEnv();
export const buildInfo = resolveBuildInfo(app.isPackaged, app.getAppPath());
export const userDataDir = app.getPath("userData");

export const e2eFixture = resolveDesktopE2eFixture();
export const workspaceRoot = join(
  userDataDir,
  "workspaces",
  e2eFixture?.workspaceName ?? "default",
);

// Delegates the Runtime Host boot assigns once its services exist; the window
// controller reads them lazily so the window never waits on that wiring.
export const mainWindowDelegates = {
  onMainWindowClose: (): void => {},
  onMainWindowClosed: (): void => {},
};

export const desktopDiagnostics: DesktopDiagnosticsDeps = {
  environment: () =>
    captureDesktopDiagnosticEnvironment({
      appVersion: app.getVersion(),
      buildMode: buildInfo.mode,
      updateChannel: desktopDiagnosticUpdateChannel({
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
      }),
      buildCommit: buildInfo.commit,
      locale: app.getLocale(),
      workspacePath: workspaceRoot,
    }),
  mainLogs: () => mainProcessLogBuffer.snapshot(),
  runtimeHostProcessLogs: () => runtimeHostProcessLogBuffer.snapshot(),
  runtimeHostConnections: () => bootContext.runtimeHostManager?.entries() ?? [],
  resolveActiveRuntimeHost: () => {
    const scope = bootContext.activeRuntimeHostRef?.();
    return scope ? bootContext.resolveRuntimeHostDiagnostics?.(scope) : undefined;
  },
  resolveRuntimeHost: (scope) => {
    const resolve = bootContext.resolveRuntimeHostDiagnostics;
    if (!resolve) throw new Error("Desktop Runtime Host diagnostics are unavailable");
    return resolve(scope);
  },
  writeClipboard: (report) => clipboard.writeText(report),
};

// The storage-root repair dialog can fire before settingsStore/desktopLocale
// exist, so both resolvers start at safe defaults and are rebound below once
// the settings-backed versions can actually run.
let resolveBrowserDialogParent = (): BrowserWindow | undefined => undefined;
let resolveBrowserDialogAppearance = async (): Promise<BrowserMessageBoxTheme> => ({
  locale: resolveSystemUiLocale(app.getPreferredSystemLanguages()),
  palette: "default",
});

export async function showDesktopMessageBox(
  options: MessageBoxOptions,
  override?: Partial<BrowserMessageBoxTheme>,
): Promise<MessageBoxReturnValue> {
  const appearance = {
    ...(await resolveBrowserDialogAppearance()),
    ...override,
    revealMode,
  };
  return showBrowserMessageBox(options, resolveBrowserDialogParent(), appearance);
}

export function showStartupDiagnosticDialog(
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
const resolvedLocalStorageRoot = await (e2eFixture
  ? resolveStorageRoot({ path: workspaceRoot, kind: "interactive" })
  : startupStep(
      "storage root",
      resolveDesktopStorageRoot(workspaceRoot, {
        confirmRepair: () => confirmDesktopStorageRootRepair(workspaceRoot),
      }),
    ));
if (!resolvedLocalStorageRoot) {
  app.quit();
  await new Promise<never>(() => {});
  throw new Error("Desktop storage root resolution did not complete");
}
export const startupLocalStorageRoot = resolvedLocalStorageRoot;
export const settingsStore = createSettingsStore(workspaceRoot);
export const desktopLocale = createDesktopLocaleAuthority({
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

// Resolves on the first window's painted frame — main.ts holds the heavy
// Runtime Host module graph until then so its evaluation cannot starve the
// window's prelude or first paint. The launch-settle promise is the fallback
// resolver so a wedged load never holds the Host boot hostage.
let resolveFirstWindowConstructed!: () => void;
export const firstWindowConstructed = new Promise<void>((resolve) => {
  resolveFirstWindowConstructed = resolve;
});

export const mainWindowController = createMainWindowController({
  workspaceRoot,
  e2eFixture,
  settingsStore,
  revealMode,
  onWindowConstructed: () => {
    // `ready-to-show` is the first painted frame — the point after which the
    // Runtime Host module graph may evaluate without starving the paint.
    mainWindowController
      .browserWindow()
      ?.once('ready-to-show', resolveFirstWindowConstructed);
  },
  onClose: () => mainWindowDelegates.onMainWindowClose(),
  onClosed: () => mainWindowDelegates.onMainWindowClosed(),
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
resolveBrowserDialogParent = () => {
  const main = mainWindowController.browserWindow();
  return main?.isVisible() ? main : undefined;
};

export const quitCoordinator = createAppQuitCoordinator({
  // Until the Runtime Host boot wires its quit hooks there is nothing to
  // retire — a quit in that gap proceeds straight to cleanup.
  prepareToQuit: () => bootContext.prepareToQuit?.() ?? Promise.resolve("ready" as const),
  cleanup: () => bootContext.cleanup?.() ?? Promise.resolve(),
  focusOrCreateWindow: (signal) => {
    if (mainWindowController.hasOpenWindows()) mainWindowController.focus();
    else return mainWindowController.createWindow(signal);
  },
  onPreparationError: (error) => {
    console.error("[runtime-host] quit retirement failed:", error);
  },
  onCleanupError: (error) =>
    console.error("[runtime-host] shutdown failed:", error),
  onWindowCreationError: (error) =>
    console.error("[window] creation failed:", error),
  resumeQuit: () => app.quit(),
});
app.on("before-quit", quitCoordinator.handleBeforeQuit);
// Renderer-ready is a window-lifecycle signal, not a Runtime Host scope: it
// must be handled before the scoped IPC router exists, or the first React
// commit could race ahead of target wiring and leave the window hidden.
ipcMain.handle("window:notifyRendererReady", (event): void => {
  mainWindowController.notifyRendererReady(event.sender, event.senderFrame);
});
// The renderer's invoke gate: it resolves when the Runtime Host boot module's
// registration pass has run, so a renderer call that lands while the heavy
// module graph is still evaluating waits instead of hitting "No handler
// registered". Rejects through `failIpcReady` if startup dies before then.
ipcMain.handle("app:bootstrapReady", () => bootContext.ipcReady);
// The window loads the renderer while the Runtime Host services assemble;
// `ready-to-show` reveals the loading surface on the first painted frame.
const firstWindowLaunch = quitCoordinator.focusOrCreateWindow();
void firstWindowLaunch.then(resolveFirstWindowConstructed, resolveFirstWindowConstructed);

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
