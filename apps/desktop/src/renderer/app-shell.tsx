import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { ScheduledTask } from '@maka/core/scheduled-task';
import type { ProjectRecord } from '@maka/core/project';
import type { QuoteRef } from '@maka/core/events';
import type { SessionSummary } from '@maka/core/session';
import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import type { SlashCommandIdForSurface } from '@maka/core/slash-command-catalog';
import type { UiLocale, UiLocalePreference } from '@maka/core/ui-locale';
import { collapseSessionRevisions } from '@maka/core/session-revisions';
import { isLinkedSubagentSession } from '@maka/core/session';
import { resolveUiLocale } from '@maka/core/ui-locale';
import { slashCommandsForSurface } from '@maka/core/slash-command-catalog';
import { hasSettledInitialOnboarding } from '@maka/core/onboarding-milestone';
import {
  ScheduledTasksPage,
  DailyReviewPage,
  ChatSurfaceLayout,
  type ComposerHandle,
  type ComposerSendMetadata,
  type ComposerSlashCommandOption,
  type MakaUriDest,
  MakaUriContext,
  AstryxLocaleProvider,
  LocaleProvider,
  ModuleHubSelector,
  ToastProvider,
  type ToastErrorAction,
  type NavSelection,
  SessionListPanel,
  type SessionHistoryGroup,
  SkillsPage,
  type SessionViewMode,
  TitlebarSessionIdentity,
  type TurnFooterActionMeta,
  type WorkspacePickerModel,
  useToast,
  activeInteractionFor,
  deriveTitlebarProjectName,
  enqueueInteraction,
  getConversationCopy,
  getSharedUiCopy,
  reconcileInteractions,
} from '@maka/ui';
import type { ConnectionEvent } from '@maka/core/connections';
import { GitBranch, MessageCircleQuestion, Minimize2, Network } from '@maka/ui/icons';
import { useKeyboardHelp } from './keyboard-help';
import { useCommandPalette } from './command-palette';
import { ChatMessageSurface } from './chat-message-surface';
import { useTaskSubmissionReadiness } from './use-task-submission-readiness';
import {
  deriveTaskReadinessNotice,
  isTaskSubmissionHardBlocked,
  resolveTaskReadinessModelTarget,
} from './task-readiness-notice';
import { deriveWorkspaceReadinessRecovery } from './workspace-readiness-recovery';
import { LiveTurnReconciler } from './live-turn-reconciler';
import { useAppShellSessionUiReads } from './use-app-shell-session-ui-reads';
import { AgentGraphPanel } from './agent-graph-panel';
import { ChatComposerRegion } from './chat-composer-region';
import { ChatWorkbar } from './chat-workbar';
import type {
  SessionWorkbarPlacement,
  SessionWorkbarTab,
  SessionWorkbarTabKind,
} from './session-workbar-tabs';
import {
  findPreferredSideChatWorkbarTab,
  terminalRefFromWorkbarTab,
  terminalSessionWorkbarTabId,
} from './session-workbar-tabs';
import {
  consumeCompanionInitialPrompt,
  consumeCompanionQuoteSnapshot,
  openCompanionPanel,
  removeStagedCompanionQuote,
  stageCompanionQuote,
} from './quote-companion-panel-state';
import { UNRESOLVED_NEW_TASK_DRAFT_KEY } from './new-task-reload-intent';
import { useNewTaskChoice } from './use-new-task-choice';
import { sideChatTitleFromPrompt } from './side-chat-command';
import { parseDesktopSlashCommand } from './desktop-slash-command';
import {
  applyCompanionForkVisibilityEvent,
  reconcileCompanionForkVisibility,
} from './quote-companion-visibility';
import {
  PlanExecutionPanel,
  PlanProposalCard,
  usePlanModeState,
} from './plan-mode-panel';
import { McpPage } from './mcp-page';
import { getOnboardingActivationCandidate, useOnboardingSnapshot } from './use-onboarding-snapshot';
import type {
  AppUpdateStatus,
  DesktopSessionSummary,
  OnboardingSnapshot,
} from '../preload/bridge-contract.js';
import { DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES } from '../preload/transcript-contract.js';
import {
  isAppUpdateInstallFailure,
  requestDownloadedAppUpdate,
} from './app-update-install';
import { ProviderLogo } from './settings/provider-display';
import { ProviderBrandMark } from './settings/provider-brand-marks';
import { RuntimeHostSshTerminalDialog } from './settings/runtime-host-ssh-terminal-dialog.js';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy';
import { getDesktopConversationCopy } from './locales/conversation-copy';
import {
  SideChatCloseConfirmation,
  SKIP_SIDE_CHAT_CLOSE_CONFIRMATION_KEY,
} from './side-chat-close-confirmation';
import { safeLocalStorageGet, safeLocalStorageSet } from './browser-storage';
import { ErrorBoundary } from './error-boundary';
import { useShellAppearance } from './use-shell-appearance';
import { useShellSearch } from './use-shell-search';
import { useSessionGoal } from './use-session-goal';
import { deriveStaleSessionIds } from './stale-sessions';
import { deriveProjectGroups, deriveWorktreeSessionIds } from './session-project-grouping';
import { deriveSessionRail } from './session-rail';
import { useAppShellTurnPresentation } from './app-shell-turn-view-model';
import { readScrollMotionBehavior } from './scroll-motion-policy';
import { deriveBranchBanner } from './branch-banner';
import { readNavigationState, selectNavigation } from './nav-selection';
import { sessionMatchesRail } from './session-nav-filter';
import { deriveSessionRevisionNavigation } from './session-revisions';
import { deriveDesktopExecutionBoundarySurface } from './desktop-execution-boundary-surface';
import { useActiveExecutionBoundary } from './use-active-execution-boundary';
import {
  SESSION_LIST_EXPANDED_MAX_WIDTH,
  SESSION_LIST_EXPANDED_MIN_WIDTH,
  readSessionListViewMode,
} from './session-list-layout';
import { modelSetupToastCopy } from './model-connection-errors';
import type { AppShellCommandListOptions } from './app-shell-command-actions';
import { AppShellTopbarActions, AppShellWorkspaceTopActions } from './app-shell-chrome-actions';
import { updateReminderFromStatus } from './app-shell-app-update';
import { AppShellDetailPanel } from './app-shell-detail-panel';
import { AppShellOverlays } from './app-shell-overlays';
import type { ArchivedTasksBridge } from './settings/tasks-settings-page';
import { CustomPetCompanion } from './custom-pet-companion';
import { derivePetActivityState } from './custom-pet-companion-model';
import { createAppShellDailyReviewBridge } from './app-shell-daily-review-bridge';
import { useAppShellModuleData } from './use-module-data';
import { useKeepSystemAwake } from './use-keep-system-awake';
import { useAppShellProjectContext } from './use-project-context';
import {
  createAppShellSessionDisplayBatch,
  createAppShellSessionEventHandlers,
} from './app-shell-session-events';
import { createAppShellE2eFixtureActions } from './app-shell-e2e-fixture';
import {
  createAppShellChatActions,
  type WorkspaceFileReferencePosition,
} from './app-shell-chat-actions';
import { createAppShellTurnActions } from './app-shell-turn-actions';
import {
  abandonTurnRevisionCopyAttempt,
  completeTurnRevisionCopyAttempt,
  createAppShellRevisionActions,
  type TurnRevisionDraft,
} from './app-shell-revision-actions';
import { createAppShellSessionStartActions } from './app-shell-session-start-actions';
import { createAppShellDailyReviewActions } from './app-shell-daily-review-actions';
import { createAppShellSessionRowActions } from './app-shell-session-row-actions';
import { createAppShellSessionSettingsActions } from './app-shell-session-settings-actions';
import { createAppShellStopAction } from './app-shell-stop-action';
import { useStableActions } from './use-stable-actions';
import {
  useActiveSessionEvents,
  useAppShellBootstrapSubscriptions,
  useAppShellHostEffects,
  useAppShellPersistenceEffects,
  useAppShellNavRefSync,
  useSessionEventHealthPolling,
  useShellRunUpdates,
} from './app-shell-effects';
import {
  EMPTY_LIVE_CONTENT_SEED,
  beginLiveContentSeed,
  completeLiveContentSeed,
  liveContentSeedRevision,
  type LiveContentSeed,
} from './live-content-seed';
import { loadComposerDefaults, saveComposerDefaults } from './composer-defaults';
import { useKeyedPendingRegistry } from './use-pending-action-registry';
import { useAppShellComposerAttachments } from './use-app-shell-composer-attachments';
import { useAppShellComposerQuotes } from './use-app-shell-composer-quotes';
import { useComposerMentions } from './use-composer-mentions';
import { useAppShellSessionWorkspace } from './use-app-shell-session-workspace';
import { useShellMemoryPill } from './use-shell-memory-pill';
import { useShellConnections } from './use-shell-connections';
import { useNewTaskTarget } from './use-new-task-target';
import { useShellChatModel } from './use-shell-chat-model';
import { useShellLiveTurn } from './use-shell-live-turn';
import { useShellLayout } from './use-shell-layout';
import { useShellResume } from './use-shell-resume';
import { recoverOrphanedCompanionCopies } from './quote-companion-core';
import { useSideConversationWorkspace } from './use-side-conversation-workspace';

function rebaseWorkspaceFileReferences(
  sourceText: string,
  projectedText: string,
  references: readonly WorkspaceFileReferencePosition[],
): WorkspaceFileReferencePosition[] {
  const offset = sourceText.lastIndexOf(projectedText);
  if (offset < 0) return [];
  return references
    .filter(
      (reference) =>
        reference.start >= offset &&
        reference.start + reference.value.length <= offset + projectedText.length,
    )
    .map((reference) => ({ ...reference, start: reference.start - offset }));
}

import { useSettingsModal } from './use-settings-modal';
import { RemoteProjectDirectoryDialog } from './remote-project-directory-dialog';
import { useSystemUiLocale } from './use-system-ui-locale';
import {
  isSessionWorkspaceUnavailableError,
  showSessionWorkspaceUnavailableToast,
} from './session-workspace-errors';
import { AppShell as AstryxAppShell } from '@astryxdesign/core/AppShell';
import type { SideNavImperativeCollapseHandle } from '@astryxdesign/core/SideNav';

type ComposerImportOwner = {
  sessionId: string | undefined;
  navSection: NavSelection['section'];
  newTaskDraftKey?: string;
};

function newTaskDraftKey(target: {
  profileId: string;
  hostId: string;
  projectId: string | null;
} | undefined): string {
  return target
    ? JSON.stringify(['new-task', target.profileId, target.hostId, target.projectId])
    : UNRESOLVED_NEW_TASK_DRAFT_KEY;
}

/**
 * Grace period before the committed-history fallback force-settles an
 * assistant stream slot when the primary post-commit signal is missed.
 */
const SETTLE_FALLBACK_GRACE_MS = 1000;
/**
 * Module surfaces that own their whole column and render no workspace toolbar.
 * This used to be a `display: none` rule keyed on the detail panel's
 * `data-agents-view`; the toolbar now lives in the window titlebar, which is not
 * a descendant of the detail panel, so the condition belongs here.
 */
const VIEWS_WITHOUT_WORKSPACE_ACTIONS = new Set(['skills', 'cron', 'daily-review']);

type AppShellProps = {
  /** Pre-mount snapshot prefetched by main.tsx — see prefetchOnboardingSnapshot. */
  initialOnboardingSnapshot?: OnboardingSnapshot | null;
};

export function AppShell({ initialOnboardingSnapshot = null }: AppShellProps = {}) {
  const [uiLocalePreference, setUiLocalePreference] = useState<UiLocalePreference>('auto');
  const [uiLocaleOverride, setUiLocaleOverride] = useState<UiLocale | null>(null);
  const systemUiLocale = useSystemUiLocale();
  const uiLocale = resolveUiLocale(uiLocalePreference, systemUiLocale, uiLocaleOverride);
  const errorToastAction = useMemo<ToastErrorAction>(
    () => ({
      label: getShellCopy(uiLocale).errorBoundary.copyReport,
      onClick: (input) => {
        void window.maka.diagnostics.copyErrorReport({
            surface: 'toast',
            title: input.title,
            ...(input.description ? { description: input.description } : {}),
            ...(input.diagnosticDetails ? { details: input.diagnosticDetails } : {}),
            ...(input.diagnosticTarget ? { execution: input.diagnosticTarget } : {}),
            rendererUserAgent: navigator.userAgent,
            rendererLocale: navigator.language,
          })
          .catch(() => undefined);
      },
    }),
    [uiLocale],
  );

  return (
    <LocaleProvider locale={uiLocale} override={uiLocaleOverride}>
      {/* #1565: Astryx's message catalog is keyed off OUR locale context, so it
          must sit inside LocaleProvider — not at the `<Theme>` level, where
          `useUiLocale()` throws before anything renders. Still above every
          Astryx subtree. */}
      <AstryxLocaleProvider>
        <ToastProvider errorAction={errorToastAction}>
          <ErrorBoundary locale={uiLocale}>
            <AppShellContent
              initialOnboardingSnapshot={initialOnboardingSnapshot}
              uiLocale={uiLocale}
              uiLocaleOverride={uiLocaleOverride}
              setUiLocaleOverride={setUiLocaleOverride}
              setUiLocalePreference={setUiLocalePreference}
            />
          </ErrorBoundary>
        </ToastProvider>
      </AstryxLocaleProvider>
    </LocaleProvider>
  );
}

function nextSideChatOrdinal(tabs: readonly SessionWorkbarTab[]): number {
  return (
    tabs.reduce(
      (highest, tab, index) =>
        tab.kind === 'side-chat'
          ? Math.max(highest, tab.ordinal ?? index + 1)
          : highest,
      0,
    ) + 1
  );
}

function nextTerminalOrdinal(tabs: readonly SessionWorkbarTab[]): number {
  return (
    tabs.reduce(
      (highest, tab, index) =>
        tab.kind === 'terminal'
          ? Math.max(highest, tab.ordinal ?? index + 1)
          : highest,
      0,
    ) + 1
  );
}

