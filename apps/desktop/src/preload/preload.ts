import { contextBridge, ipcRenderer } from 'electron';
import { encodeIngestItems } from './attachment-ingest-payload.js';
import type {
  MakaBridge,
  OnboardingSnapshot,
  DesktopTaskSubmissionReadinessRequest,
  PermissionActionResult,
  PermissionOverlayStartResult,
  RendererIngestInput,
  DesktopBranchFromTurnInput,
  DesktopReviseBeforeTurnInput,
  AppUpdateInstallRequest,
  AppUpdateInstallResult,
  AppUpdateStatus,
  WindowCommand,
  PetPackChangedEvent,
} from './bridge-contract.js';
import type { ExternalSessionImportIpcResult } from './external-session-import-result.js';
import type {
  DesktopDiagnosticCopyResult,
  DesktopErrorDiagnosticInput,
} from './diagnostics-contract.js';
import type {
  ConnectionEvent,
  ConnectionTestResult,
  CreateConnectionInput,
  AppSettings,
  BotProvider,
  BotOnboardingSnapshot,
  BotOnboardingStartInput,
  HealthSnapshot,
  ExecutionBoundaryReadModel,
  LlmConnection,
  ModelDiscoveryResult,
  ModelInfo,
  ActiveInteractionRequestEvent,
  SandboxBoundaryResponse,
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
  ExternalSessionSummary,
  GitReviewReadResult,
  GitReviewMutationAction,
  GitReviewMutationResult,
  GitReviewSource,
  ArtifactBinaryReadResult,
  ArtifactChangedEvent,
  ArtifactDescriptor,
  ArtifactSaveResult,
  ArtifactTextReadResult,
  CapabilitySnapshotCollection,
  RegenerateTurnInput,
  TurnRecord,
  PermissionSnapshot,
  LocalMemoryEntryPreview,
  LocalMemoryState,
  AuthorizationUrlPayload,
  SubscriptionAccountState,
  SubscriptionActionResult,
  PlanReminder,
  ProjectRecord,
  PlanReminderDeliveryTarget,
  PlanReminderRecurrence,
  DailyReviewArchive,
  DailyReviewArchiveSummary,
  QueueEnqueueOutcome,
  DailyReviewConfig,
  DailyReviewRange,
  DailyReviewSummary,
  WebSearchProvider,
  WebSearchResponse,
  BrowserState,
  BrowserViewRect,
  ThemePreference,
  Task,
  TaskLedgerChangedEvent,
  DeepResearchChangedEvent,
  DeepResearchClientProgress,
} from '@maka/core';
import type { SessionTrace } from '@maka/core/session-trace';
import type {
  AgentGraphClientSnapshot,
  AgentGraphClientSnapshotOptions,
  AgentGraphOperatorInspection,
  BotStatus,
  ShellRunPtyDataEvent,
  ShellRunPtySnapshot,
  WechatBridgeQrCodeResult,
} from '@maka/runtime';
import type { GoalState } from '@maka/runtime';
import type { BundledSkillCatalogEntry, ManagedSkillSourceEntry, ManagedSkillUpdatePreview, SkillEntry, SkillGovernanceDetails } from '@maka/ui';
import type { ConfigCategory } from '@maka/storage';
import type { TestProxyInput } from '@maka/core/settings/network-settings';
import type { Result } from '@maka/core/result';
import type { CreateSessionRequestInput } from '@maka/core';
import type {
  McpConfigFile,
  McpServerConfig,
  McpServerStatus,
  McpTestResult,
} from '@maka/core/mcp';
import type {
  AttachmentRef,
  InlineReference,
  OnboardingMilestoneId,
  QuoteRef,
} from '@maka/core';

type LocalMemoryMutationResult =
  | { ok: true; state: LocalMemoryState; entry?: LocalMemoryEntryPreview; proposal?: LocalMemoryEntryPreview }
  | { ok: false; state: LocalMemoryState; reason: string; message: string };

