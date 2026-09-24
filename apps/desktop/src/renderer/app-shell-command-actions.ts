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

import { useMemo, useRef } from "react";
import type { LlmConnection } from '@maka/core/llm-connections';
import type { PermissionMode } from '@maka/core/permission';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import type { SettingsSection, ThemePreference } from '@maka/core/settings';
import type { UiLocale } from '@maka/core/ui-locale';
import type { NavSelection } from "@maka/ui";
import type { DesktopManualDiagnosticTarget } from '../preload/diagnostics-contract.js';
import {
  defaultRuntimeHostDiagnosticTarget,
  runOnDefaultRuntimeHost,
} from './default-runtime-host-operation.js';
import { buildCommandList } from "./command-palette-commands.js";
import type { Command } from './features/overlays/index.js';
import type { SessionCatalogController } from './application/contracts/session-catalog/session-catalog-state.js';
import { renderConversationMarkdown } from "./conversation-markdown.js";
import {
  commandPaletteActionErrorMessage,
  commandPaletteConnectionTestFailureMessage,
} from "./app-shell-copy.js";
import { getShellCopy } from "./locales/shell-copy.js";
import { memoryOpenFailureMessage } from "./locales/settings-memory-copy.js";
import { settingsTestResultMessage } from "./locales/settings-test-result-copy.js";

type ToastApi = {
  success(title: string, description?: string): void;
  info(title: string, description?: string): void;
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string } | { profileId: string },
  ): void;
};

type ComposerImportOwner = {
  sessionId: string | undefined;
  navSection: NavSelection["section"];
  newTaskDraftKey?: string;
};

type RefBox<T> = { current: T };

export interface AppShellCommandListOptions {
  uiLocale: UiLocale;
  activeId: string | undefined;
  activePermissionMode: PermissionMode | undefined;
  canSetPermissionMode: boolean;
  clientPathsAccessible: boolean;
  connections: LlmConnection[];
  defaultConnection: string | null;
  messages: StoredMessage[];
  newTaskProfileId: string | undefined;
  settingsOpen: boolean;
  settingsProfileId: string | undefined;
  sessionCatalog: SessionCatalogController;
  themePref: ThemePreference;
  /** Sessions the rail hides (mounted side-chat forks) — the palette skips them too. */
  hiddenSessionIds: ReadonlySet<string>;
  captureComposerImportOwner: () => ComposerImportOwner;
  createSession: () => void;
  openSideConversation: () => void;
  openHelp: () => void;
  openScheduledTaskCreate: () => void;
  openProjectFolder: () => Promise<void>;
  openSessionInChat: (sessionId: string) => void;
  openSettings: () => void;
  openSettingsSection: (section: SettingsSection) => void;
  openWorkspaceFolder: () => Promise<void>;
  refreshConnections: () => Promise<void>;
  copyTodayDailyReview: () => Promise<void>;
  pasteTodayDailyReview: () => Promise<void>;
  saveTodayDailyReview: () => Promise<void>;
  setNavSelection: (selection: NavSelection) => void;
  setPermissionMode: (mode: PermissionMode) => Promise<boolean>;
  setThemePref: (themePref: ThemePreference) => void;
  toastApi: ToastApi;
}

export function resolveManualDiagnosticTarget(
  owner: Pick<ComposerImportOwner, 'navSection' | 'sessionId'>,
  newTaskProfileId: string | undefined,
  settingsOpen = false,
  settingsProfileId?: string,
): DesktopManualDiagnosticTarget | undefined {
  if (settingsOpen) {
    return settingsProfileId
      ? { profileId: settingsProfileId }
      : undefined;
  }
  if (owner.navSection !== 'sessions') return undefined;
  if (owner.sessionId) return { sessionId: owner.sessionId };
  return newTaskProfileId
    ? { profileId: newTaskProfileId }
    : undefined;
}