function AppShellContent({
  initialOnboardingSnapshot = null,
  uiLocale,
  uiLocaleOverride,
  setUiLocaleOverride,
  setUiLocalePreference,
}: {
  initialOnboardingSnapshot?: OnboardingSnapshot | null;
  uiLocale: UiLocale;
  uiLocaleOverride: UiLocale | null;
  setUiLocaleOverride: Dispatch<SetStateAction<UiLocale | null>>;
  setUiLocalePreference: Dispatch<SetStateAction<UiLocalePreference>>;
}) {
  const toastApi = useToast();
  const [appUpdateStatus, setAppUpdateStatus] = useState<AppUpdateStatus | null>(null);
  const updateInstallInFlightRef = useRef(false);
  const notifiedInstallErrorRef = useRef<string | null>(null);
  const {
    sessions,
    authoritativeSessionIds,
    sessionsRef,
    setSessions,
    refreshSessions,
    seedSessions,
    upsertSessionSummary,
    markSessionReadLocally,
    activeId,
    activeIdRef,
    bootstrapSelectionLease,
    setActiveId,
    startNewSession,
    clearOwnedSessionState,
    messages,
    setMessages,
    transcriptRangeRef,
    messageLoadPending,
    setMessageLoadPending,
    messageRetryPendingRef,
    stopPendingRef,
    sessionUiController,
    liveTurnBySessionRef,
    sessionEventHealthBySessionRef,
    setMessageLoadErrorBySession,
    setMessageRetryPendingBySession,
    setStopPendingBySession,
    setLiveTurnBySession,
    confirmLiveTurn,
    setShellRunUpdatesBySession,
    setInteractionBySession,
    setSessionEventHealthBySession,
    setPendingPermissionModeBySession,
    setPendingSessionModelBySession,
  } = useAppShellSessionWorkspace(toastApi);
  const interactionHydrationEpochRef = useRef(new Map<string, number>());
  const markInteractionChanged = useCallback((sessionId: string) => {
    const epochs = interactionHydrationEpochRef.current;
    epochs.set(sessionId, (epochs.get(sessionId) ?? 0) + 1);
  }, []);

  const onboarding = useOnboardingSnapshot(initialOnboardingSnapshot);
  const newTask = useNewTaskTarget({ toastApi, uiLocale });
  const currentNewTaskDraftKey = newTaskDraftKey(newTask.target);
  const attachmentDraftKey = activeId ?? currentNewTaskDraftKey;
  const {
    pendingAttachments,
    pickAttachments,
    attachFilePaths,
    removeAttachment,
    clearSubmittedAttachments,
  } = useAppShellComposerAttachments({
    draftKey: attachmentDraftKey,
    toastApi,
  });
  const {
    pendingQuotes,
    addQuote,
    removeQuote,
    clearQuotes,
  } = useAppShellComposerQuotes({ draftKey: attachmentDraftKey });
  const [newChatPlanModeActive, setNewChatPlanModeActive] = useState(false);
  const [scheduledTaskCreateRequestNonce, setScheduledTaskCreateRequestNonce] = useState(0);
  const [pendingCollaborationModeBySession, setPendingCollaborationModeBySession] = useState<Record<string, boolean>>({});
  const [newChatSwarmModeActive, setNewChatSwarmModeActive] = useState(false);
  const [newChatGraphModeActive, setNewChatGraphModeActive] = useState(false);
  const [newTaskPermissionChoice, setNewTaskPermissionChoice] =
    useNewTaskChoice<ChatDefaultPermissionMode>(currentNewTaskDraftKey);
  const [pendingOrchestrationModeBySession, setPendingOrchestrationModeBySession] = useState<Record<string, boolean>>({});
  const [historyLoadPendingSessionId, setHistoryLoadPendingSessionId] = useState<string>();
  const [transcriptTurnIndex, setTranscriptTurnIndex] = useState<{
    sessionId: string;
    throughSequence: number | null;
    turns: readonly { turnId: string; sequence: number; label: string }[];
  }>();
  const [petCompletionNonce, setPetCompletionNonce] = useState(0);
  // P3: session ids with a live embedded-browser view. The right-side
  // BrowserPanel mounts only for these, so ordinary chats reserve no space.
  const [, setLiveBrowserSessionIds] = useState<string[]>([]);
  const [navigationState, setNavigationState] = useState(() => readNavigationState());
  const navSelection = navigationState.selection;
  const setNavSelection = useCallback<Dispatch<SetStateAction<NavSelection>>>((nextSelection) => {
    setNavigationState((current) => selectNavigation(
      current,
      typeof nextSelection === 'function' ? nextSelection(current.selection) : nextSelection,
    ));
  }, []);
  const navSelectionRef = useRef<NavSelection>(navSelection);
  // #1985: the shell's complete read of session UI state. See the hook for why
  // the two token-rate maps are absent.
  const {
    messageLoadErrorBySession,
    messageRetryPendingBySession,
    stopPendingBySession,
    interactionBySession,
    pendingPermissionModeBySession,
    pendingSessionModelBySession,
    streamingSessionIds,
    activeLiveTurnSnapshot,
  } = useAppShellSessionUiReads(sessionUiController, activeId);
  // The chat surface follows the active Session's Host. Settings and global
  // commands remain owned by the default Host.
  const { memoryActive, refreshMemoryActive } = useShellMemoryPill({
    toastApi,
    uiLocale,
    sessionId: activeId,
  });
  const newTaskHost = newTask.selectedHost
    ? { profileId: newTask.selectedHost.profile.id, hostId: newTask.selectedHost.hostId }
    : undefined;
  const newTaskConnections = useShellConnections({
    toastApi,
    uiLocale,
    target: { kind: 'new-task', host: newTaskHost },
  });
  const defaultHostConnections = useShellConnections({
    toastApi,
    uiLocale,
    target: { kind: 'default' },
  });
  const sessionHostConnections = useShellConnections({
    toastApi,
    uiLocale,
    target: { kind: 'session', sessionId: activeId },
  });
  const startupConnectionSnapshot =
    initialOnboardingSnapshot ?? onboarding.mountedSnapshotHandoff;
  const newTaskUsesDefaultHost =
    newTask.catalog.hosts.length === 0 ||
    newTask.selectedProfileId === newTask.catalog.defaultProfileId;
  let newTaskConnectionSnapshot = newTaskConnections.snapshot;
  if (!newTaskConnections.hasSnapshot && newTaskUsesDefaultHost) {
    newTaskConnectionSnapshot = defaultHostConnections.hasSnapshot
      ? defaultHostConnections.snapshot
      : startupConnectionSnapshot
        ? {
            connections: startupConnectionSnapshot.connections,
            defaultConnection: startupConnectionSnapshot.defaultSlug,
            chatModelChoices: startupConnectionSnapshot.chatModelChoices,
          }
        : defaultHostConnections.snapshot;
  }
  const activeConnectionSnapshot = activeId
    ? sessionHostConnections.snapshot
    : newTaskConnectionSnapshot;
  const connections = activeConnectionSnapshot.connections;
  const defaultConnection = activeConnectionSnapshot.defaultConnection;
  const connectionModelChoices = activeConnectionSnapshot.chatModelChoices;
  const refreshConnections = activeId
    ? sessionHostConnections.refreshConnections
    : newTaskConnections.refreshConnections;
  function refreshConnectionProjections(): Promise<void> {
    return Promise.all([
      defaultHostConnections.refreshConnections(),
      newTaskConnections.refreshConnections(),
      ...(activeId ? [sessionHostConnections.refreshConnections()] : []),
    ]).then(() => undefined);
  }
  function handleConnectionEvent(event: ConnectionEvent): void {
    defaultHostConnections.handleConnectionEvent(event);
    newTaskConnections.handleConnectionEvent(event);
    if (activeId) sessionHostConnections.handleConnectionEvent(event);
  }
  const onboardingState = onboarding.snapshot?.state;
  const onboardingSettled = hasSettledInitialOnboarding(onboarding.snapshot?.milestones ?? []);
  const onboardingActivationCandidate = getOnboardingActivationCandidate(
    onboarding.snapshot,
    sessions.length > 0,
  );
  const {
    settingsOpen,
    settingsRequestedSection,
    settingsProviderCatalogOpen,
    settingsConnectionDetailSlug,
    settingsCreateProviderType,
    setSettingsOpen,
    setSettingsProviderCatalogOpen,
    openSettings,
    openSettingsSection,
    openProviderCatalog,
    openConnectionDetail,
    openProviderCreate,
  } = useSettingsModal();
  const {
    themePref,
    setThemePref,
    themePalette,
    setThemePalette,
    uiLocaleUpdateGate,
    userLabel,
    setUserLabel,
    defaultPermissionMode,
    setDefaultPermissionMode,
    refreshShellSettings,
  } = useShellAppearance({
    toastApi,
    uiLocale,
    setUiLocaleOverride,
    setUiLocalePreference,
  });
  const shellCopy = getShellCopy(uiLocale).app;
  const projectActionsCopy = getShellCopy(uiLocale).projectActions;
  const desktopConversationCopy = getDesktopConversationCopy(uiLocale);
  const terminalPanelCopy = desktopConversationCopy.terminalPanel;
  const workbarCopy = desktopConversationCopy.workbar;
  const newTaskPermissionMode =
    newTaskPermissionChoice ??
    newTask.selectedHost?.chatDefaults.permissionMode ??
    'ask';
  const setNewTaskPermissionMode = setNewTaskPermissionChoice;
  useEffect(() => {
    if (!isAppUpdateInstallFailure(appUpdateStatus)) {
      notifiedInstallErrorRef.current = null;
      return;
    }
    if (notifiedInstallErrorRef.current === appUpdateStatus.message) return;
    notifiedInstallErrorRef.current = appUpdateStatus.message;
    toastApi.error(
      shellCopy.updateInstallFailedTitle,
      shellCopy.updateInstallManualFallback,
    );
  }, [appUpdateStatus, shellCopy, toastApi]);
  useEffect(() => {
    let cancelled = false;
    let receivedPush = false;
    const unsubscribeUpdateStatus = window.maka.app.subscribeUpdateStatus((next) => {
      receivedPush = true;
      if (!cancelled) setAppUpdateStatus(next);
    });
    void window.maka.app
      .updateStatus()
      .then((next) => {
        if (!cancelled && !receivedPush) setAppUpdateStatus(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unsubscribeUpdateStatus();
    };
  }, []);

  const updateReminder = updateReminderFromStatus(appUpdateStatus);
  // Dispatches on the task, not on the raw status: the footer is this
  // callback's only caller and it only renders for the two states above, so
  // reading the status again here would be the same "who needs the user" list
  // maintained twice.
  const openUpdateDownload = useCallback(() => {
    if (updateReminder?.state === 'downloaded') {
      if (updateInstallInFlightRef.current) return;
      updateInstallInFlightRef.current = true;
      void requestDownloadedAppUpdate({
        installUpdate: (input) => window.maka.app.installUpdate(input),
        confirmActiveTasks: () => toastApi.confirm({
          title: shellCopy.updateActiveTasksTitle,
          description: shellCopy.updateActiveTasksDescription,
          confirmLabel: shellCopy.updateActiveTasksConfirm,
          cancelLabel: shellCopy.updateActiveTasksCancel,
          destructive: true,
        }),
      })
        .then((outcome) => {
          if (outcome.kind !== 'failed') return;
          if (outcome.reason === 'install_failed') return;
          toastApi.error(
            shellCopy.updateInstallFailedTitle,
            shellCopy.updateInstallManualFallback,
          );
        })
        .catch((error) => {
          toastApi.error(
            shellCopy.updateInstallFailedTitle,
            localizedShellErrorMessage(error, shellCopy.updateInstallFailedFallback, uiLocale),
          );
        })
        .finally(() => {
          updateInstallInFlightRef.current = false;
        });
      return;
    }
    if (!updateReminder) return;
    void window.maka.app
      .retryUpdateDownload()
      .then((next) => {
        if (next.state !== 'error') return;
        toastApi.error(
          shellCopy.updateRetryFailedTitle,
          shellCopy.updateRetryFailedFallback,
        );
      })
      .catch((error) => {
        toastApi.error(
          shellCopy.updateRetryFailedTitle,
          localizedShellErrorMessage(error, shellCopy.updateRetryFailedFallback, uiLocale),
        );
      });
  }, [updateReminder, shellCopy, toastApi, uiLocale]);
  const moduleHubCopy = getSharedUiCopy(uiLocale).moduleHubs;
  const extensionsHubHeader = {
    title: moduleHubCopy.extensions.title,
    subtitle: moduleHubCopy.extensions.description,
    badge: (
      <ModuleHubSelector
        hub="extensions"
        value={navSelection.section === 'extensions' ? navSelection.module : navigationState.moduleMemory.extensions}
        onChange={(module) => setNavSelection({ section: 'extensions', module })}
      />
    ),
  };
  const automationsHubHeader = {
    title: moduleHubCopy.automations.title,
    subtitle: moduleHubCopy.automations.description,
    badge: (
      <ModuleHubSelector
        hub="automations"
        value={navSelection.section === 'automations' ? navSelection.module : navigationState.moduleMemory.automations}
        onChange={(module) => setNavSelection({ section: 'automations', module })}
      />
    ),
  };
  // Persisted composer defaults seed the empty-state model, project path, and
  // recent workspace history so the home view is populated before the async
  // `app:info` round-trip completes on mount.
  const persistedComposerDefaults = loadComposerDefaults();
  const [helpOpen, closeHelp, openHelp] = useKeyboardHelp();
  const [paletteOpen, openPalette, closePalette] = useCommandPalette();
  const [viewMode, setViewMode] = useState<SessionViewMode>(() => readSessionListViewMode());
  const composerRef = useRef<ComposerHandle>(null);
  // The rail's toggle has to reach Astryx's resizable state, not just this
  // boolean — see the prop's note on SessionListPanel. The sidenav is mounted
  // for the whole shell, so the handle is always live by the time it is called.
  const sessionSideNavHandleRef = useRef<SideNavImperativeCollapseHandle | null>(null);
  // Codex-style side conversations: each workbar tab owns a separate transient
  // fork, composer draft, quote queue, and cleanup lifecycle.
  const sideConversations = useSideConversationWorkspace();
  const quotePanels = sideConversations.panels;
  const sideChatContentPanelIds = sideConversations.contentPanelIds;
  const sideChatPreparingPanelIds = sideConversations.preparingPanelIds;
  const sideChatActivePanelIds = sideConversations.activePanelIds;
  const [pendingSideChatClose, setPendingSideChatClose] =
    useState<Array<{ placement: SessionWorkbarPlacement; tab: SessionWorkbarTab }>>(
      [],
    );
  const [skipSideChatCloseConfirmation, setSkipSideChatCloseConfirmation] =
    useState(
      () => safeLocalStorageGet(SKIP_SIDE_CHAT_CLOSE_CONFIRMATION_KEY) === 'true',
    );
  // Created companion forks stay hidden until authoritative cleanup succeeds or
  // a later authoritative session list confirms they are gone. A set preserves
  // earlier failed cleanups when another companion opens.
  const [hiddenCompanionForkIds, setHiddenCompanionForkIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const companionRecoveryStartedRef = useRef(false);
  useLayoutEffect(() => {
    if (companionRecoveryStartedRef.current) return;
    companionRecoveryStartedRef.current = true;
    void recoverOrphanedCompanionCopies(window.maka.sessions);
  }, []);
  const onCompanionForkVisibilityChange = useCallback(
    (event: Parameters<typeof applyCompanionForkVisibilityEvent>[1]) =>
      setHiddenCompanionForkIds((current) =>
        applyCompanionForkVisibilityEvent(current, event),
      ),
    [],
  );
  useEffect(() => {
    if (!authoritativeSessionIds) return;
    setHiddenCompanionForkIds((current) =>
      reconcileCompanionForkVisibility(current, authoritativeSessionIds),
    );
  }, [authoritativeSessionIds]);
  const [revisionDraft, setRevisionDraft] = useState<TurnRevisionDraft | null>(null);
  const revisionDraftRef = useRef<TurnRevisionDraft | null>(null);
  const commitRevisionDraft = useCallback((draft: TurnRevisionDraft | null) => {
    revisionDraftRef.current = draft;
    setRevisionDraft(draft);
  }, []);
  useEffect(() => {
    const draft = revisionDraftRef.current;
    if (!draft) return;
    const source = sessions.find((session) => session.id === draft.sourceSessionId);
    const owner = sessions.find((session) => session.id === draft.draftSessionId);
    if (source && owner && !source.isArchived && !owner.isArchived) return;
    composerRef.current?.clearDraft(draft.draftSessionId);
    if (draft.sourceSessionId !== draft.draftSessionId) {
      composerRef.current?.clearDraft(draft.sourceSessionId);
    }
    if (draft.copyPhase === 'reserved') completeTurnRevisionCopyAttempt(draft);
    else void abandonTurnRevisionCopyAttempt(draft);
    commitRevisionDraft(null);
  }, [sessions, commitRevisionDraft]);

  const {
    resumePendingSessionId,
    resumeParkDescriptionBySession,
    resumeInterruptedSession,
  } = useShellResume({ activeId, toastApi, shellCopy, uiLocale });
  const rendererMountedRef = useRef(true);
  // Active autonomous goal for the current session drives the header
  // kill-switch pill (visible indicator + one-click clear).
  const activeGoal = useSessionGoal(activeId);
  // Set of session ids whose backend / connection is no longer usable —
  // drives the sidebar "已过期" pill (PR108g, paired with the PR108e chat
  // header banner). Derivation is pure (see `stale-sessions.ts`) so the
  // classifier is testable without a DOM.
  const staleSessionIds = useMemo(
    () =>
      deriveStaleSessionIds({
        sessions,
        sendOutcomes: onboarding.snapshot?.sessionSendOutcomes ?? {},
      }),
    [sessions, onboarding.snapshot?.sessionSendOutcomes],
  );
  // Status-grouped sidebar. The `chats`
  // filter shows sessions grouped by SessionStatus (Pinned →
  // Running → Waiting → Blocked → Active → Review → Done → Archived);
  // `aborted` is dropped. Pinned (flagged) sessions float to the top
  // in their own group, preserving the PR48 pin-floats behavior.
  // One projection owns rail membership, active highlight, and titlebar parent:
  // revision-tree roots (orphans stay; linked children with a live parent leave),
  // flat nav / companion filter — never promote children past ancestors.
  const {
    sessions: visibleSessions,
    activeRowId: sidebarActiveId,
    activeParentSession: railParentSession,
  } = useMemo(
    () =>
      deriveSessionRail(sessions, activeId, (session) =>
        !hiddenCompanionForkIds.has(session.id) && sessionMatchesRail(session),
      ),
    [sessions, activeId, hiddenCompanionForkIds],
  );
  // PR-DAILY-REVIEW-MVP-0: bridge for the main Daily Review module.
  // Memoized so the panel's `useEffect` cleanup keys
  // off a stable reference instead of refetching on every render.
  const dailyReviewBridge = useMemo(() => createAppShellDailyReviewBridge(uiLocale), [uiLocale]);
  const {
    appendDailyReviewMarkdown,
    copyDailyReviewMarkdown,
    saveDailyReviewMarkdown,
  } = useStableActions(createAppShellDailyReviewActions, {
    uiLocale,
    composerRef,
    toastApi,
  });
  const activeInteraction = activeInteractionFor(interactionBySession, activeId);
  const activeSandboxBoundary =
    activeInteraction?.type === 'sandbox_boundary_request' ? activeInteraction : undefined;
  const activeQuestion = activeInteraction?.type === 'user_question_request' ? activeInteraction : undefined;
  const activeSession = sessions.find((session) => session.id === activeId);
  const activeDesktopSession = activeSession;
  // The shell's reading of the active live turn: streaming/settled flags, the
  // in-flight tool signal, and the #646 turn-wait cues, all derived from the
  // semantic snapshot rather than the projection (#1985).
  const {
    activeStreamingLive,
    activeStreamingMessageId,
    hasInFlightLiveTools,
    hasLiveTurnContent,
    turnActive,
    showRunningStatus,
    showProcessingIndicator,
    showContinuingIndicator,
  } = useShellLiveTurn({
    liveTurn: activeLiveTurnSnapshot,
    activeSession,
  });
  const petActivityState = derivePetActivityState({
    hasActiveSession: activeSession !== undefined,
    hasActiveInteraction: activeInteraction !== undefined,
    turnActive,
    sessionStatus: activeSession?.status,
  });
  // Surface a credential-lifecycle alert directly in the chat header when
  // the active session's connection is in `needs_reauth` / `error` or has
  // been deleted entirely with no usable default. Main resolves credential
  // presence into the onboarding snapshot; a connection event starts an async
  // snapshot pull, so the notice keeps the previous outcome only until that
  // pull completes. Model / thinking selection + the hard-only health notice
  // live in useShellChatModel (pure derivation of the snapshot + active session);
  // openSettingsSection is injected so the notice can wrap the derived click
  // target.
  const activeSessionSendOutcome = activeSession
    ? onboarding.snapshot?.sessionSendOutcomes[activeSession.id]
    : undefined;
  const composerProfileId = activeId
    ? activeDesktopSession?.profileId
    : newTask.selectedProfileId;
  const composerProfileName = activeId
    ? activeDesktopSession?.profileName
    : newTask.selectedHost?.profile.name;
  const modelSettingsOwnsComposerHost =
    composerProfileId !== undefined &&
    composerProfileId === newTask.catalog.defaultProfileId;
  const {
    chatModelChoices,
    activeConnection,
    activeConnectionLabel,
    activeModel,
    activeModelLabel,
    activeThinkingLevels,
    activeThinkingLevel,
    newChatModel,
    newChatModelLabel,
    newChatThinkingLevels,
    newChatThinkingLevel,
    setPendingNewChatModel,
    pendingNewChatThinkingLevel,
    setPendingNewChatThinkingLevel,
    sessionHealthNotice,
  } = useShellChatModel({
    uiLocale,
    connections,
    chatModelChoices: connectionModelChoices,
    sessionSendOutcome: activeSessionSendOutcome,
    defaultConnection,
    newTaskKey: currentNewTaskDraftKey,
    activationCandidate: modelSettingsOwnsComposerHost
      ? onboardingActivationCandidate
      : undefined,
    activeSession,
    persistedComposerDefaults,
    usePersistedComposerDefaults: modelSettingsOwnsComposerHost,
    defaultThinkingLevel: newTask.selectedHost?.chatDefaults.thinkingLevel,
    openSettingsSection,
  });
  const newChatProviderType = newChatModel
    ? connections.find((connection) => connection.slug === newChatModel.llmConnectionSlug)?.providerType
    : undefined;

  // PR109d-b: turn footer actions per turn. Derived from the
  // materialized turn list (status + lineage descendants) + pending
  // mask. Per @kenji PR109d review: pending state prevents double-click
  // duplicate sibling turns by disabling the action button between
  // click and `sessions:changed turn-status-change` arriving.
  // The four de-dup registries (turn-footer actions, session-row actions,
  // per-session permission-mode / model changes) all share the same keyed-Set
  // shape; see useKeyedPendingRegistry. Only the turn-footer registry mirrors
  // into React state (drives the disabled mask) and arms a 5s auto-clear
  // fallback timer; the other three stay ref-only and clear in their action's
  // `finally`.
  const turnActionRegistry = useKeyedPendingRegistry({
    trackState: true,
    autoClearMs: 5000,
  });
  const pendingTurnActions = turnActionRegistry.keys;
  const sessionRowActionRegistry = useKeyedPendingRegistry();
  const permissionModeChangeRegistry = useKeyedPendingRegistry();
  const collaborationModeChangeRegistry = useKeyedPendingRegistry();
  const orchestrationModeChangeRegistry = useKeyedPendingRegistry();
  const sessionModelChangeRegistry = useKeyedPendingRegistry();
  const pendingKeyOf = (sessionId: string, turnId: string, actionId: string) =>
    `${sessionId}:${turnId}:${actionId}`;
  function omitSessionKey<T>(current: Record<string, T>, sessionId: string): Record<string, T> {
    if (!(sessionId in current)) return current;
    const next = { ...current };
    delete next[sessionId];
    return next;
  }

  function addPendingSessionAction(
    sessionId: string,
    pendingRef: { current: Set<string> },
    setPendingBySession: (updater: (current: Record<string, boolean>) => Record<string, boolean>) => void,
  ): boolean {
    if (pendingRef.current.has(sessionId)) return false;
    pendingRef.current.add(sessionId);
    setPendingBySession((current) => ({ ...current, [sessionId]: true }));
    return true;
  }

  function clearPendingSessionAction(
    sessionId: string,
    pendingRef: { current: Set<string> },
    setPendingBySession: (updater: (current: Record<string, boolean>) => Record<string, boolean>) => void,
  ): void {
    if (!pendingRef.current.has(sessionId)) return;
    pendingRef.current.delete(sessionId);
    setPendingBySession((current) => omitSessionKey(current, sessionId));
  }

  function clearSessionRendererState(sessionId: string): void {
    clearOwnedSessionState(sessionId);
    turnActionRegistry.clearForSession(sessionId);
    permissionModeChangeRegistry.keysRef.current.delete(sessionId);
    collaborationModeChangeRegistry.keysRef.current.delete(sessionId);
    setPendingCollaborationModeBySession((current) => omitSessionKey(current, sessionId));
    orchestrationModeChangeRegistry.keysRef.current.delete(sessionId);
    setPendingOrchestrationModeBySession((current) => omitSessionKey(current, sessionId));
    sessionModelChangeRegistry.keysRef.current.delete(sessionId);
  }

  const sessionRowActionHandlers = useStableActions(createAppShellSessionRowActions, {
    uiLocale,
    activeIdRef,
    clearSessionRendererState,
    pendingSessionRowActionsRef: sessionRowActionRegistry.keysRef,
    refreshSessions,
    sessionsRef,
    setActiveId,
    setMessages,
    toastApi,
  });
  const sessionRowActions = useMemo<NonNullable<Parameters<typeof SessionListPanel>[0]['rowActions']>>(
    () => ({
      onToggleFlag: (sessionId, next) => sessionRowActionHandlers.flagSession(sessionId, next),
      onArchive: (sessionId) => sessionRowActionHandlers.archiveSession(sessionId),
      onUnarchive: (sessionId) => sessionRowActionHandlers.unarchiveSession(sessionId),
      onRename: (sessionId, name) => sessionRowActionHandlers.renameSession(sessionId, name),
      onDelete: (sessionId) => sessionRowActionHandlers.deleteSession(sessionId),
    }),
    [],
  );

  const {
    setPermissionMode,
    setSessionModel,
    setSessionThinkingLevel,
  } = useStableActions(createAppShellSessionSettingsActions, {
    uiLocale,
    activeIdRef,
    connections,
    messages,
    pendingPermissionModeChangesRef: permissionModeChangeRegistry.keysRef,
    pendingSessionModelChangesRef: sessionModelChangeRegistry.keysRef,
    refreshSessions,
    saveComposerDefaults,
    sessionsRef,
    setNewTaskPermissionMode,
    setPendingPermissionModeBySession,
    setPendingSessionModelBySession,
    setSessions,
    toastApi,
  });

  async function setPlanMode(active: boolean): Promise<void> {
    const sessionId = activeIdRef.current;
    if (!sessionId) {
      setNewChatPlanModeActive(active);
      return;
    }
    if (!addPendingSessionAction(
      sessionId,
      collaborationModeChangeRegistry.keysRef,
      setPendingCollaborationModeBySession,
    )) return;

    try {
      const planState = await window.maka.sessions.getPlanState(sessionId);
      if (active && planState.activeExecutionId) {
        toastApi.error(
          shellCopy.planModeExecutionActiveTitle,
          shellCopy.planModeExecutionActiveDescription,
        );
        return;
      }
      const latestProposal = planState.proposals.find(
        (proposal) => proposal.proposalId === planState.latestProposalId,
      );
      if (!active && latestProposal?.status === 'pending_approval') {
        const confirmed = await toastApi.confirm({
          title: shellCopy.planModeExitPendingTitle,
          description: shellCopy.planModeExitPendingDescription(latestProposal.title),
          confirmLabel: shellCopy.planModeExitConfirm,
          cancelLabel: shellCopy.planModeExitCancel,
          destructive: true,
        });
        if (!confirmed) return;
        await window.maka.sessions.abandonPlanProposal(sessionId, latestProposal.proposalId);
        setSessions((current) => current.map((session) => (
          session.id === sessionId ? { ...session, collaborationMode: 'agent' } : session
        )));
      } else {
        const next = await window.maka.sessions.setCollaborationMode(
          sessionId,
          active ? 'plan' : 'agent',
        );
        setSessions((current) => current.map((session) => session.id === next.id ? next : session));
      }
      await refreshSessions();
    } catch (error) {
      if (activeIdRef.current === sessionId) {
        toastApi.error(
          shellCopy.planModeFailedTitle,
          localizedShellErrorMessage(error, shellCopy.planModeFallback, uiLocale),
        );
      }
    } finally {
      clearPendingSessionAction(
        sessionId,
        collaborationModeChangeRegistry.keysRef,
        setPendingCollaborationModeBySession,
      );
    }
  }

  async function setSwarmMode(active: boolean): Promise<boolean> {
    const sessionId = activeIdRef.current;
    if (!sessionId) {
      setNewChatSwarmModeActive(active);
      if (active) setNewChatGraphModeActive(false);
      return true;
    }
    if (!addPendingSessionAction(
      sessionId,
      orchestrationModeChangeRegistry.keysRef,
      setPendingOrchestrationModeBySession,
    )) return false;

    try {
      const next = await window.maka.sessions.setOrchestrationMode(
        sessionId,
        active ? 'swarm' : 'default',
      );
      setSessions((current) => current.map((session) => session.id === next.id ? next : session));
      await refreshSessions();
      return true;
    } catch (error) {
      if (activeIdRef.current === sessionId) {
        toastApi.error(
          shellCopy.swarmModeFailedTitle,
          localizedShellErrorMessage(error, shellCopy.swarmModeFallback, uiLocale),
        );
      }
      return false;
    } finally {
      clearPendingSessionAction(
        sessionId,
        orchestrationModeChangeRegistry.keysRef,
        setPendingOrchestrationModeBySession,
      );
    }
  }

  async function setGraphMode(active: boolean): Promise<boolean> {
    const sessionId = activeIdRef.current;
    if (!sessionId) {
      setNewChatGraphModeActive(active);
      if (active) setNewChatSwarmModeActive(false);
      return true;
    }
    if (!addPendingSessionAction(
      sessionId,
      orchestrationModeChangeRegistry.keysRef,
      setPendingOrchestrationModeBySession,
    )) return false;

    try {
      const next = await window.maka.sessions.setOrchestrationMode(
        sessionId,
        active ? 'graph' : 'default',
      );
      setSessions((current) => current.map((session) => session.id === next.id ? next : session));
      await refreshSessions();
      return true;
    } catch (error) {
      if (activeIdRef.current === sessionId) {
        toastApi.error(
          shellCopy.graphModeFailedTitle,
          localizedShellErrorMessage(error, shellCopy.graphModeFallback, uiLocale),
        );
      }
      return false;
    } finally {
      clearPendingSessionAction(
        sessionId,
        orchestrationModeChangeRegistry.keysRef,
        setPendingOrchestrationModeBySession,
      );
    }
  }

  // Handed to ChatView, which calls it with the turns its transcript projection
  // produced. The shell no longer materializes the transcript a second time to
  // derive these props, so the turn objects the projection kept are also what
  // keeps the props a memoized TurnView reads stable (#2030).
  const deriveTurnPresentation = useAppShellTurnPresentation({
    activeId,
    pendingTurnActions,
    pendingKeyOf,
    uiLocale,
  });

  // PR109e-e: click handler for lineage badge → scroll target turn into
  // view. Avoids pulling a separate ref-tracker: relies on the
  // `data-turn-id` attribute the renderer already sets on each TurnView.
  //
  // @kenji PR109e review + @xuan PR109f follow-up: scrollIntoView with
  // `behavior: 'smooth'` must respect both reduced-motion AND the
  // e2e-fixture capture entry (PR-IR-02). @xuan confirmed on main that
  // e2e-fixture always writes `data-maka-e2e-fixture="true"` but
  // `data-maka-reduced-motion="true"` is only set on the reduced
  // variant — so the e2e-fixture attribute is the broader signal for
  // "deterministic capture, no animations". Three triggers collapse to
  // `auto`:
  //   1. `data-maka-reduced-motion="true"` — PR-IR-04 reduced variant
  //   2. `data-maka-e2e-fixture="true"` — PR-IR-02 any capture
  //   3. `prefers-reduced-motion: reduce` — OS-level user preference
  function handleLineageBadgeClick(targetTurnId: string): void {
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-turn-id="${CSS.escape(targetTurnId)}"]`);
      if (!el || !('scrollIntoView' in el)) return;
      (el as HTMLElement).scrollIntoView({
        behavior: readScrollMotionBehavior(),
        block: 'center',
      });
    });
  }

  function openSessionInChat(sessionId: string, turnId?: string, sequence?: number): void {
    setNavSelection({ section: 'sessions' });
    setActiveId(sessionId);
    if (turnId) {
      setSearchScrollTarget({ sessionId, turnId, sequence, nonce: Date.now() });
    } else {
      setSearchScrollTarget(null);
    }
  }

  /* PR-FE-BUG-HUNT-0 (kenji bug-hunt 2026-06-24): SearchModal +
     CommandPalette callbacks used to be inline arrows in JSX, so
     their identity churned on every App re-render. SearchModal's
     debounce effect lists `searchThread` in its dep array; during a
     turn stream `App` re-renders many times per second and the
     180ms timeout was torn down + restarted on every render, so it
     never reached its `setTimeout` fire — search was effectively
     dead while a stream was active. Same root cause for the palette
     selection effect that resets keyboard highlight on every deps
     change. Stable refs + memos keep the timers alive. */
  const openSessionInChatRef = useRef(openSessionInChat);
  openSessionInChatRef.current = openSessionInChat;
  const {
    searchModalOpen,
    setSearchModalOpen,
    searchScrollTarget,
    setSearchScrollTarget,
    closeSearchModal,
    searchModalDeps,
    searchModalOnNavigate,
  } = useShellSearch({ openSessionInChatRef });
  /** 技能页 使用: jump to the chat view and seed the composer with a skill
   *  invocation. Same human-in-the-loop rule as maka://compose — we never
   *  auto-send; the user finishes the sentence and presses Enter.
   *  U4: append (not replace) so an in-progress draft survives — appendText
   *  falls back to a plain set when the draft is empty, so the empty-composer
   *  path is unchanged while a half-written message is no longer clobbered. */
  const useSkillInChat = useCallback(
    (_skillId: string, skillName: string) => {
    setNavSelection({ section: 'sessions' });
    const seed = () => {
        composerRef.current?.appendText(shellCopy.useSkillPrompt(skillName));
      composerRef.current?.focus();
    };
    if (activeIdRef.current) {
      window.requestAnimationFrame(seed);
      return;
    }
    void createSession().then(() => window.requestAnimationFrame(seed));
    },
    [shellCopy],
  );
  const sessionListSelectSession = useCallback((sessionId: string) => {
    openSessionInChatRef.current(sessionId);
  }, []);

  // PR109f: branched session context. When the active session was
  // created via `sessions:branchFromTurn`, its `parentSessionId` is
  // set; render a banner above the chat surface so the user knows
  // they're in a derived conversation and can jump back to the parent.
  //
  // v1 intentionally omits the fromAbortedTurn hint because checking
  // it requires loading the parent's full message log. The session
  // banner stays at "分自 ${parentName}" until parent-message
  // preloading lands; "从中断前" is only surfaced in the aborted
  // turn's branch footer tooltip where the active turn status is known.
  const branchBanner = useMemo(
    () => deriveBranchBanner(activeSession, sessions),
    [activeSession?.parentSessionId, sessions],
  );
  const revisionNavigation = useMemo(
    () => deriveSessionRevisionNavigation(sessions, activeId),
    [sessions, activeId],
  );

  function handleBranchBannerClick(parentSessionId: string): void {
    openSessionInChat(parentSessionId);
  }

  // Same revision-aware parent row the rail uses — not a second physical-id walk.
  const titlebarParentSession = useMemo(() => {
    if (!railParentSession) return undefined;
    const parentId = railParentSession.id;
    return {
      name: railParentSession.name,
      onOpen: () => openSessionInChatRef.current(parentId),
    };
  }, [railParentSession]);

  const activeSessionForView: SessionSummary | undefined =
    activeSession ??
    (activeId
      ? {
    id: activeId,
          name: shellCopy.newConversation,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'default',
    connectionLocked: false,
    model: 'fake-model',
    // Transient placeholder while the real SessionSummary loads --
    // matches the configured default so the composer doesn't flash a
    // hardcoded value before the real session data settles.
    permissionMode: defaultPermissionMode,
        }
      : undefined);
  const {
    boundary: activeExecutionBoundary,
    unreadable: activeExecutionBoundaryUnreadable,
    reading: activeExecutionBoundaryReading,
    reload: reloadActiveExecutionBoundary,
  } = useActiveExecutionBoundary(activeId, activeSessionForView?.permissionMode);
  // The session view only subscribes to the session it shows, so a request
  // raised while another session was active never reaches this surface as a
  // live event — and neither does one raised before the window existed. The
  // runtime holds every unanswered request, so read them back whenever the
  // active session changes (#2072).
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    const hydrationEpoch = interactionHydrationEpochRef.current.get(activeId) ?? 0;
    void window.maka.sessions
      .listActiveInteractions(activeId)
      .then((requests) => {
        if (
          cancelled ||
          (interactionHydrationEpochRef.current.get(activeId) ?? 0) !== hydrationEpoch
        ) {
          return;
        }
        setInteractionBySession((current) => reconcileInteractions(current, activeId, requests));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeId, setInteractionBySession]);
  useEffect(
    () =>
      window.maka.sessions.subscribeActiveInteractions(({ sessionId, interactions }) => {
        markInteractionChanged(sessionId);
        setInteractionBySession((current) =>
          reconcileInteractions(current, sessionId, interactions),
        );
      }),
    [markInteractionChanged, setInteractionBySession],
  );
  const activeBoundarySurface = deriveDesktopExecutionBoundarySurface(
    activeId,
    activeExecutionBoundary,
    activeId ? (activeSessionForView?.permissionMode ?? 'ask') : newTaskPermissionMode,
  );
  const activePermissionMode = activeBoundarySurface.permissionMode;
  const planMode = usePlanModeState(activeSessionForView);
  const planConversationItems = (planMode.state?.proposals ?? []).map((proposal) => ({
    id: proposal.proposalId,
    afterTurnId: proposal.turnId,
    renderWhenAnchorMissing:
      proposal.status === 'pending_approval'
      && proposal.proposalId === planMode.state?.latestProposalId,
    content: <PlanProposalCard proposal={proposal} planMode={planMode} />,
  }));
  const activeMessageLoading = Boolean(activeId && messageLoadPending);
  // Session switches clear the transcript projection before its async read.
  // Keep the switch warning anchored to the durable session summary, while
  // retaining the local projection for an optimistic first message that has
  // not reached the catalog yet.
  const modelSwitchHasHistory =
    activeSessionForView?.lastMessageAt !== undefined ||
    messages.some((message) => message.type === 'user' || message.type === 'assistant');
  // PR110c: OnboardingState is now the single source of truth for
  // first-run UI. The renderer never re-derives provider readiness;
  // `useOnboardingSnapshot()` pulls the derived state from the main
  // process (PR110a + PR110b contract) and reactively invalidates on
  // `sessions:changed` + `connections:event`. The hero renders only
  // when sessions.length === 0; any session (including archived /
  // aborted) takes over with the existing chat surface.
  // Re-entrancy lock only — a ref, not state, because nothing renders
  // from it (#1433 removed its last reader with the first-run hero).
  const sessionStartPendingRef = useRef(false);
  // Seed sessions from the onboarding snapshot on first load — the snapshot
  // already fetches the session list + connections internally, so separate
  // Session and connection snapshot IPCs are redundant.
  // This lets the UI show the sidebar + model picker immediately on first load.
  const initialSnapshotSeededRef = useRef(false);
  const mountedSnapshotSeededRef = useRef(false);
  const bootstrapFallbackStartedRef = useRef(false);
  // useLayoutEffect, NOT useEffect: the snapshot render flips
  // `isOnboardingLoading` off while `sessions` is still []. A passive
  // effect seeds sessions AFTER the browser paints that frame, so users
  // with history saw a one-frame flash of the empty-state hero (the
  // "配置页闪了一下" startup flash). Layout effects run before paint,
  // so the seeded sessions and the un-gated frame commit together.
  useLayoutEffect(() => {
    // Snapshot IPC failed — the seed path will never run, so fall back
    // to the classic boot pull or the sidebar stays empty forever.
    if (
      onboarding.error &&
      !initialOnboardingSnapshot &&
      !onboarding.mountedSnapshotHandoff &&
      !bootstrapFallbackStartedRef.current
    ) {
      bootstrapFallbackStartedRef.current = true;
      void bootstrapSessions();
      void defaultHostConnections.refreshConnections();
      return;
    }
    let snapshot: OnboardingSnapshot | null = null;
    let releaseSelectionLease = false;
    if (!initialSnapshotSeededRef.current && initialOnboardingSnapshot) {
      initialSnapshotSeededRef.current = true;
      snapshot = initialOnboardingSnapshot;
    } else if (
      !bootstrapFallbackStartedRef.current &&
      !mountedSnapshotSeededRef.current &&
      onboarding.mountedSnapshotHandoff
    ) {
      mountedSnapshotSeededRef.current = true;
      snapshot = onboarding.mountedSnapshotHandoff;
      releaseSelectionLease = true;
    }
    if (!snapshot) return;
    // Seed sessions. Display normalization MUST run here too — this is
    // a third renderer state entry alongside commitSessions /
    // upsertSessionSummary (#452): without it, legacy blocked/unknown
    // sessions flash an 已阻塞 group on first paint until the first
    // refreshSessions() overwrites the seed.
    const next = seedSessions(snapshot.sessions);
    bootstrapSelectionLease.reconcile(collapseSessionRevisions(next));
    if (releaseSelectionLease) bootstrapSelectionLease.release();
  }, [initialOnboardingSnapshot, onboarding.mountedSnapshotHandoff, onboarding.error]);
  useEffect(() => {
    const snapshot = initialOnboardingSnapshot ?? onboarding.mountedSnapshotHandoff;
    if (!snapshot) return;
    defaultHostConnections.seedSnapshot({
      connections: snapshot.connections,
      defaultConnection: snapshot.defaultSlug,
      chatModelChoices: snapshot.chatModelChoices,
    });
  }, [
    initialOnboardingSnapshot,
    onboarding.mountedSnapshotHandoff,
  ]);
  // PR110c (@kenji review): suppress hero AND the fallback EmptyChatHero
  // while the initial snapshot is in flight. Otherwise sessions.length===0
  // + snapshot===null flashes the prompt-suggestion EmptyChatHero before
  // the state-routed OnboardingHero mounts.
  const isOnboardingLoading = sessions.length === 0 && onboardingState === undefined && !onboardingSettled;
  // Only unfinished setup takes the chat surface over. A configured user with
  // no sessions is not onboarding: they land on the normal empty chat and use
  // the one real Composer, which creates the session on its first send.
  const showOnboardingHero =
    sessions.length === 0 &&
    !onboardingSettled &&
    onboardingState !== undefined &&
    onboardingState.kind !== 'ready_with_history' &&
    onboardingState.kind !== 'ready_empty';
  const workspaceReadinessRecovery = deriveWorkspaceReadinessRecovery({
    state: onboardingState,
    locale: uiLocale,
    activeSessionId: activeId,
    showOnboardingHero,
  });
  const onboardingComposerHidden = isOnboardingLoading || (showOnboardingHero && onboardingState !== undefined);
  // #1629: hiding the composer because the boundary is unknown is right, but
  // hiding it silently and forever is not. Once the read has spent its retries
  // the slot says so and hands the user another attempt; while it is still
  // reading, or while onboarding owns the surface, there is nothing to say.
  const boundaryUnreadableNotice =
    activeId && activeExecutionBoundaryUnreadable && !onboardingComposerHidden
      ? {
          title: shellCopy.boundaryUnreadableTitle,
          detail: shellCopy.boundaryUnreadableDetail,
          retryLabel: shellCopy.boundaryUnreadableRetry,
          retryPendingLabel: shellCopy.boundaryUnreadableRetrying,
          retryPending: activeExecutionBoundaryReading,
          onRetry: () => reloadActiveExecutionBoundary(activeId),
        }
      : undefined;
  const {
    sessionListWidth,
    setSessionListWidth,
    sessionListCollapsed,
    setSessionListCollapsed,
    workbarCollapsed,
    setWorkbarCollapsed,
    bottomPanelOpen,
    setBottomPanelOpen,
    workbarWidth,
    workbarResizable,
    bottomPanelHeight,
    bottomPanelResizable,
    workbarPanelsState,
    openWorkbarTab,
    openDynamicWorkbarTab,
    activateWorkbarTab,
    closeWorkbarTab,
    closeWorkbarTabs,
    reorderWorkbarTab,
    moveWorkbarTab,
    moveWorkbarTabToPanel,
    titleWorkbarTab,
    pinWorkbarTab,
    openWorkbarLauncher,
  } = useShellLayout();
  const openNewSideConversation = useCallback(
    (placement: SessionWorkbarPlacement, initialPrompt?: string) => {
      const sourceSessionId = activeIdRef.current;
      if (!sourceSessionId) return;
      const panel = openCompanionPanel(null, {
        sourceSessionId,
        initialPrompt,
        newId: () => crypto.randomUUID(),
      });
      sideConversations.upsertPanel(panel, true);
      openDynamicWorkbarTab(
        {
          id: `side-chat:${panel.id}`,
          kind: 'side-chat',
          title: sideChatTitleFromPrompt(initialPrompt ?? ''),
          ordinal: nextSideChatOrdinal([
            ...workbarPanelsState.right.tabs,
            ...workbarPanelsState.bottom.tabs,
          ]),
        },
        placement,
      );
      if (placement === 'right') setWorkbarCollapsed(false);
      else setBottomPanelOpen(true);
    },
    [
      openDynamicWorkbarTab,
      setBottomPanelOpen,
      setWorkbarCollapsed,
      sideConversations,
      workbarPanelsState,
    ],
  );
  const openSideConversation = useCallback(
    (initialPrompt?: string) => openNewSideConversation('right', initialPrompt),
    [openNewSideConversation],
  );
  const desktopSlashCommands = useMemo<readonly ComposerSlashCommandOption[]>(
    () => {
      const streaming = turnActive || activeStreamingLive;
      const availableCommands = slashCommandsForSurface('desktop').filter(
        ({ id, session }) =>
          (session === 'none' || Boolean(activeId))
          && !(streaming && id === 'compact'),
      );
      const presentation: Record<
        SlashCommandIdForSurface<'desktop'>,
        Omit<ComposerSlashCommandOption, 'id'>
      > = {
        compact: {
          ...shellCopy.slashCommands.compact,
          keywords: ['compact', 'context', '压缩', '上下文'],
          Icon: Minimize2,
        },
        side: {
          ...shellCopy.slashCommands.side,
          keywords: ['side', 'btw', '侧聊', '追问'],
          Icon: MessageCircleQuestion,
        },
        swarm: {
          ...shellCopy.slashCommands.swarm,
          keywords: ['swarm', 'multi-agent', '多智能体'],
          Icon: Network,
        },
        graph: {
          ...shellCopy.slashCommands.graph,
          keywords: ['graph', 'agent graph', '智能体图'],
          Icon: GitBranch,
        },
      };
      return availableCommands.map(({ id }) => ({ id, ...presentation[id] }));
    },
    [activeId, activeStreamingLive, shellCopy.slashCommands, turnActive],
  );
  const openSideConversationWithQuote = useCallback(
    (quote: QuoteRef) => {
      if (!activeId) return;
      const activeSideChat = findPreferredSideChatWorkbarTab(workbarPanelsState);
      const activeSideChatTab = activeSideChat?.tab;
      const activePanelId = activeSideChatTab?.id.slice('side-chat:'.length);
      const activePanel = quotePanels.find(
        (panel) =>
          panel.id === activePanelId && panel.sourceSessionId === activeId,
      );
      const panel = stageCompanionQuote(
        activePanel ?? null,
        {
          sourceSessionId: activeId,
          quote,
          newId: () => crypto.randomUUID(),
        },
      );
      sideConversations.upsertPanel(panel, !activePanel);
      const targetPlacement =
        activeSideChat?.placement ?? 'right';
      openDynamicWorkbarTab(
        {
          id: `side-chat:${panel.id}`,
          kind: 'side-chat',
          ordinal:
            activeSideChatTab?.ordinal ??
            nextSideChatOrdinal([
              ...workbarPanelsState.right.tabs,
              ...workbarPanelsState.bottom.tabs,
            ]),
        },
        targetPlacement,
      );
      if (targetPlacement === 'right') setWorkbarCollapsed(false);
      else setBottomPanelOpen(true);
    },
    [
      activeId,
      openDynamicWorkbarTab,
      quotePanels,
      setBottomPanelOpen,
      setWorkbarCollapsed,
      sideConversations,
      workbarPanelsState,
    ],
  );

  const requestOpenWorkbarTab = useCallback(
    (placement: SessionWorkbarPlacement, kind: SessionWorkbarTabKind) => {
      if (kind === 'terminal') {
        if (!activeId) return;
        const ownerSessionId = activeId;
        const tabs = [
          ...workbarPanelsState.right.tabs,
          ...workbarPanelsState.bottom.tabs,
        ];
        void window.maka.shellRuns
          .start(ownerSessionId)
          .then((update) => {
            const ref = update.result.ref;
            openDynamicWorkbarTab(
              {
                id: terminalSessionWorkbarTabId(ref),
                kind: 'terminal',
                ordinal: nextTerminalOrdinal(tabs),
                resourceRef: ref,
                ownerSessionId,
              },
              placement,
            );
            if (placement === 'right') setWorkbarCollapsed(false);
            else setBottomPanelOpen(true);
          })
          .catch((error) => {
            toastApi.error(
              terminalPanelCopy.startFailed,
              localizedShellErrorMessage(
                error,
                terminalPanelCopy.startFailed,
                uiLocale,
              ),
            );
          });
        return;
      }
      if (kind === 'side-chat') {
        openNewSideConversation(placement);
        return;
      }
      openWorkbarTab(kind, placement);
      if (placement === 'right') setWorkbarCollapsed(false);
      else setBottomPanelOpen(true);
    },
    [
      activeId,
      openDynamicWorkbarTab,
      openNewSideConversation,
      openWorkbarTab,
      setBottomPanelOpen,
      setWorkbarCollapsed,
      terminalPanelCopy,
      toastApi,
      uiLocale,
      workbarPanelsState,
    ],
  );

  const closeWorkbarTabsImmediately = useCallback(
    (
      placement: SessionWorkbarPlacement,
      tabs: readonly SessionWorkbarTab[],
    ) => {
      if (tabs.length === 0) return;
      for (const tab of tabs) {
        const ref = terminalRefFromWorkbarTab(tab);
        if (!ref || !tab.ownerSessionId) continue;
        void window.maka.shellRuns
          .stop({ sessionId: tab.ownerSessionId, ref })
          .catch(() => {});
      }
      closeWorkbarTabs(placement, tabs.map((tab) => tab.id));
      const panelIds = new Set(
        tabs
          .filter((tab) => tab.kind === 'side-chat')
          .map((tab) => tab.id.slice('side-chat:'.length)),
      );
      if (panelIds.size === 0) return;
      sideConversations.removePanels(panelIds);
    },
    [closeWorkbarTabs, sideConversations],
  );

  useEffect(() => {
    const stale = (['right', 'bottom'] as const).flatMap((placement) =>
      workbarPanelsState[placement].tabs
        .filter(
          (tab) =>
            tab.kind === 'terminal' &&
            tab.ownerSessionId !== activeId,
        )
        .map((tab) => ({ placement, tab })),
    );
    for (const placement of ['right', 'bottom'] as const) {
      const tabs = stale
        .filter((candidate) => candidate.placement === placement)
        .map((candidate) => candidate.tab);
      closeWorkbarTabsImmediately(placement, tabs);
    }
  }, [activeId, closeWorkbarTabsImmediately, workbarPanelsState]);

  const closeWorkbarTabsAndSurfaces = useCallback(
    (
      placement: SessionWorkbarPlacement,
      tabs: readonly SessionWorkbarTab[],
    ) => {
      const closableTabs = tabs.filter(
        (tab) =>
          tab.kind !== 'side-chat' ||
          !sideChatPreparingPanelIds.has(tab.id.slice('side-chat:'.length)),
      );
      if (closableTabs.length === 0) return;
      const needsConfirmation =
        !skipSideChatCloseConfirmation &&
        closableTabs.some(
          (tab) =>
            tab.kind === 'side-chat' &&
            sideChatContentPanelIds.has(tab.id.slice('side-chat:'.length)),
        );
      if (needsConfirmation) {
        setPendingSideChatClose(
          closableTabs.map((tab) => ({ placement, tab })),
        );
        return;
      }
      closeWorkbarTabsImmediately(placement, closableTabs);
    },
    [
      closeWorkbarTabsImmediately,
      sideChatContentPanelIds,
      sideChatPreparingPanelIds,
      skipSideChatCloseConfirmation,
    ],
  );

  const closeWorkbarTabAndSurface = useCallback(
    (placement: SessionWorkbarPlacement, tab: SessionWorkbarTab) =>
      closeWorkbarTabsAndSurfaces(placement, [tab]),
    [closeWorkbarTabsAndSurfaces],
  );

  const toggleWorkbar = useCallback(() => {
    if (workbarCollapsed) {
      setWorkbarCollapsed(false);
      if (workbarPanelsState.right.activeTabId) {
        activateWorkbarTab('right', workbarPanelsState.right.activeTabId);
      }
      return;
    }
    setWorkbarCollapsed(true);
  }, [
    activateWorkbarTab,
    setWorkbarCollapsed,
    workbarCollapsed,
    workbarPanelsState.right.activeTabId,
  ]);

  // Side chats survive a panel collapse. They are cleaned up only when their
  // tab closes or when navigation leaves the owning source session.
  useEffect(() => {
    const stalePanels = quotePanels.filter(
      (panel) => panel.sourceSessionId !== activeId,
    );
    if (stalePanels.length === 0) return;
    const staleIds = new Set(stalePanels.map((panel) => panel.id));
    for (const panel of stalePanels) {
      const tabId = `side-chat:${panel.id}`;
      const placement = workbarPanelsState.right.tabs.some((tab) => tab.id === tabId)
        ? 'right'
        : 'bottom';
      closeWorkbarTab(placement, tabId);
    }
    sideConversations.removePanels(staleIds);
  }, [quotePanels, activeId, closeWorkbarTab, sideConversations, workbarPanelsState]);

  function isScheduledTasksSurfaceActive(): boolean {
    return navSelectionRef.current.section === 'automations' && navSelectionRef.current.module === 'scheduled-tasks';
  }

  function isSkillsSurfaceActive(): boolean {
    return navSelectionRef.current.section === 'extensions' && navSelectionRef.current.module === 'skills';
  }

  function isDailyReviewSurfaceActive(): boolean {
    return navSelectionRef.current.section === 'automations' && navSelectionRef.current.module === 'daily-review';
  }

  const {
    skills,
    managedSkillSources,
    bundledSkillCatalog,
    scheduledTasks,
    refreshScheduledTasks,
    createScheduledTask,
    updateScheduledTask,
    toggleScheduledTask,
    triggerScheduledTaskNow,
    snoozeScheduledTask,
    clearScheduledTaskRunHistory,
    deleteScheduledTask,
    refreshSkills,
    refreshManagedSkillSources,
    refreshBundledSkillCatalog,
    importManagedSkillSource,
    installManagedSkill,
    installBundledSkill,
    previewManagedSkillUpdate,
    updateManagedSkill,
    setSkillEnabled,
    setSkillPinned,
    deleteSkill,
    openSkill,
  } = useAppShellModuleData({
    uiLocale,
    isSkillsSurfaceActive,
    isScheduledTasksSurfaceActive,
    toastApi,
  });

  // 保持系统唤醒 capability for the 定时任务 page: reads/writes
  // settings.system.keepSystemAwake over the existing settings bridge. When
  // the bridge is absent the panel hides the row (fail-soft).
  const keepSystemAwakeController = useKeepSystemAwake();

  const {
    projectInfo,
    projects,
    projectCapabilities,
    activeProjectCapabilities,
    localProjects,
    currentProjectId,
    currentProject,
    projectPickerPendingRef,
    projectPickerRequestRef,
    refreshProjects,
    relinkProject,
    renameProject,
    archiveProject,
    restoreProject,
    openProjectFolder,
    openWorkspaceFolder,
    openSkillsFolder,
  } = useAppShellProjectContext({
    uiLocale,
    rendererMountedRef,
    sessionId: activeId,
    sessionCwd: activeSession?.cwd,
    sessionProjectId: activeSession?.projectId,
    sessionProfileKind: activeDesktopSession?.profileKind,
    onProjectSelected: (ownerSessionId) => {
      void refreshSkills();
      void refreshManagedSkillSources();
      void refreshBundledSkillCatalog();
      if (ownerSessionId && activeIdRef.current === ownerSessionId) openNewTaskSurface();
    },
    toastApi,
  });
  // Where a NEW chat starts. Built unconditionally and handed to the composer,
  // which renders it only while no session owns it — the project is fixed once
  // the first message creates one, so there is nothing to pick after that.
  const selectedNewTaskHost = newTask.catalog.hosts.find(
    (host) => host.profile.id === newTask.selectedProfileId,
  );
  const selectedNewTaskProject = newTask.currentProject?.name ??
    (newTask.selectedProjectId === null && newTask.selectedHost?.capabilities.selectNoProject
      ? getConversationCopy(uiLocale).workspace.noProject
      : undefined);
  const selectedNewTaskBranch =
    newTask.selectedHost &&
      newTask.selectedProjectId === newTask.selectedHost.selectedProjectId
      ? newTask.selectedHost.branch
      : undefined;
  const newTaskCatalogNeedsRetry = Boolean(newTask.error) || newTask.catalog.hosts.some(
    (host) => host.readiness === 'ready' && host.state === 'error',
  );
  const workspacePicker: WorkspacePickerModel = {
    label: selectedNewTaskProject ?? selectedNewTaskHost?.profile.name ??
      (newTask.error ? getShellCopy(uiLocale).projectActions.catalogUnavailable : undefined),
    ...(selectedNewTaskHost?.profile.kind === 'remote'
      ? { hostBadge: selectedNewTaskHost.profile.name }
      : {}),
    branch: newTask.selectedProjectId === null ? null : selectedNewTaskBranch,
    pending: newTask.pending || (newTask.refreshing && newTask.catalog.hosts.length === 0),
    selectedGroupId: newTask.selectedProfileId,
    groups: newTask.catalog.hosts.map((host) => {
      if (host.readiness !== 'ready' || host.state !== 'available') {
        return {
          id: host.profile.id,
          label: host.profile.name,
          status: host.readiness === 'ready'
            ? host.message
            : getShellCopy(uiLocale).projectActions.runtimeHostReadiness[host.readiness],
          disabled: true,
          projects: [],
        };
      }
      const selectedProjectId = host.profile.id === newTask.selectedProfileId
        ? newTask.selectedProjectId
        : host.selectedProjectId;
      return {
        id: host.profile.id,
        label: host.profile.name,
        projects: host.projects.filter((project) => project.archivedAt === undefined),
        selectedProjectId,
        onSelectProject: (projectId: string) => newTask.selectProject(host, projectId),
        ...(host.capabilities.chooseClientDirectory || host.capabilities.chooseHostDirectory
          ? { onAdd: () => void newTask.addProject(host) }
          : {}),
        ...(host.capabilities.chooseClientDirectory
          ? { onRelink: (projectId: string) => void newTask.relinkProject(host, projectId) }
          : {}),
        ...(host.capabilities.selectNoProject
          ? { onSelectNoProject: () => newTask.selectNoProject(host) }
          : {}),
      };
    }),
    ...(newTaskCatalogNeedsRetry
      ? {
          retry: {
            label: getShellCopy(uiLocale).projectActions.retryCatalog,
            onClick: () => void newTask.refresh().catch(() => undefined),
          },
        }
      : {}),
  };
  const taskReadinessWorkspace = activeSession?.cwd ?? newTask.projectPath;
  const taskReadinessRequest = {
    ...resolveTaskReadinessModelTarget(activeSession, activeSessionSendOutcome, newChatModel),
    ...(taskReadinessWorkspace ? { cwd: taskReadinessWorkspace } : {}),
  };
  const taskReadiness = useTaskSubmissionReadiness(
    taskReadinessRequest,
    onboarding.snapshot,
    activeId,
    activeId ? undefined : newTask.target,
  );
  const taskReadinessNotice = deriveTaskReadinessNotice(taskReadiness.snapshot, uiLocale);
  const ignoreTaskReadinessModelTarget =
    activeSession !== undefined && activeSessionSendOutcome?.kind !== 'blocked';
  const taskSubmissionHardBlocked =
    (!activeId && !newTask.target) ||
    isTaskSubmissionHardBlocked(taskReadiness.snapshot, {
      ignoreModelTarget: ignoreTaskReadinessModelTarget,
    });
  // The titlebar names the directory the ACTIVE session runs in, so it reads
  // the same projected project state the picker does — `projectInfo` already
  // resolves to the session's own cwd once a session owns it.
  const titlebarProjectName = deriveTitlebarProjectName({
    projectName: currentProject?.name,
    projectPath: projectInfo?.projectPath,
  });
  const sessionProjectGroups = useMemo(
    () => deriveDesktopSessionGroups(visibleSessions, localProjects, uiLocale),
    [visibleSessions, localProjects, uiLocale],
  );
  const worktreeSessionIds = useMemo(
    () => deriveWorktreeSessionIds(
      visibleSessions.filter(
        (session) => session.profileKind !== 'remote',
      ),
      localProjects,
    ),
    [visibleSessions, localProjects],
  );
  // Archived Local tasks use the Local Host catalog; remote rows identify
  // their Host instead of resolving Project ids across unrelated catalogs.
  const archivedTasksBridge = useMemo<ArchivedTasksBridge>(
    () => ({
      sessions,
      projects: localProjects,
      onRestore: (sessionId) => void sessionRowActionHandlers.unarchiveSession(sessionId),
      onDelete: (sessionId) => void sessionRowActionHandlers.deleteSession(sessionId),
      onPurge: (sessionIds) => sessionRowActionHandlers.purgeSessions(sessionIds),
    }),
    [sessions, localProjects],
  );
  const { startModeSession } = useStableActions(createAppShellSessionStartActions, {
    uiLocale,
    activeIdRef,
    captureComposerImportOwner,
    composerRef,
    isShellSurfaceOwnerActive,
    openSessionInChat,
    newTaskTarget: newTask.target,
    sessionStartPendingRef,
    refreshOnboarding: onboarding.refresh,
    refreshSessions,
    showModelSetupToast,
    toastApi,
  });
  // Sidebar Project groups are Local. Their catalog mutations remain on the
  // default-scoped bridge until Settings receives its own Host selector.
  const projectRowActions: Parameters<typeof SessionListPanel>[0]['projectActions'] =
    projectCapabilities.setLocalDefault
      ? {
          onNew: createSessionInProject,
          onRename: renameProject,
          onArchive: archiveProject,
          onRestore: restoreProject,
          ...(projectCapabilities.chooseClientDirectory
            ? {
                onRelink: (projectId: string) =>
                  relinkProject(projectId).then(() => undefined),
              }
            : {}),
        }
      : undefined;

  // Composer mention popups: `/` uses Runtime's session/project-aware,
  // host-compatible projection; `@` uses workspace file search. Keep the
  // resolved project path as a refresh key for new-chat project changes.
  const { mentionSkills, searchMentionFiles } = useComposerMentions({
    skills,
    sessionId: activeId,
    projectPath: activeId ? projectInfo?.projectPath : newTask.projectPath,
    newTaskTarget: activeId ? undefined : newTask.target,
    newSessionModel: newChatModel,
    newSessionCollaborationMode: newChatPlanModeActive ? 'plan' : 'agent',
    // Refresh only; Desktop Main re-reads the authoritative default before
    // constructing the Runtime Host preview target.
    newSessionPermissionMode: newTaskPermissionMode,
  });

  const { applyE2eFixture } = useStableActions(createAppShellE2eFixtureActions, {
    openSettingsSection,
    refreshSessions,
    setActiveId,
    setNavSelection,
    setSearchModalOpen,
    setSessionListCollapsed,
    setWorkbarCollapsed,
    openWorkbarTab,
    setThemePref,
    setUiLocaleOverride,
  });

  const {
    send,
    respondToSandboxBoundary,
    respondToUserQuestion,
    refreshMessages,
    retryMessages,
  } = useStableActions(createAppShellChatActions, {
    uiLocale,
    activeIdRef,
    addPendingSessionAction,
    captureComposerImportOwner,
    checkTaskSubmissionReadiness: taskSubmissionReadyAtSend,
    clearPendingSessionAction,
    isNewChatSendSurfaceActive,
    isShellSurfaceOwnerActive,
    markSessionReadLocally,
    messageRetryPendingRef,
    refreshSessions,
    setActiveId,
    setMessageLoadErrorBySession,
    setMessageRetryPendingBySession,
    setMessages,
    transcriptRangeRef,
    setNavSelection,
    setLiveTurnBySession,
    setInteractionBySession,
    onInteractionChanged: markInteractionChanged,
    onExecutionBoundaryChanged: reloadActiveExecutionBoundary,
    showModelSetupToast,
    toastApi,
    upsertSessionSummary,
    newChatModel: newChatModel ?? null,
    pendingNewChatThinkingLevel: newChatThinkingLevel ?? null,
    newChatPermissionMode: newTaskPermissionMode,
    newChatCollaborationMode: newChatPlanModeActive ? 'plan' : 'agent',
    newChatOrchestrationMode: newChatGraphModeActive
      ? 'graph'
      : newChatSwarmModeActive
        ? 'swarm'
        : 'default',
    newTaskTarget: newTask.target,
  });

  const { handleTurnFooterAction } = useStableActions(createAppShellTurnActions, {
    uiLocale,
    activeIdRef,
    addPendingTurnAction: turnActionRegistry.addKey,
    clearPendingTurnAction: turnActionRegistry.clearKey,
    openSessionInChat,
    pendingKeyOf,
    refreshMessages,
    refreshSessions,
    setMessages,
    toastApi,
    upsertSessionSummary,
  });

  const {
    beginEditUserMessage,
    prepareRevisionSend,
    cancelRevisionDraft,
  } = useStableActions(createAppShellRevisionActions, {
    uiLocale,
    activeIdRef,
    composerRef,
    messages,
    hasPendingAttachments: () => pendingAttachments.length > 0,
    openSessionInChat,
    refreshMessages,
    refreshSessions,
    setMessages,
    commitRevisionDraft,
    revisionDraftRef,
    toastApi,
    upsertSessionSummary,
  });

  async function taskSubmissionReadyAtSend(): Promise<boolean> {
    const snapshot = await taskReadiness.checkNow();
    return !isTaskSubmissionHardBlocked(snapshot, {
      ignoreModelTarget: ignoreTaskReadinessModelTarget,
    });
  }

  async function sendWithAttachments(
    text: string,
    metadata?: ComposerSendMetadata,
  ): Promise<boolean | void> {
    const revision = revisionDraftRef.current;
    const revisionSend = Boolean(
      revision && activeIdRef.current === revision.draftSessionId,
    );
    const slashCommand = parseDesktopSlashCommand(text);
    // The composer has one submit; mid-turn it means steering, and this is
    // where that reading lives. Slash commands are exempt because they are
    // control instructions to the shell, not text for the running turn.
    if (!slashCommand && (turnActive || activeStreamingLive)) {
      return steerWithText(text);
    }
    if (
      revisionSend &&
      revision &&
      text.trim() === revision.originalText.trim() &&
      pendingAttachments.length === 0
    ) {
      const actionCopy = getDesktopConversationCopy(uiLocale).actions;
      toastApi.info(actionCopy.revisionReadyTitle, actionCopy.revisionUnchanged);
      return false;
    }
    if (revisionSend && revision) {
      const actionCopy = getDesktopConversationCopy(uiLocale).actions;
      if (pendingAttachments.length > 0) {
        toastApi.info(actionCopy.revisionUnavailableTitle, actionCopy.revisionAttachmentsUnsupported);
        return false;
      }
      if (slashCommand) {
        toastApi.info(actionCopy.revisionUnavailableTitle, actionCopy.revisionCommandUnsupported);
        return false;
      }
      if (!(await prepareRevisionSend(text))) return false;
    }
    if (slashCommand?.kind === 'compact') {
      const sessionId = activeIdRef.current;
      if (!sessionId) return true;
      try {
        await window.maka.sessions.compact(sessionId);
        return true;
      } catch (error) {
        if (activeIdRef.current !== sessionId) return false;
        if (isSessionWorkspaceUnavailableError(error)) {
          showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
        } else {
          toastApi.error(
            shellCopy.compactErrorTitle,
            localizedShellErrorMessage(error, shellCopy.compactErrorFallback, uiLocale),
          );
        }
        return false;
      }
    }
    if (slashCommand?.kind === 'side') {
      if (!activeIdRef.current) {
        toastApi.info(
          shellCopy.sideChatUnavailableTitle,
          shellCopy.sideChatUnavailableDescription,
        );
        return false;
      }
      if (
        pendingAttachments.length > 0 ||
        pendingQuotes.length > 0 ||
        (metadata?.workspaceFileReferences?.length ?? 0) > 0
      ) {
        toastApi.info(
          shellCopy.sideChatContextPendingTitle,
          shellCopy.sideChatContextPendingDescription,
        );
        return false;
      }
      openSideConversation(slashCommand.command.prompt || undefined);
      return true;
    }
    if (slashCommand?.kind === 'swarm') {
      const swarmCommand = slashCommand.command;
      if (swarmCommand.kind === 'status') {
        const active = activeIdRef.current
          ? (activeSessionForView?.orchestrationMode ?? 'default') === 'swarm'
          : newChatSwarmModeActive;
        toastApi.info(
          active ? shellCopy.swarmModeEnabledTitle : shellCopy.swarmModeDisabledTitle,
          shellCopy.swarmModeStatusDescription,
        );
        return true;
      }
      if (swarmCommand.kind === 'set_mode') {
        const changed = await setSwarmMode(swarmCommand.mode === 'swarm');
        if (changed) {
          toastApi.info(
            swarmCommand.mode === 'swarm'
              ? shellCopy.swarmModeEnabledTitle
              : shellCopy.swarmModeDisabledTitle,
            shellCopy.swarmModeStatusDescription,
          );
        }
        return changed;
      }
      const pending = pendingAttachments.length > 0 ? pendingAttachments : undefined;
      const quotes = pendingQuotes.length > 0 ? pendingQuotes : undefined;
      const ok = await send(swarmCommand.task, pending, {
        turnOrchestration: { mode: 'swarm', source: 'slash_command' },
        ...(quotes ? { quotes } : {}),
        ...(metadata?.workspaceFileReferences?.length
          ? {
              workspaceFileReferences: rebaseWorkspaceFileReferences(
                text,
                swarmCommand.task,
                metadata.workspaceFileReferences,
              ),
            }
          : {}),
      });
      if (ok !== false && pending) clearSubmittedAttachments(pending);
      if (ok !== false && quotes) clearQuotes();
      return ok;
    }
    if (slashCommand?.kind === 'graph') {
      const graphCommand = slashCommand.command;
      if (graphCommand.kind === 'status') {
        const active = activeIdRef.current
          ? (activeSessionForView?.orchestrationMode ?? 'default') === 'graph'
          : newChatGraphModeActive;
        toastApi.info(
          active ? shellCopy.graphModeEnabledTitle : shellCopy.graphModeDisabledTitle,
          shellCopy.graphModeStatusDescription,
        );
        return true;
      }
      if (graphCommand.kind === 'set_mode') {
        const changed = await setGraphMode(graphCommand.mode === 'graph');
        if (changed) {
          toastApi.info(
            graphCommand.mode === 'graph'
              ? shellCopy.graphModeEnabledTitle
              : shellCopy.graphModeDisabledTitle,
            shellCopy.graphModeStatusDescription,
          );
        }
        return changed;
      }
      const pending = pendingAttachments.length > 0 ? pendingAttachments : undefined;
      const quotes = pendingQuotes.length > 0 ? pendingQuotes : undefined;
      const ok = await send(graphCommand.task, pending, {
        turnOrchestration: { mode: 'graph', source: 'slash_command' },
        ...(quotes ? { quotes } : {}),
        ...(metadata?.workspaceFileReferences?.length
          ? {
              workspaceFileReferences: rebaseWorkspaceFileReferences(
                text,
                graphCommand.task,
                metadata.workspaceFileReferences,
              ),
            }
          : {}),
      });
      if (ok !== false && pending) clearSubmittedAttachments(pending);
      if (ok !== false && quotes) clearQuotes();
      return ok;
    }
    const pending = pendingAttachments.length > 0 ? pendingAttachments : undefined;
    const expectedRevisionDraft = revisionSend
      ? revisionDraftRef.current
      : undefined;
    const quotes = pendingQuotes.length > 0 ? pendingQuotes : undefined;
    const ok = await send(text, pending, {
      ...(quotes ? { quotes } : {}),
      ...(metadata?.workspaceFileReferences?.length
        ? { workspaceFileReferences: metadata.workspaceFileReferences }
        : {}),
    });
    if (ok !== false && pending) clearSubmittedAttachments(pending);
    if (ok !== false && quotes) clearQuotes();
    if (ok !== false && revisionSend) {
      if (expectedRevisionDraft) {
        completeTurnRevisionCopyAttempt(expectedRevisionDraft);
        composerRef.current?.clearDraft(expectedRevisionDraft.draftSessionId);
        if (expectedRevisionDraft.sourceSessionId !== expectedRevisionDraft.draftSessionId) {
          composerRef.current?.clearDraft(expectedRevisionDraft.sourceSessionId);
        }
      }
      commitRevisionDraft(null);
    }
    return ok;
  }

  async function steerWithText(text: string): Promise<boolean> {
    const sessionId = activeIdRef.current;
    if (!sessionId || !text.trim()) return false;
    try {
      const outcome = await window.maka.sessions.steer(sessionId, text.trim());
      return outcome.kind === 'queued';
    } catch (error) {
      if (activeIdRef.current === sessionId) {
        const copy = getDesktopConversationCopy(uiLocale).actions;
        toastApi.error(
          copy.operationFailedTitle,
          localizedShellErrorMessage(error, copy.operationFailedFallback, uiLocale),
        );
      }
      return false;
    }
  }

  const stop = createAppShellStopAction({
    uiLocale,
    activeIdRef,
    addPendingSessionAction,
    clearPendingSessionAction,
    setStopPendingBySession,
    stopPendingRef,
    toastApi,
  });

  const [sessionDisplayBatch] = useState(createAppShellSessionDisplayBatch);
  const {
    handleEvent,
    reconcilePersistedMessages,
    settleAssistantStreaming,
    flushDisplayEvents,
    markDisplayPending,
    markDisplayReady,
  } = useStableActions(createAppShellSessionEventHandlers, {
    uiLocale,
    activeIdRef,
    liveTurnBySessionRef,
    refreshMessages,
    refreshSessions,
    setLiveTurnBySession,
    setInteractionBySession,
    displayBatch: sessionDisplayBatch,
    onInteractionChanged: markInteractionChanged,
    onExecutionBoundaryChanged: reloadActiveExecutionBoundary,
    showModelSetupToast,
    toastApi,
    notifyRunEnded: ({ kind, sessionId, body }) => {
      if (kind === 'completed' && activeIdRef.current === sessionId) {
        setPetCompletionNonce((current) => current + 1);
      }
      const title = sessionsRef.current.find((session) => session.id === sessionId)?.name;
      // Best-effort: swallow any main-side failure so a missed banner
      // never surfaces as an unhandled promise rejection.
      void window.maka.notifications.runEnded({ kind, title, body }).catch(() => {});
    },
  });

  // Streaming-settle handoff, FALLBACK path only. The bubble's primary
  // `onStreamingSettled` signal runs after Astryx commits the terminal text.
  // Keep a delayed fallback because a stuck slot would otherwise hide the
  // committed answer forever (`streamingMessageId` suppresses it while live).
  useEffect(() => {
    if (!activeId || !activeStreamingMessageId) return;
    const committedAssistantArrived = messages.some(
      (message) => message.type === 'assistant' && message.id === activeStreamingMessageId,
    );
    if (!committedAssistantArrived) return;
    const timer = window.setTimeout(() => {
      void settleAssistantStreaming(activeId, activeStreamingMessageId);
    }, SETTLE_FALLBACK_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [activeId, activeStreamingMessageId, messages, settleAssistantStreaming]);

  const hasModalOpen = helpOpen || paletteOpen || searchModalOpen;
  const shellObscured = hasModalOpen || settingsOpen;

  useEffect(() => {
    const handleWorkbarShortcut = (event: KeyboardEvent) => {
      if (
        shellObscured ||
        navSelectionRef.current.section !== 'sessions' ||
        !activeId
      ) {
        return;
      }
      const primary = navigator.platform.toLowerCase().includes('mac')
        ? event.metaKey
        : event.ctrlKey;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && !event.altKey && key === 'g') {
        event.preventDefault();
        requestOpenWorkbarTab('right', 'review');
      } else if (
        event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        (key === '`' || event.code === 'Backquote')
      ) {
        event.preventDefault();
        requestOpenWorkbarTab('right', 'terminal');
      } else if (primary && !event.altKey && !event.shiftKey && key === 't') {
        event.preventDefault();
        requestOpenWorkbarTab('right', 'browser');
      } else if (primary && !event.altKey && !event.shiftKey && key === 'p') {
        event.preventDefault();
        requestOpenWorkbarTab('right', 'files');
      } else if (primary && event.altKey && !event.shiftKey && key === 's') {
        event.preventDefault();
        requestOpenWorkbarTab('right', 'side-chat');
      }
    };
    window.addEventListener('keydown', handleWorkbarShortcut, true);
    return () => window.removeEventListener('keydown', handleWorkbarShortcut, true);
  }, [activeId, requestOpenWorkbarTab, shellObscured]);

  useAppShellNavRefSync({
    navSelection,
    navSelectionRef,
  });
  useAppShellHostEffects({
    activeId,
    setLiveBrowserSessionIds,
  });
  useAppShellBootstrapSubscriptions({
    uiLocale,
    activeIdRef,
    applyE2eFixture,
    bootstrapSessions,
    clearPendingTurnActionsForSession: turnActionRegistry.clearForSession,
    confirmLiveTurn,
    clearSessionRendererState,
    createSession,
    handleConnectionEvent,
    openHelp,
    openSettings,
    pendingPermissionModeChangesRef: permissionModeChangeRegistry.keysRef,
    pendingSessionModelChangesRef: sessionModelChangeRegistry.keysRef,
    pendingTurnActionTimersRef: turnActionRegistry.timersRef,
    pendingTurnActionsRef: turnActionRegistry.keysRef,
    projectPickerPendingRef,
    projectPickerRequestRef,
    refreshConnections: refreshConnectionProjections,
    refreshMemoryActive,
    refreshMessages,
    refreshScheduledTasks,
    refreshProjects,
    refreshShellSettings,
    refreshSkills,
    refreshManagedSkillSources,
    refreshBundledSkillCatalog,
    refreshSessions,
    rendererMountedRef,
    setActiveId,
    setMessages,
    setNavSelection,
    setSessionEventHealthBySession,
    toastApi,
  });
  useAppShellPersistenceEffects({
    navigationState,
    sessionListCollapsed,
    sessionListWidth,
    sessionListViewMode: viewMode,
    workbarCollapsed,
    workbarWidth,
    bottomPanelOpen,
    bottomPanelHeight,
    workbarPanelsState,
    themePalette,
    themePref,
  });
  const [activeEventSeed, setActiveEventSeed] = useState<LiveContentSeed>(EMPTY_LIVE_CONTENT_SEED);
  const activeEventSeedRef = useRef(activeEventSeed);
  activeEventSeedRef.current = activeEventSeed;
  const beginObservationSeed = (sessionId: string): number => {
    const next = beginLiveContentSeed(activeEventSeedRef.current, sessionId);
    activeEventSeedRef.current = next;
    markDisplayPending(sessionId);
    setActiveEventSeed(next);
    return next.generation;
  };
  const completeObservationSeed = (sessionId: string, generation?: number): void => {
    const current = activeEventSeedRef.current;
    const expected = generation ?? current.generation;
    if (current.sessionId !== sessionId || current.generation !== expected) return;
    flushDisplayEvents(sessionId);
    markDisplayReady(sessionId);
    const next = completeLiveContentSeed(current, sessionId, expected);
    activeEventSeedRef.current = next;
    setActiveEventSeed(next);
  };
  useActiveSessionEvents({
    uiLocale,
    activeId,
    activeIdRef,
    handleEvent,
    markSessionReadLocally,
    beginObservationSeed,
    completeObservationSeed,
    setMessageLoadErrorBySession,
    setMessageLoadPending,
    setMessages,
    transcriptRangeRef,
    setSessionEventHealthBySession,
    toastApi,
  });
  let newestDurablePromptSequence: number | null = null;
  try {
    const controller = transcriptRangeRef.current;
    if (controller && controller.store.range().sessionId === activeId) {
      newestDurablePromptSequence = controller.store.newestDurableUserSequence();
    }
  } catch {
    newestDurablePromptSequence = null;
  }
  useEffect(() => {
    const sessionId = activeId;
    if (!sessionId) {
      setTranscriptTurnIndex(undefined);
      return;
    }
    let disposed = false;
    if (
      transcriptTurnIndex?.sessionId === sessionId &&
      (newestDurablePromptSequence === null ||
        (transcriptTurnIndex.throughSequence !== null &&
          newestDurablePromptSequence <= transcriptTurnIndex.throughSequence))
    ) return;
    void window.maka.sessions.listTurnLandmarks(sessionId).then(
      (snapshot) => {
        if (disposed || activeIdRef.current !== sessionId) return;
        setTranscriptTurnIndex({
          sessionId,
          throughSequence: snapshot.throughSequence,
          turns: snapshot.landmarks,
        });
      },
      () => undefined,
    );
    return () => {
      disposed = true;
    };
  }, [activeId, activeIdRef, newestDurablePromptSequence, transcriptTurnIndex]);
  useEffect(() => {
    const target = searchScrollTarget;
    if (!target || target.sessionId !== activeId || target.sequence === undefined) return;
    const sequence = target.sequence;
    const controller = transcriptRangeRef.current;
    if (!controller) return;
    let disposed = false;
    void controller.ready()
      .then(() => controller.loadAround(sequence))
      .then(() => {
        if (
          disposed ||
          transcriptRangeRef.current !== controller ||
          activeIdRef.current !== target.sessionId
        ) return;
        setMessages([...controller.store.snapshot().messages]);
      })
      .catch((error) => {
        if (disposed || activeIdRef.current !== target.sessionId) return;
        setMessageLoadErrorBySession((current) => ({
          ...current,
          [target.sessionId]: localizedShellErrorMessage(
            error,
            desktopConversationCopy.actions.operationFailedFallback,
            uiLocale,
          ),
        }));
      });
    return () => {
      disposed = true;
    };
  }, [activeId, searchScrollTarget?.nonce]);
  useShellRunUpdates({ activeId, setShellRunUpdatesBySession });
  useSessionEventHealthPolling({
    activeId,
    activeInteraction,
    activeSession,
    activeStreamingLive,
    hasInFlightLiveTools,
    refreshMessages,
    refreshSessions,
    sessionEventHealthBySessionRef,
    setSessionEventHealthBySession,
  });
  function captureComposerImportOwner(): ComposerImportOwner {
    return {
      sessionId: activeIdRef.current,
      navSection: navSelectionRef.current.section,
      ...(activeIdRef.current === undefined
        ? { newTaskDraftKey: currentNewTaskDraftKey }
        : {}),
    };
  }

  /**
   * "Is this owner still the surface the user is looking at." One rule, both
   * halves: an async result that lands after the user moved on must not toast,
   * navigate or steal focus, and `selectNavigation` never clears `activeId`
   * (nav-selection.ts) — so the session id alone answers yes long after the
   * user left for 扩展 or 设置.
   *
   * The two below are this same question with a precondition on what KIND of
   * owner the caller wants, not second opinions about the question. They were
   * three independent spellings once, and the one that re-derived it from an
   * id drifted: it lost the section half, which is exactly what let a failed
   * send pull a user out of 技能 and into 设置 · 模型.
   */
  function isShellSurfaceOwnerActive(owner: ComposerImportOwner): boolean {
    return navSelectionRef.current.section === owner.navSection &&
      activeIdRef.current === owner.sessionId &&
      (owner.sessionId !== undefined || owner.newTaskDraftKey === currentNewTaskDraftKey);
  }

  /** …and the owner was captured on the chat surface. */
  function isComposerImportOwnerActive(owner: ComposerImportOwner): boolean {
    return owner.navSection === 'sessions' && isShellSurfaceOwnerActive(owner);
  }

  /** …and it was the new-chat surface, which by definition has no session. */
  function isNewChatSendSurfaceActive(owner: ComposerImportOwner): boolean {
    return owner.sessionId === undefined && isComposerImportOwnerActive(owner);
  }

  async function bootstrapSessions() {
    const next = await refreshSessions();
    bootstrapSelectionLease.reconcile(collapseSessionRevisions(next));
    bootstrapSelectionLease.release();
  }

  function openNewTaskSurface() {
    startNewSession();
    setNewChatPlanModeActive(false);
    setNavSelection({ section: 'sessions' });
    setSearchScrollTarget(null);
    // New-task affordances reset to the empty-state composer; move focus
    // there so the user can start typing immediately.
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function createSession() {
    openNewTaskSurface();
  }

  async function createSessionInProject(projectId: string) {
    if (!newTask.localHost) return;
    newTask.selectProject(newTask.localHost, projectId);
    openNewTaskSurface();
  }

  function openScheduledTaskForm() {
    setNavSelection({ section: 'automations', module: 'scheduled-tasks' });
    closePalette();
    setScheduledTaskCreateRequestNonce((nonce) => nonce + 1);
  }

  /**
   * PR-UI-RENDER-2 - single chokepoint for the Markdown internal-URI
   * router. Receives a typed `MakaUriDest` from the link override in
   * `<Markdown>` and dispatches to the existing app navigation
   * surfaces:
   *
   *   - `kind: 'settings'` → `openSettingsSection(section)` (existing
   *     Settings modal jump, persisted via localStorage).
   *   - `kind: 'compose'` → write text into the composer via
   *     `composerRef.current.setText(...)` and focus it. We do NOT
   *     auto-submit the prompt; the user still presses Enter. That
   *     keeps an injected `maka://compose?text=ransfer my keys...`
   *     from sending without a human in the loop.
   *
   * No other cases exist today by design — the parser only emits
   * these two discriminants. If a new variant is added in `MakaUriDest`,
   * TypeScript's exhaustiveness check below trips and a new branch
   * must be wired here with corresponding fixture and journey coverage.
   */
  function dispatchMakaUri(dest: MakaUriDest) {
    switch (dest.kind) {
      case 'settings':
        openSettingsSection(dest.section);
        return;
      case 'compose':
        composerRef.current?.setText(dest.text);
        composerRef.current?.focus();
        return;
      default: {
        const _exhaustive: never = dest;
        return _exhaustive;
      }
    }
  }

  function closeSettings() {
    setSettingsOpen(false);
    setSettingsProviderCatalogOpen(false);
    // PR110c: re-pull onboarding snapshot when the user closes the
    // Settings modal — they may have just configured a default
    // connection or supplied a credential. Existing connections /
    // sessions events cover most state changes, but a settings-only
    // write (e.g. defaultSlug picked) may not always fire one.
    onboarding.refresh();
    // PR-MEMORY-VISIBILITY-INDICATOR-0: same recompute path for the
    // session-context memory state — user may have just flipped the
    // agentReadEnabled switch.
    void refreshMemoryActive();
    void defaultHostConnections.refreshConnections();
    // Settings pages own optimistic local drafts, so the shell does not see
    // every write live. Refresh its display mirrors on close (e.g. default
    // permission mode) without requiring an app restart.
    void refreshShellSettings();
  }

  function showModelSetupToast(description: string, reason?: string) {
    const copy = modelSetupToastCopy(reason, description, uiLocale);
    toastApi.toast({
      title: copy.title,
      description: !modelSettingsOwnsComposerHost && composerProfileName
        ? shellCopy.configureModelsOnHost(composerProfileName)
        : copy.description,
      variant: 'error',
      duration: 8000,
      ...(modelSettingsOwnsComposerHost
        ? {
            action: {
              label: shellCopy.openModelSettings,
              onClick: () => openSettingsSection('models'),
            },
          }
        : {}),
    });
    if (modelSettingsOwnsComposerHost) openSettingsSection('models');
  }

  const canStageComposerContext = activeId !== undefined || newTask.target !== undefined;

  const activeMessageLoadError = activeId ? messageLoadErrorBySession[activeId] : undefined;
  let activeTranscriptRange;
  try {
    const controller = transcriptRangeRef.current;
    const range = controller?.store.range();
    if (range?.sessionId === activeId) activeTranscriptRange = range;
  } catch {
    activeTranscriptRange = undefined;
  }
  async function loadTranscriptHistory(target: 'earlier' | 'latest') {
    const controller = transcriptRangeRef.current;
    const sessionId = activeId;
    if (!controller || !sessionId || historyLoadPendingSessionId) return;
    setHistoryLoadPendingSessionId(sessionId);
    try {
      if (target === 'earlier') {
        await controller.loadBefore(DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES);
      } else {
        await controller.loadLatest();
      }
    } catch (error) {
      toastApi.error(
        desktopConversationCopy.actions.messageReadFailedTitle,
        localizedShellErrorMessage(
          error,
          desktopConversationCopy.actions.operationFailedFallback,
          uiLocale,
        ),
      );
    } finally {
      setHistoryLoadPendingSessionId((current) => current === sessionId ? undefined : current);
    }
  }
  const homeSurfaceActive =
    navSelection.section === 'sessions' &&
    messages.length === 0 &&
    !hasLiveTurnContent &&
    !activeMessageLoadError;
  const commandOptions: AppShellCommandListOptions = {
    uiLocale,
    activeId,
    activePermissionMode,
    canSetPermissionMode: activeBoundarySurface.localInteractionAvailable,
    clientPathsAccessible:
      activeId
        ? activeProjectCapabilities.viewClientPath
        : projectCapabilities.viewClientPath,
    connections: defaultHostConnections.snapshot.connections,
    defaultConnection: defaultHostConnections.snapshot.defaultConnection,
    dailyReviewBridge,
    messages,
    sessions,
    themePref,
    visibleSessions,
    captureComposerImportOwner,
    composerRef,
    createSession,
    startModeSession,
    isComposerImportOwnerActive,
    openHelp,
    openScheduledTaskForm,
    openProjectFolder,
    openSessionInChat,
    openSideConversation,
    openSettings,
    openSettingsSection,
    openSkillsFolder,
    openWorkspaceFolder,
    refreshConnections: defaultHostConnections.refreshConnections,
    saveDailyReviewMarkdown,
    setNavSelection,
    setPermissionMode,
    setThemePref,
    toastApi,
  };

  const agentsView =
    navSelection.section === 'automations'
      ? navSelection.module === 'daily-review'
        ? 'daily-review'
        : 'cron'
      : navSelection.section === 'extensions'
        ? navSelection.module
        : 'im_hub';

  return (
    <div
      className="appFrame agents-layout-root"
      data-agents-page
      /* The single writer for sidebar state in the DOM. It sits on the frame,
         above both the chrome strip and the shell, so every rule that keys on
         it (shell-layout.css, sidebar.css) reaches its target as a descendant.
         Copies on the shell and the detail panel bought nothing — one had no
         readers at all — and three writers of the same value is three chances
         for them to disagree. */
      data-sidebar-state={sessionListCollapsed ? 'collapsed' : 'expanded'}
      /* Published here for the same reason `data-sidebar-state` is: the frame is
         the only ancestor shared by the sidebar column and the titlebar strip,
         and both need this number. The column is this wide; the titlebar's
         session breadcrumb opens at that edge rather than straddling the seam
         between the columns.

         Only the EXPANDED width, and only as an inline style, because that is
         the half of the answer this component owns — the user's dragged width.
         The collapsed width is a constant, so shell-layout.css states it off
         `data-sidebar-state`. Writing both here would duplicate the constant;
         writing this one unconditionally would bury the other, since an inline
         custom property outranks any rule that redefines it. */
      style={
        sessionListCollapsed
          ? undefined
          : ({
              '--maka-sidenav-width': `${sessionListWidth}px`,
            } as CSSProperties)
      }
    >
      <LiveTurnReconciler
        controller={sessionUiController}
        activeId={activeId}
        messages={messages}
        reconcile={reconcilePersistedMessages}
      />
      {/* Window chrome is frame-level hit-test only (not AppShell topNav): a
          transparent drag overlay so column surfaces paint to the window top.
          It precedes the shell so Chromium applies app-region subtraction from
          one frame-level hit-test surface. */}
      <header
        className="maka-window-titlebar"
        aria-hidden={shellObscured ? 'true' : undefined}
        inert={hasModalOpen ? true : undefined}
      >
        {/* Settings owns the full window chrome. Keep this empty header mounted
            as the frameless window's drag authority, but remove every control
            and identity belonging to the obscured session shell. */}
        {!settingsOpen && (
          <>
            <AppShellTopbarActions
              sidebarCollapsed={sessionListCollapsed}
              onToggleSidebar={() => sessionSideNavHandleRef.current?.getCollapseState()?.toggle()}
              onOpenSearchModal={() => setSearchModalOpen(true)}
            />
            {/* Only a session has an identity to state. The other views name
                themselves in the nav column they are selected from, and the
                new-task surface still shows its project in the composer's
                WorkspacePicker — which stops rendering at the exact moment this
                takes over, when the first message creates the session. */}
            {/* `activeSessionForView`, not `activeSession`: opening or creating a
                session runs a few hundred ms on a placeholder record while the real
                summary loads, and the name this replaced (the context layer's) was
                showing through that window. Hung on the real record alone, 新任务
                was named nowhere for the length of it. */}
            {navSelection.section === 'sessions' && activeSessionForView && (
              <TitlebarSessionIdentity
                /* Keyed by session: the open rename is local state and the field is
                   uncontrolled, so a switch that left the instance mounted would
                   carry one session's half-typed name — and its commit — onto the
                   next one. A remount ties the edit to the session it belongs to. */
                key={activeSessionForView.id}
                sessionName={activeSessionForView.name}
                onRenameSession={(name) => {
                  void sessionRowActionHandlers.renameSession(activeSessionForView.id, name);
                }}
                project={
                  titlebarProjectName
                    ? {
                        name: titlebarProjectName,
                        ...(activeProjectCapabilities.viewClientPath
                          ? { onOpenFolder: () => void openProjectFolder() }
                          : {}),
                      }
                    : undefined
                }
                parentSession={titlebarParentSession}
              />
            )}
            {!VIEWS_WITHOUT_WORKSPACE_ACTIONS.has(agentsView) && (
              <AppShellWorkspaceTopActions
                workbarAvailable={navSelection.section === 'sessions' && Boolean(activeId)}
                workbarCollapsed={workbarCollapsed}
                onToggleWorkbar={toggleWorkbar}
              />
            )}
          </>
        )}
      </header>
      <AstryxAppShell
        className="app maka-shell-astryx agents-layout-body"
        /* Astryx's default: nav column takes --color-background-body, content takes
           --color-background-surface. Both point at the product palette through
           makaTheme.ts, so the shell follows a palette switch. Declared rather
           than defaulted — it decides what separates the two columns. */
        variant="elevated"
        height="fill"
        contentPadding={0}
        mobileNav={{ breakpoint: 'none', hasToggle: false }}
        aria-hidden={shellObscured ? 'true' : undefined}
        inert={shellObscured ? true : undefined}
        sideNav={
          <SessionListPanel
            collapseHandleRef={sessionSideNavHandleRef}
            collapsed={sessionListCollapsed}
            onCollapsedChange={setSessionListCollapsed}
            width={sessionListWidth}
            onWidthChange={(width) => {
              if (width >= SESSION_LIST_EXPANDED_MIN_WIDTH) setSessionListWidth(width);
            }}
            minWidth={SESSION_LIST_EXPANDED_MIN_WIDTH}
            maxWidth={SESSION_LIST_EXPANDED_MAX_WIDTH}
            selection={navSelection}
            sessions={visibleSessions}
            activeId={sidebarActiveId}
            scheduledTasks={scheduledTasks}
            streamingSessionIds={streamingSessionIds}
            staleSessionIds={staleSessionIds}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            groups={viewMode === 'project' ? sessionProjectGroups : undefined}
            worktreeSessionIds={worktreeSessionIds}
            sessionMeta={runtimeHostSessionMeta}
            moduleMemory={navigationState.moduleMemory}
            onSelect={setNavSelection}
            onSelectSession={sessionListSelectSession}
            onOpenSettings={openSettings}
            updateReminder={updateReminder}
            onOpenUpdate={openUpdateDownload}
            onNew={createSession}
            rowActions={sessionRowActions}
            projectActions={projectRowActions}
          />
        }
      >
        <AppShellDetailPanel agentsView={agentsView}>
          {/* PR-UI-RENDER-2: install the internal-URI dispatcher
              for any Markdown rendered inside ChatView (assistant
              answers, thinking panels, streaming bubbles). Wrapping
              at the detail-panel level keeps the provider scoped to
              the chat surface — Markdown rendered elsewhere (e.g.
              About settings) doesn't auto-route maka:// links,
              which is correct: those surfaces shouldn't be a
              navigation entry point. */}
          <MakaUriContext.Provider value={dispatchMakaUri}>
          <div className="maka-detail-with-artifacts">
            <div className="mainColumn" data-home-surface={homeSurfaceActive ? 'true' : undefined}>
              {navSelection.section === 'extensions' && navSelection.module === 'skills' ? (
                <SkillsPage
                  hubHeader={extensionsHubHeader}
                  skills={skills}
                  scheduledTasks={scheduledTasks}
                  onRefreshSkills={() => refreshSkills()}
                  onRefreshManagedSkillSources={() => refreshManagedSkillSources()}
                  onOpenSkill={projectCapabilities.viewClientPath
                    ? (skillId) => openSkill(skillId)
                    : undefined}
                  onUseSkill={useSkillInChat}
                  onOpenSkillsFolder={projectCapabilities.viewClientPath
                    ? () => openSkillsFolder()
                    : undefined}
                  managedSkillSources={managedSkillSources}
                  onImportManagedSkillSource={projectCapabilities.viewClientPath
                    ? () => importManagedSkillSource()
                    : undefined}
                  onInstallManagedSkill={(sourceId) => installManagedSkill(sourceId)}
                  bundledSkillCatalog={bundledSkillCatalog}
                  onRefreshBundledSkillCatalog={() => refreshBundledSkillCatalog()}
                  onInstallBundledSkill={(id) => installBundledSkill(id)}
                  onPreviewManagedSkillUpdate={(skillId) => previewManagedSkillUpdate(skillId)}
                  onUpdateManagedSkill={(skillId, options) => updateManagedSkill(skillId, options)}
                  onSetSkillEnabled={(skillId, enabled) => setSkillEnabled(skillId, enabled)}
                  onSetSkillPinned={(skillRef, pinned) => setSkillPinned(skillRef, pinned)}
                  onDeleteSkill={(skillRef) => deleteSkill(skillRef)}
                />
              ) : navSelection.section === 'extensions' && navSelection.module === 'mcp' ? (
                <McpPage hubHeader={extensionsHubHeader} />
              ) : navSelection.section === 'automations' && navSelection.module === 'scheduled-tasks' ? (
                <ScheduledTasksPage
                  hubHeader={automationsHubHeader}
                  tasks={scheduledTasks}
                  createRequestNonce={scheduledTaskCreateRequestNonce}
                  onCreateRequestHandled={() => setScheduledTaskCreateRequestNonce(0)}
                  keepSystemAwake={
                    keepSystemAwakeController.supported
                      ? keepSystemAwakeController.keepSystemAwake
                      : undefined
                  }
                  onKeepSystemAwakeChange={
                    keepSystemAwakeController.supported
                      ? keepSystemAwakeController.setKeepSystemAwake
                      : undefined
                  }
                    onRefresh={() =>
                      refreshScheduledTasks({
                        shouldShowError: isScheduledTasksSurfaceActive,
                      })
                    }
                  onCreate={(input) => createScheduledTask(input)}
                  onUpdate={(id, patch) => updateScheduledTask(id, patch)}
                  onToggle={(id, enabled) => toggleScheduledTask(id, enabled)}
                  onTriggerNow={(id) => triggerScheduledTaskNow(id)}
                  onSnooze={(id) => snoozeScheduledTask(id)}
                  onClearRunHistory={(id) => clearScheduledTaskRunHistory(id)}
                  onDelete={(id) => deleteScheduledTask(id)}
                />
              ) : navSelection.section === 'automations' && navSelection.module === 'daily-review' ? (
                <DailyReviewPage
                  hubHeader={automationsHubHeader}
                  bridge={dailyReviewBridge}
                  onSelectSession={openSessionInChat}
                  onCopyMarkdown={(input) => copyDailyReviewMarkdown(input, { shouldShowFeedback: isDailyReviewSurfaceActive })}
                  onAppendMarkdown={appendDailyReviewMarkdown}
                  onSaveMarkdown={(input) => saveDailyReviewMarkdown(input, { shouldShowFeedback: isDailyReviewSurfaceActive })}
                />
              ) : null}
              <ChatSurfaceLayout
                // Reset conversation-owned scroll state without remounting the
                // composer: its contenteditable DOM carries the live draft.
                conversationKey={activeId}
                hidden={navSelection.section !== 'sessions'}
                composer={
                  <>
                    {navSelection.section === 'sessions' &&
                    activeId &&
                    activeSessionForView &&
                    !isLinkedSubagentSession(activeSessionForView) ? (
                      <AgentGraphPanel
                        rootSessionId={activeId}
                        enabled={(activeSessionForView.orchestrationMode ?? 'default') === 'graph'}
                        locale={uiLocale}
                        onOpenSession={openSessionInChat}
                      />
                    ) : null}
                    {navSelection.section === 'sessions' ? <PlanExecutionPanel planMode={planMode} /> : null}
                    <ChatComposerRegion
                  workspacePicker={workspacePicker}
                  composerRef={composerRef}
                  active={navSelection.section === 'sessions'}
                  onboardingComposerHidden={
                    onboardingComposerHidden || !activeBoundarySurface.localInteractionAvailable
                  }
                  boundaryUnreadableNotice={boundaryUnreadableNotice}
                  activeInteraction={activeInteraction}
                  activeId={activeId}
                  newTaskDraftKey={currentNewTaskDraftKey}
                  stopPendingBySession={stopPendingBySession}
                  activeSandboxBoundary={activeSandboxBoundary}
                  respondToSandboxBoundary={respondToSandboxBoundary}
                  activeQuestion={activeQuestion}
                  respondToUserQuestion={respondToUserQuestion}
                  stop={stop}
                  // #646: Stop must be available for the WHOLE turn - the moment the
                  // user most wants to interrupt is a long wait with nothing on
                  // screen (first token, or a slow provider's step-to-step lull).
                  // `turnActive` unions the send's zero-lag local arm with the
                  // runtime's live `runningTurnIds` (turns this renderer did not
                  // send), so neither witness can veto the other — see
                  // `deriveTurnActive`. `activeStreamingLive` is folded in
                  // defensively for the rare replay where the arm was over-cleared.
                  streaming={turnActive || activeStreamingLive}
                  // #646: in the first-token wait (Stop up, nothing streams yet) the
                  // hint reads "Maka 正在处理…"; in a mid-turn lull it reads the calm
                  // "Maka 继续中…". Both are mutually exclusive with activeStreamingLive.
                  processing={showProcessingIndicator && !activeStreamingLive}
                  continuing={showContinuingIndicator && !activeStreamingLive}
                  onSend={sendWithAttachments}
                  onStop={stop}
                  revisionNotice={
                    revisionDraft && activeId === revisionDraft.draftSessionId
                      ? {
                          title: getDesktopConversationCopy(uiLocale).actions.revisionBannerTitle,
                          detail: getDesktopConversationCopy(uiLocale).actions.revisionBannerDetail,
                          cancelLabel: getDesktopConversationCopy(uiLocale).actions.revisionCancelLabel,
                          onCancel: () => { void cancelRevisionDraft(); },
                        }
                      : undefined
                  }
                  mentionSkills={mentionSkills}
                  slashCommands={desktopSlashCommands}
                  onSearchMentionFiles={searchMentionFiles}
                  pendingAttachments={pendingAttachments}
                  onRemoveAttachment={removeAttachment}
                  pendingQuotes={pendingQuotes}
                  onRemoveQuote={removeQuote}
                  onPasteAsQuote={canStageComposerContext ? addQuote : undefined}
                  onPickAttachments={
                    !canStageComposerContext ||
                      (revisionDraft && activeId === revisionDraft.draftSessionId)
                      ? undefined
                      : pickAttachments
                  }
                  onAttachFilePaths={
                    !canStageComposerContext ||
                      (revisionDraft && activeId === revisionDraft.draftSessionId)
                      ? undefined
                      : attachFilePaths
                  }
                  modelLabel={activeModelLabel ?? newChatModelLabel ?? undefined}
                  activeSession={activeSessionForView}
                  activeModel={activeModel}
                  activeModelLabel={activeModelLabel}
                  activeProviderType={activeConnection?.providerType}
                  modelChoices={chatModelChoices}
                  modelSwitchHasHistory={modelSwitchHasHistory}
                  renderProviderMark={(type) => <ProviderBrandMark type={type} />}
                  modelChangePending={activeId ? pendingSessionModelBySession[activeId] === true : false}
                  onModelChange={(input) => setSessionModel(input)}
                  activeThinkingLevels={activeThinkingLevels}
                  activeThinkingLevel={activeThinkingLevel}
                  onThinkingLevelChange={(level) => setSessionThinkingLevel(level)}
                  newChatModel={newChatModel}
                  newChatProviderType={newChatProviderType}
                  onPickNewChatModel={(input) => {
                    setPendingNewChatModel(input);
                    if (modelSettingsOwnsComposerHost) saveComposerDefaults({ model: input });
                  }}
                  newChatThinkingLevels={newChatThinkingLevels}
                  newChatThinkingLevel={newChatThinkingLevel}
                  onNewChatThinkingLevelChange={(level) => setPendingNewChatThinkingLevel(level ?? null)}
                  onOpenModelSettings={modelSettingsOwnsComposerHost
                    ? () => openSettingsSection('models')
                    : undefined}
                  noModelConnection={connections.length === 0}
                  noModelHint={!modelSettingsOwnsComposerHost && composerProfileName
                    ? shellCopy.configureModelsOnHost(composerProfileName)
                    : undefined}
                  sendBlocked={
                    Boolean(workspaceReadinessRecovery) ||
                    sessionHealthNotice?.tone === 'destructive' ||
                    taskSubmissionHardBlocked
                  }
                  permissionMode={activePermissionMode}
                  permissionModePending={activeId ? pendingPermissionModeBySession[activeId] === true : false}
                  // Every "cannot change this mid-turn" gate reads `turnActive`,
                  // the same witness Stop reads. Reading the persisted status
                  // here instead left these toggles live through the whole
                  // send→run-start window — long enough on a cold backend for a
                  // mode change to land before the run registers and alter the
                  // execution config of the turn already sent.
                  permissionModeDisabledReason={
                    activeId && pendingPermissionModeBySession[activeId] === true
                        ? shellCopy.permissionModeChanging
                      : activeStreamingLive
                          ? shellCopy.permissionModeStreaming
                        : activeId && turnActive
                            ? shellCopy.permissionModeRunning
                          : activeId && activeSessionForView?.status === 'waiting_for_user'
                              ? shellCopy.permissionModeWaiting
                            : undefined
                  }
                  onPermissionModeChange={
                    activeBoundarySurface.localInteractionAvailable
                      ? (mode) => setPermissionMode(mode)
                      : undefined
                  }
                  planModeActive={activeId
                    ? (activeSessionForView?.collaborationMode ?? 'agent') === 'plan'
                    : newChatPlanModeActive}
                  planModePending={activeId ? pendingCollaborationModeBySession[activeId] === true : false}
                  planModeDisabledReason={
                    activeId && pendingCollaborationModeBySession[activeId] === true
                      ? shellCopy.planModeChanging
                      : activeStreamingLive
                          ? shellCopy.planModeStreaming
                        : activeId && turnActive
                            ? shellCopy.planModeRunning
                          : activeId && activeSessionForView?.status === 'waiting_for_user'
                              ? shellCopy.planModeWaiting
                            : undefined
                  }
                  onPlanModeChange={setPlanMode}
                  swarmModeActive={activeId
                    ? (activeSessionForView?.orchestrationMode ?? 'default') === 'swarm'
                    : newChatSwarmModeActive}
                  swarmModePending={activeId ? pendingOrchestrationModeBySession[activeId] === true : false}
                  swarmModeDisabledReason={
                    activeId && pendingOrchestrationModeBySession[activeId] === true
                      ? shellCopy.swarmModeChanging
                      : activeStreamingLive
                          ? shellCopy.swarmModeStreaming
                        : activeId && turnActive
                            ? shellCopy.swarmModeRunning
                          : activeId && activeSessionForView?.status === 'waiting_for_user'
                              ? shellCopy.swarmModeWaiting
                            : undefined
                  }
                  onSwarmModeChange={(active) => {
                    void setSwarmMode(active);
                  }}
                  graphModeActive={activeId
                    ? (activeSessionForView?.orchestrationMode ?? 'default') === 'graph'
                    : newChatGraphModeActive}
                  graphModePending={activeId ? pendingOrchestrationModeBySession[activeId] === true : false}
                  graphModeDisabledReason={
                    activeId && pendingOrchestrationModeBySession[activeId] === true
                      ? shellCopy.graphModeChanging
                      : activeStreamingLive
                          ? shellCopy.graphModeStreaming
                        : activeId && turnActive
                            ? shellCopy.graphModeRunning
                          : activeId && activeSessionForView?.status === 'waiting_for_user'
                              ? shellCopy.graphModeWaiting
                            : undefined
                  }
                  onGraphModeChange={(active) => {
                    void setGraphMode(active);
                  }}
                    />
                  </>
                }
              >
                {navSelection.section === 'sessions' ? (
                  <ChatMessageSurface
                sessionUiController={sessionUiController}
                activeSessionId={activeId}
                hasOlderHistory={activeTranscriptRange?.hasOlder === true}
                hasNewerHistory={activeTranscriptRange?.hasNewer === true}
                historyLoadPending={historyLoadPendingSessionId === activeId}
                onLoadEarlierHistory={() => loadTranscriptHistory('earlier')}
                onReturnToLatestHistory={() => loadTranscriptHistory('latest')}
                liveContentSeedRevision={liveContentSeedRevision(activeEventSeed, activeId)}
                messages={messages}
                messageLoading={activeMessageLoading}
                runningStatus={showRunningStatus}
                    onStreamingSettled={
                      activeId ? (messageId) => settleAssistantStreaming(activeId, messageId) : undefined
                    }
                activeSession={activeSessionForView}
                activeConnectionLabel={activeConnectionLabel}
                activeModelLabel={activeModelLabel}
                activeProviderType={activeConnection?.providerType}
                renderProviderMark={(type) => <ProviderLogo type={type} compact />}
                modelChoices={chatModelChoices}
                modelChangePending={activeId ? pendingSessionModelBySession[activeId] === true : false}
                onModelChange={(input) => setSessionModel(input)}
                userLabel={userLabel}
                memoryActive={memoryActive}
                onOpenMemorySettings={() => openSettingsSection('memory')}
                    goalIndicator={
                      activeGoal
                        ? {
                  condition: activeGoal.condition,
                  status: activeGoal.status,
                  iterations: activeGoal.iterations,
                  maxIterations: activeGoal.maxIterations,
                            onClear: () => {
                              void window.maka.goal.clear(activeGoal.sessionId).catch((error) => {
                                toastApi.error(
                                  shellCopy.goalClearFailedTitle,
                                  localizedShellErrorMessage(
                                    error,
                                    shellCopy.goalClearFailedFallback,
                                    uiLocale,
                                  ),
                                );
                              });
                            },
                          }
                        : undefined
                    }
                messageLoadError={activeId ? messageLoadErrorBySession[activeId] : undefined}
                messageLoadRetryPending={activeId ? messageRetryPendingBySession[activeId] === true : false}
                onRetryMessages={activeId ? () => void retryMessages(activeId) : undefined}
                deriveTurnPresentation={deriveTurnPresentation}
                onTurnFooterAction={handleTurnFooterAction}
                onEditUserMessage={(turnId) => { void beginEditUserMessage(turnId); }}
                safeResumeAction={activeId ? {
                  pending: resumePendingSessionId === activeId,
                  detail: resumeParkDescriptionBySession[activeId],
                  onResume: () => { void resumeInterruptedSession(); },
                } : undefined}
                onLineageBadgeClick={handleLineageBadgeClick}
                onReadAttachmentBytes={window.maka.attachments.readBytes}
                onOpenLinkedSession={openSessionInChat}
                scrollTargetTurn={
                  activeId && searchScrollTarget?.sessionId === activeId
                        ? {
                            turnId: searchScrollTarget.turnId,
                            nonce: searchScrollTarget.nonce,
                          }
                    : undefined
                }
                transcriptTurnIndex={
                  transcriptTurnIndex && transcriptTurnIndex.sessionId === activeId
                    ? transcriptTurnIndex.turns
                    : undefined
                }
                onLoadTranscriptTurn={activeId
                  ? (target) => openSessionInChat(activeId, target.turnId, target.sequence)
                  : undefined}
                scrollBehavior={readScrollMotionBehavior()}
                branchBanner={branchBanner}
                onBranchBannerClick={handleBranchBannerClick}
                revisionNavigation={revisionNavigation}
                onRevisionNavigate={openSessionInChat}
                onNew={createSession}
                onPromptSuggestion={(prompt) => composerRef.current?.appendText(prompt)}
                onQuoteSelection={(selection) => {
                  addQuote(selection);
                  composerRef.current?.focus();
                }}
                onAskAboutSelection={
                  activeId
                    ? (input) => {
                        const quote: QuoteRef = {
                          text: input.text,
                          sourceTurnId: input.turnId,
                        };
                        openSideConversationWithQuote(quote);
                      }
                    : undefined
                }
                onContinueDeepResearchHandoff={(run) => {
                  const prompt = run.implementationPrompt;
                  if (!prompt) return;
                  void createSession().then(() => {
                    window.requestAnimationFrame(() => {
                      composerRef.current?.setText(prompt);
                      composerRef.current?.focus();
                    });
                  });
                }}
                sessionHealthNotice={sessionHealthNotice}
                workspaceReadinessRecovery={workspaceReadinessRecovery}
                taskReadinessNotice={taskReadinessNotice}
                onTaskReadinessAction={
                  taskReadinessNotice?.action === 'workspace_picker'
                    ? activeSession
                      ? openNewTaskSurface
                      : newTask.selectedHost &&
                          (newTask.selectedHost.capabilities.chooseClientDirectory ||
                            newTask.selectedHost.capabilities.chooseHostDirectory)
                        ? () => {
                            if (newTask.selectedHost) void newTask.addProject(newTask.selectedHost);
                          }
                        : undefined
                    : taskReadiness.refresh
                }
                showOnboardingHero={showOnboardingHero}
                onboardingState={onboardingState}
                isOnboardingLoading={isOnboardingLoading}
                onOpenSettings={(section) => {
                  if (section) openSettingsSection(section);
                  else openSettings();
                }}
                onOpenConnectionDetail={openConnectionDetail}
                onAddProvider={openProviderCreate}
                onBrowseProviders={openProviderCatalog}
                connections={connections}
                onRefreshConnections={refreshConnections}
                onSkip={async () => {
                  try {
                    await window.maka.onboarding.setMilestone('initial_onboarding', 'skipped');
                    onboarding.refresh();
                  } catch (error) {
                    toastApi.error(
                      shellCopy.skipErrorTitle,
                      localizedShellErrorMessage(error, shellCopy.tryAgainLater, uiLocale),
                    );
                  }
                }}
                conversationItems={planConversationItems}
                  />
                ) : null}
              </ChatSurfaceLayout>
            </div>
            {/* Rendered collapsed too: ChatWorkbar's own box is what the
                collapse animates, and it has to be in the tree on both sides of
                the toggle for there to be an animation at all. The column
                inside it still unmounts. */}
            {navSelection.section === 'sessions' && activeId && (
              <ChatWorkbar
                activeId={activeId}
                rightCollapsed={workbarCollapsed}
                bottomOpen={bottomPanelOpen}
                hidden={shellObscured}
                rightWidth={workbarWidth}
                bottomHeight={bottomPanelHeight}
                onDismissPanel={(placement) => {
                  if (placement === 'right') setWorkbarCollapsed(true);
                  else setBottomPanelOpen(false);
                }}
                panelsState={workbarPanelsState}
                onActivateTab={activateWorkbarTab}
                onCloseTab={closeWorkbarTabAndSurface}
                onCloseTabs={closeWorkbarTabsAndSurfaces}
                onReorderTab={reorderWorkbarTab}
                onMoveTab={moveWorkbarTab}
                onMoveTabToPanel={moveWorkbarTabToPanel}
                onPinTab={pinWorkbarTab}
                onOpenLauncher={(placement) => {
                  openWorkbarLauncher(placement);
                  if (placement === 'right') setWorkbarCollapsed(false);
                  else setBottomPanelOpen(true);
                }}
                onRequestOpenTab={requestOpenWorkbarTab}
                rightResizable={workbarResizable}
                bottomResizable={bottomPanelResizable}
                quotes={quotePanels.filter(
                  (panel) => panel.sourceSessionId === activeId,
                )}
                onQuotesConsumed={(snapshot) =>
                  sideConversations.updatePanel(snapshot.panelId, (panel) =>
                    consumeCompanionQuoteSnapshot(panel, snapshot) ?? panel,
                  )
                }
                onRemoveQuote={(target) =>
                  sideConversations.updatePanel(target.panelId, (panel) =>
                    removeStagedCompanionQuote(panel, target) ?? panel,
                  )
                }
                onForkVisibilityChange={onCompanionForkVisibilityChange}
                onContentStateChange={sideConversations.setContent}
                preparingSideChatPanelIds={sideChatPreparingPanelIds}
                activeSideChatPanelIds={sideChatActivePanelIds}
                onPreparingStateChange={sideConversations.setPreparing}
                onInitialPromptStarted={(panelId) =>
                  sideConversations.updatePanel(panelId, (panel) =>
                    consumeCompanionInitialPrompt(panel, panelId) ?? panel,
                  )
                }
                onPromptAccepted={(panelId, prompt) => {
                  const title = sideChatTitleFromPrompt(prompt);
                  if (title) {
                    titleWorkbarTab(`side-chat:${panelId}`, title);
                  }
                }}
                onActivityStateChange={sideConversations.setActive}
                sourceSession={activeSessionForView}
                modelChoices={chatModelChoices}
                mentionSkills={mentionSkills}
                onSearchMentionFiles={searchMentionFiles}
              />
            )}
          </div>
          </MakaUriContext.Provider>
        </AppShellDetailPanel>
      </AstryxAppShell>
      {!shellObscured && (
        <CustomPetCompanion
          activityState={petActivityState}
          completionNonce={petCompletionNonce}
          contextKey={activeId}
        />
      )}
      <SideChatCloseConfirmation
        key={pendingSideChatClose.map(({ tab }) => tab.id).join(':') || 'closed'}
        open={pendingSideChatClose.length > 0}
        sideChatCount={
          pendingSideChatClose.filter(({ tab }) => tab.kind === 'side-chat').length
        }
        onCancel={() => setPendingSideChatClose([])}
        onConfirm={(skipFutureConfirmations) => {
          const pending = pendingSideChatClose;
          if (pending.length === 0) return;
          if (skipFutureConfirmations) {
            setSkipSideChatCloseConfirmation(true);
            safeLocalStorageSet(SKIP_SIDE_CHAT_CLOSE_CONFIRMATION_KEY, 'true');
          }
          setPendingSideChatClose([]);
          const byPlacement = {
            right: pending
              .filter(({ placement }) => placement === 'right')
              .map(({ tab }) => tab),
            bottom: pending
              .filter(({ placement }) => placement === 'bottom')
              .map(({ tab }) => tab),
          };
          closeWorkbarTabsImmediately('right', byPlacement.right);
          closeWorkbarTabsImmediately('bottom', byPlacement.bottom);
        }}
      />

      <RuntimeHostSshTerminalDialog />

      <RemoteProjectDirectoryDialog
        host={newTask.directoryHost ? {
          profileId: newTask.directoryHost.profile.id,
          hostId: newTask.directoryHost.hostId,
          name: newTask.directoryHost.profile.name,
        } : undefined}
        onClose={newTask.closeDirectoryPicker}
        onRegistered={(project, host) => {
          void newTask.acceptRegisteredProject(project, host).catch((error) => {
            toastApi.error(
              projectActionsCopy.projectUpdateFailedTitle,
              localizedShellErrorMessage(
                error,
                projectActionsCopy.projectUpdateFailedFallback,
                uiLocale,
              ),
            );
          });
        }}
      />

      <AppShellOverlays
        settingsOpen={settingsOpen}
        closeSettings={closeSettings}
        themePref={themePref}
        setThemePref={setThemePref}
        themePalette={themePalette}
        setThemePalette={setThemePalette}
        setUiLocalePreference={setUiLocalePreference}
        uiLocaleUpdateGate={uiLocaleUpdateGate}
        setUserLabel={setUserLabel}
        setDefaultPermissionMode={setDefaultPermissionMode}
        settingsRequestedSection={settingsRequestedSection}
        settingsProviderCatalogOpen={settingsProviderCatalogOpen}
        settingsConnectionDetailSlug={settingsConnectionDetailSlug}
        settingsCreateProviderType={settingsCreateProviderType}
        onOpenDailyReview={() => {
          closeSettings();
          setNavSelection({ section: 'automations', module: 'daily-review' });
        }}
        onOpenKeyboardHelp={openHelp}
        onOpenSettingsSession={(sessionId) => {
          closeSettings();
          openSessionInChat(sessionId);
        }}
        archivedTasks={archivedTasksBridge}
        helpOpen={helpOpen}
        closeHelp={closeHelp}
        searchModalOpen={searchModalOpen}
        closeSearchModal={closeSearchModal}
        searchModalDeps={searchModalDeps}
        searchModalOnNavigate={searchModalOnNavigate}
        paletteOpen={paletteOpen}
        closePalette={closePalette}
        commandOptions={commandOptions}
        /* Seeding is for the navigation, not for correctness: the import IPC
           already emits `sessions:changed`, so the task reaches the rail on its
           own even if the user closes Settings mid-import. Seeding it here just
           means `openSessionInChat` has something to open without waiting for
           the refresh to land. */
        onExternalSessionImported={(session) => {
          upsertSessionSummary(session);
          closeSettings();
          openSessionInChat(session.id);
        }}
      />
    </div>
  );
}

function runtimeHostSessionMeta(session: DesktopSessionSummary): string | undefined {
  return session.profileKind === 'remote' ? session.profileName : undefined;
}

function deriveDesktopSessionGroups(
  sessions: readonly DesktopSessionSummary[],
  projects: readonly ProjectRecord[],
  locale: UiLocale,
): SessionHistoryGroup[] {
  const local: DesktopSessionSummary[] = [];
  const remote = new Map<string, { label: string; sessions: DesktopSessionSummary[] }>();
  for (const session of sessions) {
    if (session.profileKind !== 'remote') {
      local.push(session);
      continue;
    }
    const key = session.profileId;
    const group = remote.get(key) ?? {
      label: session.profileName,
      sessions: [],
    };
    group.sessions.push(session);
    remote.set(key, group);
  }
  return [
    ...deriveProjectGroups(local, projects, locale),
    ...[...remote].map(([id, group]) => ({
      id: `runtime-host:${id}`,
      label: group.label,
      sessions: group.sessions,
    })),
  ];
}
