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

import { WorkHubControlOverlay, WorkHubDock, WorkHubMainNavigation } from './features/workhub';
import { WorkHubEnablementWatch } from './application/contracts/workhub-workspace/workhub-enablement.js';
import { RuntimeHostHandoffOverlay } from './features/runtime-host-management/index.js';
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { QuoteRef } from '@maka/core/events';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { UiLocale, UiLocalePreference } from '@maka/core/ui-locale';
import { collapseSessionRevisions } from '@maka/core/session-revisions';
import { isLinkedSubagentSession } from '@maka/core/session';
import { resolveUiLocale } from '@maka/core/ui-locale';
import { hasSettledInitialOnboarding } from '@maka/core/onboarding-milestone';
import {
  ChatSurfaceLayout,
  type ComposerHandle,
  type MakaUriDest,
  MakaUriContext,
  AstryxLocaleProvider,
  LocaleProvider,
  type ToastDiagnosticTarget,
  type NavSelection,
  type ProjectRowActions,
  SessionListPanel,
  TitlebarSessionIdentity,
  type TurnFooterActionMeta,
  useToast,
  deriveComposerModelSwitchAvailability,
  deriveTitlebarProjectName,
} from '@maka/ui';
import type { ConnectionEvent } from '@maka/core/connections';
import { ChatMessageSurface } from './chat-message-surface';
import * as Conversation from './features/conversation';
import { deriveWorkspaceReadinessRecovery } from './workspace-readiness-recovery';
import { AgentGraphPanel } from './agent-graph-panel';
import { ChatComposerRegion } from './chat-composer-region';
import { WorkbarHost, WorkbarProvider, WorkbarShellRoot, type WorkbarShellProjection } from './features/workbar';
import { AppUpdateProvider } from './features/app-update/index.js';
import * as Goals from './features/goals';
import * as ModuleHub from './features/module-hub';
import {
  SessionNavigationProvider,
  createSessionOpenCommand,
  sessionRailLayoutStore,
  useSessionNavigationReads,
  type SessionNavigationPorts,
  type SessionNavigationRowActions,
} from './features/session-navigation';
import * as TaskEntry from './features/task-entry';
import type { TaskEntryShellProjection } from './features/task-entry';
import * as Overlays from './features/overlays/index.js';
import type { OverlaysShellProjection } from './features/overlays/index.js';
import * as SessionCollaboration from './features/session-collaboration';
import type { SessionCollaborationDialogProjection } from './features/session-collaboration';
import { NEW_TASK_PENDING_KEY } from './pending-items';
import {
  getOnboardingActivationCandidate,
  OnboardingConnectionSeed,
  OnboardingProjectionRoot,
  type OnboardingShellProjection,
} from './application/contracts/onboarding/onboarding-authority.js';
import { ShellLifecycleSubscriptions } from './application/contracts/shell-lifecycle.js';
import { ProviderBrandMark } from './settings/provider-brand-marks';
import { RuntimeHostSshTerminalDialog } from './settings/runtime-host-ssh-terminal-dialog.js';
import {
  getShellCopy,
  localizedShellErrorMessage,
  confirmBypassPermission,
  sessionSettingFailureCopy,
} from './locales/shell-copy';
import * as Diagnostics from './features/diagnostics/index.js';
import { getDesktopConversationCopy } from './application/contracts/conversation-copy';
import { ErrorBoundary } from './error-boundary';
import { useShellAppearance } from './use-shell-appearance';
import { SessionSettingsProvider, useSessionSettingIntent } from './features/session-settings';
import { pendingSessionView } from './pending-session-view';
import { readScrollMotionBehavior } from './scroll-motion-policy';
import { readNavigationState, selectNavigation } from './nav-selection';
import { deriveDesktopExecutionBoundarySurface } from './desktop-execution-boundary-surface';
import { modelSetupToastCopy } from './model-connection-errors';
import type { AppShellCommandListOptions } from './app-shell-command-actions';
import { AppShellTitlebar } from './app-shell-chrome-actions';
import { AppShellDetailPanel } from './shell/detail-panel';
import { appShellFrameStyle } from './shell/frame-style';
import { AppShellOverlays } from './app-shell-overlays';
import type { ArchivedTasksBridge } from './settings/tasks-settings-page';
import { CustomPetCompanionForSession } from './custom-pet-companion';
import { defaultRuntimeHostDiagnosticTarget } from './platform/desktop/default-runtime-host-operation.js';
import { useAppShellProjectContext } from './use-project-context';
import { createAppShellE2eFixtureActions } from './app-shell-e2e-fixture';
import { useStableActions } from './use-stable-actions';
import {
  useAppShellBootstrapSubscriptions,
  useAppShellHostEffects,
  useAppShellPersistenceEffects,
  useAppShellNavRefSync,
} from './app-shell-effects';
import { loadComposerDefaults, saveComposerDefaults } from './composer-defaults';
import {
  useActiveExecutionBoundary,
  useShellChatModel,
} from './features/conversation/index.js';
import {
  type ComposerMentionsSurfaceInput,
  renderComposerMentionsProvider,
} from './composer-mentions';
import { useAppShellSessionWorkspace } from './use-app-shell-session-workspace';
import { useShellMemoryPill } from './use-shell-memory-pill';
import { useShellConnections } from './use-shell-connections';

import { useSystemUiLocale } from './use-system-ui-locale';
import { AppShell as AstryxAppShell } from '@astryxdesign/core/AppShell';

type ComposerImportOwner = {
  sessionId: string | undefined;
  navSection: NavSelection['section'];
  newTaskDraftKey?: string;
};

