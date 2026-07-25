import type {
  ConnectionEvent,
  ConnectionTestResult,
  CreateConnectionInput,
  AppSettings,
  BotProvider,
  BotOnboardingSnapshot,
  BotOnboardingStartInput,
  HealthSnapshot,
  LlmConnection,
  ModelDiscoveryResult,
  ModelInfo,
  PermissionResponse,
  UserQuestionResponse,
  PermissionMode,
  CollaborationMode,
  OrchestrationMode,
  TurnOrchestration,
  PlanSessionState,
  SearchErrorReason,
  SearchRequest,
  SearchResult,
  SettingsTestResult,
  SessionCommand,
  SessionChangedEvent,
  SessionEvent,
  SessionListFilter,
  SessionSummary,
  ShellRunUpdate,
  StoredMessage,
  ThinkingLevel,
  UpdateConnectionInput,
  UpdateAppSettingsInput,
  UpdateAppSettingsResult,
  UsageRange,
  UsageStats,
  E2eFixtureState,
  ArtifactBinaryReadResult,
  ArtifactChangedEvent,
  ArtifactRecord,
  ArtifactSaveResult,
  ArtifactTextReadResult,
  BranchFromTurnInput,
  CapabilitySnapshotCollection,
  RegenerateTurnInput,
  ReviseBeforeTurnInput,
  TurnRecord,
  PermissionSnapshot,
  OpenGatewayRuntimeStatus,
  LocalMemoryState,
  AuthorizationUrlPayload,
  SubscriptionAccountState,
  SubscriptionActionResult,
  PlanReminder,
  PlanReminderDeliveryTarget,
  PlanReminderRecurrence,
  DailyReviewArchive,
  DailyReviewArchiveSummary,
  DailyReviewConfig,
  DailyReviewMode,
  DailyReviewSummary,
  WebSearchProvider,
  WebSearchResponse,
  BrowserState,
  BrowserViewRect,
  ThemePreference,
  Task,
  TaskLedgerChangedEvent,
  DeepResearchChangedEvent,
  DeepResearchRun,
  LocalMemoryEntryPreview,
} from '@maka/core';
import type {
  PricingConfig,
  UsageBucket,
  UsageGroupBy,
  UsageLogRow,
  UsageQuery,
  UsageSummaryV2,
} from '@maka/core/usage-stats/types';
import type { TestProxyInput } from '@maka/core/settings/network-settings';
import type { Result } from '@maka/core/result';
import type { CreateSessionRequestInput } from '@maka/core';
import type {
  McpConfigFile,
  McpServerConfig,
  McpServerStatus,
  McpTestResult,
} from '@maka/core/mcp';
import type { BotStatus, WechatBridgeQrCodeResult } from '@maka/runtime';
import type { BundledSkillCatalogEntry, ManagedSkillSourceEntry, ManagedSkillUpdatePreview, SkillEntry, SkillGovernanceDetails } from '@maka/ui';
import type { ConfigCategory } from '@maka/storage';
import type {
  OnboardingMilestone,
  OnboardingMilestoneId,
  OnboardingState,
} from '@maka/core';

export interface ExpertTeamMemberSummary {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
}
export interface ExpertTeamSummary {
  id: string;
  name: string;
  description: string;
  members: ExpertTeamMemberSummary[];
}
export type ExpertTeamStartResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'unknown_team'; teamId: string }
  | { ok: false; reason: 'setup_required'; state: OnboardingState }
  | { ok: false; reason: 'workspace_unavailable' }
  | { ok: false; reason: 'send_failed'; message: string };

export interface OnboardingSnapshot {
  state: OnboardingState;
  milestones: OnboardingMilestone[];
  sessions: import('@maka/core').SessionSummary[];
  connections: import('@maka/core').LlmConnection[];
  defaultSlug: string | null;
}

export type WorkspaceInstructionFileStatus =
  | 'available'
  | 'missing'
  | 'blocked'
  | 'empty'
  | 'unreadable';