export function buildAppShellCommandList(
  optionsRef: RefBox<AppShellCommandListOptions>,
): ReturnType<typeof buildCommandList> {
  // #1045: useAppShellCommands freezes this list per palette open/close
  // transition. List-SHAPING fields (which rows exist, labels, hints) come
  // from the build-time snapshot below; every value a command touches at RUN
  // time is dereferenced from the ref inside the callback, so the frozen list
  // still acts on current data (same stable-ref pattern as
  // openSessionInChatRef in app-shell.tsx).
  const options = optionsRef.current;
  const locale = options.uiLocale;
  const copy = getShellCopy(locale).commandActions;

  return buildCommandList({
    locale,
    activeSessionId: options.activeId,
    themePref: options.themePref,
    connections: options.connections,
    defaultSlug: options.defaultConnection,
    onNewChat: () => optionsRef.current.createSession(),
    onOpenSideChat: () => optionsRef.current.openSideConversation(),
    onStartScheduledTask: () => optionsRef.current.openScheduledTaskCreate(),
    onOpenSettings: () => optionsRef.current.openSettings(),
    onOpenSettingsSection: (section) =>
      optionsRef.current.openSettingsSection(section),
    // `openHelp` is the overlays owner's command (`overlays.commands.openHelp`),
    // handed in by the shell, rather than a synthetic KeyboardEvent: same
    // effect, clearer intent, and a typed `?` in a text input is never
    // swallowed by the global keydown listener.
    onOpenShortcuts: () => optionsRef.current.openHelp(),
    onSetTheme: (next) => optionsRef.current.setThemePref(next),
    onTestConnection: async (slug) => {
      const { connections, refreshConnections, toastApi } = optionsRef.current;
      try {
        const { value: result, diagnosticTarget } = await runOnDefaultRuntimeHost((host) =>
          window.maka.connections.test(slug, undefined, host),
        );
        const conn = connections.find((c) => c.slug === slug);
        const name = conn?.name ?? slug;
        if (result.ok) {
          toastApi.success(
            copy.connectionVerified(name),
            copy.connectionLatency(result.latencyMs ?? "?", result.modelTested),
          );
        } else {
          toastApi.error(
            copy.connectionTestFailed(name),
            commandPaletteConnectionTestFailureMessage(
              result,
              locale,
            ),
            undefined,
            diagnosticTarget,
          );
        }
        await refreshConnections();
      } catch (err) {
        toastApi.error(
          copy.testErrorTitle,
          commandPaletteActionErrorMessage(
            err,
            copy.connectionUnavailable,
            locale,
          ),
          undefined,
          defaultRuntimeHostDiagnosticTarget(err),
        );
      }
    },
    onSetDefaultConnection: async (slug) => {
      const { connections, refreshConnections, toastApi } = optionsRef.current;
      try {
        await runOnDefaultRuntimeHost((host) =>
          window.maka.connections.setDefault(slug, host),
        );
        await refreshConnections();
        const conn = connections.find((c) => c.slug === slug);
        toastApi.success(copy.setDefaultSuccess(conn?.name ?? slug));
      } catch (err) {
        toastApi.error(
          copy.setDefaultFailedTitle,
          commandPaletteActionErrorMessage(
            err,
            copy.setDefaultFallback,
            locale,
          ),
          undefined,
          defaultRuntimeHostDiagnosticTarget(err),
        );
      }
    },
    onOpenWorkspace: async () => {
      await optionsRef.current.openWorkspaceFolder();
    },
    ...(options.clientPathsAccessible
      ? {
          onOpenProjectFolder: () => optionsRef.current.openProjectFolder(),
        }
      : {}),
    onSelectModule: (selection) => {
      optionsRef.current.setNavSelection(selection);
    },
    onExportActiveConversation: async () => {
      const { activeId, messages, sessionCatalog, toastApi } = optionsRef.current;
      if (!activeId) return;
      const session = sessionCatalog.getState().sessions.find((s) => s.id === activeId);
      const markdown = renderConversationMarkdown(
        session?.name ?? copy.newConversation,
        messages,
        locale,
      );
      try {
        await navigator.clipboard.writeText(markdown);
        toastApi.success(
          copy.conversationCopiedTitle,
          copy.lineCount(markdown.split("\n").length),
        );
      } catch {
        toastApi.error(copy.copyFailedTitle, copy.clipboardUnavailable);
      }
    },
    onSaveActiveConversationToFile: async () => {
      const { activeId, messages, sessionCatalog, toastApi } = optionsRef.current;
      if (!activeId) return;
      const session = sessionCatalog.getState().sessions.find((s) => s.id === activeId);
      const sessionName = session?.name ?? copy.newConversation;
      const markdown = renderConversationMarkdown(
        sessionName,
        messages,
        locale,
      );
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      // Make the filename mostly portable: collapse whitespace
      // and quote chars that some file pickers don't like.
      const sanitizedSession = sessionName
        .replace(/[\s ]+/g, "-")
        .replace(/["<>:|?*]/g, "")
        .slice(0, 80);
      const defaultName = `maka-${sanitizedSession}-${yyyy}-${mm}-${dd}.md`;
      try {
        const result = await window.maka.sessions.saveConversationToFile({
          markdown,
          defaultName,
        });
        if (result.ok) {
          toastApi.success(
            copy.conversationSavedTitle,
            copy.saveSummary(markdown.split("\n").length, defaultName),
          );
        } else if (result.reason === "canceled") {
          // User dismissed the dialog — no toast.
        } else if (result.reason === "invalid_input") {
          toastApi.error(copy.saveFailedTitle, copy.invalidExport);
        } else {
          toastApi.error(copy.saveFailedTitle, copy.writeFailed);
        }
      } catch (err) {
        toastApi.error(
          copy.saveFailedTitle,
          commandPaletteActionErrorMessage(
            err,
            copy.exportFallback,
            locale,
          ),
        );
      }
    },
    onOpenLocalMemoryFile: async () => {
      const { toastApi } = optionsRef.current;
      try {
        const { value: result, diagnosticTarget } = await runOnDefaultRuntimeHost((host) =>
          window.maka.memory.openFile(host),
        );
        if (!result.ok) {
          toastApi.error(
            copy.memoryOpenFailedTitle,
            memoryOpenFailureMessage(result, locale),
            undefined,
            diagnosticTarget,
          );
        }
      } catch (err) {
        toastApi.error(
          copy.openFailedTitle,
          commandPaletteActionErrorMessage(
            err,
            copy.memoryOpenFallback,
            locale,
          ),
          undefined,
          defaultRuntimeHostDiagnosticTarget(err),
        );
      }
    },
    onSetPermissionMode: options.canSetPermissionMode
      ? async (mode) => {
          await optionsRef.current.setPermissionMode(mode);
        }
      : undefined,
    activePermissionMode: options.activePermissionMode,
    onCopyTodayDailyReview: () => optionsRef.current.copyTodayDailyReview(),
    onPasteTodayDailyReviewIntoComposer: () => optionsRef.current.pasteTodayDailyReview(),
    onSaveTodayDailyReviewToFile: () => optionsRef.current.saveTodayDailyReview(),
    onCopyDiagnostics: async () => {
      const {
        captureComposerImportOwner,
        newTaskProfileId,
        settingsOpen,
        settingsProfileId,
        toastApi,
      } = optionsRef.current;
      const owner = captureComposerImportOwner();
      const target = resolveManualDiagnosticTarget(
        owner,
        newTaskProfileId,
        settingsOpen,
        settingsProfileId,
      );
      try {
        await window.maka.diagnostics.copyReport({
          surface: "manual",
          ...(target ? { target } : {}),
        });
        toastApi.success(copy.diagnosticsCopiedTitle, copy.diagnosticsCopiedDescription);
      } catch (err) {
        toastApi.error(
          copy.copyFailedTitle,
          commandPaletteActionErrorMessage(
            err,
            copy.clipboardDenied,
            locale,
          ),
          undefined,
          target,
        );
      }
    },
    onTestNetworkProxy: async () => {
      const { toastApi } = optionsRef.current;
      try {
        // PR-CMD-PALETTE-NETWORK-PROXY-TEST-0: surface the
        // proxy test result via toast so a user debugging a
        // connection issue does not need to open Settings →
        // 网络. `testNetworkProxy(undefined)` uses the
        // current persisted proxy config.
        const { value: result, diagnosticTarget } = await runOnDefaultRuntimeHost((host) =>
          window.maka.settings.testNetworkProxy(undefined, host),
        );
        const message = settingsTestResultMessage(result, locale);
        if (result.ok) {
          const latency = result.latencyMs ? ` · ${result.latencyMs}ms` : "";
          toastApi.success(copy.networkPassedTitle, `${message}${latency}`);
        } else {
          toastApi.error(copy.networkFailedTitle, message, undefined, diagnosticTarget);
        }
      } catch (err) {
        toastApi.error(
          copy.genericTestFailedTitle,
          commandPaletteActionErrorMessage(
            err,
            copy.networkTestFallback,
            locale,
          ),
          undefined,
          defaultRuntimeHostDiagnosticTarget(err),
        );
      }
    },
  });
}

/**
 * #1045: the palette's command list keeps a stable identity while it is open.
 * app-shell rebuilds commandOptions on every render (streaming ticks
 * included), so the base commands are built once per open/close transition —
 * their run() closures dereference the latest options through the ref, so the
 * frozen list still acts on current data. Session rows are derived separately,
 * memoized on the visible session catalog + active session only: background
 * session creates/renames stay live while the palette is open, without
 * reintroducing per-tick rebuilds. The catalog subscription lives here — the
 * consumption point — so shell renders are not driven by palette-only reads.
 */
export function useAppShellCommands(
  paletteOpen: boolean,
  commandOptions: AppShellCommandListOptions,
): {
  commands: Command[];
  sessionCatalog: SessionCatalogController;
  hiddenSessionIds: ReadonlySet<string>;
  activeSessionId: string | undefined;
  onSelectSession: (id: string) => void;
} {
  const optionsRef = useRef(commandOptions);
  optionsRef.current = commandOptions;
  const { uiLocale } = commandOptions;
  const commands = useMemo(
    () => buildAppShellCommandList(optionsRef),
    [paletteOpen, uiLocale],
  );
  // Session rows subscribe the catalog inside the palette — the consumption
  // point — so shell renders are not driven by palette-only reads.
  return {
    commands,
    sessionCatalog: commandOptions.sessionCatalog,
    hiddenSessionIds: commandOptions.hiddenSessionIds,
    activeSessionId: commandOptions.activeId,
    onSelectSession: commandOptions.openSessionInChat,
  };
}