const makaBridge = {
  pets: {
    list() {
      return ipcRenderer.invoke('pets:list');
    },
    getSelection() {
      return ipcRenderer.invoke('pets:getSelection');
    },
    select(petId: string | null) {
      return ipcRenderer.invoke('pets:select', petId);
    },
    readSpriteSheet(petId: string) {
      return ipcRenderer.invoke('pets:readSpriteSheet', petId);
    },
    remove(petId: string) {
      return ipcRenderer.invoke('pets:remove', petId);
    },
    importLocalDirectory() {
      return ipcRenderer.invoke('pets:importLocalDirectory');
    },
    subscribeChanges(handler: (event: PetPackChangedEvent) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: PetPackChangedEvent) =>
        handler(payload);
      ipcRenderer.on('pets:changed', listener);
      return () => ipcRenderer.off('pets:changed', listener);
    },
  },
  tasks: {
    list(sessionId: string): Promise<Task[]> {
      return ipcRenderer.invoke('tasks:list', sessionId);
    },
    subscribeChanges(handler: (event: TaskLedgerChangedEvent) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: TaskLedgerChangedEvent) => handler(payload);
      ipcRenderer.on('tasks:changed', listener);
      return () => ipcRenderer.off('tasks:changed', listener);
    },
  },
  deepResearch: {
    get(sessionId: string): Promise<DeepResearchClientProgress | undefined> {
      return ipcRenderer.invoke('deepResearch:get', sessionId);
    },
    subscribeChanges(handler: (event: DeepResearchChangedEvent) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: DeepResearchChangedEvent) =>
        handler(payload);
      ipcRenderer.on('deepResearch:changed', listener);
      return () => ipcRenderer.off('deepResearch:changed', listener);
    },
  },
  graphs: {
    getSnapshot(
      rootSessionId: string,
      options?: AgentGraphClientSnapshotOptions,
    ): Promise<AgentGraphClientSnapshot> {
      return ipcRenderer.invoke('graphs:getSnapshot', rootSessionId, options);
    },
    inspectOperator(
      rootSessionId: string,
      operatorId: string,
    ): Promise<AgentGraphOperatorInspection> {
      return ipcRenderer.invoke('graphs:inspectOperator', rootSessionId, operatorId);
    },
    stop(rootSessionId: string): Promise<void> {
      return ipcRenderer.invoke('graphs:stop', rootSessionId);
    },
    subscribe(
      rootSessionId: string,
      handler: () => void,
    ): () => void {
      const changedListener = (
        _event: Electron.IpcRendererEvent,
        payload: { rootSessionId: string },
      ) => {
        if (payload.rootSessionId === rootSessionId) handler();
      };
      const resyncListener = (
        _event: Electron.IpcRendererEvent,
        payload: { rootSessionId: string },
      ) => {
        if (payload.rootSessionId === rootSessionId) handler();
      };
      ipcRenderer.on('graphs:changed', changedListener);
      ipcRenderer.on('graphs:resync', resyncListener);
      return () => {
        ipcRenderer.off('graphs:changed', changedListener);
        ipcRenderer.off('graphs:resync', resyncListener);
      };
    },
  },
  sessions: {
    list(filter?: SessionListFilter): Promise<SessionSummary[]> {
      return ipcRenderer.invoke('sessions:list', filter);
    },
    /**
     * The single session-creation channel (#1433). `mode` names a
     * product intent — main derives the permission boundary, name and
     * labels it implies (`create-session-input.ts`); the renderer cannot
     * reach a boundary like `explore` by asking for it directly.
     */
    create(input?: CreateSessionRequestInput): Promise<SessionSummary> {
      return ipcRenderer.invoke('sessions:create', input);
    },
    async send(
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
            quotes?: QuoteRef[];
            workspaceFileReferences?: Array<Pick<InlineReference, 'value' | 'start'>>;
          },
    ): Promise<
      | {
          ok: true;
          turnId: string;
          attachments: AttachmentRef[];
          inlineReferences: InlineReference[];
          skillInvocation: import('@maka/runtime').SkillInvocationResult;
        }
      | {
          ok: false;
          reason: 'skill_invocation_failed';
          skillInvocation: import('@maka/runtime').SkillInvocationResult;
        }
    > {
      if (command.type === 'send' && 'attachmentItems' in command && command.attachmentItems) {
        const encoded = await encodeIngestItems(command.attachmentItems as RendererIngestInput[]);
        return ipcRenderer.invoke('sessions:send', sessionId, { ...command, attachmentItems: encoded });
      }
      return ipcRenderer.invoke('sessions:send', sessionId, command);
    },
    compact(sessionId: string): Promise<void> {
      return ipcRenderer.invoke('sessions:compact', sessionId);
    },
    resumeLatest(sessionId: string): Promise<
      | { disposition: 'started'; runId: string; turnId: string }
      | { disposition: 'park'; rejectionReasons: string[]; diagnostics: unknown[] }
    > {
      return ipcRenderer.invoke('sessions:resumeLatest', sessionId);
    },
    stop(sessionId: string, input?: { source?: 'stop_button' }): Promise<void> {
      return ipcRenderer.invoke('sessions:stop', sessionId, input);
    },
    steer(sessionId: string, text: string): Promise<QueueEnqueueOutcome> {
      return ipcRenderer.invoke('sessions:steer', sessionId, text);
    },
    readMessages(sessionId: string): Promise<StoredMessage[]> {
      return ipcRenderer.invoke('sessions:readMessages', sessionId);
    },
    readExecutionBoundary(sessionId: string): Promise<ExecutionBoundaryReadModel> {
      return ipcRenderer.invoke('sessions:readExecutionBoundary', sessionId);
    },
    listActiveInteractions(sessionId: string): Promise<ActiveInteractionRequestEvent[]> {
      return ipcRenderer.invoke('sessions:listActiveInteractions', sessionId);
    },
    subscribeActiveInteractions(
      handler: (event: {
        sessionId: string;
        interactions: ActiveInteractionRequestEvent[];
      }) => void,
    ): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { sessionId: string; interactions: ActiveInteractionRequestEvent[] },
      ) => handler(payload);
      ipcRenderer.on('sessions:active-interactions-changed', listener);
      return () => ipcRenderer.off('sessions:active-interactions-changed', listener);
    },
    listTurns(sessionId: string): Promise<TurnRecord[]> {
      return ipcRenderer.invoke('sessions:listTurns', sessionId);
    },
    regenerateTurn(sessionId: string, input: RegenerateTurnInput): Promise<void> {
      return ipcRenderer.invoke('sessions:regenerateTurn', sessionId, input);
    },
    branchFromTurn(sessionId: string, input: DesktopBranchFromTurnInput): Promise<SessionSummary> {
      return ipcRenderer.invoke('sessions:branchFromTurn', sessionId, input);
    },
    reviseBeforeTurn(sessionId: string, input: DesktopReviseBeforeTurnInput): Promise<SessionSummary> {
      return ipcRenderer.invoke('sessions:reviseBeforeTurn', sessionId, input);
    },
    respondToSandboxBoundary(sessionId: string, response: SandboxBoundaryResponse): Promise<void> {
      return ipcRenderer.invoke('sessions:respondToSandboxBoundary', sessionId, response);
    },
    respondToUserQuestion(sessionId: string, response: UserQuestionResponse): Promise<void> {
      return ipcRenderer.invoke('sessions:respondToUserQuestion', sessionId, response);
    },
    /**
     * PR-CMD-PALETTE-SAVE-CONVERSATION-FILE-0: write the renderer-formatted
     * conversation markdown to a user-chosen file. Renderer owns the
     * `renderConversationMarkdown` step (it knows the session name + raw
     * message stream); main owns the save dialog + file write.
     */
    saveConversationToFile(input: {
      markdown: string;
      defaultName: string;
    }): Promise<
      { ok: true; path: string } | { ok: false; reason: 'canceled' | 'write_failed' | 'invalid_input' }
    > {
      return ipcRenderer.invoke('chat:saveConversationToFile', input);
    },
    subscribeEvents(sessionId: string, handler: (event: SessionEvent) => void): () => void {
      const channel = `sessions:event:${sessionId}`;
      const listener = (_event: Electron.IpcRendererEvent, payload: SessionEvent) => handler(payload);
      ipcRenderer.on(channel, listener);
      const observerId = crypto.randomUUID();
      void ipcRenderer.invoke('sessions:observe', sessionId, observerId).catch(() => undefined);
      return () => {
        ipcRenderer.off(channel, listener);
        void ipcRenderer.invoke('sessions:unobserve', observerId).catch(() => undefined);
      };
    },
    subscribeChanges(handler: (event: SessionChangedEvent) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: SessionChangedEvent) => handler(payload);
      ipcRenderer.on('sessions:changed', listener);
      return () => ipcRenderer.off('sessions:changed', listener);
    },
    archive(sessionId: string, options?: { revisionFamily?: boolean }): Promise<void> {
      return ipcRenderer.invoke('sessions:archive', sessionId, options);
    },
    unarchive(sessionId: string, options?: { revisionFamily?: boolean }): Promise<void> {
      return ipcRenderer.invoke('sessions:unarchive', sessionId, options);
    },
    setFlagged(sessionId: string, isFlagged: boolean, options?: { revisionFamily?: boolean }): Promise<void> {
      return ipcRenderer.invoke('sessions:setFlagged', sessionId, isFlagged, options);
    },
    rename(sessionId: string, name: string, options?: { revisionFamily?: boolean }): Promise<void> {
      return ipcRenderer.invoke('sessions:rename', sessionId, name, options);
    },
    setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary> {
      return ipcRenderer.invoke('sessions:setPermissionMode', sessionId, mode);
    },
    setCollaborationMode(sessionId: string, mode: CollaborationMode): Promise<SessionSummary> {
      return ipcRenderer.invoke('sessions:setCollaborationMode', sessionId, mode);
    },
    setOrchestrationMode(sessionId: string, mode: OrchestrationMode): Promise<SessionSummary> {
      return ipcRenderer.invoke('sessions:setOrchestrationMode', sessionId, mode);
    },
    getPlanState(sessionId: string): Promise<PlanSessionState> {
      return ipcRenderer.invoke('plan-mode:getState', sessionId);
    },
    subscribePlanChanges(sessionId: string, handler: () => void): () => void {
      const channel = 'plan-mode:changed';
      const listener = (_event: Electron.IpcRendererEvent, payload: { sessionId: string }) => {
        if (payload.sessionId === sessionId) handler();
      };
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.off(channel, listener);
    },
    requestPlanRevision(sessionId: string, proposalId: string): Promise<PlanSessionState> {
      return ipcRenderer.invoke('plan-mode:requestRevision', sessionId, proposalId);
    },
    abandonPlanProposal(
      sessionId: string,
      proposalId: string,
    ): Promise<PlanSessionState> {
      return ipcRenderer.invoke('plan-mode:abandon', sessionId, proposalId);
    },
    approvePlan(sessionId: string, input: {
      proposalId: string;
      expectedRevision: number;
      expectedStoreVersion: number;
      turnId: string;
    }): Promise<{ turnId: string; executionId: string }> {
      return ipcRenderer.invoke('plan-mode:approve', sessionId, input);
    },
    resumePlan(sessionId: string, executionId: string, turnId: string): Promise<{
      turnId: string;
      executionId: string;
    }> {
      return ipcRenderer.invoke('plan-mode:resume', sessionId, executionId, turnId);
    },
    abandonPlanExecution(sessionId: string, executionId: string): Promise<PlanSessionState> {
      return ipcRenderer.invoke('plan-mode:abandonExecution', sessionId, executionId);
    },
    setModel(sessionId: string, input: { llmConnectionSlug: string; model: string }): Promise<SessionSummary> {
      return ipcRenderer.invoke('sessions:setModel', sessionId, input);
    },
    setThinkingLevel(sessionId: string, level: ThinkingLevel | undefined | null): Promise<SessionSummary> {
      return ipcRenderer.invoke('sessions:setThinkingLevel', sessionId, level ?? undefined);
    },
    remove(sessionId: string, options?: { revisionFamily?: boolean }): Promise<void> {
      return ipcRenderer.invoke('sessions:remove', sessionId, options);
    },
    cleanupSessionCopy(sessionId: string): Promise<void> {
      return ipcRenderer.invoke('sessions:cleanupSessionCopy', sessionId);
    },
    abandonSessionCopy(sessionId: string): Promise<void> {
      return ipcRenderer.invoke('sessions:abandonSessionCopy', sessionId);
    },
  },
  externalSessions: {
    listSources(): Promise<{ adapterIds: string[] }> {
      return ipcRenderer.invoke('external-sessions:listSources');
    },
    list(input: {
      adapterId: string;
      includeArchived?: boolean;
      cwd?: string;
      cursor?: string;
    }): Promise<{ sessions: ExternalSessionSummary[]; nextCursor: string | null }> {
      return ipcRenderer.invoke('external-sessions:list', input);
    },
    import(input: {
      adapterId: string;
      sourceSessionId: string;
    }): Promise<ExternalSessionImportIpcResult> {
      return ipcRenderer.invoke('external-sessions:import', input);
    },
  },
  projects: {
    list(): Promise<ProjectRecord[]> {
      return ipcRenderer.invoke('projects:list');
    },
    subscribeChanges(handler: () => void): () => void {
      const listener = () => handler();
      ipcRenderer.on('projects:changed', listener);
      return () => ipcRenderer.off('projects:changed', listener);
    },
    add(): Promise<
      { ok: true; project: ProjectRecord; path: string } | { ok: false; reason: 'cancelled' }
    > {
      return ipcRenderer.invoke('projects:add');
    },
    select(
      projectId: string | null,
    ): Promise<{ project: ProjectRecord | null; path: string }> {
      return ipcRenderer.invoke('projects:select', projectId);
    },
    relink(projectId: string): Promise<
      { ok: true; project: ProjectRecord } | { ok: false; reason: 'cancelled' }
    > {
      return ipcRenderer.invoke('projects:relink', projectId);
    },
    reveal(projectId: string): Promise<
      | { ok: true; opened: string }
      | {
          ok: false;
          reason: 'unknown-key' | 'not-allowed' | 'missing' | 'not-a-directory' | 'open-failed';
        }
    > {
      return ipcRenderer.invoke('projects:reveal', projectId);
    },
    rename(projectId: string, name: string): Promise<ProjectRecord> {
      return ipcRenderer.invoke('projects:rename', projectId, name);
    },
    archive(projectId: string): Promise<ProjectRecord> {
      return ipcRenderer.invoke('projects:archive', projectId);
    },
    restore(projectId: string): Promise<ProjectRecord> {
      return ipcRenderer.invoke('projects:restore', projectId);
    },
  },
  shellRuns: {
    list(sessionId: string): Promise<ShellRunUpdate[]> {
      return ipcRenderer.invoke('shell-runs:list', sessionId);
    },
    attach(input: {
      sessionId: string;
      ref: string;
    }): Promise<ShellRunPtySnapshot | null> {
      return ipcRenderer.invoke('shell-runs:attach', input);
    },
    detach(input: { sessionId: string; ref: string }): Promise<void> {
      return ipcRenderer.invoke('shell-runs:detach', input);
    },
    start(sessionId: string): Promise<ShellRunUpdate> {
      return ipcRenderer.invoke('shell-runs:start', sessionId);
    },
    write(input: {
      sessionId: string;
      ref: string;
      input?: string;
      size?: { cols: number; rows: number };
    }): Promise<ShellRunUpdate | null> {
      return ipcRenderer.invoke('shell-runs:write', input);
    },
    stop(input: {
      sessionId: string;
      ref: string;
    }): Promise<ShellRunUpdate | null> {
      return ipcRenderer.invoke('shell-runs:stop', input);
    },
    subscribeUpdates(handler: (update: ShellRunUpdate) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, update: ShellRunUpdate) => handler(update);
      ipcRenderer.on('shell-runs:update', listener);
      return () => ipcRenderer.off('shell-runs:update', listener);
    },
    subscribePtyData(handler: (event: ShellRunPtyDataEvent) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: ShellRunPtyDataEvent) =>
        handler(payload);
      ipcRenderer.on('shell-runs:pty-data', listener);
      return () => ipcRenderer.off('shell-runs:pty-data', listener);
    },
    subscribeResync(handler: (event: { sessionId: string }) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: { sessionId: string }) =>
        handler(payload);
      ipcRenderer.on('shell-runs:resync', listener);
      return () => ipcRenderer.off('shell-runs:resync', listener);
    },
  },
  gitReview: {
    read(input: {
      sessionId: string;
      source: GitReviewSource;
      baseBranch?: string;
    }): Promise<GitReviewReadResult> {
      return ipcRenderer.invoke('git-review:read', input);
    },
    mutate(input: {
      sessionId: string;
      source: Extract<GitReviewSource, 'unstaged' | 'staged'>;
      revision: string;
      path: string;
      action: GitReviewMutationAction;
    }): Promise<GitReviewMutationResult> {
      return ipcRenderer.invoke('git-review:mutate', input);
    },
  },
  goal: {
    get(sessionId: string): Promise<GoalState | null> {
      return ipcRenderer.invoke('goal:get', sessionId);
    },
    clear(sessionId: string): Promise<void> {
      return ipcRenderer.invoke('goal:clear', sessionId);
    },
  },
  connections: {
    list(): Promise<LlmConnection[]> {
      return ipcRenderer.invoke('connections:list');
    },
    getDefault(): Promise<string | null> {
      return ipcRenderer.invoke('connections:getDefault');
    },
    setDefault(slug: string | null): Promise<void> {
      return ipcRenderer.invoke('connections:setDefault', slug);
    },
    setDefaultModel(input: { slug: string; model: string } | null): Promise<void> {
      return ipcRenderer.invoke('connections:setDefaultModel', input);
    },
    create(input: CreateConnectionInput): Promise<LlmConnection> {
      return ipcRenderer.invoke('connections:create', input);
    },
    update(slug: string, patch: UpdateConnectionInput): Promise<LlmConnection> {
      return ipcRenderer.invoke('connections:update', slug, patch);
    },
    delete(slug: string): Promise<void> {
      return ipcRenderer.invoke('connections:delete', slug);
    },
    test(slug: string, opts?: { model?: string }): Promise<ConnectionTestResult> {
      return ipcRenderer.invoke('connections:test', slug, opts);
    },
    fetchModels(slug: string): Promise<ModelDiscoveryResult> {
      return ipcRenderer.invoke('connections:fetchModels', slug);
    },
    hasSecret(slug: string): Promise<boolean> {
      return ipcRenderer.invoke('connections:hasSecret', slug);
    },
    getRequestHeaders(slug: string): Promise<import('@maka/core').SavedRequestHeaders> {
      return ipcRenderer.invoke('connections:getRequestHeaders', slug);
    },
    setRequestHeaders(
      slug: string,
      headers: readonly import('@maka/core').RequestHeaderUpdate[],
    ): Promise<import('@maka/core').SavedRequestHeaders> {
      return ipcRenderer.invoke('connections:setRequestHeaders', slug, headers);
    },
    subscribeEvents(handler: (event: ConnectionEvent) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: ConnectionEvent) => handler(payload);
      ipcRenderer.on('connections:event', listener);
      return () => ipcRenderer.off('connections:event', listener);
    },
  },
  mcp: {
    getConfig(): Promise<McpConfigFile> {
      return ipcRenderer.invoke('mcp:getConfig');
    },
    listStatuses(): Promise<McpServerStatus[]> {
      return ipcRenderer.invoke('mcp:listStatuses');
    },
    setConfig(config: McpConfigFile): Promise<McpConfigFile> {
      return ipcRenderer.invoke('mcp:setConfig', config);
    },
    upsert(serverId: string, config: McpServerConfig): Promise<McpConfigFile> {
      return ipcRenderer.invoke('mcp:upsert', serverId, config);
    },
    install(serverId: string, config: McpServerConfig): Promise<McpConfigFile> {
      return ipcRenderer.invoke('mcp:install', serverId, config);
    },
    remove(serverId: string): Promise<McpConfigFile> {
      return ipcRenderer.invoke('mcp:remove', serverId);
    },
    cancelInstall(serverId: string): Promise<McpConfigFile> {
      return ipcRenderer.invoke('mcp:cancelInstall', serverId);
    },
    test(serverId: string): Promise<McpTestResult> {
      return ipcRenderer.invoke('mcp:test', serverId);
    },
    reconnect(serverId: string): Promise<McpServerStatus> {
      return ipcRenderer.invoke('mcp:reconnect', serverId);
    },
    subscribeChanges(handler: (statuses: McpServerStatus[]) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: McpServerStatus[]) => handler(payload);
      ipcRenderer.on('mcp:changed', listener);
      return () => ipcRenderer.off('mcp:changed', listener);
    },
  },
  // PR110b: onboarding snapshot + milestone IPCs. Renderer polls
  // `getSnapshot()` on app load and re-polls when
  // `sessions:changed` / `connections:changed` / settings change
  // events fire. There is no push event for OnboardingState — it is
  // a derived projection and refresh latency is acceptable.
  onboarding: {
    getSnapshot(): Promise<OnboardingSnapshot> {
      return ipcRenderer.invoke('onboarding:getSnapshot');
    },
    setMilestone(
      id: OnboardingMilestoneId,
      status: 'completed' | 'skipped',
    ): Promise<OnboardingSnapshot> {
      return ipcRenderer.invoke('onboarding:setMilestone', id, status);
    },
    clearMilestone(id: OnboardingMilestoneId): Promise<OnboardingSnapshot> {
      return ipcRenderer.invoke('onboarding:clearMilestone', id);
    },
  },
  taskReadiness: {
    getSnapshot(input?: DesktopTaskSubmissionReadinessRequest) {
      return ipcRenderer.invoke('taskReadiness:getSnapshot', input);
    },
  },
  permissions: {
    getSnapshot(): Promise<PermissionSnapshot> {
      return ipcRenderer.invoke('permissions:getSnapshot');
    },
    openSystemSettings(permId: string): Promise<PermissionActionResult> {
      return ipcRenderer.invoke('permissions:openSystemSettings', permId);
    },
    requestAccess(permId: string): Promise<PermissionActionResult> {
      return ipcRenderer.invoke('permissions:requestAccess', permId);
    },
    startDragOnboarding(permId: string): Promise<PermissionOverlayStartResult> {
      return ipcRenderer.invoke('permissions:startDragOnboarding', permId);
    },
  },
  capabilities: {
    getSnapshot(): Promise<CapabilitySnapshotCollection> {
      return ipcRenderer.invoke('capabilities:getSnapshot');
    },
  },
  health: {
    getSnapshot(): Promise<HealthSnapshot> {
      return ipcRenderer.invoke('health:getSnapshot');
    },
  },
  memory: {
    getState(): Promise<LocalMemoryState> {
      return ipcRenderer.invoke('memory:getState');
    },
    listProposals(): Promise<ReadonlyArray<LocalMemoryEntryPreview>> {
      return ipcRenderer.invoke('memory:listProposals');
    },
    propose(input: { title: string; content: string; scope?: 'workspace' | 'session'; sessionId?: string }): Promise<LocalMemoryMutationResult> {
      return ipcRenderer.invoke('memory:propose', input);
    },
    remember(input: { title: string; content: string; scope?: 'workspace' | 'session'; sessionId?: string }): Promise<LocalMemoryMutationResult> {
      return ipcRenderer.invoke('memory:remember', input);
    },
    approveProposal(proposalId: string): Promise<LocalMemoryMutationResult> {
      return ipcRenderer.invoke('memory:approveProposal', proposalId);
    },
    rejectProposal(proposalId: string): Promise<LocalMemoryMutationResult> {
      return ipcRenderer.invoke('memory:rejectProposal', proposalId);
    },
    archiveEntry(entryId: string, reason?: string): Promise<LocalMemoryMutationResult> {
      return ipcRenderer.invoke('memory:archiveEntry', entryId, reason);
    },
    restoreEntry(entryId: string): Promise<LocalMemoryMutationResult> {
      return ipcRenderer.invoke('memory:restoreEntry', entryId);
    },
    save(content: string): Promise<LocalMemoryState> {
      return ipcRenderer.invoke('memory:save', content);
    },
    reset(): Promise<LocalMemoryState> {
      return ipcRenderer.invoke('memory:reset');
    },
    restoreLatestBackup(): Promise<{ ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }> {
      return ipcRenderer.invoke('memory:restoreLatestBackup');
    },
    restoreBackup(kind: 'save' | 'reset' | 'restore'): Promise<{ ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }> {
      return ipcRenderer.invoke('memory:restoreBackup', kind);
    },
    setEnabled(enabled: boolean): Promise<LocalMemoryState> {
      return ipcRenderer.invoke('memory:setEnabled', enabled);
    },
    setAgentReadEnabled(enabled: boolean): Promise<LocalMemoryState> {
      return ipcRenderer.invoke('memory:setAgentReadEnabled', enabled);
    },
    openFile(): Promise<{ ok: true } | { ok: false; message: string }> {
      return ipcRenderer.invoke('memory:openFile');
    },
    openLatestBackup(): Promise<{ ok: true } | { ok: false; message: string }> {
      return ipcRenderer.invoke('memory:openLatestBackup');
    },
    openBackup(kind: 'save' | 'reset' | 'restore'): Promise<{ ok: true } | { ok: false; message: string }> {
      return ipcRenderer.invoke('memory:openBackup', kind);
    },
  },
  attachments: {
    pickFiles(): Promise<
      | { ok: true; files: { approvalId: string; name: string; mimeType?: string; size: number }[] }
      | { ok: false; reason: 'cancelled' }
    > {
      return ipcRenderer.invoke('attachments:pickFiles');
    },
    // Staged-attachment thumbnail for the composer drawer. Peeks the approval
    // (never consumes it) so the token stays redeemable for the actual send.
    previewApproval(approvalId: string): Promise<
      | { ok: true; base64: string; mimeType: string }
      | { ok: false; reason: string }
    > {
      return ipcRenderer.invoke('attachments:previewApproval', approvalId);
    },
    readBytes(sessionId: string, relativePath: string): Promise<
      | { ok: true; base64: string; mimeType: string }
      | { ok: false; reason: string }
    > {
      return ipcRenderer.invoke('attachments:readBytes', sessionId, relativePath);
    },
  },
  search: {
    // PR-SEARCH-2: local thread search. Renderer sends a `SearchRequest`
    // (source must be 'thread'); main responds with `SearchResult[]` or
    // an error envelope. The query body never leaves the device — the
    // helper is local-only and the IPC handler never emits the query
    // into telemetry.
    thread(request: SearchRequest): Promise<SearchResult[] | { ok: false; reason: SearchErrorReason; message: string }> {
      return ipcRenderer.invoke('search:thread', request);
    },
  },
  // PR-OAUTH-SUBSCRIPTION-0: Claude subscription OAuth bridge.
  // NEVER returns raw OAuth credentials; renderer only sees account
  // state + quota + action results (xuan G-X3 + the
  // claude-subscription-ipc-boundary contract test enforces this).
  //
  // kenji `1da909d5`/`45b31e16` hardening: `openAuthUrl` takes
  // ONLY an `authRequestId`; the URL is held by main from the
  // earlier `getAuthUrl` call. Renderer can never hand
  // `shell.openExternal` an arbitrary URL.
  //
  // Whole feature is gated behind `MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL=1`
  // until product/legal sign-off. `isExperimentalEnabled()` lets the
  // Settings UI hide the card; even without that hide, all auth-flow
  // handlers re-check the flag main-side (fail-closed via the
  // `experimental_disabled` reason).
  claudeSubscription: {
    isExperimentalEnabled(): Promise<boolean> {
      return ipcRenderer.invoke('claude-subscription:is-experimental-enabled');
    },
    getAuthUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
      return ipcRenderer.invoke('claude-subscription:get-auth-url');
    },
    openAuthUrl(authRequestId: string): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('claude-subscription:open-auth-url', authRequestId);
    },
    completeAuthorization(authRequestId: string, pasted: string): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('claude-subscription:complete-authorization', authRequestId, pasted);
    },
    cancelAuthorization(authRequestId?: string): Promise<{ ok: true }> {
      return ipcRenderer.invoke('claude-subscription:cancel-authorization', authRequestId);
    },
    getAccountState(): Promise<SubscriptionAccountState> {
      return ipcRenderer.invoke('claude-subscription:get-account-state');
    },
    refreshQuota(): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('claude-subscription:refresh-quota');
    },
    refreshTokens(): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('claude-subscription:refresh-tokens');
    },
    logout(): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('claude-subscription:logout');
    },
  },
  // PR-MODEL-OAUTH-ALL-0: Codex / Antigravity subscription
  // bridges. Same shape as `claudeSubscription` (no token-shaped
  // fields, opaque authRequestId, action-result envelopes). Each
  // service's state snapshot is provider-specific because the
  // upstream auth claims differ (Codex carries JWT account_id /
  // plan; Antigravity is preview-only).
  openAiCodex: {
    isExperimentalEnabled(): Promise<boolean> {
      return ipcRenderer.invoke('openai-codex:is-experimental-enabled');
    },
    getAuthUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
      return ipcRenderer.invoke('openai-codex:get-auth-url');
    },
    openAuthUrl(authRequestId: string): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('openai-codex:open-auth-url', authRequestId);
    },
    completeAuthorization(authRequestId: string): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('openai-codex:complete-authorization', authRequestId);
    },
    cancelAuthorization(authRequestId?: string): Promise<{ ok: true }> {
      return ipcRenderer.invoke('openai-codex:cancel-authorization', authRequestId);
    },
    getAccountState(): Promise<{
      provider: 'openai-codex';
      runtimeState: 'not_logged_in' | 'authorizing' | 'authenticated' | 'refreshing' | 'refresh_failed';
      accountId?: string;
      email?: string;
      plan?: string;
      picture?: string;
      errorMessage?: string;
    }> {
      return ipcRenderer.invoke('openai-codex:get-account-state');
    },
    refreshTokens(): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('openai-codex:refresh-tokens');
    },
    logout(): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('openai-codex:logout');
    },
  },
  xaiOAuth: {
    getAuthUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
      return ipcRenderer.invoke('xai-oauth:get-auth-url');
    },
    openAuthUrl(authRequestId: string): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('xai-oauth:open-auth-url', authRequestId);
    },
    completeAuthorization(authRequestId: string): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('xai-oauth:complete-authorization', authRequestId);
    },
    cancelAuthorization(authRequestId?: string): Promise<{ ok: true }> {
      return ipcRenderer.invoke('xai-oauth:cancel-authorization', authRequestId);
    },
    getAccountState(): Promise<{
      provider: 'xai-oauth';
      runtimeState:
        | 'not_logged_in'
        | 'authorizing'
        | 'authenticated'
        | 'refreshing'
        | 'refresh_failed'
        | 'storage_failed';
      errorMessage?: string;
    }> {
      return ipcRenderer.invoke('xai-oauth:get-account-state');
    },
    refreshTokens(): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('xai-oauth:refresh-tokens');
    },
    logout(): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('xai-oauth:logout');
    },
  },
  githubCopilotSubscription: {
    connectExistingLogin(): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('github-copilot:connect-existing-login');
    },
    getAccountState(): Promise<{
      provider: 'github-copilot';
      runtimeState: 'not_logged_in' | 'authenticated' | 'refreshing' | 'refresh_failed' | 'storage_failed';
      errorMessage?: string;
    }> {
      return ipcRenderer.invoke('github-copilot:get-account-state');
    },
    refreshTokens(): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('github-copilot:refresh-tokens');
    },
    logout(): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('github-copilot:logout');
    },
  },
  antigravitySubscription: {
    isExperimentalEnabled(): Promise<boolean> {
      return ipcRenderer.invoke('antigravity-subscription:is-experimental-enabled');
    },
    getAuthUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
      return ipcRenderer.invoke('antigravity-subscription:get-auth-url');
    },
    openAuthUrl(authRequestId: string): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('antigravity-subscription:open-auth-url', authRequestId);
    },
    completeAuthorization(authRequestId: string): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('antigravity-subscription:complete-authorization', authRequestId);
    },
    cancelAuthorization(authRequestId?: string): Promise<{ ok: true }> {
      return ipcRenderer.invoke('antigravity-subscription:cancel-authorization', authRequestId);
    },
    getAccountState(): Promise<{
      provider: 'antigravity-subscription';
      status: 'preview';
      runtimeState: 'not_logged_in' | 'authorizing' | 'authenticated' | 'refreshing' | 'refresh_failed';
      errorMessage?: string;
    }> {
      return ipcRenderer.invoke('antigravity-subscription:get-account-state');
    },
    refreshTokens(): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('antigravity-subscription:refresh-tokens');
    },
    logout(): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('antigravity-subscription:logout');
    },
  },
  plans: {
    list(): Promise<PlanReminder[]> {
      return ipcRenderer.invoke('plans:list');
    },
    create(input: { title: string; note?: string; runAt: number | string; recurrence?: PlanReminderRecurrence; cronExpression?: string; delivery?: PlanReminderDeliveryTarget }): Promise<PlanReminder> {
      return ipcRenderer.invoke('plans:create', input);
    },
    update(id: string, patch: { title?: string; note?: string; runAt?: number | string; recurrence?: PlanReminderRecurrence; cronExpression?: string; delivery?: PlanReminderDeliveryTarget; enabled?: boolean }): Promise<PlanReminder> {
      return ipcRenderer.invoke('plans:update', id, patch);
    },
    setEnabled(id: string, enabled: boolean): Promise<PlanReminder> {
      return ipcRenderer.invoke('plans:setEnabled', id, enabled);
    },
    triggerNow(id: string): Promise<PlanReminder> {
      return ipcRenderer.invoke('plans:triggerNow', id);
    },
    snooze(id: string): Promise<PlanReminder> {
      return ipcRenderer.invoke('plans:snooze', id);
    },
    clearRunHistory(id: string): Promise<PlanReminder> {
      return ipcRenderer.invoke('plans:clearRunHistory', id);
    },
    delete(id: string): Promise<void> {
      return ipcRenderer.invoke('plans:delete', id);
    },
    subscribeChanges(handler: (event: { type: 'plans_changed'; reason: string; reminderId?: string; ts: number }) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: { type: 'plans_changed'; reason: string; reminderId?: string; ts: number }) => handler(payload);
      ipcRenderer.on('plans:changed', listener);
      return () => ipcRenderer.off('plans:changed', listener);
    },
    subscribeDue(handler: (reminder: PlanReminder) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: PlanReminder) => handler(payload);
      ipcRenderer.on('plans:due', listener);
      return () => ipcRenderer.off('plans:due', listener);
    },
  },
  settings: {
    get(): Promise<AppSettings> {
      return ipcRenderer.invoke('settings:get');
    },
    update(patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsResult> {
      return ipcRenderer.invoke('settings:update', patch);
    },
    subscribeExternalChanged(handler: () => void): () => void {
      const listener = () => handler();
      ipcRenderer.on('settings:externalChanged', listener);
      return () => ipcRenderer.off('settings:externalChanged', listener);
    },
    testNetworkProxy(input?: TestProxyInput): Promise<SettingsTestResult> {
      return ipcRenderer.invoke('settings:testNetworkProxy', input);
    },
    testBotChannel(provider: BotProvider): Promise<SettingsTestResult> {
      return ipcRenderer.invoke('settings:testBotChannel', provider);
    },
    usageStats(range?: UsageRange): Promise<UsageStats> {
      return ipcRenderer.invoke('settings:usageStats', range);
    },
    bots: {
      listStatuses(): Promise<Record<BotProvider, BotStatus>> {
        return ipcRenderer.invoke('settings:bots:listStatuses');
      },
      restart(provider: BotProvider): Promise<BotStatus> {
        return ipcRenderer.invoke('settings:bots:restart', provider);
      },
      wechatQrCode(): Promise<WechatBridgeQrCodeResult> {
        return ipcRenderer.invoke('settings:bots:wechatQrCode');
      },
      subscribeStatusChanges(handler: (status: BotStatus) => void): () => void {
        const listener = (_event: Electron.IpcRendererEvent, payload: BotStatus) => handler(payload);
        ipcRenderer.on('settings:bots:statusChanged', listener);
        return () => ipcRenderer.off('settings:bots:statusChanged', listener);
      },
      onboarding: {
        start(input: BotOnboardingStartInput): Promise<Result<BotOnboardingSnapshot>> {
          return ipcRenderer.invoke('settings:bots:onboarding:start', input);
        },
        poll(sessionId: string): Promise<Result<BotOnboardingSnapshot>> {
          return ipcRenderer.invoke('settings:bots:onboarding:poll', sessionId);
        },
        cancel(sessionId: string): Promise<Result<BotOnboardingSnapshot>> {
          return ipcRenderer.invoke('settings:bots:onboarding:cancel', sessionId);
        },
        openInBrowser(sessionId: string): Promise<Result<void>> {
          return ipcRenderer.invoke('settings:bots:onboarding:open', sessionId);
        },
      },
    },
  },
  notifications: {
    // Fire-and-forget signal that an agent turn reached a terminal
    // state. `title` is the session name, `body` the start of the reply
    // (or the error message); main sanitizes both and falls back to
    // generic copy when blank. Main gates on the product toggle + window
    // focus before raising a native OS notification.
    runEnded(payload: {
      kind: 'completed' | 'errored';
      title?: string;
      body?: string;
    }): Promise<void> {
      return ipcRenderer.invoke('notifications:runEnded', payload);
    },
  },
  inspector: {
    /** Read-only per-session causal trace (#1625). Never writes runtime state. */
    trace(sessionId: string): Promise<Result<SessionTrace>> {
      return ipcRenderer.invoke('inspector:trace', sessionId);
    },
  },
  dailyReview: {
    day(offsetDays: number, daySpan?: number): Promise<Result<DailyReviewSummary>> {
      return ipcRenderer.invoke('daily-review:day', { offsetDays, daySpan });
    },
    getConfig(): Promise<DailyReviewConfig> {
      return ipcRenderer.invoke('daily-review:getConfig');
    },
    setConfig(patch: Partial<DailyReviewConfig>): Promise<DailyReviewConfig> {
      return ipcRenderer.invoke('daily-review:setConfig', patch);
    },
    runOnce(input: { range: DailyReviewRange; offsetDays?: number; modelKey?: string }): Promise<{ archiveId: string }> {
      return ipcRenderer.invoke('daily-review:runOnce', input);
    },
    listArchives(): Promise<DailyReviewArchiveSummary[]> {
      return ipcRenderer.invoke('daily-review:list');
    },
    getArchive(archiveId: string): Promise<DailyReviewArchive | null> {
      return ipcRenderer.invoke('daily-review:get', archiveId);
    },
    /**
     * PR-DAILY-REVIEW-EXPORT-FILE-0: render the markdown in the renderer
     * (where the human-readable title context lives) and ship the bytes
     * to main for the save dialog + write. Main never sees the raw
     * telemetry; only the formatted output.
     */
    saveMarkdownToFile(input: {
      markdown: string;
      defaultName: string;
    }): Promise<
      { ok: true; path: string } | { ok: false; reason: 'canceled' | 'write_failed' | 'invalid_input' }
    > {
      return ipcRenderer.invoke('daily-review:saveMarkdownToFile', input);
    },
  },
  webSearch: {
    query(input: {
      query: string;
      limit?: number;
      provider?: WebSearchProvider;
      apiKey?: string;
    }): Promise<WebSearchResponse> {
      return ipcRenderer.invoke('web-search:query', input);
    },
    test(input: { provider?: WebSearchProvider; apiKey?: string }): Promise<WebSearchResponse> {
      return ipcRenderer.invoke('web-search:test', input);
    },
  },
  appWindow: {
    setTitlebarControlsVisible(visible: boolean): Promise<void> {
      return ipcRenderer.invoke('window:setTitlebarControlsVisible', visible);
    },
    setThemeSource(themePref: ThemePreference): Promise<void> {
      return ipcRenderer.invoke('window:setThemeSource', themePref);
    },
    // PR-WINDOW-TITLEBAR-0: re-sync the native Windows titleBarOverlay
    // color/symbolColor to the resolved app surface. No-op on non-Windows.
    setTitleBarOverlayTheme(theme: { isDark: boolean; backgroundColor: string }): Promise<void> {
      return ipcRenderer.invoke('window:setTitleBarOverlayTheme', theme);
    },
    // PR-SHOW-AFTER-FIRST-COMMIT: tell main the renderer finished its first
    // React commit so the hidden window can be revealed. Fire-and-forget.
    notifyRendererReady(): Promise<void> {
      return ipcRenderer.invoke('window:notifyRendererReady');
    },
    // PR-2088: main-to-renderer route for native-menu commands (New Task /
    // Settings / Keyboard Shortcuts). The `ipcRenderer.on`/`off` idiom keeps
    // an HMR or shell remount from stacking duplicate listeners.
    subscribeCommand(handler: (command: WindowCommand) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, command: WindowCommand) => handler(command);
      ipcRenderer.on('window:command', listener);
      return () => ipcRenderer.off('window:command', listener);
    },
  },
  config: {
    export(input: { categories: ConfigCategory[] }): Promise<
      | { ok: false; reason: 'no_categories' | 'canceled' }
      | { ok: true; path: string; includedData: ConfigCategory[] }
    > {
      return ipcRenderer.invoke('config:export', input);
    },
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
    > {
      return ipcRenderer.invoke('config:import', input);
    },
  },
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
      homePath: string;
      operationalStateDatabasePath: string;
      projectId?: string | null;
      projectPath: string;
      projectGit: { isGitRepo: boolean; branch?: string };
      buildMode: 'dev' | 'packaged';
      buildCommit: string | null;
    }> {
      return ipcRenderer.invoke('app:info');
    },
    subscribeUpdateStatus(handler: (status: AppUpdateStatus) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, status: AppUpdateStatus) => handler(status);
      ipcRenderer.on('app:updateStatusChanged', listener);
      return () => ipcRenderer.off('app:updateStatusChanged', listener);
    },
    updateStatus(): Promise<AppUpdateStatus> {
      return ipcRenderer.invoke('app:updateStatus');
    },
    checkForUpdates(): Promise<AppUpdateStatus> {
      return ipcRenderer.invoke('app:checkForUpdates');
    },
    retryUpdateDownload(): Promise<AppUpdateStatus> {
      return ipcRenderer.invoke('app:retryUpdateDownload');
    },
    installUpdate(input: AppUpdateInstallRequest): Promise<AppUpdateInstallResult> {
      return ipcRenderer.invoke('app:installUpdate', input);
    },
    sessionProjectInfo(sessionId: string): Promise<{
      projectPath: string;
      projectGit: { isGitRepo: boolean; branch?: string };
    }> {
      return ipcRenderer.invoke('app:sessionProjectInfo', sessionId);
    },
    openPath(
      key: 'workspace' | 'skills' | 'memory' | 'project',
      sessionId?: string,
    ): Promise<
      | { ok: true; opened: string }
      | {
          ok: false;
          reason: 'unknown-key' | 'not-allowed' | 'missing' | 'not-a-directory' | 'open-failed';
        }
    > {
      return ipcRenderer.invoke('app:openPath', key, sessionId);
    },
    resolveProjectGitInfo(projectPath: string): Promise<
      | { ok: true; projectPath: string; projectGit: { isGitRepo: boolean; branch?: string } }
      | { ok: false; reason: 'invalid-path' | 'not-found' }
    > {
      return ipcRenderer.invoke('app:resolveProjectGitInfo', projectPath);
    },
    openArtifactPath(
      sessionId: string,
      artifactId: string,
    ): Promise<
      | { ok: true; opened: string }
      | {
          ok: false;
          reason: 'unknown-key' | 'not-allowed' | 'missing' | 'not-a-directory' | 'open-failed';
        }
    > {
      return ipcRenderer.invoke('app:openArtifactPath', sessionId, artifactId);
    },
    saveArtifactAs(sessionId: string, artifactId: string): Promise<ArtifactSaveResult> {
      return ipcRenderer.invoke('app:saveArtifactAs', sessionId, artifactId);
    },
  },
  diagnostics: {
    copyErrorReport(input: DesktopErrorDiagnosticInput): Promise<DesktopDiagnosticCopyResult> {
      return ipcRenderer.invoke('diagnostics:copyErrorReport', input);
    },
  },
  workspace: {
    /** Composer `@` mention popup: list workspace files matching `query`. */
    searchFiles(
      query: string,
      options?: { sessionId?: string; limit?: number },
    ): Promise<
      | { ok: true; files: Array<{ relativePath: string }> }
      | { ok: false; reason: 'no_project' | 'search_failed' }
    > {
      return ipcRenderer.invoke('workspace:searchFiles', { query, ...options });
    },
  },
  e2eFixture: {
    getState(): Promise<E2eFixtureState | null> {
      return ipcRenderer.invoke('e2eFixture:getState');
    },
  },
  artifacts: {
    list(sessionId: string, opts?: { includeDeleted?: boolean }): Promise<ArtifactDescriptor[]> {
      return ipcRenderer.invoke('artifacts:list', sessionId, opts);
    },
    get(sessionId: string, artifactId: string): Promise<ArtifactDescriptor | null> {
      return ipcRenderer.invoke('artifacts:get', sessionId, artifactId);
    },
    readText(sessionId: string, artifactId: string): Promise<ArtifactTextReadResult> {
      return ipcRenderer.invoke('artifacts:readText', sessionId, artifactId);
    },
    readBinary(sessionId: string, artifactId: string): Promise<ArtifactBinaryReadResult> {
      return ipcRenderer.invoke('artifacts:readBinary', sessionId, artifactId);
    },
    delete(sessionId: string, artifactId: string): Promise<void> {
      return ipcRenderer.invoke('artifacts:delete', sessionId, artifactId);
    },
    subscribeChanges(handler: (event: ArtifactChangedEvent) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: ArtifactChangedEvent) => handler(payload);
      ipcRenderer.on('artifacts:changed', listener);
      return () => ipcRenderer.off('artifacts:changed', listener);
    },
  },
  skills: {
    list(): Promise<SkillEntry[]> {
      return ipcRenderer.invoke('skills:list');
    },
    listInvocable(
      sessionId?: string,
      newSessionContext?: {
        llmConnectionSlug?: string;
        model?: string;
        collaborationMode?: 'agent' | 'plan';
      },
    ): Promise<import('@maka/runtime').InvocableSkillEntry[]> {
      return ipcRenderer.invoke('skills:listInvocable', sessionId, newSessionContext);
    },
    catalog: {
      list(): Promise<BundledSkillCatalogEntry[]> {
        return ipcRenderer.invoke('skills:catalog:list');
      },
      install(id: string): Promise<
        | { ok: true; skill: SkillEntry }
        | { ok: false; reason: 'not_found' | 'already_exists' | 'blocked_path' | 'write_failed' }
      > {
        return ipcRenderer.invoke('skills:catalog:install', id);
      },
    },
    sources: {
      list(): Promise<ManagedSkillSourceEntry[]> {
        return ipcRenderer.invoke('skills:sources:list');
      },
      importLocalFile(): Promise<
        | { ok: true; source: ManagedSkillSourceEntry }
        | { ok: false; reason: 'cancelled' | 'invalid_skill' | 'already_exists' | 'blocked_path' | 'write_failed' }
      > {
        return ipcRenderer.invoke('skills:sources:importLocalFile');
      },
    },
    installManaged(sourceId: string): Promise<
      | { ok: true; skill: SkillEntry }
      | { ok: false; reason: 'not_found' | 'already_exists' | 'blocked_path' | 'write_failed' }
    > {
      return ipcRenderer.invoke('skills:installManaged', sourceId);
    },
    details(skillId: string): Promise<
      | { ok: true; details: SkillGovernanceDetails }
      | { ok: false; reason: 'not_found' | 'invalid_id' }
    > {
      return ipcRenderer.invoke('skills:details', skillId);
    },
    previewUpdate(skillId: string): Promise<
      | { ok: true; preview: ManagedSkillUpdatePreview }
      | { ok: false; reason: 'not_managed' | 'source_missing' | 'metadata_error' | 'blocked_path' | 'read_failed' }
    > {
      return ipcRenderer.invoke('skills:previewUpdate', skillId);
    },
    updateManaged(skillId: string, options?: { force?: boolean; expectedCurrentSha256?: string; expectedSourceSha256?: string }): Promise<
      | { ok: true; skill: SkillEntry }
      | { ok: false; reason: 'not_managed' | 'source_missing' | 'local_modified' | 'metadata_error' | 'blocked_path' | 'write_failed' }
    > {
      return ipcRenderer.invoke('skills:updateManaged', skillId, options);
    },
    setEnabled(skillId: string, enabled: boolean): Promise<
      | { ok: true; skill: SkillEntry }
      | { ok: false; reason: 'not_found' | 'blocked_path' | 'state_error' | 'write_failed' }
    > {
      return ipcRenderer.invoke('skills:setEnabled', skillId, enabled);
    },
    setPinned(skillRef: string, pinned: boolean): Promise<
      | { ok: true; skill: SkillEntry }
      | { ok: false; reason: 'not_found' | 'blocked_path' | 'state_error' | 'write_failed' }
    > {
      return ipcRenderer.invoke('skills:setPinned', skillRef, pinned);
    },
    createStarter(): Promise<
      | { ok: true; created: boolean; skill: SkillEntry; filePath: string }
      | { ok: false; reason: 'blocked_path' | 'already_exists' | 'write_failed' }
    > {
      return ipcRenderer.invoke('skills:createStarter');
    },
    delete(idOrRef: string): Promise<
      | { ok: true }
      | { ok: false; reason: 'not_found' | 'blocked_path' | 'blocked_scope' | 'delete_failed' }
    > {
      return ipcRenderer.invoke('skills:delete', idOrRef);
    },
    open(id: string, target: 'file' | 'directory' = 'file'): Promise<
      | { ok: true; target: 'file' | 'directory' }
      | { ok: false; reason: 'invalid_id' | 'missing' | 'blocked_path' | 'not_file' | 'not_directory' | 'open_failed' }
    > {
      return ipcRenderer.invoke('skills:open', id, target);
    },
  },
  // Embedded browser (P3). The native WebContentsView floats above the DOM; the
  // renderer panel only mirrors its strip's rect and drives navigation. No
  // automation endpoint/secret is ever exposed here — that stays main-internal.
  browser: {
    /** Tell main which conversation this window shows, so it can validate targets. */
    setActiveSession(sessionId: string | null): void {
      ipcRenderer.send('browser:active-session', sessionId);
    },
    /** Mirror the panel strip's on-screen rect (null hides the native view). */
    setViewport(input: { sessionId: string; rect: BrowserViewRect | null }): void {
      ipcRenderer.send('browser:setViewport', input);
    },
    navigate(sessionId: string, url: string): Promise<void> {
      return ipcRenderer.invoke('browser:navigate', sessionId, url);
    },
    back(sessionId: string): Promise<void> {
      return ipcRenderer.invoke('browser:back', sessionId);
    },
    forward(sessionId: string): Promise<void> {
      return ipcRenderer.invoke('browser:forward', sessionId);
    },
    reload(sessionId: string): Promise<void> {
      return ipcRenderer.invoke('browser:reload', sessionId);
    },
    stop(sessionId: string): Promise<void> {
      return ipcRenderer.invoke('browser:stop', sessionId);
    },
    close(sessionId: string): Promise<void> {
      return ipcRenderer.invoke('browser:close-page', sessionId);
    },
    getState(sessionId: string): Promise<BrowserState | null> {
      return ipcRenderer.invoke('browser:get-state', sessionId);
    },
    onState(handler: (payload: { sessionId: string; state: BrowserState }) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: { sessionId: string; state: BrowserState }) =>
        handler(payload);
      ipcRenderer.on('browser:state', listener);
      return () => ipcRenderer.off('browser:state', listener);
    },
    onLive(handler: (payload: { sessionIds: string[] }) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: { sessionIds: string[] }) => handler(payload);
      ipcRenderer.on('browser:live', listener);
      return () => ipcRenderer.off('browser:live', listener);
    },
  },
} satisfies MakaBridge;

contextBridge.exposeInMainWorld('maka', makaBridge);
