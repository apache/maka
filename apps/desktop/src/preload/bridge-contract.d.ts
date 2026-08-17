import type { ConnectionEvent } from '@maka/core/connections';
import type {
  ConnectionTestResult,
  CreateConnectionInput,
  LlmConnection,
  ModelDiscoveryResult,
  ModelInfo,
  UpdateConnectionInput,
} from '@maka/core/llm-connections';
import type {
  AppSettings,
  ChatDefaultsSettings,
  SettingsTestResult,
  UpdateAppSettingsInput,
  UpdateAppSettingsResult,
  UsageRange,
  UsageStats,
  ThemePreference,
} from '@maka/core/settings';
import type { BotProvider } from '@maka/core/bot-chat-settings';
import type { BotOnboardingSnapshot, BotOnboardingStartInput } from '@maka/core/bot-onboarding';
import type { HealthSnapshot } from '@maka/core/health';
import type { ExecutionBoundaryReadModel, SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type {
  ActiveInteractionRequestEvent,
  SessionCommand,
  SessionEvent,
  ShellRunUpdate,
  QueueEnqueueOutcome,
} from '@maka/core/events';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { PermissionMode } from '@maka/core/permission';
import type { CollaborationMode } from '@maka/core/collaboration';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type {
  TurnOrchestration,
  SessionListFilter,
  BranchFromTurnInput,
  RegenerateTurnInput,
  ReviseBeforeTurnInput,
} from '@maka/core/runtime-inputs';
import type { PlanSessionState } from '@maka/core/plan';
import type { SearchErrorReason, SearchRequest, SearchResult } from '@maka/core/search';
import type { SessionChangedEvent, SessionSummary, TurnRecord } from '@maka/core/session';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { E2eFixtureState } from '@maka/core/e2e-fixture';
import type { ExternalSessionSummary } from '@maka/core/external-session';
import type {
  GitReviewReadResult,
  GitReviewSource,
} from '@maka/core/git-review';
import type {
  ArtifactBinaryReadResult,
  ArtifactChangedEvent,
  ArtifactDescriptor,
  ArtifactSaveResult,
  ArtifactTextReadResult,
} from '@maka/core/artifacts';
import type { CapabilitySnapshotCollection, PermissionSnapshot } from '@maka/core/capabilities';
import type { LocalMemoryState } from '@maka/core/local-memory';
import type {
  AuthorizationUrlPayload,
  SubscriptionAccountState,
  SubscriptionActionResult,
} from '@maka/core/oauth-subscription';
import type { CreateScheduledTaskInput, ScheduledTask, UpdateScheduledTaskInput } from '@maka/core/scheduled-task';
import type { ProjectRecord } from '@maka/core/project';
import type {
  DailyReviewArchive,
  DailyReviewArchiveSummary,
  DailyReviewConfig,
  DailyReviewRange,
  DailyReviewSummary,
} from '@maka/core/daily-review';
import type { WebSearchProvider, WebSearchResponse } from '@maka/core/web-search';
import type { BrowserState, BrowserViewRect } from '@maka/core/browser';
import type { Task, TaskLedgerChangedEvent } from '@maka/core/task-ledger';
import type { DeepResearchChangedEvent, DeepResearchClientProgress } from '@maka/core/deep-research-run';
import type {
  DesktopTranscriptBatch,
  DesktopTranscriptHandle,
} from './transcript-contract.js';
import type { PetPackManifestV1 } from '@maka/core/pet';
import type {
  OperationInput,
  OperationOutput,
} from '@maka/runtime-host/protocol';
import type {
  RendererRuntimeHostCommandOperation,
  RendererRuntimeHostQueryOperation,
} from './runtime-host-renderer-operations.js';
import type { SessionTrace } from '@maka/core/session-trace';
import type { ContextDiagnosticsResult } from '@maka/runtime-host/protocol';
import type { TestProxyInput } from '@maka/core/settings/network-settings';
import type { ExternalSessionImportIpcResult } from './external-session-import-result.js';
import type { DesktopSessionSummary } from '../shared/desktop-session-projection.js';
export type { DesktopSessionSummary } from '../shared/desktop-session-projection.js';
import type { DesktopConnectionSnapshot } from '../shared/desktop-connection-snapshot.js';
import type {
  DesktopDiagnosticCopyResult,
  DesktopErrorDiagnosticInput,
} from './diagnostics-contract.js';
import type { Result } from '@maka/core/result';
import type { CreateSessionRequestInput } from '@maka/core/runtime-inputs';
import type {
  McpConfigFile,
  McpServerConfig,
  McpServerStatus,
  McpTestResult,
} from '@maka/core/mcp';
import type {
  AgentGraphClientSnapshot,
  AgentGraphClientSnapshotOptions,
  AgentGraphOperatorInspection,
} from '@maka/runtime/stream-graph-read-model';
import type { BotStatus, WechatBridgeQrCodeResult } from '@maka/runtime/bots';
import type { ShellRunPtyDataEvent, ShellRunPtySnapshot } from '@maka/runtime/shell-run-contract';
import type { BundledSkillCatalogEntry, ManagedSkillSourceEntry, ManagedSkillUpdatePreview, SkillEntry } from '@maka/ui';
import type { ConfigCategory } from '@maka/storage';
import type { OnboardingMilestone, OnboardingMilestoneId, OnboardingState } from '@maka/core/onboarding';
import type {
  RemoteRuntimeHostProfile,
  RuntimeHostProfile,
} from '@maka/runtime-host/client';
export interface OnboardingSnapshot {
  state: OnboardingState;
  milestones: OnboardingMilestone[];
  sessions: DesktopSessionSummary[];
  connections: import('@maka/core/llm-connections').LlmConnection[];
  defaultSlug: string | null;
  chatModelChoices: import('@maka/core/chat-model-choice').ChatModelChoice[];
  sessionSendOutcomes: Record<string, import('@maka/core/session-send-projection').SessionSendProjection>;
}

export interface DesktopTaskSubmissionReadinessRequest {
  connectionSlug?: string;
  model?: string;
  cwd?: string;
}

export type RendererIngestInput =
  | { approvalId: string; name: string; mimeType?: string }
  | { file: File };

export type DesktopBranchFromTurnInput = BranchFromTurnInput & {
  /** Stable target identity for retrying one Desktop copy action. */
  copyId: string;
};

export type DesktopReviseBeforeTurnInput = ReviseBeforeTurnInput & {
  /** Stable target identity for retrying one Desktop copy action. */
  copyId: string;
};

export type PermissionActionResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'invalid_id'
        | 'unsupported_platform'
        | 'unsupported_permission'
        | 'open_settings_failed'
        | 'denied'
        | 'failed';
      message?: string;
    };

