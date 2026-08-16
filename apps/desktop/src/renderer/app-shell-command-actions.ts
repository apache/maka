import { useMemo, useRef } from "react";
import type { DailyReviewSummary } from '@maka/core/daily-review';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { PermissionMode } from '@maka/core/permission';
import type { SessionStartMode } from '@maka/core/explore-agent';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import type { SettingsSection, ThemePreference } from '@maka/core/settings';
import type { UiLocale } from '@maka/core/ui-locale';
import { formatDailyReviewMarkdown } from "@maka/ui";
import type { DailyReviewMarkdownActionInput, NavSelection } from "@maka/ui";
import {
  buildCommandList,
  buildSessionCommands,
} from "./command-palette-commands.js";
import type { Command } from "./command-palette-types.js";
import { renderConversationMarkdown } from "./conversation-markdown.js";
import { dailyReviewActionErrorMessage } from "./daily-review-actions.js";
import {
  commandPaletteActionErrorMessage,
  commandPaletteConnectionTestFailureMessage,
} from "./app-shell-copy.js";
import { getShellCopy } from "./locales/shell-copy.js";
import { settingsTestResultMessage } from "./locales/settings-test-result-copy.js";

type ToastApi = {
  success(title: string, description?: string): void;
  info(title: string, description?: string): void;
  error(title: string, description?: string): void;
};

type ComposerImportOwner = {
  sessionId: string | undefined;
  navSection: NavSelection["section"];
};

type RefBox<T> = { current: T };

type ComposerAppendHandle = {
  appendText(text: string): void;
};

type DailyReviewBridge = {
  fetchDay(offsetDays: number, daySpan?: number): Promise<DailyReviewSummary>;
};

export interface AppShellCommandListOptions {
  uiLocale: UiLocale;
  activeId: string | undefined;
  activePermissionMode: PermissionMode | undefined;
  canSetPermissionMode: boolean;
  clientPathsAccessible: boolean;
  connections: LlmConnection[];
  defaultConnection: string | null;
  dailyReviewBridge: DailyReviewBridge;
  messages: StoredMessage[];
  sessions: SessionSummary[];
  themePref: ThemePreference;
  visibleSessions: SessionSummary[];
  captureComposerImportOwner: () => ComposerImportOwner;
  composerRef: RefBox<ComposerAppendHandle | null>;
  createSession: () => void;
  openSideConversation: () => void;
  startModeSession: (mode: SessionStartMode) => Promise<boolean>;
  isComposerImportOwnerActive: (owner: ComposerImportOwner) => boolean;
  openHelp: () => void;
  openScheduledTaskForm: () => void;
  openProjectFolder: () => Promise<void>;
  openSessionInChat: (sessionId: string) => void;
  openSettings: () => void;
  openSettingsSection: (section: SettingsSection) => void;
  openSkillsFolder: () => Promise<void>;
  openWorkspaceFolder: () => Promise<void>;
  refreshConnections: () => Promise<void>;
  saveDailyReviewMarkdown: (
    input: DailyReviewMarkdownActionInput,
  ) => Promise<void>;
  setNavSelection: (selection: NavSelection) => void;
  setPermissionMode: (mode: PermissionMode) => Promise<void>;
  setThemePref: (themePref: ThemePreference) => void;
  toastApi: ToastApi;
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
  const copy = getShellCopy(options.uiLocale).commandActions;

