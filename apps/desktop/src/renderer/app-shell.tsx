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
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { ProjectRecord } from '@maka/core/project';
import type {
  FollowUpMode,
  InlineReference,
  QuoteRef,
} from '@maka/core/events';
import type { SessionSummary } from '@maka/core/session';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import type { SlashCommandIdForSurface } from '@maka/core/slash-command-catalog';
import type { UiLocale, UiLocalePreference } from '@maka/core/ui-locale';
import { collapseSessionRevisions } from '@maka/core/session-revisions';
import { isLinkedSubagentSession } from '@maka/core/session';
import { resolveUiLocale } from '@maka/core/ui-locale';
import { slashCommandsForSurface } from '@maka/core/slash-command-catalog';
import { hasSettledInitialOnboarding } from '@maka/core/onboarding-milestone';
import {
  ChatSurfaceLayout,
  type ComposerHandle,
  type ComposerSendMetadata,
  type ComposerSlashCommandOption,
  type MakaUriDest,
  MakaUriContext,
  AstryxLocaleProvider,
  LocaleProvider,
  ToastProvider,
  type ToastDiagnosticTarget,
  type ToastErrorAction,
  type NavSelection,
  type ProjectRowActions,
  SessionListPanel,
  TitlebarSessionIdentity,
  type TurnFooterActionMeta,
  useToast,
  activeInteractionFor,
  deriveComposerModelSwitchAvailability,
  deriveTitlebarProjectName,
  enqueueInteraction,
  reconcileInteractions,
} from '@maka/ui';
import type { ConnectionEvent } from '@maka/core/connections';
import { GitBranch, MessageCircleQuestion, Minimize2, Network } from '@maka/ui/icons';
import { Button } from '@astryxdesign/core/Button';
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
import {
  WorkbarHost,
  WorkbarTitlebarActions,
  useWorkbarController,
} from './features/workbar';
import { GoalHost, useGoalController } from './features/goals';
import { ModuleHubHost, useModuleHubController } from './features/module-hub';
import {
  SessionNavigationProvider,
  createSessionOpenCommand,
  sessionRailLayoutStore,
  useSessionNavigationReads,
  type SessionNavigationPorts,
  type SessionNavigationRowActions,
} from './features/session-navigation';
import {
  TaskEntryHost,
  useTaskEntryController,
  type TaskEntryError,
} from './features/task-entry';
import { useNewTaskChoice } from './use-new-task-choice';
import { SessionCollaborationDialog } from './session-collaboration-dialog';
import { SessionTurnRequestComposer } from './session-turn-request-composer.js';
import { getSessionCollaborationCopy } from './locales/session-collaboration-copy';
import { useSessionCollaborationDialog } from './use-session-collaboration-dialog';
import { NEW_TASK_PENDING_KEY } from './pending-items';
import { parseDesktopSlashCommand } from './desktop-slash-command';
import {
  hasActiveTurnAtSubmit,
  mergeWorkspaceReferences,
  rebaseWorkspaceFileReferences,
  resolveFollowUpModeAtSubmit,
} from './follow-up-submit-routing';
import {
  PlanExecutionPanel,
  PlanProposalCard,
  usePlanModeState,
} from './plan-mode-panel';
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
import { createWorkHubController } from './workhub-controller.js';
import { startWorkHubCoordinationLifecycle } from './workhub-coordination-lifecycle.js';
import { scopeWorkHubSessionsToCoordinationHost } from './workhub-coordination-host-scope.js';
import { createDesktopWorkHubSessionPort } from './workhub-session-port.js';
import { createDesktopWorkHubCoordinationPort } from './workhub-coordination-port.js';
import { WorkHubCoordinationStatus, WorkHubSurface } from './workhub-surface.js';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy';
import { getShellRemainingCopy } from './locales/shell-remaining-copy.js';
import { getDesktopConversationCopy } from './locales/conversation-copy';
import { ErrorBoundary } from './error-boundary';
import { useShellAppearance } from './use-shell-appearance';
import { useShellSearch } from './use-shell-search';
import { useSessionSettingIntent } from './use-session-setting-intent';
import { deriveStaleSessionIds } from './stale-sessions';
import { pendingSessionView } from './pending-session-view';
import { useAppShellTurnPresentation } from './app-shell-turn-view-model';
import { readScrollMotionBehavior } from './scroll-motion-policy';
import { readNavigationState, selectNavigation } from './nav-selection';
import { deriveDesktopExecutionBoundarySurface } from './desktop-execution-boundary-surface';
import { useActiveExecutionBoundary } from './use-active-execution-boundary';
import { modelSetupToastCopy } from './model-connection-errors';
import type { AppShellCommandListOptions } from './app-shell-command-actions';
import {
  createContextCompactionPresentation,
  presentContextCompactionResult,
} from './app-shell-context-compaction';
import { AppShellTopbarActions } from './app-shell-chrome-actions';
import { updateReminderFromStatus } from './app-shell-app-update';
import { AppShellDetailPanel } from './app-shell-detail-panel';
import { AppShellOverlays } from './app-shell-overlays';
import type { ArchivedTasksBridge } from './settings/tasks-settings-page';
import { CustomPetCompanion } from './custom-pet-companion';
import { derivePetActivityState } from './custom-pet-companion-model';
import {
  defaultRuntimeHostDiagnosticTarget,
  runOnDefaultRuntimeHost,
} from './default-runtime-host-operation.js';
import { useAppShellProjectContext } from './use-project-context';
import {
  createAppShellSessionDisplayBatch,
  createAppShellSessionEventHandlers,
} from './app-shell-session-events';
import { createAppShellE2eFixtureActions } from './app-shell-e2e-fixture';
import { createAppShellChatActions } from './app-shell-chat-actions';
import { createAppShellTurnActions } from './app-shell-turn-actions';
import {
  abandonTurnRevisionCopyAttempt,
  completeTurnRevisionCopyAttempt,
  createAppShellRevisionActions,
  type TurnRevisionDraft,
} from './app-shell-revision-actions';
import { createAppShellSessionStartActions } from './app-shell-session-start-actions';
import { createAppShellSessionSettingsActions } from './app-shell-session-settings-actions';
import { createAppShellStopAction } from './app-shell-stop-action';
import { useExternalStoreSelector } from './use-external-store-selector';
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
import { useTurnActionRegistry } from './use-turn-action-registry';
import { useComposerAttachments } from './use-composer-attachments';
import { useAppShellComposerQuotes } from './use-app-shell-composer-quotes';
import { ComposerMentionsProvider, type ComposerMentionsSurface } from './composer-mentions';
import { useAppShellSessionWorkspace } from './use-app-shell-session-workspace';
import { useShellMemoryPill } from './use-shell-memory-pill';
import { useShellConnections } from './use-shell-connections';
import { useShellChatModel } from './use-shell-chat-model';
import { useShellLiveTurn } from './use-shell-live-turn';
import { useShellResume } from './use-shell-resume';

import { useSettingsModal } from './use-settings-modal';
import { useSystemUiLocale } from './use-system-ui-locale';
import {
  isSessionWorkspaceUnavailableError,
  showSessionWorkspaceUnavailableToast,
} from './session-workspace-errors';
import { AppShell as AstryxAppShell } from '@astryxdesign/core/AppShell';

type ComposerImportOwner = {
  sessionId: string | undefined;
  navSection: NavSelection['section'];
  newTaskDraftKey?: string;
};

/**
 * Grace period before the committed-history fallback force-settles an
 * assistant stream slot when the primary post-commit signal is missed.
 */
const SETTLE_FALLBACK_GRACE_MS = 1000;
const FIRST_SEND_OBSERVATION_TIMEOUT_MS = 30_000;
type FirstSendObservationWaiter = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof globalThis.setTimeout>;
};
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
      failureTitle: getShellCopy(uiLocale).commandActions.copyFailedTitle,
      failureDescription: getShellCopy(uiLocale).commandActions.clipboardDenied,
      onClick: (input) => window.maka.diagnostics.copyReport({
        surface: 'toast',
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.diagnosticDetails ? { details: input.diagnosticDetails } : {}),
        ...(input.diagnosticTarget ? { target: input.diagnosticTarget } : {}),
      }),
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

/**
 * The Session rail, as one element built once.
 *
 * AppShell re-renders about fourteen times per session switch. Written inline
 * in the JSX below, each of those rebuilt this element and re-rendered the
 * rail's ~1,000 fibers with it; hoisted here, React sees the same element and
 * skips the subtree, and what reaches the rail is the two rail contexts alone.
 * The panel takes no props for exactly this reason (#4109).
 */