export type PermissionOverlayStartResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'invalid_id' | 'unsupported_platform' | 'already_open' | 'open_settings_failed';
      message?: string;
    };

export type AppUpdateStatus =
  | { state: 'idle'; currentVersion: string }
  | { state: 'checking'; currentVersion: string }
  | { state: 'not-available'; currentVersion: string; latestVersion?: string }
  | {
      state: 'available';
      currentVersion: string;
      latestVersion: string;
    }
  | {
      state: 'downloading';
      currentVersion: string;
      latestVersion: string;
      progress: {
        percent: number;
        bytesPerSecond?: number;
        transferred?: number;
        total?: number;
      };
    }
  | {
      state: 'downloaded';
      currentVersion: string;
      latestVersion: string;
    }
  | { state: 'installing'; currentVersion: string; latestVersion: string }
  | {
      state: 'error';
      currentVersion: string;
      message: string;
      operation: 'check' | 'download' | 'install';
      latestVersion?: string;
    };

export type AppUpdateInstallRequest = {
  /** User consent from the trusted desktop renderer; this is a UX boundary, not a security boundary. */
  allowInterruptActiveTasks: boolean;
};

export type AppUpdateInstallResult =
  | { ok: true }
  | { ok: false; reason: 'active_tasks' }
  | { ok: false; reason: 'not_downloaded' | 'install_failed' };

export interface DesktopRuntimeHostProfileEntry {
  readonly profile: RuntimeHostProfile;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly readiness: 'disabled' | 'connecting' | 'ready' | 'reconnecting' | 'unavailable';
  readonly hostId?: string;
  readonly message?: string;
}

export interface DesktopRuntimeHostProfileSnapshot {
  readonly entries: readonly DesktopRuntimeHostProfileEntry[];
  readonly defaultProfileId: string;
}

export interface DesktopRuntimeHostRef {
  readonly profileId: string;
  readonly hostId: string;
}

export type DesktopNewTaskHostRef = DesktopRuntimeHostRef;

export interface DesktopNewTaskTarget extends DesktopRuntimeHostRef {
  readonly projectId: string | null;
}

export type DesktopNewTaskHost =
  | {
      readonly profile: RuntimeHostProfile;
      readonly hostId: string;
      readonly readiness: 'ready';
      readonly state: 'available';
      readonly projects: readonly ProjectRecord[];
      readonly capabilities: DesktopProjectCapabilities;
      readonly selectedProjectId: string | null | undefined;
      readonly defaultProjectId?: string;
      readonly chatDefaults: ChatDefaultsSettings;
      readonly projectPath?: string;
      readonly branch?: string;
    }
  | {
      readonly profile: RuntimeHostProfile;
      readonly hostId: string;
      readonly readiness: 'ready';
      readonly state: 'error';
      readonly message: string;
    }
  | {
      readonly profile: RuntimeHostProfile;
      readonly readiness: 'connecting' | 'reconnecting' | 'unavailable';
      readonly message?: string;
    };

export interface DesktopNewTaskCatalog {
  readonly defaultProfileId: string;
  readonly hosts: readonly DesktopNewTaskHost[];
}

export interface DesktopRuntimeHostProfileAddInput {
  readonly profile: RemoteRuntimeHostProfile;
  readonly credential?: string;
}

export type DesktopRuntimeHostProfileAddResult =
  | {
      readonly kind: 'connected';
      readonly snapshot: DesktopRuntimeHostProfileSnapshot;
    }
  | {
      readonly kind: 'unavailable';
      readonly snapshot: DesktopRuntimeHostProfileSnapshot;
      readonly message: string;
    };