  return buildCommandList({
    locale: options.uiLocale,
    activeSessionId: options.activeId,
    themePref: options.themePref,
    connections: options.connections,
    defaultSlug: options.defaultConnection,
    onNewChat: () => optionsRef.current.createSession(),
    onOpenSideChat: () => optionsRef.current.openSideConversation(),
    onStartDeepResearch: async () => {
      const { startModeSession } = optionsRef.current;
      await startModeSession("deep_research");
    },
    onStartScheduledTask: () => optionsRef.current.openScheduledTaskForm(),
    onOpenSettings: () => optionsRef.current.openSettings(),
    onOpenSettingsSection: (section) =>
      optionsRef.current.openSettingsSection(section),
    // PR-UX-POLISH-1 commit 4 (WAWQAQ `e0dbad11` + kenji `2844f64f`):
    // use the openHelp callback returned by useKeyboardHelp directly,
    // instead of dispatching a synthetic KeyboardEvent. Same effect,
    // clearer intent, and avoids the foot-gun where a typed `?` in a
    // text input would be swallowed by the global keydown listener.
    onOpenShortcuts: () => optionsRef.current.openHelp(),
    onSetTheme: (next) => optionsRef.current.setThemePref(next),
    onTestConnection: async (slug) => {
      const { connections, refreshConnections, toastApi } = optionsRef.current;
      try {
        const result = await window.maka.connections.test(slug);
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
              options.uiLocale,
            ),
          );
        }
        await refreshConnections();
      } catch (err) {
        toastApi.error(
          copy.testErrorTitle,
          commandPaletteActionErrorMessage(
            err,
            copy.connectionUnavailable,
            options.uiLocale,
          ),
        );
      }
    },
    onSetDefaultConnection: async (slug) => {
      const { connections, refreshConnections, toastApi } = optionsRef.current;
      try {
        await window.maka.connections.setDefault(slug);
        await refreshConnections();
        const conn = connections.find((c) => c.slug === slug);
        toastApi.success(copy.setDefaultSuccess(conn?.name ?? slug));
      } catch (err) {
        toastApi.error(
          copy.setDefaultFailedTitle,
          commandPaletteActionErrorMessage(
            err,
            copy.setDefaultFallback,
            options.uiLocale,
          ),
        );
      }
    },
    onOpenWorkspace: async () => {
      await optionsRef.current.openWorkspaceFolder();
    },
    ...(options.clientPathsAccessible
      ? {
          onOpenProjectFolder: () => optionsRef.current.openProjectFolder(),
          onOpenSkillsFolder: () => optionsRef.current.openSkillsFolder(),
        }
      : {}),
    onSelectModule: (selection) => {
      optionsRef.current.setNavSelection(selection);
    },
    onExportActiveConversation: async () => {
      const { activeId, messages, sessions, toastApi } = optionsRef.current;
      if (!activeId) return;
      const session = sessions.find((s) => s.id === activeId);
      const markdown = renderConversationMarkdown(
        session?.name ?? copy.newConversation,
        messages,
        options.uiLocale,
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
      const { activeId, messages, sessions, toastApi } = optionsRef.current;
      if (!activeId) return;
      const session = sessions.find((s) => s.id === activeId);
      const sessionName = session?.name ?? copy.newConversation;
      const markdown = renderConversationMarkdown(
        sessionName,
        messages,
        options.uiLocale,
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
            options.uiLocale,
          ),
        );
      }
    },
    onOpenLocalMemoryFile: async () => {
      const { toastApi } = optionsRef.current;
      try {
        const result = await window.maka.memory.openFile();
        if (!result.ok) {
          toastApi.error(copy.memoryOpenFailedTitle, result.message);
        }
      } catch (err) {
        toastApi.error(
          copy.openFailedTitle,
          commandPaletteActionErrorMessage(
            err,
            copy.memoryOpenFallback,
            options.uiLocale,
          ),
        );
      }
    },
    onSetPermissionMode: options.canSetPermissionMode
      ? (mode) => optionsRef.current.setPermissionMode(mode)
      : undefined,
    activePermissionMode: options.activePermissionMode,
    onCopyTodayDailyReview: async () => {
      const { dailyReviewBridge, toastApi } = optionsRef.current;
      try {
        const summary = await dailyReviewBridge.fetchDay(0, 1);
        const markdown = formatDailyReviewMarkdown(
          summary,
          copy.today,
          options.uiLocale,
        );
        await navigator.clipboard.writeText(markdown);
        toastApi.success(
          copy.reviewCopiedTitle,
          copy.reviewSummary(
            summary.totals.sessionCount,
            summary.totals.requestCount,
          ),
        );
      } catch (err) {
        toastApi.error(
          copy.copyFailedTitle,
          dailyReviewActionErrorMessage(
            err,
            copy.reviewCopyFallback,
            options.uiLocale,
          ),
        );
      }
    },
    onPasteTodayDailyReviewIntoComposer: async () => {
      const {
        captureComposerImportOwner,
        composerRef,
        dailyReviewBridge,
        isComposerImportOwnerActive,
        toastApi,
      } = optionsRef.current;
      const owner = captureComposerImportOwner();
      if (!owner.sessionId) return;
      try {
        const summary = await dailyReviewBridge.fetchDay(0, 1);
        const markdown = formatDailyReviewMarkdown(
          summary,
          copy.today,
          options.uiLocale,
        );
        if (!isComposerImportOwnerActive(owner)) return;
        composerRef.current?.appendText(markdown);
        toastApi.success(
          copy.reviewPastedTitle,
          copy.reviewSummary(
            summary.totals.sessionCount,
            summary.totals.requestCount,
          ),
        );
      } catch (err) {
        if (isComposerImportOwnerActive(owner)) {
          toastApi.error(
            copy.pasteFailedTitle,
            dailyReviewActionErrorMessage(
              err,
              copy.reviewUnavailable,
              options.uiLocale,
            ),
          );
        }
      }
    },
    onSaveTodayDailyReviewToFile: async () => {
      const { dailyReviewBridge, saveDailyReviewMarkdown, toastApi } =
        optionsRef.current;
      try {
        const summary = await dailyReviewBridge.fetchDay(0, 1);
        const markdown = formatDailyReviewMarkdown(
          summary,
          copy.today,
          options.uiLocale,
        );
        await saveDailyReviewMarkdown({
          day: summary.day,
          range: 1,
          totals: summary.totals,
          markdown,
          label: copy.today,
        });
      } catch (err) {
        toastApi.error(
          copy.saveFailedTitle,
          dailyReviewActionErrorMessage(
            err,
            copy.reviewUnavailable,
            options.uiLocale,
          ),
        );
      }
    },
    onCopyEnvSummary: async () => {
      const { toastApi } = optionsRef.current;
      try {
        const info = await window.maka.app.info();
        const platformPretty =
          info.platform === "darwin"
            ? "macOS"
            : info.platform === "win32"
              ? "Windows"
              : info.platform === "linux"
                ? "Linux"
                : info.platform;
        const buildLine =
          info.buildMode === "dev"
            ? `- Build: dev${info.buildCommit ? ` @ ${info.buildCommit}` : ""}`
            : "- Build: packaged";
        const summary = [
          `**Maka** v${info.appVersion}`,
          ``,
          `- Electron: ${info.electronVersion}`,
          `- Node: ${info.nodeVersion}`,
          `- Chrome: ${info.chromeVersion}`,
          `- Platform: ${platformPretty} ${info.osRelease}`,
          `- Arch: ${info.arch}`,
          buildLine,
        ].join("\n");
        await navigator.clipboard.writeText(summary);
        toastApi.success(
          copy.environmentCopiedTitle,
          `Maka v${info.appVersion} · ${platformPretty} · ${info.arch}`,
        );
      } catch (err) {
        toastApi.error(
          copy.copyFailedTitle,
          commandPaletteActionErrorMessage(
            err,
            copy.clipboardDenied,
            options.uiLocale,
          ),
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
        const result = await window.maka.settings.testNetworkProxy(undefined);
        const message = settingsTestResultMessage(result, options.uiLocale);
        if (result.ok) {
          const latency = result.latencyMs ? ` · ${result.latencyMs}ms` : "";
          toastApi.success(copy.networkPassedTitle, `${message}${latency}`);
        } else {
          toastApi.error(copy.networkFailedTitle, message);
        }
      } catch (err) {
        toastApi.error(
          copy.genericTestFailedTitle,
          commandPaletteActionErrorMessage(
            err,
            copy.networkTestFallback,
            options.uiLocale,
          ),
        );
      }
    },
  });
}