export interface WorkspaceInstructionFileState {
  file: string;
  status: WorkspaceInstructionFileStatus;
  chars: number;
  truncated: boolean;
}

export interface WorkspaceInstructionsState {
  files: WorkspaceInstructionFileState[];
  detectedCount: number;
  fileCharLimit: number;
  promptCharLimit: number;
}

export type RendererIngestInput =
  | { approvalId: string; name: string; mimeType?: string }
  | { file: File };

export type LocalMemoryMutationResult =
  | { ok: true; state: LocalMemoryState; entry?: LocalMemoryEntryPreview; proposal?: LocalMemoryEntryPreview }
  | { ok: false; state: LocalMemoryState; reason: string; message: string };

export type PermissionActionResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'invalid_id' | 'unsupported_platform' | 'unsupported_permission' | 'failed';
      message?: string;
    };

export interface MakaBridge {

  tasks: {
    list(sessionId: string): Promise<Task[]>;
    subscribeChanges(handler: (event: TaskLedgerChangedEvent) => void): () => void;
  };
  deepResearch: {
    get(sessionId: string): Promise<DeepResearchRun | undefined>;
    subscribeChanges(handler: (event: DeepResearchChangedEvent) => void): () => void;
  };
  sessions: {
    list(filter?: SessionListFilter): Promise<SessionSummary[]>;
    create(input?: CreateSessionRequestInput): Promise<SessionSummary>;
    send(
      sessionId: string,
      command:
        | SessionCommand
        | {
            type: 'send';
            turnId: string;
            text: string;
            skillIds?: string[];
            attachmentItems?: RendererIngestInput[];
            turnOrchestration?: TurnOrchestration;
            quotes?: import('@maka/core').QuoteRef[];
          },
    ): Promise<
      | {
          ok: true;
          turnId: string;
          attachments: import('@maka/core').AttachmentRef[];
          skillInvocation: import('@maka/runtime').SkillInvocationResult;
        }
      | {
          ok: false;
          reason: 'skill_invocation_failed';
          skillInvocation: import('@maka/runtime').SkillInvocationResult;
        }
    >;
    stop(sessionId: string, input?: { source?: 'stop_button' }): Promise<void>;
    readMessages(sessionId: string): Promise<StoredMessage[]>;
    listTurns(sessionId: string): Promise<TurnRecord[]>;
    compact(sessionId: string): Promise<void>;
    resumeLatest(sessionId: string): Promise<
      | { disposition: 'started'; runId: string; turnId: string }
      | { disposition: 'park'; rejectionReasons: string[]; diagnostics: unknown[] }
    >;
    regenerateTurn(sessionId: string, input: RegenerateTurnInput): Promise<void>;
    branchFromTurn(sessionId: string, input: BranchFromTurnInput): Promise<SessionSummary>;
    reviseBeforeTurn(sessionId: string, input: ReviseBeforeTurnInput): Promise<SessionSummary>;
    respondToPermission(sessionId: string, response: PermissionResponse): Promise<void>;
    respondToUserQuestion(sessionId: string, response: UserQuestionResponse): Promise<void>;
    saveConversationToFile(input: {
      markdown: string;
      defaultName: string;
    }): Promise<
      { ok: true; path: string } | { ok: false; reason: 'canceled' | 'write_failed' | 'invalid_input' }
    >;
    subscribeEvents(sessionId: string, handler: (event: SessionEvent) => void): () => void;
    subscribeChanges(handler: (event: SessionChangedEvent) => void): () => void;
    archive(sessionId: string, options?: { revisionFamily?: boolean }): Promise<void>;
    unarchive(sessionId: string, options?: { revisionFamily?: boolean }): Promise<void>;
    setFlagged(sessionId: string, isFlagged: boolean, options?: { revisionFamily?: boolean }): Promise<void>;
    rename(sessionId: string, name: string, options?: { revisionFamily?: boolean }): Promise<void>;
    setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary>;
    setCollaborationMode(sessionId: string, mode: CollaborationMode): Promise<SessionSummary>;
    setOrchestrationMode(sessionId: string, mode: OrchestrationMode): Promise<SessionSummary>;
    getPlanState(sessionId: string): Promise<PlanSessionState>;
    requestPlanRevision(sessionId: string, proposalId: string): Promise<PlanSessionState>;
    abandonPlanProposal(
      sessionId: string,
      proposalId: string,
    ): Promise<PlanSessionState>;
    approvePlan(sessionId: string, input: {
      proposalId: string;
      expectedRevision: number;
      expectedStoreVersion?: number;
    }): Promise<{ state: PlanSessionState; turnId: string; executionId: string }>;
    resumePlan(sessionId: string, executionId: string): Promise<{
      state: PlanSessionState;
      turnId: string;
      executionId: string;
    }>;
    abandonPlanExecution(sessionId: string, executionId: string): Promise<PlanSessionState>;
    setModel(sessionId: string, input: { llmConnectionSlug: string; model: string }): Promise<SessionSummary>;
    setThinkingLevel(sessionId: string, level: ThinkingLevel | undefined | null): Promise<SessionSummary>;
    remove(sessionId: string, options?: { revisionFamily?: boolean }): Promise<void>;
  };
  shellRuns: {
    list(sessionId: string): Promise<ShellRunUpdate[]>;
    subscribeUpdates(handler: (update: ShellRunUpdate) => void): () => void;
  };
  goal: {
    /** The session's current goal (null when none is set). */
    get(sessionId: string): Promise<import('@maka/runtime').GoalState | null>;
    /** Clear the active goal, stopping autonomous continuation. */
    clear(sessionId: string): Promise<void>;
  };
  connections: {
    list(): Promise<LlmConnection[]>;
    getDefault(): Promise<string | null>;
    setDefault(slug: string | null): Promise<void>;
    setDefaultModel(input: { slug: string; model: string } | null): Promise<void>;
    create(input: CreateConnectionInput): Promise<LlmConnection>;
    update(slug: string, patch: UpdateConnectionInput): Promise<LlmConnection>;
    delete(slug: string): Promise<void>;
    test(slug: string, opts?: { model?: string }): Promise<ConnectionTestResult>;
    fetchModels(slug: string): Promise<ModelDiscoveryResult>;
    hasSecret(slug: string): Promise<boolean>;
    subscribeEvents(handler: (event: ConnectionEvent) => void): () => void;
  };
  mcp: {
    getConfig(): Promise<McpConfigFile>;
    listStatuses(): Promise<McpServerStatus[]>;
    setConfig(config: McpConfigFile): Promise<McpConfigFile>;
    upsert(serverId: string, config: McpServerConfig): Promise<McpConfigFile>;
    install(serverId: string, config: McpServerConfig): Promise<McpConfigFile>;
    remove(serverId: string): Promise<McpConfigFile>;
    cancelInstall(serverId: string): Promise<McpConfigFile>;
    test(serverId: string): Promise<McpTestResult>;
    reconnect(serverId: string): Promise<McpServerStatus>;
    subscribeChanges(handler: (statuses: McpServerStatus[]) => void): () => void;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsResult>;
    subscribeExternalChanged(handler: () => void): () => void;
    testNetworkProxy(input?: TestProxyInput): Promise<SettingsTestResult>;
    testBotChannel(provider: BotProvider): Promise<SettingsTestResult>;
    usageStats(range?: UsageRange): Promise<UsageStats>;
    bots: {
      listStatuses(): Promise<Record<BotProvider, BotStatus>>;
      restart(provider: BotProvider): Promise<BotStatus>;
      wechatQrCode(): Promise<WechatBridgeQrCodeResult>;
      subscribeStatusChanges(handler: (status: BotStatus) => void): () => void;
      onboarding: {
        start(input: BotOnboardingStartInput): Promise<Result<BotOnboardingSnapshot>>;
        poll(sessionId: string): Promise<Result<BotOnboardingSnapshot>>;
        cancel(sessionId: string): Promise<Result<BotOnboardingSnapshot>>;
        openInBrowser(sessionId: string): Promise<Result<void>>;
      };
    };
  };
  notifications: {
    /** Fire-and-forget: report that an agent turn reached a terminal
     * state. `title` is the session name, `body` the start of the
     * reply (or error message); main sanitizes + falls back to
     * generic copy. Main gates on the product toggle + window focus
     * before raising a native OS notification. */
    runEnded(payload: {
      kind: 'completed' | 'errored';
      title?: string;
      body?: string;
    }): Promise<void>;
  };
  onboarding: {
    getSnapshot(): Promise<OnboardingSnapshot>;
    setMilestone(
      id: OnboardingMilestoneId,
      status: 'completed' | 'skipped',
    ): Promise<OnboardingSnapshot>;
    clearMilestone(id: OnboardingMilestoneId): Promise<OnboardingSnapshot>;
  };
  expertTeam: {
    list(): Promise<{ teams: ExpertTeamSummary[] }>;
    start(input: { teamId: string; prompt?: string }): Promise<ExpertTeamStartResult>;
  };
  permissions: {
    getSnapshot(): Promise<PermissionSnapshot>;
    openSystemSettings(permId: string): Promise<PermissionActionResult>;
    requestAccess(permId: string): Promise<PermissionActionResult>;
  };
  capabilities: {
    getSnapshot(): Promise<CapabilitySnapshotCollection>;
  };
  health: {
    getSnapshot(): Promise<HealthSnapshot>;
  };
  memory: {
    getState(): Promise<LocalMemoryState>;
    listProposals(): Promise<ReadonlyArray<LocalMemoryEntryPreview>>;
    propose(input: { title: string; content: string; scope?: 'workspace' | 'session' }): Promise<LocalMemoryMutationResult>;
    remember(input: { title: string; content: string; scope?: 'workspace' | 'session' }): Promise<LocalMemoryMutationResult>;
    approveProposal(proposalId: string): Promise<LocalMemoryMutationResult>;
    rejectProposal(proposalId: string): Promise<LocalMemoryMutationResult>;
    archiveEntry(entryId: string, reason?: string): Promise<LocalMemoryMutationResult>;
    restoreEntry(entryId: string): Promise<LocalMemoryMutationResult>;
    save(content: string): Promise<LocalMemoryState>;
    reset(): Promise<LocalMemoryState>;
    restoreLatestBackup(): Promise<{ ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }>;
    restoreBackup(kind: 'save' | 'reset' | 'restore'): Promise<{ ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }>;
    setEnabled(enabled: boolean): Promise<LocalMemoryState>;
    setAgentReadEnabled(enabled: boolean): Promise<LocalMemoryState>;
    openFile(): Promise<{ ok: true } | { ok: false; message: string }>;
    openLatestBackup(): Promise<{ ok: true } | { ok: false; message: string }>;
    openBackup(kind: 'save' | 'reset' | 'restore'): Promise<{ ok: true } | { ok: false; message: string }>;
  };
  workspaceInstructions: {
    getState(): Promise<WorkspaceInstructionsState>;
    openFile(file: string): Promise<{ ok: true } | { ok: false; message: string }>;
    createFile(file: string): Promise<{ ok: true } | { ok: false; message: string }>;
  };
  attachments: {
    pickFiles(): Promise<
      | { ok: true; files: { approvalId: string; name: string; mimeType?: string; size: number }[] }
      | { ok: false; reason: 'cancelled' }
    >;
    readBytes(sessionId: string, relativePath: string): Promise<
      | { ok: true; base64: string; mimeType: string }
      | { ok: false; reason: string }
    >;
  };
  search: {
    thread(
      request: SearchRequest,
    ): Promise<
      | SearchResult[]
      | { ok: false; reason: SearchErrorReason; message: string }
    >;
  };
  gateway: {
    status(): Promise<OpenGatewayRuntimeStatus>;
    subscribeStatusChanges(handler: (status: OpenGatewayRuntimeStatus) => void): () => void;
  };
  claudeSubscription: {
    isExperimentalEnabled(): Promise<boolean>;
    getAuthUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult>;
    openAuthUrl(authRequestId: string): Promise<SubscriptionActionResult>;
    completeAuthorization(
      authRequestId: string,
      pasted: string,
    ): Promise<SubscriptionActionResult>;
    cancelAuthorization(authRequestId?: string): Promise<{ ok: true }>;
    getAccountState(): Promise<SubscriptionAccountState>;
    refreshQuota(): Promise<SubscriptionActionResult>;
    refreshTokens(): Promise<SubscriptionActionResult>;
    logout(): Promise<SubscriptionActionResult>;
  };
  openAiCodex: {
    isExperimentalEnabled(): Promise<boolean>;
    getAuthUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult>;
    openAuthUrl(authRequestId: string): Promise<SubscriptionActionResult>;
    completeAuthorization(authRequestId: string): Promise<SubscriptionActionResult>;
    cancelAuthorization(authRequestId?: string): Promise<{ ok: true }>;
    getAccountState(): Promise<{
      provider: 'openai-codex';
      runtimeState:
        | 'not_logged_in'
        | 'authorizing'
        | 'authenticated'
        | 'refreshing'
        | 'refresh_failed';
      accountId?: string;
      email?: string;
      plan?: string;
      picture?: string;
      errorMessage?: string;
    }>;
    refreshTokens(): Promise<SubscriptionActionResult>;
    logout(): Promise<SubscriptionActionResult>;
  };
  githubCopilotSubscription: {
    connectExistingLogin(): Promise<SubscriptionActionResult>;
    getAccountState(): Promise<{
      provider: 'github-copilot';
      runtimeState: 'not_logged_in' | 'authenticated' | 'refreshing' | 'refresh_failed' | 'storage_failed';
      errorMessage?: string;
    }>;
    refreshTokens(): Promise<SubscriptionActionResult>;
    logout(): Promise<SubscriptionActionResult>;
  };
  cursorSubscription: {
    isExperimentalEnabled(): Promise<boolean>;
    getAuthUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult>;
    openAuthUrl(authRequestId: string): Promise<SubscriptionActionResult>;
    completeAuthorization(authRequestId: string): Promise<SubscriptionActionResult>;
    cancelAuthorization(authRequestId?: string): Promise<{ ok: true }>;
    getAccountState(): Promise<{
      provider: 'cursor-subscription';
      runtimeState:
        | 'not_logged_in'
        | 'authorizing'
        | 'authenticated'
        | 'refreshing'
        | 'refresh_failed';
      errorMessage?: string;
    }>;
    refreshTokens(): Promise<SubscriptionActionResult>;
    logout(): Promise<SubscriptionActionResult>;
  };
  antigravitySubscription: {
    isExperimentalEnabled(): Promise<boolean>;
    getAuthUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult>;
    openAuthUrl(authRequestId: string): Promise<SubscriptionActionResult>;
    completeAuthorization(authRequestId: string): Promise<SubscriptionActionResult>;
    cancelAuthorization(authRequestId?: string): Promise<{ ok: true }>;
    getAccountState(): Promise<{
      provider: 'antigravity-subscription';
      status: 'preview';
      runtimeState:
        | 'not_logged_in'
        | 'authorizing'
        | 'authenticated'
        | 'refreshing'
        | 'refresh_failed';
      errorMessage?: string;
    }>;
    refreshTokens(): Promise<SubscriptionActionResult>;
    logout(): Promise<SubscriptionActionResult>;
  };
  plans: {
    list(): Promise<PlanReminder[]>;
    create(input: { title: string; note?: string; runAt: number | string; recurrence?: PlanReminderRecurrence; cronExpression?: string; delivery?: PlanReminderDeliveryTarget }): Promise<PlanReminder>;
    update(
      id: string,
      patch: { title?: string; note?: string; runAt?: number | string; recurrence?: PlanReminderRecurrence; cronExpression?: string; delivery?: PlanReminderDeliveryTarget; enabled?: boolean },
    ): Promise<PlanReminder>;
    setEnabled(id: string, enabled: boolean): Promise<PlanReminder>;
    triggerNow(id: string): Promise<PlanReminder>;
    snooze(id: string): Promise<PlanReminder>;
    clearRunHistory(id: string): Promise<PlanReminder>;
    delete(id: string): Promise<void>;
    subscribeChanges(
      handler: (event: { type: 'plans_changed'; reason: string; reminderId?: string; ts: number }) => void,
    ): () => void;
    subscribeDue(handler: (reminder: PlanReminder) => void): () => void;
  };
  usage: {
    summary(query: UsageQuery): Promise<Result<UsageSummaryV2>>;
    buckets(query: UsageQuery & { groupBy: UsageGroupBy }): Promise<Result<UsageBucket[]>>;
    logs(query: UsageQuery & { offset?: number; limit?: number }): Promise<Result<{ rows: UsageLogRow[]; total: number }>>;
    listPricing(): Promise<Result<PricingConfig[]>>;
    putPricing(pricing: PricingConfig): Promise<Result<PricingConfig>>;
    resetPricing(modelKey: string): Promise<Result<void>>;
  };
  webSearch: {
    query(input: {
      query: string;
      limit?: number;
      provider?: WebSearchProvider;
      apiKey?: string;
    }): Promise<WebSearchResponse>;
    test(input: { provider?: WebSearchProvider; apiKey?: string }): Promise<WebSearchResponse>;
  };
  dailyReview: {
    day(offsetDays: number, daySpan?: number): Promise<Result<DailyReviewSummary>>;
    getConfig?(): Promise<DailyReviewConfig>;
    setConfig?(patch: Partial<DailyReviewConfig>): Promise<DailyReviewConfig>;
    runOnce?(input: { mode: DailyReviewMode; day?: number; modelKey?: string }): Promise<{ archiveId: string }>;
    list?(): Promise<DailyReviewArchiveSummary[]>;
    get?(archiveId: string): Promise<DailyReviewArchive | null>;
    delete?(archiveId: string): Promise<void>;
    listArchives?(): Promise<DailyReviewArchiveSummary[]>;
    getArchive?(archiveId: string): Promise<DailyReviewArchive | null>;
    deleteArchive?(archiveId: string): Promise<void>;
    saveMarkdownToFile(input: {
      markdown: string;
      defaultName: string;
    }): Promise<
      { ok: true; path: string } | { ok: false; reason: 'canceled' | 'write_failed' | 'invalid_input' }
    >;
    /**
     * PR-DAILY-REVIEW-FULL-0 — pipeline + archive surface. Each
     * method may reject with a string error code when the
     * backend is not yet wired or when prerequisites are missing
     * (e.g. no model configured). Renderer gracefully handles
     * rejection by showing the disabled / fallback form.
     */
  };
  appWindow: {
    subscribeOpenSettings(handler: () => void): () => void;
    setTitlebarControlsVisible(visible: boolean): Promise<void>;
    setThemeSource(themePref: ThemePreference): Promise<void>;
    // PR-WINDOW-TITLEBAR-0: re-sync the native Windows titleBarOverlay
    // color/symbolColor to the resolved app surface. No-op on non-Windows.
    setTitleBarOverlayTheme(theme: { isDark: boolean; backgroundColor: string }): Promise<void>;
    // PR-SHOW-AFTER-FIRST-COMMIT: signal main after the first React commit
    // so the hidden window is revealed (see main-window.ts).
    notifyRendererReady(): Promise<void>;
  };
  config: {
    export(input: { categories: ConfigCategory[] }): Promise<
      | { ok: false; reason: 'no_categories' | 'canceled' }
      | { ok: true; path: string; includedData: ConfigCategory[] }
    >;
    import(input: { strategy: 'skip' | 'overwrite' }): Promise<
      | { ok: false; reason: 'canceled' | 'not_json' | 'malformed' | 'unsupported_version'; message?: string }
      | {
          ok: true;
          includedData: ConfigCategory[];
          result: {
            connections?: { created: number; overwritten: number; skipped: number };
            settings?: { applied: boolean };
            credentials?: { applied: number; skipped: number };
            memory?: { applied: boolean };
          };
        }
    >;
  };
  app: {
    info(): Promise<{
      appVersion: string;
      electronVersion: string;
      nodeVersion: string;
      chromeVersion: string;
      platform: string;
      arch: string;
      osRelease: string;
      workspacePath: string;
      projectPath: string;
      projectGit: { isGitRepo: boolean; branch?: string };
      buildMode: 'dev' | 'packaged';
      buildCommit: string | null;
    }>;
    sessionProjectInfo(sessionId: string): Promise<{
      projectPath: string;
      projectGit: { isGitRepo: boolean; branch?: string };
    }>;
    openPath(
      key: 'workspace' | 'skills' | 'memory' | 'project',
      sessionId?: string,
    ): Promise<
      | { ok: true; opened: string }
      | {
          ok: false;
          reason:
            | 'unknown-key'
            | 'not-allowed'
            | 'missing'
            | 'not-a-directory'
            | 'open-failed';
        }
    >;
    selectProjectDirectory(): Promise<
      | { ok: true; projectPath: string; projectGit: { isGitRepo: boolean; branch?: string } }
      | { ok: false; reason: 'cancelled' | 'missing-selection' }
    >;
    selectProjectRoot(projectPath: string): Promise<
      | { ok: true; projectPath: string; projectGit: { isGitRepo: boolean; branch?: string } }
      | { ok: false; reason: 'invalid-path' | 'not-found' }
    >;
    resolveProjectGitInfo(projectPath: string): Promise<
      | { ok: true; projectPath: string; projectGit: { isGitRepo: boolean; branch?: string } }
      | { ok: false; reason: 'invalid-path' | 'not-found' }
    >;
    listGitBranches(sessionId?: string): Promise<{
      ok: boolean;
      branches?: string[];
      current?: string;
      reason?: string;
      message?: string;
    }>;
    checkoutGitBranch(branch: string, sessionId?: string): Promise<{
      ok: boolean;
      branch?: string;
      reason?: string;
      message?: string;
    }>;
    openArtifactPath(
      artifactId: string,
    ): Promise<
      | { ok: true; opened: string }
      | {
          ok: false;
          reason:
            | 'unknown-key'
            | 'not-allowed'
            | 'missing'
            | 'not-a-directory'
            | 'open-failed';
        }
    >;
    saveArtifactAs(artifactId: string): Promise<ArtifactSaveResult>;
  };
  workspace: {
    searchFiles(
      query: string,
      options?: { sessionId?: string; limit?: number },
    ): Promise<
      | { ok: true; files: Array<{ relativePath: string }> }
      | { ok: false; reason: 'no_project' | 'search_failed' }
    >;
  };
  e2eFixture: {
    getState(): Promise<E2eFixtureState | null>;
  };
  artifacts: {
    list(sessionId: string, opts?: { includeDeleted?: boolean }): Promise<ArtifactRecord[]>;
    get(artifactId: string): Promise<ArtifactRecord | null>;
    readText(artifactId: string): Promise<ArtifactTextReadResult>;
    readBinary(artifactId: string): Promise<ArtifactBinaryReadResult>;
    delete(artifactId: string): Promise<void>;
    subscribeChanges(handler: (event: ArtifactChangedEvent) => void): () => void;
  };
  skills: {
    list(): Promise<SkillEntry[]>;
    listInvocable(
      sessionId?: string,
      newSessionContext?: {
        llmConnectionSlug?: string;
        model?: string;
        collaborationMode?: 'agent' | 'plan';
      },
    ): Promise<import('@maka/runtime').InvocableSkillEntry[]>;
    catalog: {
      list(): Promise<BundledSkillCatalogEntry[]>;
      install(id: string): Promise<
        | { ok: true; skill: SkillEntry }
        | { ok: false; reason: 'not_found' | 'already_exists' | 'blocked_path' | 'write_failed' }
      >;
    };
    sources: {
      list(): Promise<ManagedSkillSourceEntry[]>;
      importLocalFile(): Promise<
        | { ok: true; source: ManagedSkillSourceEntry }
        | { ok: false; reason: 'cancelled' | 'invalid_skill' | 'already_exists' | 'blocked_path' | 'write_failed' }
      >;
    };
    installManaged(sourceId: string): Promise<
      | { ok: true; skill: SkillEntry }
      | { ok: false; reason: 'not_found' | 'already_exists' | 'blocked_path' | 'write_failed' }
    >;
    details(skillId: string): Promise<
      | { ok: true; details: SkillGovernanceDetails }
      | { ok: false; reason: 'not_found' | 'invalid_id' }
    >;
    previewUpdate(skillId: string): Promise<
      | { ok: true; preview: ManagedSkillUpdatePreview }
      | { ok: false; reason: 'not_managed' | 'source_missing' | 'metadata_error' | 'blocked_path' | 'read_failed' }
    >;
    updateManaged(skillId: string, options?: { force?: boolean; expectedCurrentSha256?: string; expectedSourceSha256?: string }): Promise<
      | { ok: true; skill: SkillEntry }
      | { ok: false; reason: 'not_managed' | 'source_missing' | 'local_modified' | 'metadata_error' | 'blocked_path' | 'write_failed' }
    >;
    setEnabled(skillId: string, enabled: boolean): Promise<
      | { ok: true; skill: SkillEntry }
      | { ok: false; reason: 'not_found' | 'blocked_path' | 'state_error' | 'write_failed' }
    >;
    setPinned(skillRef: string, pinned: boolean): Promise<
      | { ok: true; skill: SkillEntry }
      | { ok: false; reason: 'not_found' | 'blocked_path' | 'state_error' | 'write_failed' }
    >;
    createStarter(): Promise<
      | { ok: true; created: boolean; skill: SkillEntry; filePath: string }
      | { ok: false; reason: 'blocked_path' | 'already_exists' | 'write_failed' }
    >;
    delete(id: string): Promise<
      | { ok: true }
      | { ok: false; reason: 'not_found' | 'blocked_path' | 'delete_failed' }
    >;
    open(id: string, target?: 'file' | 'directory'): Promise<
      | { ok: true; target: 'file' | 'directory' }
      | { ok: false; reason: 'invalid_id' | 'missing' | 'blocked_path' | 'not_file' | 'not_directory' | 'open_failed' }
    >;
  };
  browser: {
    setActiveSession(sessionId: string | null): void;
    setViewport(input: { sessionId: string; rect: BrowserViewRect | null }): void;
    navigate(sessionId: string, url: string): Promise<void>;
    back(sessionId: string): Promise<void>;
    forward(sessionId: string): Promise<void>;
    reload(sessionId: string): Promise<void>;
    stop(sessionId: string): Promise<void>;
    close(sessionId: string): Promise<void>;
    getState(sessionId: string): Promise<BrowserState | null>;
    onState(handler: (payload: { sessionId: string; state: BrowserState }) => void): () => void;
    onLive(handler: (payload: { sessionIds: string[] }) => void): () => void;
  };
}