export interface DesktopRuntimeHostProfileChangedEvent {
  readonly epoch: string;
  readonly profileId: string;
  readonly profileName: string;
  readonly profileKind: 'local' | 'remote';
  readonly readiness: 'connecting' | 'ready' | 'reconnecting' | 'unavailable';
  readonly hostId?: string;
  readonly isDefault: boolean;
  readonly removed?: boolean;
}

export type DesktopRuntimeHostSshTerminalEvent =
  | { readonly kind: 'opened'; readonly revision: number; readonly sessionId: string }
  | { readonly kind: 'data'; readonly revision: number; readonly sessionId: string; readonly data: string }
  | { readonly kind: 'connected'; readonly revision: number; readonly sessionId: string }
  | {
      readonly kind: 'closed';
      readonly revision: number;
      readonly sessionId: string;
      readonly code: number | null;
      readonly signal: string | null;
    };

export type DesktopRuntimeHostSshTerminalSnapshot =
  | { readonly kind: 'idle'; readonly revision: number }
  | { readonly kind: 'connecting'; readonly revision: number; readonly sessionId: string; readonly output: string }
  | {
      readonly kind: 'closed';
      readonly revision: number;
      readonly sessionId: string;
      readonly output: string;
      readonly code: number | null;
      readonly signal: string | null;
    };

export interface DesktopProjectCapabilities {
  readonly chooseClientDirectory: boolean;
  readonly chooseHostDirectory: boolean;
  readonly selectNoProject: boolean;
  readonly setLocalDefault: boolean;
  readonly viewClientPath: boolean;
}

export interface DesktopProjectDirectoryRoot {
  readonly id: string;
  readonly label: string;
}

export interface DesktopProjectDirectoryEntry {
  readonly name: string;
}

export interface DesktopProjectSnapshot {
  readonly projects: readonly ProjectRecord[];
  readonly capabilities: DesktopProjectCapabilities;
}

export interface DesktopAppInfo {
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly nodeVersion: string;
  readonly chromeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly osRelease: string;
  readonly workspacePath: string;
  /** The OS home directory, for collapsing displayed paths to `~`. */
  readonly homePath: string;
  /** Exact operational-state database path resolved by main. */
  readonly operationalStateDatabasePath: string;
  readonly projectId?: string | null;
  readonly projectPath: string;
  readonly projectGit: { readonly isGitRepo: boolean; readonly branch?: string };
  readonly buildMode: 'dev' | 'packaged';
  readonly buildCommit: string | null;
}

/**
 * Commands dispatched by the native application menu (see
 * main/application-menu.ts). The renderer owns the implementations.
 */
export type WindowCommand = { id: 'newTask' | 'openSettings' | 'openHelp' };

export interface PetPackChangedEvent {
  readonly type: 'pet_pack_changed';
  readonly reason: 'installed' | 'removed' | 'selected';
  readonly petId: string | null;
  readonly ts: number;
}

export interface MakaBridge {
  runtimeHost: {
    query<K extends RendererRuntimeHostQueryOperation>(
      operation: K,
      input: OperationInput<K>,
    ): Promise<OperationOutput<K>>;
    command<K extends RendererRuntimeHostCommandOperation>(
      operation: K,
      input: OperationInput<K>,
    ): Promise<OperationOutput<K>>;
  };

  runtimeHostProfiles: {
    getSnapshot(): Promise<DesktopRuntimeHostProfileSnapshot>;
    addAndEnable(
      input: DesktopRuntimeHostProfileAddInput,
    ): Promise<DesktopRuntimeHostProfileAddResult>;
    remove(profileId: string): Promise<DesktopRuntimeHostProfileSnapshot>;
    setEnabled(profileId: string, enabled: boolean): Promise<DesktopRuntimeHostProfileSnapshot>;
    setDefault(profileId: string): Promise<DesktopRuntimeHostProfileSnapshot>;
    subscribeChanges(
      handler: (event: DesktopRuntimeHostProfileChangedEvent) => void,
    ): () => void;
  };

  runtimeHostSshTerminal: {
    getSnapshot(): Promise<DesktopRuntimeHostSshTerminalSnapshot>;
    write(sessionId: string, data: string): Promise<void>;
    resize(sessionId: string, cols: number, rows: number): Promise<void>;
    cancel(sessionId: string): Promise<void>;
    subscribe(handler: (event: DesktopRuntimeHostSshTerminalEvent) => void): () => void;
  };

  newTasks: {
    getCatalog(): Promise<DesktopNewTaskCatalog>;
    subscribeChanges(handler: () => void): () => void;
    addProject(host: DesktopNewTaskHostRef): Promise<
      { ok: true; project: ProjectRecord } | { ok: false; reason: 'cancelled' }
    >;
    relinkProject(host: DesktopNewTaskHostRef, projectId: string): Promise<
      { ok: true; project: ProjectRecord } | { ok: false; reason: 'cancelled' }
    >;
    getConnections(host: DesktopNewTaskHostRef): Promise<DesktopConnectionSnapshot>;
    listInvocableSkills(
      target: DesktopNewTaskTarget,
      context?: {
        llmConnectionSlug?: string;
        model?: string;
        collaborationMode?: 'agent' | 'plan';
        permissionMode?: ChatDefaultsSettings['permissionMode'];
      },
    ): Promise<import('@maka/runtime/skill-invocation').InvocableSkillEntry[]>;
    getReadiness(
      target: DesktopNewTaskTarget,
      input?: DesktopTaskSubmissionReadinessRequest,
    ): Promise<import('@maka/core/task-submission-readiness').TaskSubmissionReadinessSnapshot>;
    searchFiles(
      target: DesktopNewTaskTarget,
      query: string,
      options?: { limit?: number },
    ): Promise<
      | { ok: true; files: Array<{ relativePath: string }> }
      | { ok: false; reason: 'no_project' | 'search_failed' }
    >;
    create(
      target: DesktopNewTaskTarget,
      input?: CreateSessionRequestInput,
    ): Promise<DesktopSessionSummary>;
  };