const SESSION_RAIL = <SessionListPanel />;

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
  const sharedSessionDialog = useSessionCollaborationDialog();
  const updateInstallInFlightRef = useRef(false);
  const notifiedInstallErrorRef = useRef<string | null>(null);
  const previousInterruptionShownRef = useRef(false);
  const {
    sessions,
    catalogRevision,
    authoritativeSessionIds,
    sessionsRef,
    refreshSessions,
    seedSessions,
    activeId,
    activeIdRef,
    bootstrapSelectionLease,
    setActiveId,
    startNewSession,
    clearOwnedSessionState,
    messages,
    transientMessages,
    setMessages,
    addTransientMessage,
    updateTransientMessage,
    projectQueuedTransientMessages,
    retireCancelledTransientMessages,
    removeTransientMessage,
    transcriptRangeRef,
    messageLoadPending,
    setMessageLoadPending,
    sessionUiController,
  } = useAppShellSessionWorkspace(toastApi);
  const activeCatalogSession = sessions.find((session) => session.id === activeId);
  const sharedSessionActive =
    (activeCatalogSession as DesktopSessionSummary | undefined)?.shared === true;
  const ownerActiveId = activeCatalogSession && !sharedSessionActive ? activeId : undefined;
  const interactionHydrationEpochRef = useRef(new Map<string, number>());
  const markInteractionChanged = useCallback((sessionId: string) => {
    const epochs = interactionHydrationEpochRef.current;
    epochs.set(sessionId, (epochs.get(sessionId) ?? 0) + 1);
  }, []);

  const {
    settingsOpen,
    settingsRequest,
    settingsProviderCatalogOpen,
    settingsConnectionDetailSlug,
    settingsCreateProviderType,
    setSettingsOpen,
    setSettingsProviderCatalogOpen,
    setSettingsProfileId,
    openSettings,
    openSettingsSection,
    openProjectSettings,
    openProviderCatalog,
    openConnectionDetail,
    openProviderCreate,
  } = useSettingsModal();

  const onboarding = useOnboardingSnapshot(initialOnboardingSnapshot);
  const reportTaskEntryError = useCallback(
    ({ title, description, profileId }: TaskEntryError) => {
      toastApi.error(title, description, undefined, { profileId });
    },
    [toastApi],
  );
  const taskEntry = useTaskEntryController({
    reportError: reportTaskEntryError,
    manageProjects: openProjectSettings,
  });
  // Named on its own because the rail depends on it: `taskEntry.commands` is a
  // fresh object every render, so depending on the bag rather than the command
  // would rebuild the rail's Project rows on every AppShell commit (#4109).
  const { selectLocalProject } = taskEntry.commands;
  const currentNewTaskDraftKey = taskEntry.selectors.draftKey;
  // Staged files and quotes do NOT take the target-scoped key: they belong to
  // the composer the user is looking at, and an in-flight send needs an owner
  // that cannot move under it. See NEW_TASK_PENDING_KEY.
  const attachmentDraftKey = activeId ?? NEW_TASK_PENDING_KEY;
  const directoryHostId = activeId
    ? (activeCatalogSession?.profileKind === 'local'
        ? activeCatalogSession.runtimeHostId
        : undefined)
    : (taskEntry.selectors.selectedHost?.kind === 'local'
        ? taskEntry.selectors.target?.hostId
        : undefined);
  const {
    pendingAttachments,
    submittableAttachments,
    hasPendingContext,
    directoryOptions,
    directoryComposerProps,
    pickAttachments,
    attachFilePaths,
    restoreAttachments,
    removeAttachment,
    clearSubmittedContext,
    imageNoticeLifecycle,
  } = useComposerAttachments({
    draftKey: attachmentDraftKey,
    directoryHostId,
    toastApi,
    service: window.maka.attachments,
    imageNotice: {
      supportsVision: () => composerSupportsVision,
      notify: toastApi.info,
    },
  });
  const {
    pendingQuotes,
    addQuote,
    removeQuote,
    clearQuotes,
    restoreQuotes,
  } = useAppShellComposerQuotes({ draftKey: attachmentDraftKey });
  // Held for the whole of sendOwningItsTarget; see ChatComposerRegion.
  const [newTaskSendPending, setNewTaskSendPending] = useState(false);
  // What a new chat will start with, held the way the Session holds it: a
  // Plan toggle and one orchestration value, not one fused choice.
  const [newChatPlanModeActive, setNewChatPlanModeActive] = useState(false);
  const [newChatOrchestrationMode, setNewChatOrchestrationMode] = useState<OrchestrationMode>('default');
  const [newTaskPermissionChoice, setNewTaskPermissionChoice, clearNewTaskPermissionChoice] =
    useNewTaskChoice<ChatDefaultPermissionMode>(currentNewTaskDraftKey);
  const [historyLoadPendingSessionId, setHistoryLoadPendingSessionId] = useState<string>();
  // The state above is what the transcript renders; this is what the guard
  // reads. A scroller can ask twice in one task — two scroll events before
  // React has re-rendered anything — and a state read is still the old value
  // for both of them.
  const historyLoadPendingRef = useRef(false);
  const [transcriptTurnIndex, setTranscriptTurnIndex] = useState<{
    sessionId: string;
    throughSequence: number | null;
    turns: readonly { turnId: string; sequence: number; label: string }[];
  }>();
  const [petCompletionNonce, setPetCompletionNonce] = useState(0);
  const [navigationState, setNavigationState] = useState(() => readNavigationState());
  const navSelection = navigationState.selection;
  const setNavSelection = useCallback<Dispatch<SetStateAction<NavSelection>>>((nextSelection) => {
    setNavigationState((current) => selectNavigation(
      current,
      typeof nextSelection === 'function' ? nextSelection(current.selection) : nextSelection,
    ));
  }, []);
  const navSelectionRef = useRef<NavSelection>(navSelection);
  const [workHubEnabled, setWorkHubEnabled] = useState(false);
  const [workHubActive, setWorkHubActive] = useState(false);
  const [workHubCoordinationSessionId, setWorkHubCoordinationSessionId] = useState<string>();
  const [workHubCoordinationState, setWorkHubCoordinationState] = useState<
    'resolving' | 'failed'
  >('resolving');
  const workHubCoordinationRetryRef = useRef<() => void>(() => undefined);
  const workHubCoordinationGenerationRef = useRef(0);
  const workHubCoordinationSessionIdRef = useRef(workHubCoordinationSessionId);
  workHubCoordinationSessionIdRef.current = workHubCoordinationSessionId;
  const workHubEnabledRef = useRef(false);
  useEffect(() => {
    if (!workHubEnabled || !workHubActive) return;
    return startWorkHubCoordinationLifecycle({
      resolve: () => window.maka.workHub.resolveCoordinationSession(),
      subscribeHostChanges: (handler) =>
        window.maka.runtimeHostProfiles.subscribeChanges(handler),
      subscribeAvailabilityChanges: (handler) =>
        window.maka.connections.subscribeEvents((event) => {
          if (event.type === 'connection_list_changed') handler();
        }),
      onResolving: () => {
        workHubCoordinationGenerationRef.current += 1;
        workHubCoordinationSessionIdRef.current = undefined;
        setWorkHubCoordinationSessionId(undefined);
        setWorkHubCoordinationState('resolving');
      },
      onResolved: (sessionId) => {
        workHubCoordinationSessionIdRef.current = sessionId;
        setWorkHubCoordinationSessionId(sessionId);
        setWorkHubCoordinationState('resolving');
      },
      reportFailure: (error, retry) => {
        workHubCoordinationRetryRef.current = retry;
        setWorkHubCoordinationState('failed');
        console.error('[workhub] failed to resolve Coordination Session:', error);
      },
    });
  }, [workHubActive, workHubEnabled]);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const enabled = (await window.maka.settings.getClient()).workHub.enabled;
        if (disposed) return;
        const becameEnabled = enabled && !workHubEnabledRef.current;
        workHubEnabledRef.current = enabled;
        setWorkHubEnabled(enabled);
        if (!enabled) {
          workHubCoordinationGenerationRef.current += 1;
          workHubCoordinationSessionIdRef.current = undefined;
          setWorkHubActive(false);
          setWorkHubCoordinationSessionId(undefined);
        }
        if (becameEnabled) {
          setWorkHubActive(true);
          setNavSelection({ section: 'sessions' });
        }
      } catch {
        // Keep the last known client-owned setting. A transient settings read
        // must not leave the shell half-switched between WorkHub and Session.
      }
    };
    void refresh();
    const unsubscribe = window.maka.settings.subscribeClientChanged(() => void refresh());
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [setNavSelection]);
  // #1985: the shell's complete read of session UI state. See the hook for why
  // the two token-rate maps are absent.
  const {
    messageLoadErrorBySession,
    messageRetryPendingBySession,
    stopPendingBySession,
    interactionBySession,
    messageQueueBySession,
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
    sessionId: ownerActiveId,
    disabled: sharedSessionActive,
  });
  const newTaskHost = taskEntry.selectors.selectedHost
    ? {
        profileId: taskEntry.selectors.selectedHost.profileId,
        hostId: taskEntry.selectors.selectedHost.hostId,
      }
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
    target: { kind: 'session', sessionId: ownerActiveId },
  });
  const startupConnectionSnapshot =
    initialOnboardingSnapshot ?? onboarding.mountedSnapshotHandoff;
  const newTaskUsesDefaultHost = taskEntry.selectors.usesDefaultHost;
  let newTaskConnectionSnapshot = newTaskConnections.snapshot;
  if (newTaskConnections.projection.status !== 'ready' && newTaskUsesDefaultHost) {
    newTaskConnectionSnapshot = defaultHostConnections.projection.status === 'ready'
      ? defaultHostConnections.snapshot
      : defaultHostConnections.projection.status === 'unrequested' && startupConnectionSnapshot
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
      ...(ownerActiveId ? [sessionHostConnections.refreshConnections()] : []),
    ]).then(() => undefined);
  }
  function handleConnectionEvent(event: ConnectionEvent): void {
    defaultHostConnections.handleConnectionEvent(event);
    newTaskConnections.handleConnectionEvent(event);
    if (ownerActiveId) sessionHostConnections.handleConnectionEvent(event);
  }
  const onboardingState = onboarding.snapshot?.state;
  const onboardingSettled = hasSettledInitialOnboarding(onboarding.snapshot?.milestones ?? []);
  const onboardingActivationCandidate = getOnboardingActivationCandidate(
    onboarding.snapshot,
    sessions.length > 0,
  );
  const {
    themePref,
    setThemePref,
    themePalette,
    setThemePalette,
    uiLocaleUpdateGate,
    appearanceHydrated,
    userLabel,
    setUserLabel,


    refreshShellSettings,
  } = useShellAppearance({
    toastApi,
    uiLocale,
    setUiLocaleOverride,
    setUiLocalePreference,
  });
  const shellCopy = getShellCopy(uiLocale).app;
  const previousInterruptionCopy =
    getShellRemainingCopy(uiLocale).previousMainProcessInterruption;
  const desktopConversationCopy = getDesktopConversationCopy(uiLocale);
  /**
   * What this draft would start in: the user's choice for it if they made one,
   * otherwise the Host default it will inherit by omission.
   *
   * The choice stays local to the draft. Picking Full access for one task is
   * not a statement about every later task, so it is sent once on create and
   * never written back to `chatDefaults` — the Settings surface owns that.
   */
  const newTaskPermissionMode =
    newTaskPermissionChoice ??
    taskEntry.selectors.selectedHost?.chatDefaults.permissionMode ??
    'ask';
  const setNewTaskPermissionMode = setNewTaskPermissionChoice;
  useEffect(() => {
    if (!appearanceHydrated) return;
    let cancelled = false;
    void window.maka.diagnostics
      .takePreviousMainProcessInterruption()
      .then((interrupted) => {
        if (cancelled || !interrupted || previousInterruptionShownRef.current) return;
        previousInterruptionShownRef.current = true;
        toastApi.toast({
          variant: 'warning',
          title: previousInterruptionCopy.title,
          description: previousInterruptionCopy.description,
          duration: 10_000,
          action: {
            label: previousInterruptionCopy.copyDiagnostics,
            onClick: () =>
              window.maka.diagnostics.copyPreviousMainProcessInterruption(),
          },
        });
      })
      .catch((error) =>
        console.error('[diagnostics] previous-session notice failed:', error),
      );
    return () => {
      cancelled = true;
    };
  }, [appearanceHydrated, previousInterruptionCopy, toastApi]);
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
  // Persisted composer defaults seed the empty-state model, project path, and
  // recent workspace history so the home view is populated before the async
  // `app:info` round-trip completes on mount.
  const persistedComposerDefaults = loadComposerDefaults();
  const [helpOpen, closeHelp, openHelp] = useKeyboardHelp();
  const [paletteOpen, openPalette, closePalette] = useCommandPalette();
  const composerRef = useRef<ComposerHandle>(null);
  const openComposerModelPicker = useCallback(() => {
    composerRef.current?.openModelPicker();
  }, []);
  const retractedWorkspaceReferencesRef = useRef<Record<string, InlineReference[]>>({});
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
  } = useShellResume({ activeId: ownerActiveId, toastApi, shellCopy, uiLocale });
  const rendererMountedRef = useRef(true);
  const goals = useGoalController({
    activeSessionId: ownerActiveId,
    reportError: showSessionError,
  });
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
  const activeInteraction = activeInteractionFor(interactionBySession, ownerActiveId);
  const activeSession = activeCatalogSession;
  const activeMessageQueue = activeId ? messageQueueBySession[activeId] : undefined;
  const activeMessageSubmitting = transientMessages.length > 0;
  const activeDesktopSession = activeSession;
  function openSessionSharing(session: DesktopSessionSummary): void {
    sharedSessionDialog.open({
      sessionId: session.id,
      sessionName: session.name,
      requiresRemoteAccess: session.profileKind === 'local',
    });
  }
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
    : taskEntry.selectors.selectedProfileId;
  const composerProfileName = activeId
    ? activeDesktopSession?.profileName
    : taskEntry.selectors.selectedHost?.name;
  const modelSettingsOwnsComposerHost =
    composerProfileId !== undefined &&
    composerProfileId === taskEntry.selectors.defaultProfileId;
  const modelChangePending = activeId
    ? pendingSessionModelBySession[activeId] === true
    : false;
  const modelSwitchAvailability = deriveComposerModelSwitchAvailability({
    streaming: turnActive || activeStreamingLive,
    sessionStatus: activeSession?.status,
    pending: modelChangePending,
  });
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
    composerSupportsVision,
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
    defaultThinkingLevel: taskEntry.selectors.selectedHost?.chatDefaults.thinkingLevel,
    connectionSnapshotReady: activeId
      ? sessionHostConnections.projection.status === 'ready'
      : true,
    modelPickerDisabled: !modelSwitchAvailability.available,
    openSettingsSection,
    openModelPicker: openComposerModelPicker,
    refreshModelChoices: sessionHostConnections.refreshConnections,
  });
  const newChatProviderType = newChatModel
    ? connections.find((connection) => connection.slug === newChatModel.llmConnectionSlug)?.providerType
    : undefined;

  // PR109d-b: turn footer actions per turn. Derived from the
  // materialized turn list (status + lineage descendants) + pending
  // mask. Per @kenji PR109d review: pending state prevents double-click
  // duplicate sibling turns by disabling the action button between
  // click and `sessions:changed turn-status-change` arriving.
  // Session-row mutations live in Session Navigation; the per-session mode and
  // model claims live in the session UI store.
  const turnActionRegistry = useTurnActionRegistry();
  const pendingTurnActions = turnActionRegistry.keys;
  const pendingKeyOf = (sessionId: string, turnId: string, actionId: string) =>
    `${sessionId}:${turnId}:${actionId}`;

  // A hoisted declaration on purpose: `dropDisplayEvents` is destructured
  // hundreds of lines below, and the rail does not need this identity held
  // still — the rail's controller reads it through `portsRef`.
  function clearSessionRendererState(sessionId: string): void {
    dropDisplayEvents(sessionId);
    // `clearOwnedSessionState` ends in `clearSessionUiState`, which drops this
    // session from every session-UI map — the four pending claims included.
    clearOwnedSessionState(sessionId);
    turnActionRegistry.clearForSession(sessionId);
    planModeIntent.clear(sessionId);
    orchestrationModeIntent.clear(sessionId);
  }

  const {
    setPermissionMode,
    setSessionModel,
    setSessionThinkingLevel,
  } = useStableActions(createAppShellSessionSettingsActions, {
    uiLocale,
    activeIdRef,
    connections,
    messages,
    permissionModePending: sessionUiController.permissionModePending,
    sessionModelPending: sessionUiController.sessionModelPending,
    refreshSessions,
    saveComposerDefaults,
    sessionsRef,
    setNewTaskPermissionMode,
    toastApi,
  });

  // Mode writes and catalog reads run on different clocks. These controllers
  // own that gap: latest intent wins, and a Host-committed value remains the
  // presentation overlay until a causally later successful catalog snapshot
  // takes over — whether it confirms that value or shows a newer Host change.
  const planModeIntent = useSessionSettingIntent<boolean>({
    catalogRevision,
    write: commitPlanMode,
    refreshCatalog: refreshSessions,
    onWriteError: (sessionId, error) => {
      if (activeIdRef.current !== sessionId) return;
      showSessionError(
        sessionId,
        shellCopy.planModeFailedTitle,
        localizedShellErrorMessage(error, shellCopy.planModeFallback, uiLocale),
      );
    },
  });
  const orchestrationModeIntent = useSessionSettingIntent<OrchestrationMode>({
    catalogRevision,
    write: async (sessionId, mode) => {
      await window.maka.sessions.setOrchestrationMode(sessionId, mode);
      return true;
    },
    refreshCatalog: refreshSessions,
    onWriteError: (sessionId, error) => {
      if (activeIdRef.current !== sessionId) return;
      showSessionError(
        sessionId,
        shellCopy.orchestrationModeFailedTitle,
        localizedShellErrorMessage(error, shellCopy.orchestrationModeFallback, uiLocale),
      );
    },
  });

  // Stable: the rail's row actions are built from it, and it only reaches
  // registries and refs that are themselves stable (#4109).
  /**
   * Enter or leave Plan for one Session — the only path that writes
   * `collaborationMode`, and it writes nothing else.
   *
   * `sessionId` is a parameter rather than a read of `activeIdRef`, because
   * this awaits — a Plan-exit confirmation can sit open while the user opens
   * another Session, and a re-read partway through would finish the
   * transition somewhere else.
   *
   * Both gates read the Host through `getPlanState`, not the projected mode.
   * The projection can be a frame behind; the question "does this discard a
   * pending plan proposal" has an authoritative answer and deserves it.
   *
   * The Session's orchestration default is left exactly as it was. Plan is a
   * temporary excursion that Runtime ends by itself once a proposal is
   * approved or abandoned, so clearing the default on the way in would lose
   * it for the execution the plan was written for.
   */
  async function commitPlanMode(sessionId: string, active: boolean): Promise<boolean> {
    const planState = await window.maka.sessions.getPlanState(sessionId);
    if (active && planState.activeExecutionId) {
      showSessionError(
        sessionId,
        shellCopy.planModeExecutionActiveTitle,
        shellCopy.planModeExecutionActiveDescription,
      );
      return false;
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
      if (!confirmed) return false;
      // Abandoning the proposal is what leaves Plan: Runtime writes the
      // Session back to `agent` itself as part of it.
      await window.maka.sessions.abandonPlanProposal(sessionId, latestProposal.proposalId);
    } else {
      await window.maka.sessions.setCollaborationMode(
        sessionId,
        active ? 'plan' : 'agent',
      );
    }
    return true;
  }

  function setPlanMode(active: boolean): Promise<boolean> {
    const sessionId = activeIdRef.current;
    if (!sessionId) {
      setNewChatPlanModeActive(active);
      return Promise.resolve(true);
    }
    if (active === activePlanMode) return Promise.resolve(true);
    return planModeIntent.request(sessionId, active);
  }

  /**
   * The ＋ menu's orchestration choice and the `/swarm` and `/graph` commands
   * all land here, so every entry point spells the field the same way.
   *
   * `/swarm off` means "leave swarm", not "go to default": a Session already
   * in Graph has nothing for it to do.
   */
  function setOrchestrationMode(mode: OrchestrationMode): Promise<boolean> {
    const sessionId = activeIdRef.current;
    if (!sessionId) {
      setNewChatOrchestrationMode(mode);
      return Promise.resolve(true);
    }
    if (mode === activeOrchestrationMode) return Promise.resolve(true);
    return orchestrationModeIntent.request(sessionId, mode);
  }

  function setOrchestrationModeActive(
    mode: Exclude<OrchestrationMode, 'default'>,
    active: boolean,
  ): Promise<boolean> {
    if (active) return setOrchestrationMode(mode);
    if (activeOrchestrationMode !== mode) return Promise.resolve(true);
    return setOrchestrationMode('default');
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
  function handleLineageBadgeClick(targetTurnId: string) {
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-turn-id="${CSS.escape(targetTurnId)}"]`);
      if (!el || !('scrollIntoView' in el)) return;
      (el as HTMLElement).scrollIntoView({
        behavior: readScrollMotionBehavior(),
        block: 'center',
      });
    });
  }

  const openSessionInChatRef = useRef<
    (sessionId: string, turnId?: string, sequence?: number) => void
  >(() => undefined);
  const openSessionInChat = useCallback(
    (sessionId: string, turnId?: string, sequence?: number): void => {
      openSessionInChatRef.current(sessionId, turnId, sequence);
    },
    [],
  );

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
  const openWorkHub = useCallback(() => {
    setNavSelection({ section: 'sessions' });
    setWorkHubActive(true);
  }, [setNavSelection]);

  // Transient placeholder while the real SessionSummary loads, so the composer
  // does not flash a value the session never had.
  const activeSessionForView: SessionSummary | undefined =
    activeSession ??
    (activeId
      ? pendingSessionView({
          sessionId: activeId,
          name: shellCopy.newConversation,
          permissionMode: newTaskPermissionMode,
        })
      : undefined);
  // Each control reads its own field. There is nothing to project and nothing
  // to keep in sync: a Session in Plan with Swarm as its orchestration default
  // says both, because it is both.
  const activePlanMode = activeId
    ? planModeIntent.overlayBySession[activeId]
      ?? ((activeSessionForView?.collaborationMode ?? 'agent') === 'plan')
    : newChatPlanModeActive;
  const activeOrchestrationMode: OrchestrationMode = activeId
    ? orchestrationModeIntent.overlayBySession[activeId]
      ?? activeSessionForView?.orchestrationMode
      ?? 'default'
    : newChatOrchestrationMode;
  /**
   * Why neither mode can be changed right now, if either cannot. Both controls
   * write the same Session configuration, so everything that holds one holds
   * the other; only "this one is already changing" is per-control.
   */
  const modeChangeDisabledReason = activeId && !activeSession
    ? shellCopy.modeChangeLoading
    : activeStreamingLive
      ? shellCopy.modeChangeStreaming
      : activeId && turnActive
        ? shellCopy.modeChangeRunning
        : activeId && activeSessionForView?.status === 'waiting_for_user'
          ? shellCopy.modeChangeWaiting
          : undefined;
  const {
    boundary: activeExecutionBoundary,
    unreadable: activeExecutionBoundaryUnreadable,
    reading: activeExecutionBoundaryReading,
    reload: reloadActiveExecutionBoundary,
  } = useActiveExecutionBoundary(ownerActiveId, activeSessionForView?.permissionMode);
  // The session view only subscribes to the session it shows, so a request
  // raised while another session was active never reaches this surface as a
  // live event — and neither does one raised before the window existed. The
  // runtime holds every unanswered request, so read them back whenever the
  // active session changes (#2072).
  useEffect(() => {
    if (!ownerActiveId) return;
    let cancelled = false;
    const hydrationEpoch = interactionHydrationEpochRef.current.get(ownerActiveId) ?? 0;
    void window.maka.sessions
      .listActiveInteractions(ownerActiveId)
      .then((requests) => {
        if (
          cancelled ||
          (interactionHydrationEpochRef.current.get(ownerActiveId) ?? 0) !== hydrationEpoch
        ) {
          return;
        }
        sessionUiController.setInteractionBySession((current) => reconcileInteractions(current, ownerActiveId, requests));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ownerActiveId, sessionUiController.setInteractionBySession]);
  useEffect(
    () =>
      window.maka.sessions.subscribeActiveInteractions(({ sessionId, interactions }) => {
        markInteractionChanged(sessionId);
        sessionUiController.setInteractionBySession((current) =>
          reconcileInteractions(current, sessionId, interactions),
        );
      }),
    [markInteractionChanged, sessionUiController.setInteractionBySession],
  );
  const activeBoundarySurface = deriveDesktopExecutionBoundarySurface(
    activeId,
    activeExecutionBoundary,
    activeId ? (activeSessionForView?.permissionMode ?? 'ask') : newTaskPermissionMode,
  );
  const activePermissionMode = activeBoundarySurface.permissionMode;
  const planMode = usePlanModeState(sharedSessionActive ? undefined : activeSessionForView);
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
    // Display normalization prevents legacy blocked/unknown
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
  const refreshProjectSkillsRef = useRef<() => Promise<void>>(async () => {});
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
    sessionId: ownerActiveId,
    sessionCwd: sharedSessionActive ? undefined : activeSession?.cwd,
    sessionProjectId: sharedSessionActive ? undefined : activeSession?.projectId,
    sessionProfileKind: sharedSessionActive ? undefined : activeDesktopSession?.profileKind,
    onProjectSelected: (ownerSessionId) => {
      void refreshProjectSkillsRef.current();
      if (ownerSessionId && activeIdRef.current === ownerSessionId) openNewTaskSurface();
    },
    toastApi,
  });
  const captureActiveComposerClaim = useCallback(() => {
    const sessionId = activeIdRef.current;
    const composer = composerRef.current;
    if (
      !sessionId ||
      !composer ||
      navSelectionRef.current.section !== 'sessions'
    ) {
      return undefined;
    }
    return {
      isCurrent: () =>
        activeIdRef.current === sessionId &&
        navSelectionRef.current.section === 'sessions' &&
        composerRef.current === composer,
      append: (text: string) => composer.appendText(text),
    };
  }, []);
  const moduleHub = useModuleHubController({
    selection: navSelection,
    selectModule: setNavSelection,
    ...(projectCapabilities.viewClientPath ? { openSkillsFolder } : {}),
    useSkillInChat,
    openSession: (sessionId) => openSessionInChatRef.current(sessionId),
    appendComposerText: (text) => composerRef.current?.appendText(text),
    captureActiveComposerClaim,
  });
  refreshProjectSkillsRef.current = moduleHub.commands.refreshProjectSkills;
  const workHubProjectsRef = useRef(projects);
  workHubProjectsRef.current = projects;
  const workHubCoordinationGeneration = workHubCoordinationGenerationRef.current;
  const workHubController = useMemo(
    () => createWorkHubController({
      coordination: createDesktopWorkHubCoordinationPort({
        sessionId: workHubCoordinationSessionId ?? 'workhub-coordination-unresolved',
        transcripts: window.maka.transcripts,
        record: (input) =>
          window.maka.workHub.record(workHubCoordinationSessionId!, input),
        candidates: () =>
          window.maka.workHub.candidates(workHubCoordinationSessionId!),
        act: (input) =>
          window.maka.workHub.act(workHubCoordinationSessionId!, input),
      }),
      sessions: createDesktopWorkHubSessionPort({
        sessions: scopeWorkHubSessionsToCoordinationHost(
          window.maka.sessions,
          {
            sessionId: workHubCoordinationSessionId,
            isCurrent: () =>
              workHubCoordinationGenerationRef.current === workHubCoordinationGeneration &&
              workHubCoordinationSessionIdRef.current === workHubCoordinationSessionId,
          },
        ),
        transcripts: window.maka.transcripts,
        projectName: (projectId) =>
          workHubProjectsRef.current.find((project) => project.id === projectId)?.name,
      }),
    }),
    [workHubCoordinationGeneration, workHubCoordinationSessionId],
  );
  // Where a NEW chat starts. Built unconditionally and handed to the composer,
  // which renders it only while no session owns it — the project is fixed once
  // the first message creates one, so there is nothing to pick after that.
  const workspacePicker = taskEntry.selectors.workspacePicker;
  const taskReadinessWorkspace = activeSession?.cwd ?? taskEntry.selectors.projectPath;
  const taskReadinessRequest = {
    ...resolveTaskReadinessModelTarget(activeSession, activeSessionSendOutcome, newChatModel),
    ...(taskReadinessWorkspace ? { cwd: taskReadinessWorkspace } : {}),
  };
  const taskReadiness = useTaskSubmissionReadiness(
    taskReadinessRequest,
    onboarding.snapshot,
    ownerActiveId,
    activeId ? undefined : taskEntry.selectors.target,
  );
  const taskReadinessNotice = deriveTaskReadinessNotice(taskReadiness.snapshot, uiLocale);
  const ignoreTaskReadinessModelTarget =
    activeSession !== undefined && activeSessionSendOutcome?.kind !== 'blocked';
  const taskSubmissionHardBlocked =
    (!activeId && !taskEntry.selectors.target) ||
    isTaskSubmissionHardBlocked(taskReadiness.snapshot, {
      ignoreModelTarget: ignoreTaskReadinessModelTarget,
    });
  // The titlebar names the directory the ACTIVE session runs in, so it reads
  // the same projected project state the picker does — `projectInfo` already
  // resolves to the session's own cwd once a session owns it.
  const titlebarProjectName = sharedSessionActive
    ? undefined
    : deriveTitlebarProjectName({
        projectName: currentProject?.name,
        projectPath: projectInfo?.projectPath,
      });
  const { startModeSession } = useStableActions(createAppShellSessionStartActions, {
    uiLocale,
    activeIdRef,
    captureComposerImportOwner,
    composerRef,
    isShellSurfaceOwnerActive,
    openSessionInChat,
    newTaskTarget: taskEntry.selectors.target,
    sessionStartPendingRef,
    refreshOnboarding: onboarding.refresh,
    refreshSessions,
    showModelSetupToast,
    toastApi,
  });
  const openNewTaskSurface = useCallback(() => {
    imageNoticeLifecycle.reset(NEW_TASK_PENDING_KEY);
    startNewSession();
    // Only Plan resets: a new task starts out of Plan, in whatever
    // orchestration the last one was set to.
    setNewChatPlanModeActive(false);
    setNavSelection({ section: 'sessions' });
    setSearchScrollTarget(null);
    // New-task affordances reset to the empty-state composer; move focus
    // there so the user can start typing immediately.
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [imageNoticeLifecycle, setNavSelection, setSearchScrollTarget, startNewSession]);

  const createSession = useCallback(async () => {
    openNewTaskSurface();
  }, [openNewTaskSurface]);

  // Stable, because the rail's Project rows carry it: a fresh identity here
  // rebuilt the whole list on every AppShell commit (#4109).
  const createSessionInProject = useCallback(
    async (projectId: string) => {
      if (!selectLocalProject(projectId)) return;
      openNewTaskSurface();
    },
    [openNewTaskSurface, selectLocalProject],
  );

  // Sidebar Project groups are Local. Their catalog mutations remain on the
  // default-scoped bridge until Settings receives its own Host selector.
  //
  // Memoized because the rail reads it: rebuilt per render, this one object
  // would put the whole list back on every AppShell commit (#4109).
  const projectRowActions = useMemo<ProjectRowActions | undefined>(
    () =>
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
        : undefined,
    [
      archiveProject,
      createSessionInProject,
      projectCapabilities.chooseClientDirectory,
      projectCapabilities.setLocalDefault,
      relinkProject,
      renameProject,
      restoreProject,
    ],
  );

  // Composer mention popups: `/` uses Runtime's session/project-aware,
  // host-compatible projection; `@` uses workspace file search. Keep the
  // resolved project path as a refresh key for new-chat project changes. Only
  // the SURFACE is named here — the projection itself is owned by
  // `ComposerMentionsProvider` below, so its reloads do not re-render the shell.
  const composerMentionsSurface: ComposerMentionsSurface = {
    skillCatalogRevision: moduleHub.selectors.skillCatalogRevision,
    sessionId: ownerActiveId,
    projectPath: activeId
      ? ownerActiveId
        ? projectInfo?.projectPath
        : undefined
      : taskEntry.selectors.projectPath,
    newTaskTarget: activeId ? undefined : taskEntry.selectors.target,
    newSessionModel: newChatModel,
    newSessionCollaborationMode: newChatPlanModeActive ? 'plan' : 'agent',
    // Refresh only; Desktop Main re-reads the authoritative default before
    // constructing the Runtime Host preview target.
    newSessionPermissionMode: newTaskPermissionMode,
  };

  const hasModalOpen = helpOpen || paletteOpen || searchModalOpen || sharedSessionDialog.target !== undefined;
  const shellObscured = hasModalOpen || settingsOpen;
  const contextCompactionPresentation = useMemo(
    () =>
      createContextCompactionPresentation({
        toastApi,
        presentTerminal(sessionId, notice) {
          if (notice.level === 'error') {
            toastApi.error(notice.title, notice.description, undefined, { sessionId });
            return;
          }
          toastApi[notice.level](notice.title, notice.description);
        },
      }),
    [toastApi],
  );
  const reportWorkbarError = useCallback(
    (title: string, description: string, sessionId: string) =>
      toastApi.error(title, description, undefined, { sessionId }),
    [toastApi],
  );
  const workbarAvailable =
    navSelection.section === 'sessions' && !workHubActive && Boolean(activeId);
  const workbar = useWorkbarController({
    available: workbarAvailable,
    activeSession: activeSessionForView,
    projectId: currentProjectId,
    projectAliases: currentProject?.aliases ?? [],
    authoritativeSessionIds: authoritativeSessionIds ?? undefined,
    shellObscured,
    modelChoices: chatModelChoices,
    reportError: reportWorkbarError,
  });

  const exitWorkHub = useCallback(() => setWorkHubActive(false), []);
  const selectSessionSurface = useCallback(
    () => setNavSelection({ section: 'sessions' }),
    [setNavSelection],
  );
  const clearActiveMessages = useCallback(() => setMessages([]), [setMessages]);
  const openSession = useMemo(
    () =>
      createSessionOpenCommand({
        activateSession: setActiveId,
        exitWorkHub,
        selectSessionSurface,
        setSearchTarget: setSearchScrollTarget,
      }),
    [exitWorkHub, selectSessionSurface, setActiveId, setSearchScrollTarget],
  );
  useLayoutEffect(() => {
    openSessionInChatRef.current = openSession;
  }, [openSession]);
  const pendingSessionRowActionsRef = useRef(new Set<string>());
  const sessionNavigationCommandsRef = useRef<SessionNavigationRowActions | null>(null);
  // Built inline: the rail reads these through a ref published on commit, so
  // their identity carries no information and this object never has to be
  // held still by hand (#4109).
  const sessionNavigationPorts: SessionNavigationPorts = {
    activeIdRef,
    sessionsRef,
    pendingSessionRowActionsRef,
    activateSession: setActiveId,
    clearActiveMessages,
    clearSessionRendererState,
    refreshSessions,
    toastApi,
  };
  const {
    rail: sessionRail,
    branchBanner,
    revisionNavigation,
    layout: railLayout,
  } = useSessionNavigationReads({
    sessions,
    activeSessionId: activeId,
    activeSession,
    hiddenSessionIds: workbar.selectors.hiddenSessionIds,
  });
  const visibleSessions = sessionRail.sessions;
  const sessionListCollapsed = railLayout.collapsed;
  const sessionListWidth = railLayout.width;
  const sessionSideNavHandleRef = sessionRailLayoutStore.collapseHandleRef;
  const titlebarParentSession = useMemo(() => {
    const parent = sessionRail.activeParentSession;
    if (!parent) return undefined;
    const parentId = parent.id;
    return {
      name: parent.name,
      onOpen: () => openSessionInChatRef.current(parentId),
    };
  }, [sessionRail.activeParentSession]);
  const archivedTasksBridge = useMemo<ArchivedTasksBridge>(
    () => ({
      sessions,
      projects: localProjects,
      onRestore: (sessionId) =>
        void sessionNavigationCommandsRef.current?.unarchiveSession(sessionId),
      onDelete: (sessionId) =>
        void sessionNavigationCommandsRef.current?.deleteSession(sessionId),
      onPurge: (sessionIds) =>
        sessionNavigationCommandsRef.current!.purgeSessions(sessionIds),
    }),
    [sessions, localProjects],
  );

  const firstSendObservationWaitersRef = useRef(
    new Map<string, FirstSendObservationWaiter>(),
  );
  const activateSessionForFirstSend = useCallback((sessionId: string): Promise<void> => {
    let waiter = firstSendObservationWaitersRef.current.get(sessionId);
    if (!waiter) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      let created!: FirstSendObservationWaiter;
      const timeoutId = globalThis.setTimeout(() => {
        if (firstSendObservationWaitersRef.current.get(sessionId) !== created) return;
        firstSendObservationWaitersRef.current.delete(sessionId);
        created.reject(new Error('Timed out while preparing the new Session event stream'));
      }, FIRST_SEND_OBSERVATION_TIMEOUT_MS);
      created = { promise, resolve, reject, timeoutId };
      waiter = created;
      firstSendObservationWaitersRef.current.set(sessionId, waiter);
    }
    setNavSelection({ section: 'sessions' });
    setActiveId(sessionId);
    return waiter.promise;
  }, [setActiveId, setNavSelection]);
  useEffect(() => {
    for (const [sessionId, waiter] of firstSendObservationWaitersRef.current) {
      if (sessionId === activeId) continue;
      firstSendObservationWaitersRef.current.delete(sessionId);
      globalThis.clearTimeout(waiter.timeoutId);
      waiter.reject(new Error('The new Session was left before its event stream became ready'));
    }
  }, [activeId]);
  useEffect(() => () => {
    for (const [sessionId, waiter] of firstSendObservationWaitersRef.current) {
      firstSendObservationWaitersRef.current.delete(sessionId);
      globalThis.clearTimeout(waiter.timeoutId);
      waiter.reject(new Error('The app closed before the new Session event stream became ready'));
    }
  }, []);

  const { applyE2eFixture } = useStableActions(createAppShellE2eFixtureActions, {
    openSettingsSection,
    refreshSessions,
    setActiveId,
    setNavSelection,
    setSearchModalOpen,
    setSessionListCollapsed: sessionRailLayoutStore.setCollapsed,
    workbar: {
      rightCollapsed: workbar.selectors.rightCollapsed,
      toggleRight: workbar.commands.toggleRight,
      openTool: workbar.commands.openTool,
    },
    setThemePref,
    setUiLocaleOverride,
  });

  const {
    send,
    enqueueMessage,
    respondToSandboxBoundary,
    respondToUserQuestion,
    refreshMessages,
    retryMessages,
  } = useStableActions(createAppShellChatActions, {
    uiLocale,
    activeIdRef,
    captureComposerImportOwner,
    checkTaskSubmissionReadiness: taskSubmissionReadyAtSend,
    isNewChatSendSurfaceActive,
    isShellSurfaceOwnerActive,
    messageRetryPending: sessionUiController.messageRetryPending,
    refreshSessions,
    activateSessionForFirstSend,
    setActiveId,
    setMessageLoadErrorBySession: sessionUiController.setMessageLoadErrorBySession,
    setMessages,
    addTransientMessage,
    updateTransientMessage,
    removeTransientMessage,
    transcriptRangeRef,
    setLiveTurnBySession: sessionUiController.setLiveTurnBySession,
    setInteractionBySession: sessionUiController.setInteractionBySession,
    onInteractionChanged: markInteractionChanged,
    onExecutionBoundaryChanged: reloadActiveExecutionBoundary,
    showModelSetupToast,
    toastApi,
    newChatModel: newChatModel ?? null,
    pendingNewChatThinkingLevel: newChatThinkingLevel ?? null,
    newChatPermissionChoice: newTaskPermissionChoice,
    clearNewChatPermissionChoice: clearNewTaskPermissionChoice,
    newChatCollaborationMode: newChatPlanModeActive ? 'plan' : 'agent',
    newChatOrchestrationMode: newChatOrchestrationMode,
    newTaskTarget: taskEntry.selectors.target,
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
  });
  const handleSwitchToBypassAndRetry = useCallback(
    async (turnId: string) => {
      const sessionId = activeIdRef.current;
      if (!sessionId) return;
      const switched = await setPermissionMode('bypass');
      if (!switched || activeIdRef.current !== sessionId) return;
      await handleTurnFooterAction(turnId, 'regenerate');
    },
    [handleTurnFooterAction, setPermissionMode],
  );

  const {
    beginEditUserMessage,
    prepareRevisionSend,
    cancelRevisionDraft,
  } = useStableActions(createAppShellRevisionActions, {
    uiLocale,
    activeIdRef,
    composerRef,
    messages,
    hasPendingAttachments: () => hasPendingContext,
    openSessionInChat,
    refreshMessages,
    refreshSessions,
    setMessages,
    commitRevisionDraft,
    revisionDraftRef,
    toastApi,
  });

  async function taskSubmissionReadyAtSend(): Promise<boolean> {
    const snapshot = await taskReadiness.checkNow();
    return !isTaskSubmissionHardBlocked(snapshot, {
      ignoreModelTarget: ignoreTaskReadinessModelTarget,
    });
  }

  /**
   * The send the composer calls, wrapped so the new-task target cannot move
   * out from under it (#3408). `sendCurrent` captures the draft key it
   * submitted from and clears exactly that key once this resolves; the picker
   * stays live throughout, and the catalog can settle on its own. Holding the
   * flag for the whole call gives the submission one owner, and
   * ChatComposerRegion defers its carry until it drops.
   */
  async function sendOwningItsTarget(
    text: string,
    metadata?: ComposerSendMetadata,
  ): Promise<boolean | void> {
    setNewTaskSendPending(true);
    try {
      return await sendWithAttachments(text, metadata);
    } finally {
      setNewTaskSendPending(false);
    }
  }

  function settleNewTaskImageNoticeOwner(sourceSessionId?: string) {
    const createdSessionId = activeIdRef.current;
    if (!sourceSessionId && createdSessionId) {
      imageNoticeLifecycle.transfer(NEW_TASK_PENDING_KEY, createdSessionId);
    }
  }

  async function enqueueFollowUp(
    sessionId: string,
    text: string,
    mode: FollowUpMode,
    metadata?: ComposerSendMetadata,
  ): Promise<boolean> {
    const pending = submittableAttachments;
    const quotes = pendingQuotes.length ? pendingQuotes : undefined;
    try {
      const sent = await enqueueMessage(
        sessionId,
        text,
        mode === 'steer' ? 'current_turn' : 'next_turn',
        pending,
        {
          ...directoryOptions,
          ...(quotes ? { quotes: [...quotes] } : {}),
          ...(metadata?.workspaceFileReferences?.length
            ? { workspaceFileReferences: [...metadata.workspaceFileReferences] }
            : {}),
        },
      );
      // Refused: the composer keeps the draft, the attachments and the quotes,
      // because the user has to change something and send it again.
      if (!sent) return false;
      clearSubmittedContext(pending);
      if (quotes) clearQuotes();
      return true;
    } catch (error) {
      if (activeIdRef.current === sessionId) {
        const copy = getDesktopConversationCopy(uiLocale).actions;
        showSessionError(
          sessionId,
          copy.operationFailedTitle,
          localizedShellErrorMessage(error, copy.operationFailedFallback, uiLocale),
        );
      }
      return false;
    }
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
    // Read the synchronous live-turn store at submit time. React's rendered
    // `streaming` prop can lag one commit behind a just-started turn, which
    // previously sent a second root turn and surfaced duplicate session_busy
    // errors during burst input.
    const sessionId = activeIdRef.current;
    const workspaceFileReferences = mergeWorkspaceReferences(
      text,
      metadata?.workspaceFileReferences,
      sessionId ? retractedWorkspaceReferencesRef.current[sessionId] : undefined,
    );
    const liveTurn = sessionId ? sessionUiController.liveTurnBySessionRef.current[sessionId] : undefined;
    const runningTurnIds = sessionId
      ? sessionsRef.current.find((session) => session.id === sessionId)?.runningTurnIds
      : undefined;
    const followUpAtSubmit = !slashCommand
      ? resolveFollowUpModeAtSubmit({
          requestedMode: metadata?.followUpMode,
          hasActiveTurn: hasActiveTurnAtSubmit({ liveTurn, runningTurnIds }),
        })
      : undefined;
    if (sessionId && followUpAtSubmit) {
      const queued = await enqueueFollowUp(sessionId, text, followUpAtSubmit, {
        ...metadata,
        workspaceFileReferences,
      });
      if (queued) delete retractedWorkspaceReferencesRef.current[sessionId];
      return queued;
    }
    if (
      revisionSend &&
      revision &&
      text.trim() === revision.originalText.trim() &&
      !hasPendingContext
    ) {
      const actionCopy = getDesktopConversationCopy(uiLocale).actions;
      toastApi.info(actionCopy.revisionReadyTitle, actionCopy.revisionUnchanged);
      return false;
    }
    if (revisionSend && revision) {
      const actionCopy = getDesktopConversationCopy(uiLocale).actions;
      if (hasPendingContext) {
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
        const result = await window.maka.sessions.compact(sessionId);
        return presentContextCompactionResult(
          contextCompactionPresentation,
          sessionId,
          result,
          uiLocale,
        );
      } catch (error) {
        if (activeIdRef.current !== sessionId) return false;
        if (isSessionWorkspaceUnavailableError(error)) {
          showSessionWorkspaceUnavailableToast(toastApi, uiLocale, { sessionId });
        } else {
          showSessionError(
            sessionId,
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
        hasPendingContext ||
        pendingQuotes.length ||
        metadata?.workspaceFileReferences?.length
      ) {
        toastApi.info(
          shellCopy.sideChatContextPendingTitle,
          shellCopy.sideChatContextPendingDescription,
        );
        return false;
      }
      workbar.commands.openTool('side-chat', 'right', {
        ...(slashCommand.command.prompt
          ? { initialPrompt: slashCommand.command.prompt }
          : {}),
      });
      return true;
    }
    if (slashCommand?.kind === 'swarm') {
      const swarmCommand = slashCommand.command;
      if (swarmCommand.kind === 'status') {
        const active = activeOrchestrationMode === 'swarm';
        toastApi.info(
          active ? shellCopy.swarmModeEnabledTitle : shellCopy.swarmModeDisabledTitle,
          shellCopy.swarmModeStatusDescription,
        );
        return true;
      }
      if (swarmCommand.kind === 'set_mode') {
        const changed = await setOrchestrationModeActive('swarm', swarmCommand.mode === 'swarm');
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
      const pending = submittableAttachments;
      const quotes = pendingQuotes.length ? pendingQuotes : undefined;
      const ok = await send(swarmCommand.task, pending, {
        turnOrchestration: { mode: 'swarm', source: 'slash_command' },
        ...directoryOptions,
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
      if (ok !== false) {
        clearSubmittedContext(pending);
        if (quotes) clearQuotes();
        settleNewTaskImageNoticeOwner(sessionId);
      }
      return ok;
    }
    if (slashCommand?.kind === 'graph') {
      const graphCommand = slashCommand.command;
      if (graphCommand.kind === 'status') {
        const active = activeOrchestrationMode === 'graph';
        toastApi.info(
          active ? shellCopy.graphModeEnabledTitle : shellCopy.graphModeDisabledTitle,
          shellCopy.graphModeStatusDescription,
        );
        return true;
      }
      if (graphCommand.kind === 'history') {
        toastApi.info(shellCopy.graphHistoryTitle, shellCopy.graphHistoryDescription);
        return true;
      }
      if (graphCommand.kind === 'set_mode') {
        const changed = await setOrchestrationModeActive('graph', graphCommand.mode === 'graph');
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
      const pending = submittableAttachments;
      const quotes = pendingQuotes.length ? pendingQuotes : undefined;
      const ok = await send(graphCommand.task, pending, {
        turnOrchestration: { mode: 'graph', source: 'slash_command' },
        ...directoryOptions,
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
      if (ok !== false) {
        clearSubmittedContext(pending);
        if (quotes) clearQuotes();
        settleNewTaskImageNoticeOwner(sessionId);
      }
      return ok;
    }
    const pending = submittableAttachments;
    const expectedRevisionDraft = revisionSend
      ? revisionDraftRef.current
      : undefined;
    const quotes = pendingQuotes.length ? pendingQuotes : undefined;
    const ok = await send(text, pending, {
      ...directoryOptions,
      ...(quotes ? { quotes } : {}),
      ...(workspaceFileReferences.length
        ? { workspaceFileReferences }
        : {}),
    });
    if (ok !== false) {
      clearSubmittedContext(pending);
      if (quotes) clearQuotes();
      settleNewTaskImageNoticeOwner(sessionId);
      if (sessionId) delete retractedWorkspaceReferencesRef.current[sessionId];
    }
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

  async function updateQueuedEntry(
    entryId: string,
    expectedQueueRevision: number,
    text: string,
  ): Promise<void> {
    await runQueueEntryAction((sessionId) =>
      window.maka.sessions.updateQueueEntry(sessionId, entryId, expectedQueueRevision, text)
    );
  }

  async function deleteQueuedEntry(entryId: string): Promise<void> {
    const messageId = activeMessageQueue?.entries.find((entry) => entry.entryId === entryId)?.messageId;
    const sessionId = await runQueueEntryAction((sessionId) =>
      window.maka.sessions.retractQueueEntry(sessionId, entryId).then(() => undefined)
    );
    if (sessionId && messageId) removeTransientMessage(sessionId, messageId);
  }

  // Surfaces the failure, then rethrows so the pending plate can settle its
  // in-flight action state without guessing with a timer.
  async function runQueueEntryAction(
    action: (sessionId: string) => Promise<void>,
  ): Promise<string | undefined> {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    try {
      await action(sessionId);
      return sessionId;
    } catch (error) {
      if (activeIdRef.current === sessionId) {
        const copy = getDesktopConversationCopy(uiLocale).actions;
        showSessionError(
          sessionId,
          copy.operationFailedTitle,
          localizedShellErrorMessage(error, copy.operationFailedFallback, uiLocale),
        );
      }
      throw error;
    }
  }

  async function promoteQueuedEntry(entryId: string): Promise<void> {
    await runQueueEntryAction((sessionId) =>
      window.maka.sessions.promoteQueueEntry(sessionId, entryId).then(() => undefined)
    );
  }

  async function reorderQueuedEntries(entryIds: readonly string[]): Promise<void> {
    await runQueueEntryAction((sessionId) =>
      window.maka.sessions.reorderQueueEntries(sessionId, entryIds).then(() => undefined)
    );
  }

  const stop = createAppShellStopAction({
    uiLocale,
    activeIdRef,
    stopPending: sessionUiController.stopPending,
    removeTransientMessage,
    toastApi,
  });

  const [sessionDisplayBatch] = useState(createAppShellSessionDisplayBatch);
  const {
    handleEvent,
    reconcilePersistedMessages,
    settleAssistantStreaming,
    flushDisplayEvents,
    dropDisplayEvents,
    markDisplayPending,
    markDisplayReady,
  } = useStableActions(createAppShellSessionEventHandlers, {
    uiLocale,
    activeIdRef,
    liveTurnBySessionRef: sessionUiController.liveTurnBySessionRef,
    refreshMessages,
    refreshSessions,
    setLiveTurnBySession: sessionUiController.setLiveTurnBySession,
    setInteractionBySession: sessionUiController.setInteractionBySession,
    setMessageQueueBySession: sessionUiController.setMessageQueueBySession,
    projectQueuedTransientMessages,
    removeTransientMessage,
    displayBatch: sessionDisplayBatch,
    onInteractionChanged: markInteractionChanged,
    onExecutionBoundaryChanged: reloadActiveExecutionBoundary,
    onContextCompactionOutcome: (sessionId, turnId, outcome) =>
      contextCompactionPresentation.finished(sessionId, turnId, outcome, uiLocale),
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

  useAppShellNavRefSync({
    navSelection,
    navSelectionRef,
  });
  useAppShellHostEffects();
  useAppShellBootstrapSubscriptions({
    uiLocale,
    activeIdRef,
    applyE2eFixture,
    bootstrapSessions,
    clearPendingTurnActionsForSession: turnActionRegistry.clearForSession,
    confirmLiveTurn: sessionUiController.confirmLiveTurn,
    clearSessionRendererState,
    createSession,
    handleConnectionEvent,
    openHelp,
    openSettings,
    clearPendingTurnActions: turnActionRegistry.clearAll,
    projectPickerPendingRef,
    projectPickerRequestRef,
    refreshConnections: refreshConnectionProjections,
    refreshMemoryActive,
    refreshMessages,
    refreshProjects,
    refreshShellSettings,
    refreshSessions,
    rendererMountedRef,
    setActiveId,
    setMessages,
    setSessionEventHealthBySession: sessionUiController.setSessionEventHealthBySession,
    toastApi,
  });
  useAppShellPersistenceEffects({
    navigationState,
    themePalette,
    themePref,
  });
  const [activeEventSeed, setActiveEventSeed] = useState<LiveContentSeed>(EMPTY_LIVE_CONTENT_SEED);
  const activeEventSeedRef = useRef(activeEventSeed);
  activeEventSeedRef.current = activeEventSeed;
  const beginObservationSeed = (sessionId: string) => {
    const next = beginLiveContentSeed(activeEventSeedRef.current, sessionId);
    activeEventSeedRef.current = next;
    markDisplayPending(sessionId);
    setActiveEventSeed(next);
    return next.generation;
  };
  const completeObservationSeed = (sessionId: string, generation?: number) => {
    const current = activeEventSeedRef.current;
    const expected = generation ?? current.generation;
    if (current.sessionId !== sessionId || current.generation !== expected) return;
    flushDisplayEvents(sessionId);
    markDisplayReady(sessionId);
    const next = completeLiveContentSeed(current, sessionId, expected);
    activeEventSeedRef.current = next;
    setActiveEventSeed(next);
    const firstSendWaiter = firstSendObservationWaitersRef.current.get(sessionId);
    if (firstSendWaiter) {
      firstSendObservationWaitersRef.current.delete(sessionId);
      globalThis.clearTimeout(firstSendWaiter.timeoutId);
      firstSendWaiter.resolve();
    }
    void retireCancelledTransientMessages(sessionId);
  };
  useActiveSessionEvents({
    uiLocale,
    activeId,
    activeProfileId: activeSession?.profileId,
    activeIdRef,
    handleEvent,
    beginObservationSeed,
    completeObservationSeed,
    setMessageLoadErrorBySession: sessionUiController.setMessageLoadErrorBySession,
    setMessageLoadPending,
    setMessages,
    transcriptRangeRef,
    setSessionEventHealthBySession: sessionUiController.setSessionEventHealthBySession,
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
        sessionUiController.setMessageLoadErrorBySession((current) => ({
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
  useShellRunUpdates({
    activeId,
    setShellRunUpdatesBySession: sessionUiController.setShellRunUpdatesBySession,
  });
  useSessionEventHealthPolling({
    activeId,
    activeInteraction,
    activeSession,
    activeStreamingLive,
    hasInFlightLiveTools,
    refreshMessages,
    refreshSessions,
    sessionEventHealthBySessionRef: sessionUiController.sessionEventHealthBySessionRef,
    setSessionEventHealthBySession: sessionUiController.setSessionEventHealthBySession,
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

  function showModelSetupToast(
    description: string,
    reason?: string,
    diagnosticTarget?: ToastDiagnosticTarget,
  ) {
    const copy = modelSetupToastCopy(reason, description, uiLocale);
    toastApi.toast({
      title: copy.title,
      description: !modelSettingsOwnsComposerHost && composerProfileName
        ? shellCopy.configureModelsOnHost(composerProfileName)
        : copy.description,
      variant: 'error',
      duration: 8000,
      ...(diagnosticTarget ? { diagnosticTarget } : {}),
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

  function showSessionError(
    sessionId: string,
    title: string,
    description?: string,
  ) {
    toastApi.error(title, description, undefined, { sessionId });
  }

  const canStageComposerContext =
    activeId !== undefined || taskEntry.selectors.target !== undefined;

  const activeMessageLoadError = activeId ? messageLoadErrorBySession[activeId] : undefined;
  let activeTranscriptRange;
  try {
    const controller = transcriptRangeRef.current;
    const range = controller?.store.range();
    if (range?.sessionId === activeId) activeTranscriptRange = range;
  } catch {
    activeTranscriptRange = undefined;
  }
  async function loadTranscriptHistory(target: 'earlier' | 'latest', anchorTurnId?: string) {
    const controller = transcriptRangeRef.current;
    const sessionId = activeId;
    if (!controller || !sessionId || historyLoadPendingRef.current) return;
    historyLoadPendingRef.current = true;
    setHistoryLoadPendingSessionId(sessionId);
    try {
      if (target === 'earlier') {
        await controller.loadBefore(DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES, anchorTurnId);
      } else {
        await controller.loadLatest();
      }
    } catch (error) {
      if (
        activeIdRef.current !== sessionId ||
        transcriptRangeRef.current !== controller
      ) {
        return;
      }
      showSessionError(
        sessionId,
        desktopConversationCopy.actions.messageReadFailedTitle,
        localizedShellErrorMessage(
          error,
          desktopConversationCopy.actions.operationFailedFallback,
          uiLocale,
        ),
      );
    } finally {
      historyLoadPendingRef.current = false;
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
    messages,
    newTaskProfileId: taskEntry.selectors.selectedProfileId,
    settingsOpen,
    settingsProfileId: settingsRequest.profileId,
    sessions,
    themePref,
    visibleSessions,
    captureComposerImportOwner,
    createSession,
    startModeSession,
    openHelp,
    openScheduledTaskCreate: () => {
      closePalette();
      moduleHub.commands.openScheduledTaskCreate();
    },
    openProjectFolder,
    openSessionInChat,
    openSideConversation: () => workbar.commands.openTool('side-chat'),
    openSettings,
    openSettingsSection,
    openSkillsFolder,
    openWorkspaceFolder,
    refreshConnections: defaultHostConnections.refreshConnections,
    copyTodayDailyReview: moduleHub.commands.copyTodayDailyReview,
    pasteTodayDailyReview: moduleHub.commands.pasteTodayDailyReview,
    saveTodayDailyReview: moduleHub.commands.saveTodayDailyReview,
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
    // Wraps the whole frame rather than each composer, so one projection serves
    // the main composer and every side-chat panel. Left un-indented on purpose:
    // re-indenting 500 lines of JSX would bury the change that matters.
    <ComposerMentionsProvider {...composerMentionsSurface}>
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
            {navSelection.section === 'sessions' && !workHubActive && activeSessionForView && (
              <TitlebarSessionIdentity
                /* Keyed by session: the open rename is local state and the field is
                   uncontrolled, so a switch that left the instance mounted would
                   carry one session's half-typed name — and its commit — onto the
                   next one. A remount ties the edit to the session it belongs to. */
                key={activeSessionForView.id}
                sessionName={activeSessionForView.name}
                readOnly={sharedSessionActive}
                action={
                  sharedSessionActive ||
                  !activeDesktopSession ||
                  activeDesktopSession.profileKind === 'environment'
                    ? undefined
                    : {
                        label: getSessionCollaborationCopy(uiLocale).shareAction,
                        onClick: () => void openSessionSharing(activeDesktopSession),
                      }
                }
                onRenameSession={(name) => {
                  void sessionNavigationCommandsRef.current?.renameSession(activeSessionForView.id, name);
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
            {!sharedSessionActive && !VIEWS_WITHOUT_WORKSPACE_ACTIONS.has(agentsView) && (
              <WorkbarTitlebarActions
                available={workbarAvailable}
                collapsed={workbar.selectors.rightCollapsed}
                onToggle={workbar.commands.toggleRight}
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
          <SessionNavigationProvider
            rail={sessionRail}
            projects={localProjects}
            streamingSessionIds={streamingSessionIds}
            staleSessionIds={staleSessionIds}
            ports={sessionNavigationPorts}
            commandsRef={sessionNavigationCommandsRef}
            onExitWorkHub={exitWorkHub}
            onSelectSession={openSession}
            workHubActive={workHubActive}
            selection={navSelection}
            scheduledTasks={moduleHub.selectors.scheduledTasks}
            moduleMemory={navigationState.moduleMemory}
            onSelect={setNavSelection}
            onOpenSettings={openSettings}
            updateReminder={updateReminder}
            onOpenUpdate={openUpdateDownload}
            onNew={() => void createSession()}
            workHubEntry={workHubEnabled ? {
              active: workHubActive,
              label: 'WorkHub',
              onSelect: openWorkHub,
            } : undefined}
            projectActions={projectRowActions}
          >
            {SESSION_RAIL}
          </SessionNavigationProvider>
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
              <ModuleHubHost model={moduleHub.host} />
              {workHubEnabled && workHubActive && navSelection.section === 'sessions' ? (
                workHubCoordinationSessionId ? (
                  <WorkHubSurface
                    key={workHubCoordinationSessionId}
                    controller={workHubController}
                    leaseScope={workHubCoordinationSessionId}
                    locale={uiLocale}
                    {...(activeId ? { initialFocusSessionId: activeId } : {})}
                    onOpenSession={openSessionInChat}
                  />
                ) : (
                  <WorkHubCoordinationStatus
                    locale={uiLocale}
                    state={workHubCoordinationState}
                    onRetry={() => workHubCoordinationRetryRef.current()}
                  />
                )
              ) : (
              <ChatSurfaceLayout
                // ChatView positions this transcript: switching conversations,
                // following the tail and the moves the reader asks for are one
                // authority there, and the composer never remounts for any of
                // them — its contenteditable DOM carries the live draft.
                scrollOwner="host"
                data-maka-onboarding={showOnboardingHero ? 'true' : undefined}
                scrollToBottomLabel={
                  desktopConversationCopy.actions.scrollMainToBottom
                }
                hidden={navSelection.section !== 'sessions'}
                composer={
                  <>
                    {!sharedSessionActive && navSelection.section === 'sessions' &&
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
                    {!sharedSessionActive && navSelection.section === 'sessions' ? <PlanExecutionPanel planMode={planMode} /> : null}
                    {workHubEnabled && navSelection.section === 'sessions' && activeId ? (
                      <Button
                        className="workhub-return"
                        label={uiLocale === 'zh' ? '返回 WorkHub' : 'Return to WorkHub'}
                        variant="secondary"
                        size="sm"
                        onClick={openWorkHub}
                      />
                    ) : null}
                    {sharedSessionActive && activeId ? (
                      <SessionTurnRequestComposer key={activeId} sessionId={activeId} />
                    ) : (
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
                  newTaskSendPending={newTaskSendPending}
                  stopPendingBySession={stopPendingBySession}
                  respondToSandboxBoundary={respondToSandboxBoundary}
                  respondToClientCapability={workbar.commands.respondToClientCapability}
                  respondToUserQuestion={respondToUserQuestion}
                  stop={stop}
                  directoryComposerProps={directoryComposerProps}
                  directoryPickerEnabled={!!(
                    canStageComposerContext && directoryHostId && !revisionDraft
                  )}
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
                  processing={(showProcessingIndicator || activeMessageSubmitting) && !activeStreamingLive}
                  continuing={showContinuingIndicator && !activeStreamingLive}
                  onSend={sendOwningItsTarget}
                  onStop={stop}
                  queuedMessages={activeMessageQueue?.entries}
                  queuedMessageRevision={activeMessageQueue?.queueRevision}
                  onPromoteQueuedEntry={activeId ? promoteQueuedEntry : undefined}
                  onUpdateQueuedEntry={activeId ? updateQueuedEntry : undefined}
                  onDeleteQueuedEntry={activeId ? deleteQueuedEntry : undefined}
                  onReorderQueuedEntries={activeId ? reorderQueuedEntries : undefined}
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
                  slashCommands={desktopSlashCommands}
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
                  hideUnavailableCurrentModel={sessionHealthNotice?.onClickTarget === 'model_picker'}
                  renderProviderMark={(type) => <ProviderBrandMark type={type} />}
                  modelSwitchAvailability={modelSwitchAvailability}
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
                      ? async (mode) => {
                          await setPermissionMode(mode);
                        }
                      : undefined
                  }
                  planModeActive={activePlanMode}
                  // No pending-keyed disable while a toggle commits: the
                  // pending registries already swallow re-entrant toggles, and
                  // a reason here would gray the row mid-click — the blink
                  // this control had. The rows repaint when the write lands.
                  planModeDisabledReason={modeChangeDisabledReason}
                  onPlanModeChange={(active) => {
                    void setPlanMode(active);
                  }}
                  orchestrationMode={activeOrchestrationMode}
                  orchestrationModeDisabledReason={modeChangeDisabledReason}
                  onOrchestrationModeChange={(mode) => {
                    void setOrchestrationMode(mode);
                  }}
                  onSetGoal={
                    activeId && activeBoundarySurface.localInteractionAvailable
                      ? goals.commands.openDialog
                      : undefined
                  }
                  goalActive={goals.selectors.active}
                  goalDisabledReason={
                    activeStreamingLive || (activeId && turnActive)
                      ? shellCopy.goalTurnActive
                      : undefined
                  }
                    />
                    )}
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
                onLoadEarlierHistory={(anchorTurnId) =>
                  loadTranscriptHistory('earlier', anchorTurnId)}
                onReturnToLatestHistory={() => loadTranscriptHistory('latest')}
                liveContentSeedRevision={liveContentSeedRevision(activeEventSeed, activeId)}
                messages={messages}
                transientMessages={transientMessages}
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
                modelChangePending={modelChangePending}
                onModelChange={sharedSessionActive ? undefined : (input) => setSessionModel(input)}
                userLabel={userLabel}
                memoryActive={memoryActive}
                onOpenMemorySettings={sharedSessionActive ? undefined : () => openSettingsSection('memory')}
                goalIndicator={goals.selectors.indicator}
                messageLoadError={activeId ? messageLoadErrorBySession[activeId] : undefined}
                messageLoadRetryPending={activeId ? messageRetryPendingBySession[activeId] === true : false}
                onRetryMessages={activeId ? () => void retryMessages(activeId) : undefined}
                deriveTurnPresentation={deriveTurnPresentation}
                onTurnFooterAction={sharedSessionActive ? undefined : handleTurnFooterAction}
                onSwitchToBypassAndRetry={sharedSessionActive ? undefined : handleSwitchToBypassAndRetry}
                onEditUserMessage={sharedSessionActive ? undefined : (turnId) => { void beginEditUserMessage(turnId); }}
                safeResumeAction={!sharedSessionActive && activeId ? {
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
                onBranchBannerClick={openSessionInChat}
                revisionNavigation={revisionNavigation}
                onRevisionNavigate={openSessionInChat}
                onNew={createSession}
                onPromptSuggestion={(prompt) => composerRef.current?.appendText(prompt)}
                onQuoteSelection={
                  sharedSessionActive
                    ? undefined
                    : (selection) => {
                        addQuote(selection);
                        composerRef.current?.focus();
                      }
                }
                onAskAboutSelection={
                  activeId
                    ? (input) => {
                        const quote: QuoteRef = {
                          text: input.text,
                          sourceTurnId: input.turnId,
                        };
                        workbar.commands.openSideChatWithQuote(quote);
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
                sessionHealthModelPickerAvailable={
                  activeBoundarySurface.localInteractionAvailable
                }
                workspaceReadinessRecovery={workspaceReadinessRecovery}
                taskReadinessNotice={taskReadinessNotice}
                onTaskReadinessAction={
                  taskReadinessNotice?.action === 'workspace_picker'
                    ? activeSession
                      ? openNewTaskSurface
                      : taskEntry.selectors.canAddProject
                        ? taskEntry.commands.addProject
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
                    await runOnDefaultRuntimeHost((host) =>
                      window.maka.onboarding.setMilestone(
                        'initial_onboarding',
                        'skipped',
                        host,
                      ),
                    );
                    onboarding.refresh();
                  } catch (error) {
                    toastApi.error(
                      shellCopy.skipErrorTitle,
                      localizedShellErrorMessage(error, shellCopy.tryAgainLater, uiLocale),
                      undefined,
                      defaultRuntimeHostDiagnosticTarget(error),
                    );
                  }
                }}
                conversationItems={planConversationItems}
                  />
                ) : null}
              </ChatSurfaceLayout>
              )}
            </div>
            {/* Collapse hides the Workbar surface without unmounting its tools;
                dynamic resources therefore keep their existing lifecycle. */}
            <WorkbarHost model={workbar.host} />
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
      <GoalHost model={goals.host} />
      <TaskEntryHost model={taskEntry.host} />
      <RuntimeHostSshTerminalDialog />
      {sharedSessionDialog.target ? (
        <SessionCollaborationDialog
          mode="share"
          sessionId={sharedSessionDialog.target.sessionId}
          sessionName={sharedSessionDialog.target.sessionName}
          requiresRemoteAccess={sharedSessionDialog.target.requiresRemoteAccess}
          onEnableRemoteAccess={() => {
            const copy = getSessionCollaborationCopy(uiLocale);
            sharedSessionDialog.close();
            toastApi.info(copy.enableRemoteAccessTitle, copy.enableRemoteAccessBody);
            openSettingsSection('projects');
          }}
          onClose={sharedSessionDialog.close}
        />
      ) : null}

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
        refreshChatDefaults={() => {
          void taskEntry.commands.refresh().catch(() => undefined);
        }}
        settingsRequest={settingsRequest}
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
        onExternalSessionImported={(session) => {
          closeSettings();
          openSessionInChat(session.id);
        }}
        onRemoteHostAdded={(profileId) => {
          closeSettings();
          openNewTaskSurface();
          void taskEntry.commands.chooseProjectForProfile(profileId).catch(() => undefined);
        }}
        onSelectedRuntimeHostProfileIdChange={setSettingsProfileId}
      />
    </div>
    </ComposerMentionsProvider>
  );
}