export function AppShell() {
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
        <Diagnostics.DiagnosticReportToastProvider>
          <ErrorBoundary locale={uiLocale}>
            <AppUpdateProvider>
              <RuntimeHostHandoffOverlay />
              <WorkHubControlOverlay />
              <TaskEntry.TaskEntryRoot>
                {(taskEntry) => (
                  <Overlays.OverlaysRoot>
                    {(overlays) => (
                      <SessionCollaboration.SessionCollaborationDialogRoot>
                        {(sharedSessionDialog) => (
                          <WorkbarShellRoot>
                            {(workbar) => (
                              <Conversation.ConversationProvider>
                                <OnboardingProjectionRoot>
                                  {(onboarding) => (
                                    <Diagnostics.ManualDiagnosticReportConsumer>
                                      {(copyManualDiagnosticReport) => (
                                        <AppShellContent
                                          {...{ taskEntry, overlays, sharedSessionDialog, workbar, onboarding, copyManualDiagnosticReport, uiLocale, setUiLocaleOverride, setUiLocalePreference }}
                                        />
                                      )}
                                    </Diagnostics.ManualDiagnosticReportConsumer>
                                  )}
                                </OnboardingProjectionRoot>
                              </Conversation.ConversationProvider>
                            )}
                          </WorkbarShellRoot>
                        )}
                      </SessionCollaboration.SessionCollaborationDialogRoot>
                    )}
                  </Overlays.OverlaysRoot>
                )}
              </TaskEntry.TaskEntryRoot>
            </AppUpdateProvider>
          </ErrorBoundary>
        </Diagnostics.DiagnosticReportToastProvider>
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
  taskEntry,
  overlays,
  sharedSessionDialog,
  workbar: { bridge, commands, selectors, LiveContextUsageProbe },
  onboarding,
  copyManualDiagnosticReport,
  uiLocale,
  setUiLocaleOverride,
  setUiLocalePreference,
}: {
  taskEntry: TaskEntryShellProjection;
  overlays: OverlaysShellProjection;
  sharedSessionDialog: SessionCollaborationDialogProjection;
  workbar: WorkbarShellProjection;
  onboarding: OnboardingShellProjection;
  copyManualDiagnosticReport: Diagnostics.CopyManualDiagnosticReport;
  uiLocale: UiLocale;
  setUiLocaleOverride: Dispatch<SetStateAction<UiLocale | null>>;
  setUiLocalePreference: Dispatch<SetStateAction<UiLocalePreference>>;
}) {
  const toastApi = useToast();
  const {
    renderPublishedConversation,
    refreshMessages,
    transcriptEmpty,
    transcriptHasHistory,
    authoritativeSessionIds,
    sessionsRef,
    refreshSessions,
    refreshChangedSession,
    activeId,
    activeIdRef,
    bootstrapSelectionLease,
    setActiveId,
    startNewSession,
    clearOwnedSessionState,
    isSessionSelected,
    retiredSessionIds,
    sessionUiReads,
    recordSessionChange,
    sessionCatalogController,
    commitSession,
    activeCatalogSession,
    activeHostSession,
    sharedSessionActive,
    ownerActiveId,
    switchingSession,
    queueSurface,
  } = useAppShellSessionWorkspace(toastApi);
  // The shell's own reading of the catalog rides the membership set the list
  // hook already publishes — background row churn belongs to the rail, which
  // subscribes the catalog inside SessionNavigationProvider (#4109).
  const sessionCount = authoritativeSessionIds?.size ?? 0;

  const {
    openHelp,
    closePalette,
    openSearch,
    setSearchScrollTarget,
    openSettings,
    openSettingsSection,
    openProjectSettings,
    openProviderCatalog,
    openConnectionDetail,
    openProviderCreate,
    setSettingsProfileId,
  } = overlays.commands;
  const { searchScrollTarget } = overlays.selectors;
  const settingsOpen = overlays.selectors.settings.open;

  // The owner bridge keeps commands stable while TaskEntryRoot swaps the
  // current feature-owned implementation below the shell.
  const { resolveWorkBoardTarget, prepareWorkBoardDraft, openSessionWorkspaceRecovery } = taskEntry.commands;
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
  const composerStaging = useMemo(Conversation.createComposerStagingCommands, []);
  const composerSubmission = useMemo(Conversation.createComposerSubmissionCommands, []);
  const [petCompletionNonce, setPetCompletionNonce] = useState(0);
  const [navigationState, setNavigationState] = useState(() => readNavigationState());
  const navSelection = navigationState.selection;
  const sessionsSelected = navSelection.section === 'sessions';
  const setNavSelection = useCallback<Dispatch<SetStateAction<NavSelection>>>((nextSelection) => {
    setNavigationState((current) => selectNavigation(
      current,
      typeof nextSelection === 'function' ? nextSelection(current.selection) : nextSelection,
    ));
  }, []);
  const navSelectionRef = useRef<NavSelection>(navSelection);
  // Navigation only: whether WorkHub is enabled at all is the client switch
  // the WorkHub enablement authority owns (see WorkHubEnablementWatch below).
  const [workHubActive, setWorkHubActive] = useState(false);
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
  const startupConnectionSnapshot = onboarding.snapshot;
  let newTaskConnectionSnapshot = newTaskConnections.snapshot;
  if (newTaskConnections.projection.status !== 'ready' && taskEntry.selectors.usesDefaultHost) {
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
  const activeConnectionSnapshot = workHubActive || activeId
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
    sessionCount > 0,
  );
  const {
    workbarTogglePosition,
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
  const desktopConversationCopy = getDesktopConversationCopy(uiLocale);
  // Session Settings owns both the selected Session's mode writes and what a
  // new chat will start with: a Plan toggle, one orchestration value and the
  // draft's permission choice, not one fused choice.
  const sessionSettingIntent = useSessionSettingIntent(activeId);
  const newTaskSettings = sessionSettingIntent.newTask;
  /**
   * What this draft would start in: the user's choice for it if they made one,
   * otherwise the Host default it will inherit by omission.
   *
   * The choice stays local to the draft. Picking Full access for one task is
   * not a statement about every later task, so it is sent once on create and
   * never written back to `chatDefaults` — the Settings surface owns that.
   */
  const newSessionPermissionMode =
    newTaskSettings.permissionChoice ??
    taskEntry.selectors.selectedHost?.chatDefaults.permissionMode ??
    'bypass';
  // Persisted composer defaults seed the empty-state model, project path, and
  // recent workspace history so the home view is populated before the async
  // `app:info` round-trip completes on mount.
  const persistedComposerDefaults = loadComposerDefaults();
  // Named Composer edits; the editor handle stays with Conversation.
  const composerEditing = queueSurface.editing;
  const rendererMountedRef = useRef(true);
  const activeSession = activeCatalogSession;
  const { setPermissionMode, setSessionModel, setSessionThinkingLevel, setSessionExecutor } = sessionSettingIntent.commands;
  const modelConfigurationOverlay = sessionSettingIntent.overlay.modelConfiguration;
  const activeSessionForModelControls = activeSession
    ? {
        ...activeSession,
        ...(modelConfigurationOverlay
          ? {
              llmConnectionId: modelConfigurationOverlay.modelTarget.llmConnectionId,
              llmConnectionSlug: modelConfigurationOverlay.modelTarget.llmConnectionSlug,
              model: modelConfigurationOverlay.modelTarget.model,
              thinkingLevel: modelConfigurationOverlay.thinkingLevel ?? undefined,
            }
          : {}),
      }
    : undefined;
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
    ? activeSession?.profileId
    : taskEntry.selectors.selectedProfileId;
  const composerProfileName = activeId
    ? activeSession?.profileName
    : taskEntry.selectors.selectedHost?.name;
  const modelSettingsOwnsComposerHost =
    composerProfileId !== undefined &&
    composerProfileId === taskEntry.selectors.defaultProfileId;
  // The status half of the Composer's model-switch gate; the transcript region
  // adds the running Turn to the health notice's picker.
  const modelPickerStatusBlocked = !deriveComposerModelSwitchAvailability({
    sessionStatus: activeSession?.status,
    pending: false,
  }).available;
  const {
    chatModelChoices,
    activeModel,
    executor,
    composerModelProps,
    newChatModel,
    newChatExecutionTarget,
    newChatModelLabel,
    newChatProviderType,
    newChatThinkingLevels,
    newChatThinkingLevel,
    pendingNewChatThinkingLevel,
    newChatExecutionThinkingLevel,
    composerSupportsVision,
    setPendingNewChatModel,
    setPendingNewChatThinkingLevel,
    executorTarget,
    onExecutorTargetChange,
    sessionHealthNotice,
  } = useShellChatModel({
    uiLocale,
    connections,
    chatModelChoices: connectionModelChoices,
    sessionSendOutcome: activeSessionSendOutcome,
    defaultConnection,
    newTaskKey: currentNewTaskDraftKey,
    executorTarget: taskEntry.selectors.target,
    executorCwd: activeSession?.cwd ?? taskEntry.selectors.projectPath,
    executorSessionPending: activeSession?.localState === 'pending',
    activationCandidate: modelSettingsOwnsComposerHost
      ? onboardingActivationCandidate
      : undefined,
    activeSession: activeSessionForModelControls,
    sessionHealthSession: activeSession,
    persistedComposerDefaults,
    usePersistedComposerDefaults: modelSettingsOwnsComposerHost,
    connectionSnapshotReady: activeId
      ? sessionHostConnections.projection.status === 'ready'
      : true,
    modelPickerDisabled: modelPickerStatusBlocked,
    openSettingsSection,
    openModelPicker: composerEditing.openModelPicker,
    refreshModelChoices: sessionHostConnections.refreshConnections,
    setSessionExecutor,
  });
  function clearSessionRendererState(sessionId: string): void {
    // `clearOwnedSessionState` ends in `clearSessionUiState`, which drops this
    // session from every session-UI map — the four pending claims included.
    clearOwnedSessionState(sessionId);
    composerSubmission.clearPendingTurnActions(sessionId);
    sessionSettingIntent.commands.clear(sessionId);
  }

  // Stable: the rail's row actions are built from it, and it only reaches
  // registries and refs that are themselves stable (#4109).
  function setPlanMode(active: boolean): Promise<boolean> {
    const sessionId = activeIdRef.current;
    if (!sessionId) {
      sessionSettingIntent.commands.setNewTaskPlanMode(active);
      return Promise.resolve(true);
    }
    if (active === activePlanMode) return Promise.resolve(true);
    return sessionSettingIntent.commands.setPlanMode(sessionId, active);
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
      sessionSettingIntent.commands.setNewTaskOrchestrationMode(mode);
      return Promise.resolve(true);
    }
    if (mode === activeOrchestrationMode) return Promise.resolve(true);
    return sessionSettingIntent.commands.setOrchestrationMode(sessionId, mode);
  }

  function setOrchestrationModeActive(
    mode: Exclude<OrchestrationMode, 'default'>,
    active: boolean,
  ): Promise<boolean> {
    if (active) return setOrchestrationMode(mode);
    if (activeOrchestrationMode !== mode) return Promise.resolve(true);
    return setOrchestrationMode('default');
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
        composerEditing.appendText(shellCopy.useSkillPrompt(skillName));
      composerEditing.focus();
    };
    if (activeIdRef.current) window.requestAnimationFrame(seed);
    else void createSession().then(() => window.requestAnimationFrame(seed));
    },
    [shellCopy],
  );
  const openWorkHub = useCallback(() => {
    overlays.commands.closeSettings();
    setNavSelection({ section: 'sessions' });
    setWorkHubActive(true);
  }, [overlays.commands, setNavSelection]);

  // Transient placeholder while the real SessionSummary loads, so the composer
  // does not flash a value the session never had.
  const activeSessionForView = activeSession ?? (activeId
    ? pendingSessionView({
        sessionId: activeId,
        name: shellCopy.newConversation,
        permissionMode: newSessionPermissionMode,
      })
    : undefined);
  // Each control reads its own field. There is nothing to project and nothing
  // to keep in sync: a Session in Plan with Swarm as its orchestration default
  // says both, because it is both.
  const activePlanMode = activeId
    ? sessionSettingIntent.overlay.planMode
      ?? ((activeSessionForView?.collaborationMode ?? 'agent') === 'plan')
    : newTaskSettings.planMode;
  const activeOrchestrationMode: OrchestrationMode = activeId
    ? sessionSettingIntent.overlay.orchestrationMode
      ?? activeSessionForView?.orchestrationMode
      ?? 'default'
    : newTaskSettings.orchestrationMode;
  const {
    boundary: activeExecutionBoundary,
    unreadable: activeExecutionBoundaryUnreadable,
    reading: activeExecutionBoundaryReading,
    reload: reloadActiveExecutionBoundary,
  } = useActiveExecutionBoundary(ownerActiveId, activeSessionForView?.permissionMode);
  const activeBoundarySurface = deriveDesktopExecutionBoundarySurface(
    activeId,
    activeExecutionBoundary,
    newSessionPermissionMode,
    sessionSettingIntent.overlay.permissionMode,
  );
  const activePermissionMode = activeBoundarySurface.permissionMode;
  // The published target retains its picture during handoff. Pending local
  // first messages can establish history before the durable row catches up.
  const modelSwitchHasHistory =
    activeSessionForView?.lastMessageAt !== undefined ||
    transcriptHasHistory;
  // PR110c: OnboardingState is now the single source of truth for
  // first-run UI. The renderer never re-derives provider readiness;
  // the application onboarding authority pulls the derived state from the main
  // process (PR110a + PR110b contract) and reactively invalidates on
  // `sessions:changed` + `connections:event`. The hero renders only
  // when sessions.length === 0; any session (including archived /
  // aborted) takes over with the existing chat surface. The default Host's
  // connections are seeded from the same snapshot by OnboardingConnectionSeed.
  // Nothing settled to show while the first snapshot pull is in flight. The
  // flag keeps the composer hidden and — through `data-maka-content-ready` on
  // .appFrame — holds the launch overlay until a real frame exists: sessions,
  // a hero, or the load-error fallback.
  const isOnboardingLoading =
    sessionCount === 0 && onboardingState === undefined && !onboardingSettled && !onboarding.failed;
  // Only unfinished setup takes the chat surface over. A configured user with
  // no sessions is not onboarding: they land on the normal empty chat and use
  // the one real Composer, which creates the session on its first send.
  const showOnboardingHero =
    !sessionCount &&
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
  const moduleHubCommands = useMemo(ModuleHub.createModuleHubCommandPort, []);
  const {
    projectInfo,
    projectCapabilities,
    activeProjectCapabilities,
    currentProjectId,
    currentProject,
    refreshProjects,
  } = useAppShellProjectContext({
    rendererMountedRef,
    sessionId: ownerActiveId,
    sessionCwd: sharedSessionActive ? undefined : activeSession?.cwd,
    sessionProjectId: sharedSessionActive ? undefined : activeSession?.projectId,
    sessionProfileKind: sharedSessionActive ? undefined : activeSession?.profileKind,
  });
  const openProjectFolder = useCallback(
    () => taskEntry.commands.openProjectFolder(ownerActiveId),
    [taskEntry.commands, ownerActiveId],
  );
  const captureActiveComposerClaim = useCallback(() => {
    const sessionId = activeIdRef.current;
    const claim = navSelectionRef.current.section === 'sessions' && sessionId
      ? composerEditing.claimVisibleDraft()
      : undefined;
    if (!claim) return undefined;
    return {
      isCurrent: () =>
        activeIdRef.current === sessionId &&
        navSelectionRef.current.section === 'sessions' &&
        claim.isCurrent(),
      append: claim.append,
    };
  }, [composerEditing]);
  // Where a NEW chat starts. Built unconditionally and handed to the composer,
  // which renders it only while no session owns it — the project is fixed once
  // the first message creates one, so there is nothing to pick after that.
  const taskReadinessWorkspace = activeSession?.cwd ?? taskEntry.selectors.projectPath;
  const taskReadinessRequest = {
    ...Conversation.resolveTaskReadinessModelTarget(activeSession, activeSessionSendOutcome, newChatModel),
    ...(taskReadinessWorkspace ? { cwd: taskReadinessWorkspace } : {}),
  };
  const taskSubmissionHardBlocked =
    !activeId && !taskEntry.selectors.target;
  // The titlebar names the directory the ACTIVE session runs in, so it reads
  // the same projected project state the picker does — `projectInfo` already
  // resolves to the session's own cwd once a session owns it.
  const titlebarProjectName = sharedSessionActive
    ? undefined
    : deriveTitlebarProjectName({
        projectName: currentProject?.name,
        projectPath: projectInfo?.projectPath,
      });
  const openNewTaskSurface = useCallback(() => {
    composerStaging.resetImageNotice(NEW_TASK_PENDING_KEY);
    const ownerToken = startNewSession();
    // Only Plan resets: a new task starts out of Plan, in whatever
    // orchestration the last one was set to.
    sessionSettingIntent.commands.setNewTaskPlanMode(false);
    setNavSelection({ section: 'sessions' });
    setSearchScrollTarget(null);
    // New-task affordances reset to the empty-state composer; move focus
    // there so the user can start typing immediately.
    window.requestAnimationFrame(() => composerEditing.focus());
    return ownerToken;
  }, [composerEditing, composerStaging, sessionSettingIntent.commands, setNavSelection, setSearchScrollTarget, startNewSession]);

  const createSession = useCallback(async () => {
    openNewTaskSurface();
  }, [openNewTaskSurface]);

  // Stable, because the rail's Project rows carry it: a fresh identity here
  // rebuilt the whole list on every AppShell commit (#4109).
  const projectRowActions = useMemo<ProjectRowActions | undefined>(
    () => taskEntry.selectors.projectScopes.length === 0 ? undefined : {
      onNew: (key) => {
        if (taskEntry.commands.selectProject(key)) openNewTaskSurface();
      },
      onRename: taskEntry.commands.renameProject,
      onArchive: taskEntry.commands.archiveProject,
      onRestore: taskEntry.commands.restoreProject,
      onRelink: taskEntry.commands.relinkProject,
    },
    [openNewTaskSurface, taskEntry.commands, taskEntry.selectors.projectScopes.length],
  );

  // Composer mention popups: `/` uses Runtime's session/project-aware,
  // host-compatible projection; `@` uses workspace file search. Keep the
  // resolved project path as a refresh key for new-chat project changes. Only
  // the SURFACE is named here — the projection itself is owned by
  // `ComposerMentionsProvider` below, so its reloads do not re-render the shell.
  const composerMentionsSurface: ComposerMentionsSurfaceInput = {
    sessionId: ownerActiveId,
    projectPath: activeId
      ? ownerActiveId
        ? projectInfo?.projectPath
        : undefined
      : taskEntry.selectors.projectPath,
    newTaskTarget: activeId ? undefined : taskEntry.selectors.target,
    newSessionModel: newChatModel,
    newSessionCollaborationMode: newTaskSettings.planMode ? 'plan' : 'agent',
    // Refresh only; Desktop Main re-reads the authoritative default before
    // constructing the Runtime Host preview target.
    newSessionPermissionMode,
  };

  const hasModalOpen = overlays.selectors.anyModalOpen || sharedSessionDialog.isOpen;
  const shellObscured = hasModalOpen || settingsOpen;
  const exitWorkHub = useCallback(() => setWorkHubActive(false), []);
  const openSession = useMemo(
    () =>
      createSessionOpenCommand({
        activateSession: setActiveId,
        exitWorkHub,
        selectSessionSurface: () => setNavSelection({ section: 'sessions' }),
        setSearchTarget: setSearchScrollTarget,
      }),
    [exitWorkHub, setNavSelection, setActiveId, setSearchScrollTarget],
  );
  useLayoutEffect(() => {
    openSessionInChatRef.current = openSession;
  }, [openSession]);
  const sessionNavigationCommandsRef = useRef<SessionNavigationRowActions | null>(null);
  // Built inline: the rail reads these through a ref published on commit, so
  // their identity carries no information and this object never has to be
  // held still by hand (#4109).
  const sessionNavigationPorts: SessionNavigationPorts = {
    sessionsRef,
    acquireAutomaticQueryBlock: sessionCatalogController.acquireAutomaticQueryBlock,
    clearSessionRendererState,
    refreshSessions,
    toastApi,
  };
  const {
    revisionNavigation,
    activeParentSession,
    layout: railLayout,
  } = useSessionNavigationReads({
    catalog: sessionCatalogController,
    activeSessionId: activeId,
  });
  const sessionListCollapsed = railLayout.collapsed;
  const sessionListWidth = railLayout.width;
  const sessionSideNavHandleRef = sessionRailLayoutStore.collapseHandleRef;
  const titlebarParentSession = useMemo(() => {
    if (!activeParentSession) return undefined;
    const parentId = activeParentSession.id;
    return {
      name: activeParentSession.name,
      onOpen: () => openSessionInChatRef.current(parentId),
    };
  }, [activeParentSession]);
  const archivedTasksBridge = useMemo<ArchivedTasksBridge>(
    () => ({
      catalog: sessionCatalogController,
      projectScopes: taskEntry.selectors.projectScopes,
      commands: sessionNavigationCommandsRef,
    }),
    [sessionCatalogController, taskEntry.selectors.projectScopes],
  );

  const { applyE2eFixture } = useStableActions(createAppShellE2eFixtureActions, {
    openSettingsSection,
    refreshSessions,
    sessionCatalog: sessionCatalogController,
    setActiveId,
    setNavSelection,
    openSearchModal: openSearch,
    setSessionListCollapsed: sessionRailLayoutStore.setCollapsed,
    workbar: {
      setWorkbarCollapsed: commands.setWorkbarCollapsed,
      openTool: commands.openTool,
    },
    setThemePref,
    setUiLocaleOverride,
  });

  useAppShellNavRefSync({
    navSelection,
    navSelectionRef,
  });
  useAppShellHostEffects();
  const shellLifecycle = useAppShellBootstrapSubscriptions({
    uiLocale,
    activeIdRef,
    applyE2eFixture,
    bootstrapSessions,
    clearPendingTurnActionsForSession: composerSubmission.clearPendingTurnActions,
    createSession,
    handleConnectionEvent,

    openHelp,
    openSettings,
    refreshConnections: refreshConnectionProjections,
    refreshMemoryActive,
    refreshMessages,
    refreshProjects,
    refreshShellSettings,
    refreshSessions,
    refreshChangedSession,
    rendererMountedRef,
    retireSession: clearSessionRendererState,
    retiredSessionIds,
    isSessionRemoved: sessionCatalogController.isRemoved,
    sessionsRef,
    recordSessionChange,
    toastApi,
  });
  useAppShellPersistenceEffects({
    navigationState,
    themePalette,
    themePref,
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
      isSessionSelected(owner.sessionId) &&
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
   *   - `kind: 'compose'` → replace the composer's text through
   *     `composerEditing.replaceText(...)` and focus it. We do NOT
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
        composerEditing.replaceText(dest.text);
        composerEditing.focus();
        return;
      default: {
        const _exhaustive: never = dest;
        return _exhaustive;
      }
    }
  }

  function closeSettings() {
    overlays.commands.closeSettings();
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
  // #4804: attachment-only sends are opt-in per host surface, and the Desktop
  // host now admits them. An edit-and-resend draft narrows both pickers in the
  // Composer slot, where the submission owner's draft is read.

  // The home surface also needs no live Turn content and no failed load, which
  // `ConversationHomeSurface` reads for the displayed Session.
  const homeSurfaceEligible = sessionsSelected && transcriptEmpty;
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
    renderPublishedConversation,
    newTaskProfileId: taskEntry.selectors.selectedProfileId,
    settingsOpen,
    settingsProfileId: overlays.selectors.settings.request.profileId,
    sessionCatalog: sessionCatalogController,
    themePref,
    hiddenSessionIds: selectors.hiddenSessionIds,
    captureComposerImportOwner,
    copyManualDiagnosticReport,
    paletteActions: overlays.paletteActions,
    createSession,
    openHelp,
    openScheduledTaskCreate: () => {
      closePalette();
      moduleHubCommands.openScheduledTaskCreate();
    },
    openProjectFolder,
    openSessionInChat,
    openSideConversation: () => commands.openTool('side-chat'),
    openSettings,
    openSettingsSection,
    openWorkspaceFolder: taskEntry.commands.openWorkspaceFolder,
    refreshConnections: defaultHostConnections.refreshConnections,
    copyTodayDailyReview: moduleHubCommands.copyTodayDailyReview,
    pasteTodayDailyReview: moduleHubCommands.pasteTodayDailyReview,
    saveTodayDailyReview: moduleHubCommands.saveTodayDailyReview,
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
    // Feature controllers live below the shell. Task Entry publishes a stable
    // shell projection plus reader-local Host/Workspace Picker projections;
    // Goal state and Module Hub ownership likewise wake only their narrow
    // readers. Composer mentions still wrap the frame so one projection serves
    // every composer, including side-chat panels, without rebuilding the frame
    // on catalog moves.
    <Conversation.ComposerStagingProvider commands={composerStaging}
      draftKey={attachmentDraftKey} directoryHostId={directoryHostId} supportsVision={composerSupportsVision}>
    <Conversation.TaskReadinessProvider request={taskReadinessRequest}
      sessionId={ownerActiveId} newTaskTarget={activeId ? undefined : taskEntry.selectors.target}
      workspaceRecoverySessionId={activeSession?.id} openSessionWorkspaceRecovery={openSessionWorkspaceRecovery}
      addProject={taskEntry.selectors.canAddProject ? taskEntry.commands.addProject : undefined}>
    <Conversation.ComposerSubmissionProvider commands={composerSubmission} staging={composerStaging}
      sharedSessionActive={sharedSessionActive} ownerSessionId={ownerActiveId}
      newTask={{
        target: taskEntry.selectors.target,
        model: newChatExecutionTarget ?? null,
        thinkingLevel: executorTarget ? newChatExecutionThinkingLevel ?? null : pendingNewChatThinkingLevel,
        executorSelection: executor.selection,
        executorEntry: executor.entry,
        permissionChoice: newTaskSettings.permissionChoice,
        clearPermissionChoice: sessionSettingIntent.commands.clearNewTaskPermissionChoice,
        collaborationMode: newTaskSettings.planMode ? 'plan' : 'agent',
        orchestrationMode: newTaskSettings.orchestrationMode,
      }}
      shell={{
        captureOwner: captureComposerImportOwner,
        isOwnerActive: isShellSurfaceOwnerActive,
        isNewChatOwnerActive: isNewChatSendSurfaceActive,
        activateFirstSendSession: Conversation.createExecutorSessionActivator(executor, commitSession, setNavSelection, setActiveId),
        openSession: openSessionInChat,
        retireSession: clearSessionRendererState,
        refreshSessions,
        reloadExecutionBoundary: reloadActiveExecutionBoundary,
        respondToUserForm: commands.respondToUserForm,
        showModelSetupToast,
        bindNewTaskSessionResolver: commands.bindNewTaskSessionResolver,
        openSideChat: (options) => commands.openTool('side-chat', 'right', options),
        orchestrationMode: () => activeOrchestrationMode,
        setOrchestrationModeActive,
      }}>
    <Conversation.PlanProvider session={ownerActiveId ? activeHostSession : undefined}>
    <SessionSettingsProvider
      bridge={sessionSettingIntent.bridge}
      input={{
        catalog: sessionCatalogController,
        isActiveSession: (sessionId) => activeIdRef.current === sessionId,
        newTaskChoiceKey: currentNewTaskDraftKey,
        newSessionPermissionMode,
        refreshCatalog: refreshSessions,
        saveComposerDefaults: (model) => saveComposerDefaults({ model }),
        writeFailureCopy: (setting, error) => sessionSettingFailureCopy(uiLocale, setting, error),
        showSessionError,
        planMode: {
          reportExecutionActive: (sessionId) => showSessionError(
            sessionId, shellCopy.planModeExecutionActiveTitle, shellCopy.planModeExecutionActiveDescription,
          ),
          confirmDiscard: (title) => toastApi.confirm({
            title: shellCopy.planModeExitPendingTitle,
            description: shellCopy.planModeExitPendingDescription(title),
            confirmLabel: shellCopy.planModeExitConfirm,
            cancelLabel: shellCopy.planModeExitCancel,
            destructive: true,
          }),
        },
        captureOwner: captureComposerImportOwner,
        isOwnerActive: isComposerImportOwnerActive,
        confirmBypass: () => confirmBypassPermission(toastApi, uiLocale),
      }}
    >
    <Goals.GoalProvider
      activeSessionId={ownerActiveId}
      canOpenDialog={activeBoundarySurface.localInteractionAvailable}
      reportError={showSessionError}
    >
    <ModuleHub.ModuleHubProvider
      selection={navSelection}
      selectModule={setNavSelection}
      clientPathsAccessible={projectCapabilities.viewClientPath}
      useSkillInChat={useSkillInChat}
      openSession={openSessionInChat}
      appendComposerText={composerEditing.appendText}
      captureActiveComposerClaim={captureActiveComposerClaim}
      commandPort={moduleHubCommands}
    >
    <ModuleHub.ModuleHubSkillCatalogRevisionBoundary
      render={renderComposerMentionsProvider(composerMentionsSurface)}
    >
    <SessionCollaboration.SessionTurnRequestInboxProvider
      catalog={sessionCatalogController}
      onOpenSession={openSession}
    >
    <WorkbarProvider
      bridge={bridge}
      input={{
        workHub: { active: workHubActive },
        available: sessionsSelected && (workHubActive || Boolean(activeHostSession)),
        layoutSessionId: activeId,
        activeSession: activeHostSession,
        projectId: currentProjectId,
        projectAliases: currentProject?.aliases ?? [],
        authoritativeSessionIds,
        shellObscured,
        modelChoices: chatModelChoices,
        toastApi,
        composerDraft: composerEditing,
        openNewTaskSurface,
        openSessionInChat,
        resolveWorkBoardTarget,
        prepareWorkBoardDraft,
      }}
    >
    <div
      className="appFrame agents-layout-root"
      data-agents-page
      data-maka-content-ready={!isOnboardingLoading || undefined}
      /* The single writer for sidebar state in the DOM. It sits on the frame,
         above both the chrome strip and the shell, so every rule that keys on
         it (shell-layout.css, sidebar.css) reaches its target as a descendant.
         Copies on the shell and the detail panel bought nothing — one had no
         readers at all — and three writers of the same value is three chances
         for them to disagree. */
      data-sidebar-state={sessionListCollapsed ? 'collapsed' : 'expanded'}
      /* The frame is the shared owner for dimensions consumed by both shell
         columns and titlebar chrome. CSS clears the titlebar reserve when the
         responsive layout moves the workbar below the conversation. */
      style={appShellFrameStyle({
        sessionListCollapsed,
        sessionListWidth,
      })}
    >
      <Diagnostics.PreviousMainProcessInterruptionNotice ready={appearanceHydrated} />
      <ShellLifecycleSubscriptions {...shellLifecycle} />
      <OnboardingConnectionSeed seed={defaultHostConnections.seedSnapshot} refresh={() => void defaultHostConnections.refreshConnections()} />
      <WorkHubEnablementWatch onEnabled={() => { setWorkHubActive(true); setNavSelection({ section: 'sessions' }); }} onDisabled={exitWorkHub} />
      <Conversation.ConversationLifecycle
        refreshSessions={refreshSessions}
        onExecutionBoundaryChanged={reloadActiveExecutionBoundary}
        showModelSetupToast={showModelSetupToast}
        onTurnCompleted={(sessionId) => { if (activeIdRef.current === sessionId) setPetCompletionNonce((current) => current + 1); }}
        searchTarget={searchScrollTarget} clearSearchTarget={() => setSearchScrollTarget(null)}
      />
      {/* Window chrome is frame-level hit-test only (not AppShell topNav): a
          transparent drag overlay so column surfaces paint to the window top.
          It precedes the shell so Chromium applies app-region subtraction from
          one frame-level hit-test surface. */}
      <AppShellTitlebar
        obscured={shellObscured}
        modalOpen={hasModalOpen}
        settingsOpen={settingsOpen}
        sidebarCollapsed={sessionListCollapsed}
        onToggleSidebar={() => sessionSideNavHandleRef.current?.getCollapseState()?.toggle()}
        onOpenSearchModal={openSearch}
        workbar={{ togglePosition: workbarTogglePosition }}
      >
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
            {sessionsSelected && !workHubActive && activeSessionForView && (
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
                  !activeSession ||
                  activeSession.profileKind === 'environment'
                    ? undefined
                    : {
                        label: sharedSessionDialog.shareActionLabel,
                        onClick: () => sharedSessionDialog.openSession(activeSession),
                      }
                }
                onRenameSession={(name) => {
                  void sessionNavigationCommandsRef.current?.renameSession(activeSessionForView.id, name);
                }}
                project={
                  titlebarProjectName
                    ? {
                        name: titlebarProjectName,
                        path: projectInfo?.projectPath,
                        onOpenFolder: activeProjectCapabilities.viewClientPath ? openProjectFolder : undefined,
                      }
                    : undefined
                }
                parentSession={titlebarParentSession}
              />
            )}
      </AppShellTitlebar>
      <AstryxAppShell
        className="app maka-shell-astryx agents-layout-body"
        /* Astryx's default: nav column takes --color-background-body, content takes
           --color-background-surface. Both point at the product palette through
           makaTheme.ts, so the shell follows a palette switch. Declared rather
           than defaulted: the two columns are separated by that background
           step alone, so the variant IS the separation. */
        variant="elevated"
        height="fill"
        contentPadding={0}
        mobileNav={{ breakpoint: 'none', hasToggle: false }}
        aria-hidden={shellObscured ? 'true' : undefined}
        inert={shellObscured || undefined}
        sideNav={
          <ModuleHub.ModuleHubScheduledTasksBoundary
            render={(scheduledTasks) => (
              <SessionNavigationProvider
                historyBlocked={shellObscured}
                scheduledTasks={scheduledTasks}
                catalog={sessionCatalogController}
                activeSessionId={activeId}
                hiddenSessionIds={selectors.hiddenSessionIds}
                projectScopes={taskEntry.selectors.projectScopes}
                streamingSessions={sessionUiReads.streaming}
                SessionBadge={SessionCollaboration.SessionTurnRequestBadge}
                NavigationExtras={SessionCollaboration.SessionCollaborationNavigation}
                ports={sessionNavigationPorts}
                commandsRef={sessionNavigationCommandsRef}
                onExitWorkHub={exitWorkHub}
                onSelectSession={openSession}
                workHubActive={workHubActive}
                selection={navSelection}
                moduleMemory={navigationState.moduleMemory}
                onSelect={setNavSelection}
                onOpenSettings={openSettings}
                onNew={createSession}
                onOpenWorkHub={openWorkHub}
                projectActions={projectRowActions}
                onNewProject={
                  taskEntry.selectors.canAddProject
                    ? taskEntry.commands.openNewProject
                    : undefined
                }
              >
                {SESSION_RAIL}
              </SessionNavigationProvider>
            )}
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
            <Conversation.ConversationHomeSurface className="mainColumn" eligible={homeSurfaceEligible}
              inert={switchingSession || undefined}
              aria-busy={switchingSession || undefined}>
              <ModuleHub.ModuleHubHost />
              <WorkHubMainNavigation workbarReady={workHubActive && selectors.ready}
                onOpenUsage={() => commands.toggleTool('inspector')} onToggleWorkbar={commands.toggleRightPanel}
                onOpenWorkHub={openWorkHub} onOpenSession={(sessionId) => { closeSettings(); openSession(sessionId); }} />
              <WorkHubDock workbar={selectors} workbarTogglePosition={workbarTogglePosition} visible={workHubActive && sessionsSelected && !shellObscured} />
              <ChatSurfaceLayout
                data-session-history-surface="true"
                // ChatView positions this transcript: switching conversations,
                // following the tail and the moves the reader asks for are one
                // authority there, and the composer never remounts for any of
                // them — its contenteditable DOM carries the live draft.
                data-maka-onboarding={showOnboardingHero ? 'true' : undefined}
                scrollToBottomLabel={
                  desktopConversationCopy.actions.scrollMainToBottom
                }
                hidden={workHubActive || !sessionsSelected}
                composer={
                  <>
                    {ownerActiveId ? (
                      <Conversation.ConversationMessageConsumer surface={SessionCollaboration.SessionTurnRequestApprovalForSession}
                        sessionId={ownerActiveId}
                        onOpenSession={openSessionInChat}
                      />
                    ) : null}
                    {sessionsSelected &&
                    ownerActiveId &&
                    activeSessionForView &&
                    !isLinkedSubagentSession(activeSessionForView) ? (
                      <AgentGraphPanel
                        rootSessionId={ownerActiveId}
                        enabled={(activeSessionForView.orchestrationMode ?? 'default') === 'graph'}
                        locale={uiLocale}
                        onOpenSession={openSessionInChat}
                      />
                    ) : null}
                    {!sharedSessionActive && sessionsSelected ? <Conversation.PlanExecutionSurface /> : null}
                    <TaskEntry.TaskEntryWorkspacePickerConsumer manageProjects={openProjectSettings}
                      activeSession={activeSession}
                    >
                        {(workspacePicker) => (
                          <SessionCollaboration.GuestTurnRequests
                            sessionId={sharedSessionActive ? activeId : undefined}
                            discardDraft={composerEditing.discardDraft}
                          >
                            {(guest) => (
                              <Conversation.ConversationComposerRegion surface={ChatComposerRegion}
                  workspacePicker={workspacePicker}
                  guest={guest}
                  active={sessionsSelected}
                  onboardingComposerHidden={
                    onboardingComposerHidden
                  }
                  boundaryUnreadableNotice={boundaryUnreadableNotice}
                  activeId={activeId}
                  newTaskDraftKey={currentNewTaskDraftKey}
                  respondToClientCapability={commands.respondToClientCapability}
                  directoryPickerEnabled={Boolean(canStageComposerContext && directoryHostId)}
                  sessionState={{ loaded: activeSession !== undefined, status: activeSession?.status }}
                  onPromoteQueuedEntry={activeId ? queueSurface.promoteQueuedEntry : undefined}
                  onUpdateQueuedEntry={activeId ? queueSurface.updateQueuedEntry : undefined}
                  onDeleteQueuedEntry={activeId ? queueSurface.deleteQueuedEntry : undefined}
                  onReorderQueuedEntries={activeId ? queueSurface.reorderQueuedEntries : undefined}
                  allowAttachmentOnlySend={canStageComposerContext}
                  canStageContext={canStageComposerContext}
                  contextPickEnabled={canStageComposerContext}
                  executorComposer={{ selection: executor, taskSubmissionHardBlocked, connectionCount: connections.length, onSetup: () => openSettingsSection('external-agents'), onNewTask: openNewTaskSurface }}
                  activeSession={activeSessionForView}
                  {...{ executorTarget, onExecutorTargetChange }}
                  usageModel={activeModel}
                  usageRoute={activeSessionForModelControls}
                  onOpenContextUsage={() => commands.toggleTool('inspector')}
                  LiveContextUsageProbe={LiveContextUsageProbe}
                  contextUsageSessionId={ownerActiveId}
                  modelSwitchHasHistory={modelSwitchHasHistory}
                  renderProviderMark={(type) => <ProviderBrandMark type={type} />}
                  onModelChange={(input) => activeId ? void setSessionModel(activeId, input) : undefined}
                  onThinkingLevelChange={(level) => {
                    if (activeId) void setSessionThinkingLevel(activeId, level ?? null);
                  }}
                  {...composerModelProps}
                  onPickNewChatModel={(input) => {
                    setPendingNewChatModel(input);
                    if (modelSettingsOwnsComposerHost) saveComposerDefaults({ model: input });
                  }}
                  onNewChatThinkingLevelChange={(level) => setPendingNewChatThinkingLevel(level ?? null)}
                  onOpenModelSettings={modelSettingsOwnsComposerHost
                    ? () => openSettingsSection('models')
                    : undefined}
                  noModelHint={!modelSettingsOwnsComposerHost && composerProfileName
                    ? shellCopy.configureModelsOnHost(composerProfileName)
                    : undefined}
                  permissionMode={activePermissionMode}
                  onPermissionModeChange={async mode => {
                    await setPermissionMode(mode)
                  }}
                  planModeActive={activePlanMode}
                  onPlanModeChange={(active) => void setPlanMode(active)}
                  orchestrationMode={activeOrchestrationMode}
                  onOrchestrationModeChange={(mode) => void setOrchestrationMode(mode)}
                              />
                            )}
                          </SessionCollaboration.GuestTurnRequests>
                        )}
                    </TaskEntry.TaskEntryWorkspacePickerConsumer>
                  </>
                }
              >
                {sessionsSelected ? (
                  <Conversation.ConversationTranscriptRegion surface={ChatMessageSurface}
                activeSession={activeSessionForView}
                userLabel={userLabel}
                memoryActive={memoryActive}
                onOpenMemorySettings={sharedSessionActive ? undefined : () => openSettingsSection('memory')}
                onTurnFooterAction={sharedSessionActive ? undefined : composerSubmission.handleTurnFooterAction}
                onEditUserMessage={sharedSessionActive ? undefined : composerSubmission.beginEditUserMessage}
                onLineageBadgeClick={(turnId) => { if (activeId) openSessionInChat(activeId, turnId); }}
                onOpenLinkedSession={openSessionInChat}
                scrollTargetTurn={
                  activeId && searchScrollTarget?.sessionId === activeId
                        ? {
                            turnId: searchScrollTarget.turnId,
                            nonce: searchScrollTarget.nonce,
                          }
                    : undefined
                }
                scrollBehavior={readScrollMotionBehavior()}
                revisionNavigation={revisionNavigation}
                onRevisionNavigate={openSessionInChat}
                onNew={createSession}
                onPromptSuggestion={composerEditing.appendText}
                onQuoteSelection={
                  sharedSessionActive
                    ? undefined
                    : (selection) => {
                        composerStaging.addQuote(selection);
                        composerEditing.focus();
                      }
                }
                onAskAboutSelection={
                  activeId
                    ? (input) => {
                        const quote: QuoteRef = {
                          text: input.text,
                          sourceTurnId: input.turnId,
                        };
                        commands.openSideChatWithQuote(quote);
                      }
                    : undefined
                }
                sessionHealthNotice={sessionHealthNotice}
                localInteractionAvailable={activeBoundarySurface.localInteractionAvailable}
                workspaceReadinessRecovery={workspaceReadinessRecovery}
                showOnboardingHero={showOnboardingHero}
                onboardingState={onboardingState}
                onOpenSettings={openSettingsSection}
                onOpenConnectionDetail={openConnectionDetail}
                onAddProvider={openProviderCreate}
                onBrowseProviders={openProviderCatalog}
                connections={connections}
                onRefreshConnections={refreshConnections}
                onSkip={async () => {
                  try {
                    await onboarding.skipInitialOnboarding();
                  } catch (error) {
                    toastApi.error(
                      shellCopy.skipErrorTitle,
                      localizedShellErrorMessage(error, shellCopy.tryAgainLater, uiLocale),
                      undefined,
                      defaultRuntimeHostDiagnosticTarget(error),
                    );
                  }
                }}
                  />

                ) : null}
              </ChatSurfaceLayout>
            </Conversation.ConversationHomeSurface>
            {/* Collapse hides the Workbar surface without unmounting its tools. */}
            <WorkbarHost togglePosition={workbarTogglePosition} />
          </div>
          </MakaUriContext.Provider>
        </AppShellDetailPanel>
      </AstryxAppShell>
      {!shellObscured && (
        <Conversation.ConversationActivityConsumer surface={CustomPetCompanionForSession}
          hasActiveSession={activeSession !== undefined}
          sessionStatus={activeSession?.status}
          completionNonce={petCompletionNonce}
          contextKey={activeId}
        />
      )}
      <Goals.GoalHost />
      <TaskEntry.TaskEntryHost />
      <RuntimeHostSshTerminalDialog />
      <AppShellOverlays
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
        onOpenDailyReview={() => {
          closeSettings();
          setNavSelection({ section: 'automations', module: 'daily-review' });
        }}
        onOpenSettingsSession={(sessionId) => {
          closeSettings();
          openSessionInChat(sessionId);
        }}
        archivedTasks={archivedTasksBridge}
        commandOptions={commandOptions}
        onNavigateToSession={openSessionInChat}
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
    </WorkbarProvider>
    </SessionCollaboration.SessionTurnRequestInboxProvider>
    </ModuleHub.ModuleHubSkillCatalogRevisionBoundary>
    </ModuleHub.ModuleHubProvider>
    </Goals.GoalProvider>
    </SessionSettingsProvider>
    </Conversation.PlanProvider>
    </Conversation.ComposerSubmissionProvider>
    </Conversation.TaskReadinessProvider>
    </Conversation.ComposerStagingProvider>
  );
}