  pets: {
    list(): Promise<PetPackManifestV1[]>;
    getSelection(): Promise<string | null>;
    select(petId: string | null): Promise<
      | { ok: true; selectedPetId: string | null }
      | {
          ok: false;
          reason: 'invalid_id' | 'not_found' | 'read_failed' | 'write_failed';
        }
    >;
    readSpriteSheet(petId: string): Promise<
      | { ok: true; mimeType: 'image/png' | 'image/webp'; bytes: Uint8Array }
      | {
          ok: false;
          reason: 'invalid_id' | 'not_found' | 'corrupt_pack' | 'read_failed';
        }
    >;
    remove(petId: string): Promise<
      | { ok: true; removed: boolean }
      | { ok: false; reason: 'invalid_id' | 'remove_failed' }
    >;
    importLocalDirectory(): Promise<
      | { ok: true; manifest: PetPackManifestV1 }
      | {
          ok: false;
          reason:
            | 'cancelled'
            | 'invalid_directory'
            | 'invalid_manifest'
            | 'invalid_asset'
            | 'already_installed'
            | 'read_failed';
        }
    >;
    subscribeChanges(handler: (event: PetPackChangedEvent) => void): () => void;
  };

  tasks: {
    list(sessionId: string): Promise<Task[]>;
    subscribeChanges(handler: (event: TaskLedgerChangedEvent) => void): () => void;
  };
  deepResearch: {
    get(sessionId: string): Promise<DeepResearchClientProgress | undefined>;
    subscribeChanges(handler: (event: DeepResearchChangedEvent) => void): () => void;
  };
  graphs: {
    getSnapshot(
      rootSessionId: string,
      options?: AgentGraphClientSnapshotOptions,
    ): Promise<AgentGraphClientSnapshot>;
    inspectOperator(
      rootSessionId: string,
      operatorId: string,
    ): Promise<AgentGraphOperatorInspection>;
    stop(rootSessionId: string): Promise<void>;
    subscribe(
      rootSessionId: string,
      handler: () => void,
    ): () => void;
  };
  sessions: {
    list(filter?: SessionListFilter): Promise<DesktopSessionSummary[]>;
    create(input?: CreateSessionRequestInput): Promise<DesktopSessionSummary>;
    send(
      sessionId: string,
      command:
        | SessionCommand
        | {
            type: 'send';
            turnId: string;
            text: string;
            displayText?: string;
            skillIds?: string[];
            attachmentItems?: RendererIngestInput[];
            turnOrchestration?: TurnOrchestration;
            quotes?: import('@maka/core/events').QuoteRef[];
            workspaceFileReferences?: Array<
              Pick<import('@maka/core/events').InlineReference, 'value' | 'start'>
            >;
          },
    ): Promise<
      | {
          ok: true;
          turnId: string;
          /**
           * The send raced a root Turn another client opened first and was
           * queued into it as steering instead of starting `turnId`.
           */
          steered?: true;
          attachments: import('@maka/core/events').AttachmentRef[];
          inlineReferences: import('@maka/core/events').InlineReference[];
          skillInvocation: import('@maka/runtime/skill-invocation').SkillInvocationResult;
        }
      | {
          ok: false;
          reason: 'skill_invocation_failed';
          skillInvocation: import('@maka/runtime/skill-invocation').SkillInvocationResult;
        }
    >;
    stop(sessionId: string, input?: { source?: 'stop_button' }): Promise<void>;
    steer(sessionId: string, text: string): Promise<QueueEnqueueOutcome>;
    readExecutionBoundary(sessionId: string): Promise<ExecutionBoundaryReadModel>;
    listActiveInteractions(sessionId: string): Promise<ActiveInteractionRequestEvent[]>;
    subscribeActiveInteractions(
      handler: (event: {
        sessionId: string;
        interactions: ActiveInteractionRequestEvent[];
      }) => void,
    ): () => void;
    listTurns(sessionId: string): Promise<TurnRecord[]>;
    listTurnLandmarks(sessionId: string): Promise<OperationOutput<'session.turn_landmarks.query'>>;
    compact(sessionId: string): Promise<void>;
    resumeLatest(sessionId: string): Promise<
      | { disposition: 'started'; runId: string; turnId: string }
      | { disposition: 'park'; rejectionReasons: string[]; diagnostics: unknown[] }
    >;
    regenerateTurn(sessionId: string, input: RegenerateTurnInput): Promise<void>;
    branchFromTurn(sessionId: string, input: DesktopBranchFromTurnInput): Promise<DesktopSessionSummary>;
    reviseBeforeTurn(sessionId: string, input: DesktopReviseBeforeTurnInput): Promise<DesktopSessionSummary>;
    respondToSandboxBoundary(sessionId: string, response: SandboxBoundaryResponse): Promise<void>;
    respondToUserQuestion(sessionId: string, response: UserQuestionResponse): Promise<void>;
    saveConversationToFile(input: {
      markdown: string;
      defaultName: string;
    }): Promise<
      { ok: true; path: string } | { ok: false; reason: 'canceled' | 'write_failed' | 'invalid_input' }
    >;
    subscribeEvents(
      sessionId: string,
      handler: (event: SessionEvent) => void,
      onSeeded?: () => void,
      onObservationSeed?: (phase: 'pending' | 'ready') => void,
    ): () => void;
    subscribeChanges(handler: (event: SessionChangedEvent) => void): () => void;
    archive(sessionId: string, options?: { revisionFamily?: boolean }): Promise<void>;
    unarchive(sessionId: string, options?: { revisionFamily?: boolean }): Promise<void>;
    setFlagged(sessionId: string, isFlagged: boolean, options?: { revisionFamily?: boolean }): Promise<void>;
    rename(sessionId: string, name: string, options?: { revisionFamily?: boolean }): Promise<void>;
    setPermissionMode(sessionId: string, mode: PermissionMode): Promise<DesktopSessionSummary>;
    setCollaborationMode(sessionId: string, mode: CollaborationMode): Promise<DesktopSessionSummary>;
    setOrchestrationMode(sessionId: string, mode: OrchestrationMode): Promise<DesktopSessionSummary>;
    getPlanState(sessionId: string): Promise<PlanSessionState>;
    subscribePlanChanges(sessionId: string, handler: () => void): () => void;
    requestPlanRevision(sessionId: string, proposalId: string): Promise<PlanSessionState>;
    abandonPlanProposal(
      sessionId: string,
      proposalId: string,
    ): Promise<PlanSessionState>;
    approvePlan(sessionId: string, input: {
      proposalId: string;
      expectedRevision: number;
      expectedStoreVersion: number;
      turnId: string;
    }): Promise<{ turnId: string; executionId: string }>;
    resumePlan(sessionId: string, executionId: string, turnId: string): Promise<{
      turnId: string;
      executionId: string;
    }>;
    abandonPlanExecution(sessionId: string, executionId: string): Promise<PlanSessionState>;
    setModel(sessionId: string, input: { llmConnectionSlug: string; model: string }): Promise<DesktopSessionSummary>;
    setThinkingLevel(sessionId: string, level: ThinkingLevel | undefined | null): Promise<DesktopSessionSummary>;
    /**
     * `requireArchived` holds the caller's premise through the deletion: a task
     * restored meanwhile answers `restored` and is kept.
     */
    remove(
      sessionId: string,
      options?: { revisionFamily?: boolean; requireArchived?: boolean },
    ): Promise<'removed' | 'restored'>;
    cleanupSessionCopy(sessionId: string): Promise<void>;
    abandonSessionCopy(sourceSessionId: string, copyId: string): Promise<void>;
  };
  transcripts: {
    open(
      sessionId: string,
      handler: (batch: DesktopTranscriptBatch) => void,
      registerCancellation?: (cancel: () => void) => void,
    ): Promise<DesktopTranscriptHandle>;
  };
  externalSessions: {
    listSources(host?: DesktopRuntimeHostRef): Promise<{ adapterIds: string[] }>;
    list(input: { adapterId: string; includeArchived?: boolean; cursor?: string }, host?: DesktopRuntimeHostRef): Promise<{
      sessions: ExternalSessionSummary[];
      nextCursor: string | null;
    }>;
    import(input: {
      adapterId: string;
      sourceSessionId: string;
    }, host?: DesktopRuntimeHostRef): Promise<ExternalSessionImportIpcResult<DesktopSessionSummary>>;
  };
  projects: {
    getDefaultContext(): Promise<{
      snapshot: DesktopProjectSnapshot;
      info: DesktopAppInfo;
    }>;
    getSnapshot(sessionId?: string, host?: DesktopRuntimeHostRef): Promise<DesktopProjectSnapshot>;
    subscribeChanges(handler: () => void, sessionId?: string, host?: DesktopRuntimeHostRef): () => void;
    getLocalSnapshot(): Promise<DesktopProjectSnapshot>;
    subscribeLocalChanges(handler: () => void): () => void;
    add(host?: DesktopRuntimeHostRef): Promise<
      { ok: true; project: ProjectRecord; path: string } | { ok: false; reason: 'cancelled' }
    >;
    getDirectoryRoots(host: DesktopRuntimeHostRef): Promise<readonly DesktopProjectDirectoryRoot[]>;
    listDirectory(
      input: { readonly rootId: string; readonly segments: readonly string[] },
      host: DesktopRuntimeHostRef,
    ): Promise<readonly DesktopProjectDirectoryEntry[]>;
    registerDirectory(
      input: { readonly rootId: string; readonly segments: readonly string[] },
      host: DesktopRuntimeHostRef,
    ): Promise<ProjectRecord>;
    select(
      projectId: string | null,
      host?: DesktopRuntimeHostRef,
    ): Promise<{ project: ProjectRecord | null; path: string }>;
    relink(
      projectId: string,
      host?: DesktopRuntimeHostRef,
    ): Promise<{ ok: true; project: ProjectRecord } | { ok: false; reason: 'cancelled' }>;
    /** Open a catalogued project's folder in the OS file manager. */
    reveal(projectId: string, host?: DesktopRuntimeHostRef): Promise<OpenPathResult>;
    rename(projectId: string, name: string, host?: DesktopRuntimeHostRef): Promise<ProjectRecord>;
    archive(projectId: string, host?: DesktopRuntimeHostRef): Promise<ProjectRecord>;
    restore(projectId: string, host?: DesktopRuntimeHostRef): Promise<ProjectRecord>;
  };
  shellRuns: {
    list(sessionId: string): Promise<ShellRunUpdate[]>;
    attach(input: {
      sessionId: string;
      ref: string;
    }): Promise<ShellRunPtySnapshot | null>;
    detach(input: { sessionId: string; ref: string }): Promise<void>;
    start(sessionId: string): Promise<ShellRunUpdate>;
    write(input: {
      sessionId: string;
      ref: string;
      input?: string;
      size?: { cols: number; rows: number };
    }): Promise<ShellRunUpdate | null>;
    stop(input: {
      sessionId: string;
      ref: string;
    }): Promise<ShellRunUpdate | null>;
    subscribeUpdates(handler: (update: ShellRunUpdate) => void): () => void;
    subscribePtyData(handler: (event: ShellRunPtyDataEvent) => void): () => void;
    subscribeResync(handler: (event: { sessionId: string }) => void): () => void;
  };
  gitReview: {
    read(input: {
      sessionId: string;
      source: GitReviewSource;
      baseBranch?: string;
    }): Promise<GitReviewReadResult>;
  };
  goal: {
    /** The session's current goal (null when none is set). */
    get(sessionId: string): Promise<import('@maka/runtime/goal-state').GoalState | null>;
    /** Clear the active goal, stopping autonomous continuation. */
    clear(sessionId: string): Promise<void>;
  };
  connections: {
    getSnapshot(sessionId?: string, host?: DesktopRuntimeHostRef): Promise<DesktopConnectionSnapshot>;
    setDefault(slug: string | null, host?: DesktopRuntimeHostRef): Promise<void>;
    setDefaultModel(input: { slug: string; model: string } | null, host?: DesktopRuntimeHostRef): Promise<void>;
    create(input: CreateConnectionInput, host?: DesktopRuntimeHostRef): Promise<LlmConnection>;
    update(slug: string, patch: UpdateConnectionInput, host?: DesktopRuntimeHostRef): Promise<LlmConnection>;
    delete(slug: string, host?: DesktopRuntimeHostRef): Promise<void>;
    test(slug: string, opts?: { model?: string }, host?: DesktopRuntimeHostRef): Promise<ConnectionTestResult>;
    fetchModels(slug: string, host?: DesktopRuntimeHostRef): Promise<ModelDiscoveryResult>;
    hasSecret(slug: string, host?: DesktopRuntimeHostRef): Promise<boolean>;
    getRequestHeaders(slug: string, host?: DesktopRuntimeHostRef): Promise<import('@maka/core/llm-connections').SavedRequestHeaders>;
    setRequestHeaders(
      slug: string,
      headers: readonly import('@maka/core/llm-connections').RequestHeaderUpdate[],
      host?: DesktopRuntimeHostRef,
    ): Promise<import('@maka/core/llm-connections').SavedRequestHeaders>;
    subscribeEvents(handler: (event: ConnectionEvent) => void, host?: DesktopRuntimeHostRef): () => void;
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
    subscribeChanges(handler: (statuses: McpServerStatus[]) => void): () => void;
  };
  settings: {
    getClient(): Promise<AppSettings>;
    get(host?: DesktopRuntimeHostRef): Promise<AppSettings>;
    updateClient(patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsResult>;
    update(patch: UpdateAppSettingsInput, host?: DesktopRuntimeHostRef): Promise<UpdateAppSettingsResult>;
    subscribeClientChanged(handler: () => void): () => void;
    subscribeExternalChanged(handler: () => void, host?: DesktopRuntimeHostRef): () => void;
    testNetworkProxy(input?: TestProxyInput, host?: DesktopRuntimeHostRef): Promise<SettingsTestResult>;
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
  };
  taskReadiness: {
    getSnapshot(
      input?: DesktopTaskSubmissionReadinessRequest,
      sessionId?: string,
    ): Promise<import('@maka/core/task-submission-readiness').TaskSubmissionReadinessSnapshot>;
  };
  permissions: {
    getSnapshot(host?: DesktopRuntimeHostRef): Promise<PermissionSnapshot>;
    openSystemSettings(permId: string, host?: DesktopRuntimeHostRef): Promise<PermissionActionResult>;
    requestAccess(permId: string, host?: DesktopRuntimeHostRef): Promise<PermissionActionResult>;
    /**
     * macOS drag-to-grant onboarding: opens the right Privacy pane and
     * floats a card the user can drag the app bundle out of. Only
     * `accessibility` and `screen_recording` — the two permissions with
     * no programmatic consent dialog.
     */
    startDragOnboarding(permId: string, host?: DesktopRuntimeHostRef): Promise<PermissionOverlayStartResult>;
  };
  capabilities: {
    getSnapshot(host?: DesktopRuntimeHostRef): Promise<CapabilitySnapshotCollection>;
  };
  health: {
    getSnapshot(host?: DesktopRuntimeHostRef): Promise<HealthSnapshot>;
  };
  memory: {
    getState(sessionId?: string, host?: DesktopRuntimeHostRef): Promise<LocalMemoryState>;
    save(content: string, host?: DesktopRuntimeHostRef): Promise<LocalMemoryState>;
    reset(host?: DesktopRuntimeHostRef): Promise<LocalMemoryState>;
    restoreLatestBackup(host?: DesktopRuntimeHostRef): Promise<{ ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }>;
    restoreBackup(kind: 'save' | 'reset' | 'restore', host?: DesktopRuntimeHostRef): Promise<{ ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }>;
    setEnabled(enabled: boolean, host?: DesktopRuntimeHostRef): Promise<LocalMemoryState>;
    setAgentReadEnabled(enabled: boolean, host?: DesktopRuntimeHostRef): Promise<LocalMemoryState>;
    openFile(host?: DesktopRuntimeHostRef): Promise<{ ok: true } | { ok: false; message: string }>;
    openLatestBackup(host?: DesktopRuntimeHostRef): Promise<{ ok: true } | { ok: false; message: string }>;
    openBackup(kind: 'save' | 'reset' | 'restore', host?: DesktopRuntimeHostRef): Promise<{ ok: true } | { ok: false; message: string }>;
  };
  attachments: {
    pickFiles(): Promise<
      | {
          ok: true;
          files: {
            approvalId: string;
            name: string;
            mimeType?: string;
            size: number;
          }[];
        }
      | { ok: false; reason: 'cancelled' }
    >;
    previewApproval(approvalId: string): Promise<
      | { ok: true; base64: string; mimeType: string }
      | { ok: false; reason: string }
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
  claudeSubscription: {
    isExperimentalEnabled(host?: DesktopRuntimeHostRef): Promise<boolean>;
    getAuthUrl(host?: DesktopRuntimeHostRef): Promise<AuthorizationUrlPayload | SubscriptionActionResult>;
    openAuthUrl(authRequestId: string, host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult>;
    completeAuthorization(
      authRequestId: string,
      pasted: string,
      host?: DesktopRuntimeHostRef,
    ): Promise<SubscriptionActionResult>;
    cancelAuthorization(authRequestId?: string, host?: DesktopRuntimeHostRef): Promise<{ ok: true }>;
    getAccountState(host?: DesktopRuntimeHostRef): Promise<SubscriptionAccountState>;
    refreshQuota(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult>;
    refreshTokens(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult>;
    logout(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult>;
  };
  openAiCodex: {
    isExperimentalEnabled(host?: DesktopRuntimeHostRef): Promise<boolean>;
    getAuthUrl(host?: DesktopRuntimeHostRef): Promise<AuthorizationUrlPayload | SubscriptionActionResult>;
    openAuthUrl(authRequestId: string, host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult>;
    completeAuthorization(authRequestId: string, host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult>;
    cancelAuthorization(authRequestId?: string, host?: DesktopRuntimeHostRef): Promise<{ ok: true }>;
    getAccountState(host?: DesktopRuntimeHostRef): Promise<{
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
    refreshTokens(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult>;
    logout(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult>;
  };
  xaiOAuth: {
    getAuthUrl(host?: DesktopRuntimeHostRef): Promise<AuthorizationUrlPayload | SubscriptionActionResult>;
    openAuthUrl(authRequestId: string, host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult>;
    completeAuthorization(authRequestId: string, host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult>;
    cancelAuthorization(authRequestId?: string, host?: DesktopRuntimeHostRef): Promise<{ ok: true }>;
    getAccountState(host?: DesktopRuntimeHostRef): Promise<{
      provider: 'xai-oauth';
      runtimeState:
        | 'not_logged_in'
        | 'authorizing'
        | 'authenticated'
        | 'refreshing'
        | 'refresh_failed'
        | 'storage_failed';
      errorMessage?: string;
    }>;
    refreshTokens(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult>;
    logout(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult>;
  };
  githubCopilotSubscription: {
    connectExistingLogin(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult>;
    getAccountState(host?: DesktopRuntimeHostRef): Promise<{
      provider: 'github-copilot';
      runtimeState: 'not_logged_in' | 'authenticated' | 'refreshing' | 'refresh_failed' | 'storage_failed';
      errorMessage?: string;
    }>;
    refreshTokens(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult>;
    logout(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult>;
  };
  scheduledTasks: {
    list(): Promise<ScheduledTask[]>;
    create(input: Omit<CreateScheduledTaskInput, 'createdBy'>): Promise<ScheduledTask>;
    update(
      id: string,
      patch: UpdateScheduledTaskInput,
    ): Promise<ScheduledTask>;
    setEnabled(id: string, enabled: boolean): Promise<ScheduledTask>;
    triggerNow(id: string): Promise<ScheduledTask>;
    snooze(id: string): Promise<ScheduledTask>;
    clearRunHistory(id: string): Promise<ScheduledTask>;
    delete(id: string): Promise<void>;
    subscribeChanges(
      handler: (event: { type: 'scheduled_tasks_changed'; reason: string; taskId?: string; ts: number }) => void,
    ): () => void;
    subscribeDue(handler: (task: Pick<ScheduledTask, 'id' | 'title'>) => void): () => void;
  };
  inspector: {
    /** Read-only per-session causal trace (#1625). */
    trace(sessionId: string): Promise<Result<SessionTrace>>;
    /** What the session's context is made of right now (#2323). */
    context(sessionId: string): Promise<Result<ContextDiagnosticsResult>>;
  };
  webSearch: {
    query(input: {
      query: string;
      limit?: number;
      provider?: WebSearchProvider;
      apiKey?: string;
    }, host?: DesktopRuntimeHostRef): Promise<WebSearchResponse>;
    test(input: { provider?: WebSearchProvider; apiKey?: string }, host?: DesktopRuntimeHostRef): Promise<WebSearchResponse>;
  };
  dailyReview: {
    day(offsetDays: number, daySpan?: number): Promise<Result<DailyReviewSummary>>;
    getConfig?(host?: DesktopRuntimeHostRef): Promise<DailyReviewConfig>;
    setConfig?(patch: Partial<DailyReviewConfig>, host?: DesktopRuntimeHostRef): Promise<DailyReviewConfig>;
    runOnce?(input: { range: DailyReviewRange; offsetDays?: number; modelKey?: string }): Promise<{ archiveId: string }>;
    listArchives?(): Promise<DailyReviewArchiveSummary[]>;
    getArchive?(archiveId: string): Promise<DailyReviewArchive | null>;
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
    setTitlebarControlsVisible(visible: boolean): Promise<void>;
    setThemeSource(themePref: ThemePreference): Promise<void>;
    // PR-WINDOW-TITLEBAR-0: re-sync the native Windows titleBarOverlay
    // color/symbolColor to the resolved app surface. No-op on non-Windows.
    setTitleBarOverlayTheme(theme: { isDark: boolean; backgroundColor: string }): Promise<void>;
    // PR-SHOW-AFTER-FIRST-COMMIT: signal main after the first React commit
    // so the hidden window is revealed (see main-window.ts).
    notifyRendererReady(): Promise<void>;
    // PR-2088: main-to-renderer route for native-menu commands. Returns an
    // unsubscribe; a command sent before this subscription exists is dropped.
    subscribeCommand(handler: (command: WindowCommand) => void): () => void;
  };
  config: {
    export(input: { categories: ConfigCategory[] }, host?: DesktopRuntimeHostRef): Promise<
      | { ok: false; reason: 'no_categories' | 'canceled' }
      | { ok: true; path: string; includedData: ConfigCategory[] }
    >;
    import(input: { strategy: 'skip' | 'overwrite' }, host?: DesktopRuntimeHostRef): Promise<
      | { ok: false; reason: 'canceled' | 'not_json' | 'malformed' | 'unsupported_version'; message?: string }
      | {
          ok: true;
          includedData: ConfigCategory[];
          result: {
            connections?: {
              created: number;
              overwritten: number;
              skipped: number;
            };
            settings?: { applied: boolean };
            credentials?: { applied: number; skipped: number };
            memory?: { applied: boolean };
          };
        }
    >;
  };
  app: {
    info(host?: DesktopRuntimeHostRef): Promise<DesktopAppInfo>;
    subscribeUpdateStatus(handler: (status: AppUpdateStatus) => void): () => void;
    updateStatus(): Promise<AppUpdateStatus>;
    checkForUpdates(): Promise<AppUpdateStatus>;
    retryUpdateDownload(): Promise<AppUpdateStatus>;
    installUpdate(input: AppUpdateInstallRequest): Promise<AppUpdateInstallResult>;
    sessionProjectInfo(sessionId: string): Promise<{
      projectPath: string;
      projectGit: { isGitRepo: boolean; branch?: string };
    }>;
    openPath(
      key: 'workspace' | 'skills' | 'memory' | 'project',
      sessionId?: string,
      host?: DesktopRuntimeHostRef,
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
    resolveProjectGitInfo(projectPath: string): Promise<
      | { ok: true; projectPath: string; projectGit: { isGitRepo: boolean; branch?: string } }
      | { ok: false; reason: 'invalid-path' | 'not-found' }
    >;
    openArtifactPath(
      sessionId: string,
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
    saveArtifactAs(sessionId: string, artifactId: string): Promise<ArtifactSaveResult>;
  };
  diagnostics: {
    copyErrorReport(input: DesktopErrorDiagnosticInput): Promise<DesktopDiagnosticCopyResult>;
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
    list(sessionId: string, opts?: { includeDeleted?: boolean }): Promise<ArtifactDescriptor[]>;
    readText(sessionId: string, artifactId: string): Promise<ArtifactTextReadResult>;
    readBinary(sessionId: string, artifactId: string): Promise<ArtifactBinaryReadResult>;
    delete(sessionId: string, artifactId: string): Promise<void>;
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
    ): Promise<import('@maka/runtime/skill-invocation').InvocableSkillEntry[]>;
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
    delete(idOrRef: string): Promise<
      | { ok: true }
      | { ok: false; reason: 'not_found' | 'blocked_path' | 'blocked_scope' | 'delete_failed' }
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
