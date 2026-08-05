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
import type {
  PlanReminder,
  QuoteRef,
  SessionSummary,
  UiLocale,
  UiLocalePreference,
} from '@maka/core';
import {
  collapseSessionRevisions,
  filterLinkedSessionTree,
  hasSettledInitialOnboarding,
  isLinkedSubagentSession,
  parseGraphCommand,
  parseSwarmCommand,
  projectRevisionLinkedSessionTree,
  resolveUiLocale,
} from '@maka/core';
import {
  AutomationsPage,
  DailyReviewPage,
  ChatSurfaceLayout,
  type ComposerHandle,
  type MakaUriDest,
  MakaUriContext,
  AstryxLocaleProvider,
  LocaleProvider,
  ModuleHubSelector,
  ToastProvider,
  type NavSelection,
  SessionListPanel,
  SkillsPage,
  type SessionViewMode,
  type TurnFooterActionMeta,
  type WorkspacePickerModel,
  useToast,
  activeInteractionFor,
  enqueueInteraction,
  getConversationCopy,
  getSharedUiCopy,
  reconcileInteractions,
} from '@maka/ui';
import { useKeyboardHelp } from './keyboard-help';
import { useCommandPalette } from './command-palette';
import { ChatMessageSurface } from './chat-message-surface';
import { LiveTurnReconciler } from './live-turn-reconciler';
import { useAppShellSessionUiReads } from './use-app-shell-session-ui-reads';
import { AgentGraphPanel } from './agent-graph-panel';
import { ChatComposerRegion } from './chat-composer-region';
import { ChatWorkbar } from './chat-workbar';
import {
  consumeCompanionQuoteSnapshot,
  removeStagedCompanionQuote,
  stageCompanionQuote,
  type QuoteCompanionPanelState,
} from './quote-companion-panel-state';
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
import type { AppUpdateStatus, OnboardingSnapshot } from '../preload/bridge-contract.js';
import {
  isAppUpdateInstallFailure,
  requestDownloadedAppUpdate,
} from './app-update-install';
import { ProviderLogo } from './settings/provider-display';
import { ProviderBrandMark } from './settings/provider-brand-marks';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy';
import { getDesktopConversationCopy } from './locales/conversation-copy';
import { ErrorBoundary } from './error-boundary';
import { useShellAppearance } from './use-shell-appearance';
import { useShellSearch } from './use-shell-search';
import { useSessionGoal } from './use-session-goal';
import { deriveStaleSessionIds } from './stale-sessions';
import { deriveProjectGroups, deriveWorktreeSessionIds } from './session-project-grouping';
import { useAppShellTurnPresentation } from './app-shell-turn-view-model';
import { readScrollMotionBehavior } from './scroll-motion-policy';
import { deriveBranchBanner } from './branch-banner';
import { readNavigationState, selectNavigation } from './nav-selection';
import { sessionMatchesNavSelection } from './session-nav-filter';
import { deriveSessionRevisionNavigation } from './session-revisions';
import { deriveDesktopExecutionBoundarySurface } from './desktop-execution-boundary-surface';
import { useActiveExecutionBoundary } from './use-active-execution-boundary';
import {
  SESSION_LIST_EXPANDED_MAX_WIDTH,
  SESSION_LIST_EXPANDED_MIN_WIDTH,
} from './session-list-layout';
import { modelSetupToastCopy } from './model-connection-errors';
import type { AppShellCommandListOptions } from './app-shell-command-actions';
import { AppShellTopbarActions, AppShellWorkspaceTopActions } from './app-shell-chrome-actions';
import { AppShellDetailPanel } from './app-shell-detail-panel';
import { AppShellOverlays } from './app-shell-overlays';
import { createAppShellDailyReviewBridge } from './app-shell-daily-review-bridge';
import { useAppShellModuleData } from './use-module-data';
import { useKeepSystemAwake } from './use-keep-system-awake';
import { useAppShellProjectContext } from './use-project-context';
import { createAppShellSessionEventHandlers } from './app-shell-session-events';
import { createAppShellE2eFixtureActions } from './app-shell-e2e-fixture';
import {
  createAppShellChatActions,
  type WorkspaceFileReferencePosition,
} from './app-shell-chat-actions';
import { createAppShellTurnActions } from './app-shell-turn-actions';
import {
  createAppShellRevisionActions,
  type TurnRevisionDraft,
} from './app-shell-revision-actions';
import { createAppShellSessionStartActions } from './app-shell-session-start-actions';
import { createAppShellDailyReviewActions } from './app-shell-daily-review-actions';
import { createAppShellSessionRowActions } from './app-shell-session-row-actions';
import { createAppShellSessionSettingsActions } from './app-shell-session-settings-actions';
import { createAppShellStopAction } from './app-shell-stop-action';
import { useStableActions } from './use-stable-actions';
import { useVoiceInput } from './use-voice-input';
import {
  useActiveSessionEvents,
  useAppShellBootstrapSubscriptions,
  useAppShellHostEffects,
  useAppShellPersistenceEffects,
  useAppShellNavRefSync,
  useSessionEventHealthPolling,
  useShellRunUpdates,
  useSettledSessionTransientReconcile,
} from './app-shell-effects';
import { loadComposerDefaults, saveComposerDefaults } from './composer-defaults';
import { useKeyedPendingRegistry } from './use-pending-action-registry';
import { useAppShellComposerAttachments } from './use-app-shell-composer-attachments';
import { useAppShellComposerQuotes } from './use-app-shell-composer-quotes';
import { useComposerMentions } from './use-composer-mentions';
import { useAppShellSessionWorkspace } from './use-app-shell-session-workspace';
import { useShellMemoryPill } from './use-shell-memory-pill';
import { useShellConnections } from './use-shell-connections';
import { useShellChatModel } from './use-shell-chat-model';
import { useShellLiveTurn } from './use-shell-live-turn';
import { useShellLayout } from './use-shell-layout';
import { useShellResume } from './use-shell-resume';

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
};

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

  return (
    <LocaleProvider locale={uiLocale} override={uiLocaleOverride}>
      {/* #1565: Astryx's message catalog is keyed off OUR locale context, so it
          must sit inside LocaleProvider — not at the `<Theme>` level, where
          `useUiLocale()` throws before anything renders. Still above every
          Astryx subtree. */}
      <AstryxLocaleProvider>
        <ToastProvider>
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
    clearTurnTransientState,
  } = useAppShellSessionWorkspace(toastApi);
  const interactionHydrationEpochRef = useRef(new Map<string, number>());
  const markInteractionChanged = useCallback((sessionId: string) => {
    const epochs = interactionHydrationEpochRef.current;
    epochs.set(sessionId, (epochs.get(sessionId) ?? 0) + 1);
  }, []);

  const attachmentDraftKey = activeId ?? 'new-session';
  const {
    pendingAttachments,
    pickAttachments,
    attachFilePaths,
    removeAttachment,
    clearSubmittedAttachments,
  } = useAppShellComposerAttachments({ draftKey: attachmentDraftKey, toastApi });
  const { pendingQuotes, addQuote, removeQuote, clearQuotes } = useAppShellComposerQuotes({
    draftKey: attachmentDraftKey,
  });
  const [newChatPlanModeActive, setNewChatPlanModeActive] = useState(false);
  const [planReminderCreateRequestNonce, setPlanReminderCreateRequestNonce] = useState(0);
  const [pendingCollaborationModeBySession, setPendingCollaborationModeBySession] = useState<Record<string, boolean>>({});
  const [newChatSwarmModeActive, setNewChatSwarmModeActive] = useState(false);
  const [newChatGraphModeActive, setNewChatGraphModeActive] = useState(false);
  const [pendingOrchestrationModeBySession, setPendingOrchestrationModeBySession] = useState<Record<string, boolean>>({});
  // P3: session ids with a live embedded-browser view. The right-side
  // BrowserPanel mounts only for these, so ordinary chats reserve no space.
  const [liveBrowserSessionIds, setLiveBrowserSessionIds] = useState<string[]>([]);
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
  // PR-MEMORY-VISIBILITY-INDICATOR-0: session-context memory state (MEMORY.md
  // injected into the system prompt). State and the fire-and-forget refresh
  // live in `useShellMemoryPill`; recompute is triggered on mount (bootstrap
  // subscriptions) and when Settings closes (closeSettings).
  const { memoryActive, refreshMemoryActive } = useShellMemoryPill({ toastApi, uiLocale });
  const {
    connections,
    connectionsRevision,
    defaultConnection,
    setConnections,
    setDefaultConnection,
    refreshConnections,
    handleConnectionEvent,
  } = useShellConnections({ toastApi, uiLocale });
  const onboarding = useOnboardingSnapshot(initialOnboardingSnapshot);
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
    voiceCaptureConfigured,
    refreshShellSettings,
  } = useShellAppearance({
    toastApi,
    uiLocale,
    setUiLocaleOverride,
    setUiLocalePreference,
  });
  const shellCopy = getShellCopy(uiLocale).app;
  const voiceCopy = getDesktopConversationCopy(uiLocale).voice;
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

  const updateReminder =
    appUpdateStatus?.state === 'available' ||
    appUpdateStatus?.state === 'downloading' ||
    appUpdateStatus?.state === 'downloaded' ||
    (appUpdateStatus?.state === 'error' && Boolean(appUpdateStatus.latestVersion))
    ? {
        state: appUpdateStatus.state,
        latestVersion: appUpdateStatus.latestVersion ?? appUpdateStatus.currentVersion,
        progressPercent: appUpdateStatus.state === 'downloading' ? appUpdateStatus.progress.percent : undefined,
      }
    : undefined;
  const openUpdateDownload = useCallback(() => {
    if (appUpdateStatus?.state === 'downloaded') {
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
    if (
      appUpdateStatus?.state === 'available' ||
      appUpdateStatus?.state === 'downloading' ||
      appUpdateStatus?.state === 'error'
    ) {
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
      return;
    }
    void window.maka.app
      .openUpdateDownload()
      .then((result) => {
        if (result.ok) return;
        toastApi.error(
          shellCopy.updateOpenFailedTitle,
          shellCopy.updateOpenManualFallback,
        );
      })
      .catch((error) => {
        toastApi.error(
          shellCopy.updateOpenFailedTitle,
          localizedShellErrorMessage(error, shellCopy.tryAgainLater, uiLocale),
        );
      });
  }, [appUpdateStatus, shellCopy, toastApi, uiLocale]);
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
  const [viewMode, setViewMode] = useState<SessionViewMode>('conversation');
  const composerRef = useRef<ComposerHandle>(null);
  // The rail's toggle has to reach Astryx's resizable state, not just this
  // boolean — see the prop's note on SessionListPanel. The sidenav is mounted
  // for the whole shell, so the handle is always live by the time it is called.
  const sessionSideNavHandleRef = useRef<SideNavImperativeCollapseHandle | null>(null);
  // Codex-style quote side panel: a companion (fork of the main session) opened
  // from text selections in the transcript, surfaced as a transient workbar tab.
  // `quotes` accumulates excerpts staged for the next follow-up — selecting more
  // text adds to the SAME panel rather than opening a new one; `sourceSessionId`
  // pins it to the main session the companion forks from.
  const [quotePanel, setQuotePanel] = useState<QuoteCompanionPanelState | null>(null);
  // Created companion forks stay hidden until authoritative cleanup succeeds or
  // a later authoritative session list confirms they are gone. A set preserves
  // earlier failed cleanups when another companion opens.
  const [hiddenCompanionForkIds, setHiddenCompanionForkIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
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
        knownConnectionSlugs: new Set(connections.map((connection) => connection.slug)),
      }),
    [sessions, connections],
  );
  // Status-grouped sidebar. The `chats`
  // filter shows sessions grouped by SessionStatus (Pinned →
  // Running → Waiting → Blocked → Active → Review → Done → Archived);
  // `aborted` is dropped. Pinned (flagged) sessions float to the top
  // in their own group, preserving the PR48 pin-floats behavior.
  const sidebarSessionTree = useMemo(
    () => projectRevisionLinkedSessionTree(sessions, activeId),
    [sessions, activeId],
  );
  const visibleSessionTree = useMemo(
    () =>
      // Exclude the quote companion's ephemeral fork so it stays hidden from the
      // main session list while its panel is open.
      filterLinkedSessionTree(sidebarSessionTree, (session) =>
        !hiddenCompanionForkIds.has(session.id)
          ? sessionMatchesNavSelection(session, navSelection)
          : false,
      ),
    [sidebarSessionTree, navSelection, hiddenCompanionForkIds],
  );
  const visibleSessions = visibleSessionTree.roots;
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
  // The shell's reading of the active live turn: streaming/settled flags, the
  // in-flight tool signal, and the #646 turn-wait cues, all derived from the
  // semantic snapshot rather than the projection (#1985).
  const {
    activeStreamingLive,
    activeStreamingMessageId,
    hasInFlightLiveTools,
    hasLiveTurnContent,
    turnActive,
    showProcessingIndicator,
    showContinuingIndicator,
  } = useShellLiveTurn({
    liveTurn: activeLiveTurnSnapshot,
    activeSession,
  });
  // Surface a credential-lifecycle alert directly in the chat header when
  // the active session's connection is in `needs_reauth` / `error` or has
  // been deleted entirely with no usable default. We skip the async hasSecret
  // fetch here — the composer-adjacent notice is a hard-block surface;
  // AccountSettingsPage remains the authoritative detailed view. Model /
  // thinking selection + the hard-only health notice live in useShellChatModel
  // (pure derivation of the connection list + active session);
  // openSettingsSection is injected so the notice can wrap the derived click
  // target.
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
    connectionsRevision,
    defaultConnection,
    activationCandidate: onboardingActivationCandidate,
    activeSession,
    // Only trust the loaded transcript once the active session's
    // messages finished loading; during the load the list may still be
    // empty or carry the previous session.
    activeSessionHasUserMessage: !messageLoadPending && messages.some((message) => message.type === 'user'),
    persistedComposerDefaults,
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
    pendingPermissionModeChangesRef: permissionModeChangeRegistry.keysRef,
    pendingSessionModelChangesRef: sessionModelChangeRegistry.keysRef,
    refreshSessions,
    saveComposerDefaults,
    sessionsRef,
    setDefaultPermissionMode,
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

  function openSessionInChat(sessionId: string, turnId?: string): void {
    setNavSelection({ section: 'sessions', filter: 'chats' });
    setActiveId(sessionId);
    if (turnId) {
      setSearchScrollTarget({ sessionId, turnId, nonce: Date.now() });
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
    setNavSelection({ section: 'sessions', filter: 'chats' });
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
  const activeBoundarySurface = deriveDesktopExecutionBoundarySurface(
    activeId,
    activeExecutionBoundary,
    activeId ? (activeSessionForView?.permissionMode ?? 'ask') : defaultPermissionMode,
  );
  const activePermissionMode = activeBoundarySurface.permissionMode;
  const planMode = usePlanModeState(activeSessionForView);
  const planConversationItems = (planMode.state?.proposals ?? []).map((proposal) => ({
    id: proposal.proposalId,
    afterTurnId: proposal.turnId,
    content: <PlanProposalCard proposal={proposal} planMode={planMode} />,
  }));
  const activeMessageLoading = Boolean(activeId && messageLoadPending);
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
  // `sessions:list` / `connections:list` / `getDefault` IPCs are redundant.
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
      void refreshConnections();
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
    // Seed connections — avoids separate connections:list + getDefault IPCs
    setConnections(snapshot.connections);
    setDefaultConnection(snapshot.defaultSlug);
    if (releaseSelectionLease) bootstrapSelectionLease.release();
  }, [initialOnboardingSnapshot, onboarding.mountedSnapshotHandoff, onboarding.error]);
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
    workbarWidth,
    workbarResizable,
    workbarTab,
    setWorkbarTab,
  } = useShellLayout();

  // The companion panel unmounts (and its fork is removed) when the workbar
  // collapses or the active session moves off the panel's source; clear the
  // stale panel state too, so returning doesn't reopen a blank companion tab.
  useEffect(() => {
    if (quotePanel && (workbarCollapsed || quotePanel.sourceSessionId !== activeId)) {
      setQuotePanel(null);
    }
  }, [quotePanel, workbarCollapsed, activeId]);

  function isAutomationsSurfaceActive(): boolean {
    return navSelectionRef.current.section === 'automations' && navSelectionRef.current.module === 'plan-reminders';
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
    planReminders,
    refreshPlanReminders,
    createPlanReminder,
    updatePlanReminder,
    togglePlanReminder,
    triggerPlanReminderNow,
    snoozePlanReminder,
    clearPlanReminderRunHistory,
    deletePlanReminder,
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
    isAutomationsSurfaceActive,
    toastApi,
  });

  // 保持系统唤醒 capability for the 定时任务 page: reads/writes
  // settings.system.keepSystemAwake over the existing settings bridge. When
  // the bridge is absent the panel hides the row (fail-soft).
  const keepSystemAwakeController = useKeepSystemAwake();

  const {
    projectInfo,
    projects,
    selectedProjectId,
    currentProjectId,
    currentProject,
    projectPickerPending,
    projectPickerPendingRef,
    projectPickerRequestRef,
    refreshAppInfo,
    refreshProjects,
    addProject,
    selectProject,
    selectNoProject,
    prepareDefaultProject,
    prepareProject,
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
    onProjectSelected: (ownerSessionId) => {
      if (ownerSessionId && activeIdRef.current === ownerSessionId) openNewTaskSurface();
    },
    toastApi,
  });
  // Where a NEW chat starts. Built unconditionally and handed to the composer,
  // which renders it only while no session owns it — the project is fixed once
  // the first message creates one, so there is nothing to pick after that.
  const workspacePicker: WorkspacePickerModel = {
    label:
      currentProject?.name ??
      (currentProjectId === null
        ? getConversationCopy(uiLocale).workspace.noProject
        : undefined),
    branch: currentProjectId === null ? null : projectInfo?.projectGit.branch,
    pending: projectPickerPending,
    projects: projects.filter((project) => project.archivedAt === undefined),
    selectedProjectId: currentProjectId,
    onAdd: () => {
      void addProject();
    },
    onSelectProject: (projectId: string) => {
      void selectProject(projectId);
    },
    onRelink: (projectId: string) => {
      void relinkProject(projectId, true);
    },
    onSelectNoProject: selectNoProject,
  };
  const sessionProjectGroups = useMemo(
    () => deriveProjectGroups(visibleSessions, projects, uiLocale),
    [visibleSessions, projects, uiLocale],
  );
  const worktreeSessionIds = useMemo(
    () => deriveWorktreeSessionIds(visibleSessions, projects),
    [visibleSessions, projects],
  );
  const { startModeSession } = useStableActions(createAppShellSessionStartActions, {
    uiLocale,
    activeIdRef,
    captureComposerImportOwner,
    composerRef,
    isShellSurfaceOwnerActive,
    openSessionInChat,
    newChatProjectId: selectedProjectId,
    sessionStartPendingRef,
    refreshOnboarding: onboarding.refresh,
    refreshSessions,
    showModelSetupToast,
    toastApi,
  });
  const projectRowActions: NonNullable<Parameters<typeof SessionListPanel>[0]['projectActions']> = {
    onNew: createSessionInProject,
    onRename: renameProject,
    onArchive: archiveProject,
    onRestore: restoreProject,
    onRelink: async (projectId) => {
      await relinkProject(projectId);
    },
  };

  // Composer mention popups: `/` uses Runtime's session/project-aware,
  // host-compatible projection; `@` uses workspace file search. Keep the
  // resolved project path as a refresh key for new-chat project changes.
  const { mentionSkills, searchMentionFiles } = useComposerMentions({
    skills,
    sessionId: activeId,
    projectPath: projectInfo?.projectPath,
    newSessionModel: newChatModel,
    newSessionCollaborationMode: newChatPlanModeActive ? 'plan' : 'agent',
  });

  const { applyE2eFixture } = useStableActions(createAppShellE2eFixtureActions, {
    openPalette,
    composerRef,
    openSettingsSection,
    openConnectionDetail,
    refreshSessions,
    setActiveId,
    setLiveBrowserSessionIds,
    setLiveTurnBySession,
    setNavSelection,
    setInteractionBySession,
    setSearchModalOpen,
    setSessionListCollapsed,
    setWorkbarCollapsed,
    setWorkbarTab,
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
    newChatCollaborationMode: newChatPlanModeActive ? 'plan' : 'agent',
    newChatOrchestrationMode: newChatGraphModeActive
      ? 'graph'
      : newChatSwarmModeActive
        ? 'swarm'
        : 'default',
    newChatProjectId: selectedProjectId,
  });

  const voiceInput = useVoiceInput({
    getDraftKey: () => activeIdRef.current ?? 'new-session',
    getCurrentAgent: () => {
      if (activeIdRef.current && activeSessionForView) {
        return {
          connectionSlug: activeSessionForView.llmConnectionSlug,
          model: activeSessionForView.model,
        };
      }
      return newChatModel
        ? {
            connectionSlug: newChatModel.llmConnectionSlug,
            model: newChatModel.model,
          }
        : undefined;
    },
    appendTranscript: (draftKey, text) => {
      composerRef.current?.appendDraft?.(draftKey, text);
    },
    sendNativeVoice: (operationId) =>
      send(
        'Listen to the attached audio and carry out the user request. The audio is authoritative.',
        undefined,
        {
          voiceOperationId: operationId,
          displayText: voiceCopy.taskDisplayText,
        },
      ),
    runCoordinatorTool: async (call, context) => {
      if (call.name === 'start_task') {
        if (!call.arguments.task) throw new Error('voice_task_missing');
        let taskSessionId: string | undefined;
        const ok = await send(call.arguments.task, undefined, {
          onSessionResolved: (sessionId) => {
            taskSessionId = sessionId;
          },
        });
        return {
          output: {
            ok,
            ...(taskSessionId ? { sessionId: taskSessionId } : {}),
          },
          ...(ok && taskSessionId ? { taskSessionId } : {}),
        };
      }
      const sessionId = context.taskSessionId;
      if (!sessionId) {
        return { output: { ok: false, status: 'no_active_task' } };
      }
      if (call.name === 'steer_task') {
        if (!call.arguments.guidance) throw new Error('voice_guidance_missing');
        const outcome = await window.maka.sessions.steer(
          sessionId,
          call.arguments.guidance,
        );
        if (outcome.kind === 'fallback') {
          const sendResult = await window.maka.sessions.send(sessionId, {
            type: 'send',
            turnId: crypto.randomUUID(),
            text: call.arguments.guidance,
          });
          await refreshSessions();
          if (activeIdRef.current === sessionId) {
            await refreshMessages(sessionId);
          }
          return {
            output: { ok: sendResult.ok, fallback: true, sessionId },
            taskSessionId: sessionId,
          };
        }
        return {
          output: { ok: true, queued: true, sessionId },
          taskSessionId: sessionId,
        };
      }
      if (call.name === 'check_task') {
        const authoritativeSessions = await refreshSessions();
        const session = authoritativeSessions.find((candidate) => candidate.id === sessionId);
        return {
          output: session
            ? { ok: true, sessionId: session.id, status: session.status }
            : { ok: false, sessionId, status: 'task_not_found' },
          ...(session ? { taskSessionId: sessionId } : {}),
        };
      }
      const taskMessages = await window.maka.sessions.readMessages(sessionId);
      const lastAssistant = [...taskMessages]
        .reverse()
        .find((message) => message.type === 'assistant');
      return {
        output: {
          ok: true,
          sessionId,
          summary:
            lastAssistant?.type === 'assistant'
              ? lastAssistant.text.slice(-4_000)
              : voiceCopy.noTaskResponse,
        },
        taskSessionId: sessionId,
      };
    },
    onBlocked: (reason) => {
      const configure =
        reason === 'recognition_not_configured' ||
        reason === 'realtime_not_configured';
      toastApi.error(
        voiceCopy.unavailableTitle,
        configure
          ? voiceCopy.configureDescription
          : reason,
      );
      if (configure) openSettingsSection('voice');
    },
    onError: (error) => {
      toastApi.error(
        voiceCopy.operationFailedTitle,
        localizedShellErrorMessage(
          error,
          voiceCopy.operationFailedFallback,
          uiLocale,
        ),
      );
    },
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

  async function sendWithAttachments(
    text: string,
    metadata?: { workspaceFileReferences?: readonly WorkspaceFileReferencePosition[] },
  ): Promise<boolean | void> {
    const revision = revisionDraftRef.current;
    const revisionSend = Boolean(
      revision && activeIdRef.current === revision.draftSessionId,
    );
    const swarmCommand = parseSwarmCommand(text);
    const graphCommand = parseGraphCommand(text);
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
      if (text.trim() === '/compact' || swarmCommand || graphCommand) {
        toastApi.info(actionCopy.revisionUnavailableTitle, actionCopy.revisionCommandUnsupported);
        return false;
      }
      if (!(await prepareRevisionSend(text))) return false;
    }
    if (text.trim() === '/compact') {
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
    if (swarmCommand) {
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
    if (graphCommand) {
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
        composerRef.current?.clearDraft(expectedRevisionDraft.draftSessionId);
        if (expectedRevisionDraft.sourceSessionId !== expectedRevisionDraft.draftSessionId) {
          composerRef.current?.clearDraft(expectedRevisionDraft.sourceSessionId);
        }
      }
      commitRevisionDraft(null);
    }
    return ok;
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

  const { handleEvent, reconcilePersistedMessages, settleAssistantStreaming } = useStableActions(createAppShellSessionEventHandlers, {
    uiLocale,
    activeIdRef,
    liveTurnBySessionRef,
    refreshMessages,
    refreshSessions,
    setLiveTurnBySession,
    setInteractionBySession,
    onInteractionChanged: markInteractionChanged,
    onExecutionBoundaryChanged: reloadActiveExecutionBoundary,
    showModelSetupToast,
    toastApi,
    notifyRunEnded: ({ kind, sessionId, body }) => {
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

  useAppShellNavRefSync({
    navSelection,
    navSelectionRef,
  });
  useAppShellHostEffects({
    activeId,
    hasModalOpen,
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
    refreshAppInfo,
    refreshConnections,
    refreshMemoryActive,
    refreshMessages,
    refreshPlanReminders,
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
    workbarCollapsed,
    workbarWidth,
    workbarTab,
    themePalette,
    themePref,
  });
  useActiveSessionEvents({
    uiLocale,
    activeId,
    activeIdRef,
    handleEvent,
    markSessionReadLocally,
    setMessageLoadErrorBySession,
    setMessageLoadPending,
    setMessages,
    setSessionEventHealthBySession,
    toastApi,
  });
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
  useSettledSessionTransientReconcile({
    activeId,
    sessions,
    liveTurnBySessionRef,
    clearTurnTransientState,
  });

  function captureComposerImportOwner(): ComposerImportOwner {
    return {
      sessionId: activeIdRef.current,
      navSection: navSelectionRef.current.section,
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
    return navSelectionRef.current.section === owner.navSection && activeIdRef.current === owner.sessionId;
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
    setNavSelection({ section: 'sessions', filter: 'chats' });
    setSearchScrollTarget(null);
    // New-task affordances reset to the empty-state composer; move focus
    // there so the user can start typing immediately.
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function createSession() {
    if (await prepareDefaultProject()) openNewTaskSurface();
  }

  async function createSessionInProject(projectId: string) {
    if (await prepareProject(projectId)) openNewTaskSurface();
  }

  function openPlanReminderForm() {
    setNavSelection({ section: 'automations', module: 'plan-reminders' });
    closePalette();
    setPlanReminderCreateRequestNonce((nonce) => nonce + 1);
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
    // Settings pages own optimistic local drafts, so the shell does not see
    // every write live. Refresh its display mirrors on close: permission mode
    // and the independently configured voice routes must both update without
    // requiring an app restart.
    void refreshShellSettings();
  }

  function showModelSetupToast(description: string, reason?: string) {
    const copy = modelSetupToastCopy(reason, description, uiLocale);
    toastApi.toast({
      title: copy.title,
      description: copy.description,
      variant: 'error',
      duration: 8000,
      action: {
        label: shellCopy.openModelSettings,
        onClick: () => openSettingsSection('models'),
      },
    });
    openSettingsSection('models');
  }

  const activeMessageLoadError = activeId ? messageLoadErrorBySession[activeId] : undefined;
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
    connections,
    defaultConnection,
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
    openPlanReminderForm,
    openProjectFolder,
    openSessionInChat,
    openSettings,
    openSettingsSection,
    openSkillsFolder,
    openWorkspaceFolder,
    refreshConnections,
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
        aria-hidden={hasModalOpen ? 'true' : undefined}
        inert={hasModalOpen ? true : undefined}
      >
        <AppShellTopbarActions
          sidebarCollapsed={sessionListCollapsed}
          onToggleSidebar={() => sessionSideNavHandleRef.current?.getCollapseState()?.toggle()}
          sidebarToggleHidden={settingsOpen}
          onOpenSearchModal={() => setSearchModalOpen(true)}
        />
        {!VIEWS_WITHOUT_WORKSPACE_ACTIONS.has(agentsView) && (
          <AppShellWorkspaceTopActions
            workbarAvailable={navSelection.section === 'sessions' && Boolean(activeId)}
            workbarCollapsed={workbarCollapsed}
            onToggleWorkbar={() => setWorkbarCollapsed((current) => !current)}
          />
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
        aria-hidden={hasModalOpen ? 'true' : undefined}
        inert={hasModalOpen ? true : undefined}
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
            activeId={activeId}
            planReminders={planReminders}
            streamingSessionIds={streamingSessionIds}
            staleSessionIds={staleSessionIds}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            groups={viewMode === 'project' ? sessionProjectGroups : undefined}
            childSessionsByParentId={visibleSessionTree.childrenByParentId}
            worktreeSessionIds={worktreeSessionIds}
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
                  planReminders={planReminders}
                  onRefreshSkills={() => refreshSkills()}
                  onRefreshManagedSkillSources={() => refreshManagedSkillSources()}
                  onOpenSkill={(skillId) => openSkill(skillId)}
                  onUseSkill={useSkillInChat}
                  onOpenSkillsFolder={() => openSkillsFolder()}
                  managedSkillSources={managedSkillSources}
                  onImportManagedSkillSource={() => importManagedSkillSource()}
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
              ) : navSelection.section === 'automations' && navSelection.module === 'plan-reminders' ? (
                <AutomationsPage
                  hubHeader={automationsHubHeader}
                  reminders={planReminders}
                  createRequestNonce={planReminderCreateRequestNonce}
                  onCreateRequestHandled={() => setPlanReminderCreateRequestNonce(0)}
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
                      refreshPlanReminders({
                        shouldShowError: isAutomationsSurfaceActive,
                      })
                    }
                  onCreate={(input) => createPlanReminder(input)}
                  onUpdate={(id, patch) => updatePlanReminder(id, patch)}
                  onToggle={(id, enabled) => togglePlanReminder(id, enabled)}
                  onTriggerNow={(id) => triggerPlanReminderNow(id)}
                  onSnooze={(id) => snoozePlanReminder(id)}
                  onClearRunHistory={(id) => clearPlanReminderRunHistory(id)}
                  onDelete={(id) => deletePlanReminder(id)}
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
                // #2205: Astryx ChatLayout owns the new-message indicator and
                // the scroll lock, and neither is keyed to a conversation. A
                // session switch must reset both without remounting the layout —
                // a remount would drop an in-progress composer draft. Passing
                // the active session id as conversationKey makes ChatLayout
                // re-lock the scroll and clear the new-message baseline on every
                // switch (undefined while no session is selected).
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
                  voiceCaptureState={voiceInput.captureState}
                  realtimeVoiceState={voiceInput.realtimeState}
                  voiceProviderLabel={voiceInput.providerLabel}
                  onToggleVoiceCapture={
                    voiceCaptureConfigured ? voiceInput.toggleCapture : undefined
                  }
                  onCancelVoiceCapture={
                    voiceCaptureConfigured ? voiceInput.cancelCapture : undefined
                  }
                  onToggleRealtimeVoice={voiceInput.toggleRealtime}
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
                  onSearchMentionFiles={searchMentionFiles}
                  pendingAttachments={pendingAttachments}
                  onRemoveAttachment={removeAttachment}
                  pendingQuotes={pendingQuotes}
                  onRemoveQuote={removeQuote}
                  onPasteAsQuote={addQuote}
                  onPickAttachments={
                    revisionDraft && activeId === revisionDraft.draftSessionId
                      ? undefined
                      : pickAttachments
                  }
                  onAttachFilePaths={
                    revisionDraft && activeId === revisionDraft.draftSessionId
                      ? undefined
                      : attachFilePaths
                  }
                  modelLabel={activeModelLabel ?? newChatModelLabel ?? undefined}
                  activeSession={activeSessionForView}
                  activeConnectionLabel={activeConnectionLabel}
                  activeModel={activeModel}
                  activeModelLabel={activeModelLabel}
                  activeProviderType={activeConnection?.providerType}
                  modelChoices={chatModelChoices}
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
                    saveComposerDefaults({ model: input });
                  }}
                  newChatThinkingLevels={newChatThinkingLevels}
                  newChatThinkingLevel={newChatThinkingLevel}
                  onNewChatThinkingLevelChange={(level) => setPendingNewChatThinkingLevel(level ?? null)}
                  onOpenModelSettings={() => openSettingsSection('models')}
                  noModelConnection={connections.length === 0}
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
                messages={messages}
                messageLoading={activeMessageLoading}
                processingIndicator={showProcessingIndicator}
                continuingIndicator={showContinuingIndicator}
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
                scrollTargetTurn={
                  activeId && searchScrollTarget?.sessionId === activeId
                        ? {
                            turnId: searchScrollTarget.turnId,
                            nonce: searchScrollTarget.nonce,
                          }
                    : undefined
                }
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
                          ...(input.turnId ? { sourceTurnId: input.turnId } : {}),
                        };
                        // Accumulate onto the open panel for this session rather
                        // than spawning a new one; otherwise start a fresh panel.
                        setQuotePanel((prev) =>
                          stageCompanionQuote(prev, {
                            sourceSessionId: activeId,
                            quote,
                            newId: () => crypto.randomUUID(),
                          }),
                        );
                        // Surface it inside the session workbar (as a tab) rather
                        // than a second right column — open the bar on the quote tab.
                        setWorkbarCollapsed(false);
                        setWorkbarTab('quote');
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
                collapsed={workbarCollapsed}
                browserLive={liveBrowserSessionIds.includes(activeId)}
                hidden={hasModalOpen}
                width={workbarWidth}
                onDismiss={() => setWorkbarCollapsed(true)}
                activeTab={workbarTab}
                onActiveTabChange={setWorkbarTab}
                workbarResizable={workbarResizable}
                quote={
                  quotePanel && quotePanel.sourceSessionId === activeId ? quotePanel : null
                }
                onClearQuote={() => setQuotePanel(null)}
                onQuotesConsumed={(snapshot) =>
                  setQuotePanel((prev) => consumeCompanionQuoteSnapshot(prev, snapshot))
                }
                onRemoveQuote={(target) =>
                  setQuotePanel((prev) => removeStagedCompanionQuote(prev, target))
                }
                onForkVisibilityChange={onCompanionForkVisibilityChange}
                sourceSession={activeSessionForView}
                modelChoices={chatModelChoices}
              />
            )}
          </div>
          </MakaUriContext.Provider>
        </AppShellDetailPanel>
      </AstryxAppShell>
      <AppShellOverlays
        settingsOpen={settingsOpen}
        connections={connections}
        defaultConnection={defaultConnection}
        refreshConnections={refreshConnections}
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
        helpOpen={helpOpen}
        closeHelp={closeHelp}
        searchModalOpen={searchModalOpen}
        closeSearchModal={closeSearchModal}
        searchModalDeps={searchModalDeps}
        searchModalOnNavigate={searchModalOnNavigate}
        paletteOpen={paletteOpen}
        closePalette={closePalette}
        commandOptions={commandOptions}
      />
    </div>
  );
}