export function buildAppShellSessionCommands(
  optionsRef: RefBox<AppShellCommandListOptions>,
): ReturnType<typeof buildSessionCommands> {
  const options = optionsRef.current;
  return buildSessionCommands({
    locale: options.uiLocale,
    sessions: options.visibleSessions,
    activeSessionId: options.activeId,
    onSelectSession: (sessionId) => {
      optionsRef.current.openSessionInChat(sessionId);
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
 * reintroducing per-tick rebuilds (visibleSessions is itself memoized in
 * app-shell, so rows rebuild only on real catalog changes).
 */
export function useAppShellCommands(
  paletteOpen: boolean,
  commandOptions: AppShellCommandListOptions,
): Command[] {
  const optionsRef = useRef(commandOptions);
  optionsRef.current = commandOptions;
  const { activeId, uiLocale, visibleSessions } = commandOptions;
  const baseCommands = useMemo(
    () => buildAppShellCommandList(optionsRef),
    [paletteOpen, uiLocale],
  );
  const sessionCommands = useMemo(
    () => buildAppShellSessionCommands(optionsRef),
    [paletteOpen, visibleSessions, activeId, uiLocale],
  );
  return useMemo(
    () => [...baseCommands, ...sessionCommands],
    [baseCommands, sessionCommands],
  );
}
