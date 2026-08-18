import { contextBridge, ipcRenderer } from 'electron';
import { encodeIngestItems } from './attachment-ingest-payload.js';
import { notifyWhenSeeded } from './seed-completion.js';
import { releaseSessionObservation } from './session-observation-release.js';
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
  DesktopRuntimeHostProfileAddInput,
  DesktopRuntimeHostProfileChangedEvent,
  DesktopRuntimeHostSshTerminalEvent,
  DesktopRuntimeHostSshTerminalSnapshot,
  DesktopProjectSnapshot,
} from './bridge-contract.js';
import type { ExternalSessionImportIpcResult } from './external-session-import-result.js';
import {
  DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
  assertDesktopTranscriptBatch,
  type DesktopTranscriptBatch,
  type DesktopTranscriptHandle,
  type DesktopTranscriptOpenResult,
} from './transcript-contract.js';
import type {
  DesktopDiagnosticCopyResult,
  DesktopErrorDiagnosticInput,
} from './diagnostics-contract.js';
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
import type { TurnOrchestration, SessionListFilter, RegenerateTurnInput } from '@maka/core/runtime-inputs';
import type { PlanSessionState } from '@maka/core/plan';
import type { SearchErrorReason, SearchRequest, SearchResult } from '@maka/core/search';
import type { SessionChangedEvent, SessionSummary, TurnRecord } from '@maka/core/session';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { E2eFixtureState } from '@maka/core/e2e-fixture';
import type { ExternalSessionSummary } from '@maka/core/external-session';
import type {
  GitReviewReadResult,
  GitReviewMutationAction,
  GitReviewMutationResult,
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
import type { LocalMemoryEntryPreview, LocalMemoryState } from '@maka/core/local-memory';
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
import {
  isWebSearchProvider,
  MASKED_TOKEN_SENTINEL,
  normalizeWebSearchLimit,
  normalizeWebSearchQuery,
} from '@maka/core/web-search';
import {
  isSessionTrace,
  type SessionTrace,
} from '@maka/core/session-trace';
import type { ContextDiagnosticsResult } from '@maka/runtime-host/protocol';
import {
  DAILY_REVIEW_RANGES,
  normalizeDailyReviewConfig,
} from '@maka/core/daily-review';
import type {
  AgentGraphClientSnapshot,
  AgentGraphClientSnapshotOptions,
  AgentGraphOperatorInspection,
} from '@maka/runtime/stream-graph-read-model';
import type { BotStatus, WechatBridgeQrCodeResult } from '@maka/runtime/bots';
import type { ShellRunPtyDataEvent, ShellRunPtySnapshot } from '@maka/runtime/shell-run-contract';
import type { GoalState } from '@maka/runtime/goal-state';
import type { BundledSkillCatalogEntry, ManagedSkillSourceEntry, ManagedSkillUpdatePreview, SkillEntry, SkillGovernanceDetails } from '@maka/ui';
import type { ConfigCategory } from '@maka/storage';
import {
  SENSITIVE_PLACEHOLDER,
  type TestProxyInput,
} from '@maka/core/settings/network-settings';
import type { Result } from '@maka/core/result';
import type { CreateSessionRequestInput } from '@maka/core/runtime-inputs';
import type {
  McpConfigFile,
  McpServerConfig,
  McpServerStatus,
  McpTestResult,
} from '@maka/core/mcp';
import type { AttachmentRef, InlineReference, QuoteRef } from '@maka/core/events';
import type { OnboardingMilestoneId } from '@maka/core/onboarding';
import {
  SCHEDULED_TASK_CATALOG_MAX_ITEMS,
  type OperationInput,
  type OperationOutput,
} from '@maka/runtime-host/protocol';
import {
  requireDesktopHostRef,
  type DesktopHostRef,
} from './runtime-host-identity.js';

type LocalMemoryMutationResult =
  | { ok: true; state: LocalMemoryState; entry?: LocalMemoryEntryPreview; proposal?: LocalMemoryEntryPreview }
  | { ok: false; state: LocalMemoryState; reason: string; message: string };

let activeRuntimeHost: DesktopHostRef | undefined;
let activeRuntimeHostGeneration = 0;

type RuntimeHostProfileWireEvent = DesktopRuntimeHostProfileChangedEvent & {
  readonly hostId?: string;
};

ipcRenderer.on(
  'runtime-host-profiles:changed',
  (_event, change: RuntimeHostProfileWireEvent) => {
    if (change.targetChanged || change.hostId) activeRuntimeHostGeneration += 1;
    if (change.targetChanged) activeRuntimeHost = undefined;
    if (change.hostId) {
      activeRuntimeHost = { hostId: change.hostId, targetEpoch: change.epoch };
    }
  },
);

async function activeRuntimeHostRef(): Promise<DesktopHostRef> {
  while (!activeRuntimeHost) {
    const generation = activeRuntimeHostGeneration;
    const snapshot = await ipcRenderer.invoke('runtime-host:activeIdentity');
    if (generation !== activeRuntimeHostGeneration) continue;
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('Desktop Runtime Host identity is unavailable');
    }
    const hostId = (snapshot as { hostId?: unknown }).hostId;
    const targetEpoch = (snapshot as { targetEpoch?: unknown }).targetEpoch;
    if (
      typeof hostId !== 'string' ||
      !hostId ||
      typeof targetEpoch !== 'string' ||
      !targetEpoch
    ) {
      throw new Error('Desktop Runtime Host identity is unavailable');
    }
    activeRuntimeHost = { hostId, targetEpoch };
  }
  return activeRuntimeHost;
}

async function invokeActiveRuntimeHost<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, await activeRuntimeHostRef(), ...args) as Promise<T>;
}

function scopedRuntimeHost(scope: DesktopHostRef): MakaBridge['runtimeHost'] {
  return {
    query(operation, input) {
      return ipcRenderer.invoke('runtime-host:query', scope, operation, input) as Promise<
        OperationOutput<typeof operation>
      >;
    },
    command(operation, input) {
      return ipcRenderer.invoke('runtime-host:command', scope, operation, input) as Promise<
        OperationOutput<typeof operation>
      >;
    },
  };
}

function sendActiveRuntimeHost(channel: string, ...args: unknown[]): void {
  void activeRuntimeHostRef()
    .then((scope) => ipcRenderer.send(channel, scope, ...args))
    .catch(() => undefined);
}

function subscribeActiveRuntimeHostEvent<T extends readonly unknown[]>(
  channel: string,
  handler: (...args: T) => void,
): () => void {
  const listener = (
    _event: Electron.IpcRendererEvent,
    scope: unknown,
    ...args: unknown[]
  ): void => {
    let host: DesktopHostRef;
    try {
      host = requireDesktopHostRef(scope);
    } catch {
      return;
    }
    if (
      !activeRuntimeHost ||
      host.hostId !== activeRuntimeHost.hostId ||
      host.targetEpoch !== activeRuntimeHost.targetEpoch
    ) return;
    handler(...(args as unknown as T));
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const runtimeHost: MakaBridge['runtimeHost'] = {
  query(operation, input) {
    return invokeActiveRuntimeHost('runtime-host:query', operation, input) as Promise<
      OperationOutput<typeof operation>
    >;
  },
  command(operation, input) {
    return invokeActiveRuntimeHost('runtime-host:command', operation, input) as Promise<
      OperationOutput<typeof operation>
    >;
  },
};

async function listScheduledTasks(): Promise<ScheduledTask[]> {
  const host = scopedRuntimeHost(await activeRuntimeHostRef());
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tasks: ScheduledTask[] = [];
    const taskIds = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let revision: number | undefined;
    let retry = false;
    do {
      const result = await host.query('scheduled-task.query', {
        kind: 'list',
        ...(cursor === undefined ? {} : { cursor, expectedRevision: revision! }),
      });
      if (result.kind === 'revision_changed') {
        retry = true;
        break;
      }
      if (result.kind !== 'page') throw new Error('Invalid ScheduledTask catalog page');
      revision ??= result.revision;
      if (result.revision !== revision) {
        throw new Error('ScheduledTask catalog revision changed without a restart signal');
      }
      for (const task of result.tasks) {
        if (taskIds.has(task.id)) throw new Error('ScheduledTask catalog repeated a task');
        taskIds.add(task.id);
      }
      tasks.push(...result.tasks);
      if (tasks.length > SCHEDULED_TASK_CATALOG_MAX_ITEMS) {
        throw new Error('ScheduledTask catalog exceeds its item limit');
      }
      cursor = result.nextCursor ?? undefined;
      if (cursor !== undefined) {
        if (result.tasks.length === 0 || cursors.has(cursor)) {
          throw new Error('ScheduledTask catalog repeated a page cursor');
        }
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    if (!retry) return tasks;
  }
  throw new Error('ScheduledTask catalog kept changing while Desktop read it');
}

async function mutateScheduledTask(
  input: OperationInput<'scheduled-task.mutate'>,
): Promise<ScheduledTask> {
  const host = scopedRuntimeHost(await activeRuntimeHostRef());
  const result = await host.command('scheduled-task.mutate', input);
  if (result.kind !== 'task') throw new Error('Runtime Host returned no ScheduledTask');
  return result.task;
}

async function loadSessionTrace(sessionId: string): Promise<SessionTrace> {
  const host = scopedRuntimeHost(await activeRuntimeHostRef());
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const first = await host.query('execution.inspect.query', {
      kind: 'session_trace_start',
      sessionId,
    });
    if (first.kind !== 'session_trace_page') throw new Error('Invalid Session trace page');
    const turns = [...first.turns];
    const offsets = new Set<number>([0]);
    let nextOffset = first.nextOffset;
    let retry = false;
    while (nextOffset !== null) {
      if (offsets.has(nextOffset)) throw new Error('Session trace repeated a page offset');
      offsets.add(nextOffset);
      const next = await host.query('execution.inspect.query', {
        kind: 'session_trace_continue',
        sessionId,
        revision: first.revision,
        offset: nextOffset,
      });
      if (next.kind === 'session_trace_revision_changed') {
        retry = true;
        break;
      }
      if (
        next.kind !== 'session_trace_page' ||
        next.revision !== first.revision ||
        next.offset !== nextOffset ||
        JSON.stringify(next.totals) !== JSON.stringify(first.totals) ||
        JSON.stringify(next.coverage) !== JSON.stringify(first.coverage)
      ) {
        throw new Error('Invalid Session trace continuation');
      }
      turns.push(...next.turns);
      nextOffset = next.nextOffset;
    }
    if (retry) continue;
    const trace = {
      schemaVersion: first.schemaVersion,
      sessionId,
      turns,
      totals: first.totals,
      coverage: first.coverage,
    };
    if (!isSessionTrace(trace)) throw new Error('Invalid Session trace projection');
    return trace;
  }
  throw new Error('Session trace kept changing while Desktop read it');
}

async function updateDailyReviewConfig(
  patch: Partial<DailyReviewConfig>,
): Promise<DailyReviewConfig> {
  const host = scopedRuntimeHost(await activeRuntimeHostRef());
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await host.query('daily-review.query', { kind: 'config' });
    if (current.kind !== 'config') throw new Error('Invalid Daily Review config');
    const config = normalizeDailyReviewConfig({ ...current.config, ...patch });
    const result = await host.command('daily-review.mutate', {
      kind: 'update_config',
      expectedRevision: current.revision,
      config,
    });
    if (result.kind === 'config_committed' || result.kind === 'config_unchanged') {
      return result.config;
    }
  }
  throw new Error('Daily Review config kept changing while Desktop updated it');
}

async function listDailyReviewArchives(): Promise<DailyReviewArchiveSummary[]> {
  const host = scopedRuntimeHost(await activeRuntimeHostRef());
  const archives: DailyReviewArchiveSummary[] = [];
  let beforeArchiveId: string | null = null;
  do {
    const result: OperationOutput<'daily-review.query'> = await host.query(
      'daily-review.query', {
      kind: 'archives',
      beforeArchiveId,
      limit: 32,
      },
    );
    if (result.kind !== 'archives') throw new Error('Invalid Daily Review archive page');
    archives.push(...result.archives);
    beforeArchiveId = result.nextBeforeArchiveId;
  } while (beforeArchiveId !== null);
  return archives;
}

function executeWebSearchQuery(input: {
  query: string;
  limit?: number;
  provider?: WebSearchProvider;
  apiKey?: string;
}): Promise<WebSearchResponse> {
  if (input.provider !== undefined && !isWebSearchProvider(input.provider)) {
    return Promise.resolve(unsupportedWebSearchProvider());
  }
  if (input.provider === 'model') {
    return Promise.resolve({
      ok: false,
      reason: 'unsupported_provider',
      message: '原生联网搜索由对话中的主模型请求执行，不支持从设置页单独调用。',
    });
  }
  const query = normalizeWebSearchQuery(input.query);
  if (!query) {
    return Promise.resolve({ ok: false, reason: 'invalid_query', message: '请输入有效的搜索关键词。' });
  }
  const apiKey = webSearchCredentialOverride(input.apiKey);
  return runtimeHost.command('web-search.execute', {
    kind: 'query',
    query,
    limit: normalizeWebSearchLimit(input.limit),
    ...(apiKey ? { apiKey } : {}),
  });
}

function executeWebSearchTest(input: {
  provider?: WebSearchProvider;
  apiKey?: string;
}): Promise<WebSearchResponse> {
  if (input.provider !== undefined && !isWebSearchProvider(input.provider)) {
    return Promise.resolve(unsupportedWebSearchProvider());
  }
  if (input.provider === 'model') {
    return Promise.resolve({
      ok: false,
      reason: 'unsupported_provider',
      message: '原生联网搜索由对话中的主模型请求执行，不需要单独测试搜索凭据。',
    });
  }
  const apiKey = webSearchCredentialOverride(input.apiKey);
  return runtimeHost.command('web-search.execute', {
    kind: 'test',
    provider: 'tavily',
    ...(apiKey ? { apiKey } : {}),
  });
}

function unsupportedWebSearchProvider(): WebSearchResponse {
  return {
    ok: false,
    reason: 'unsupported_provider',
    message: '当前配置不支持这个搜索引擎，请选择 Tavily 后重试。',
  };
}

function webSearchCredentialOverride(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value !== MASKED_TOKEN_SENTINEL &&
    value !== SENSITIVE_PLACEHOLDER
    ? value
    : undefined;
}

function integer(value: unknown, fallback: number): number {
  return Number.isFinite(value) ? Math.trunc(value as number) : fallback;
}

async function bridgeResult<T>(operation: () => Promise<T>, code: string): Promise<Result<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    return {
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

const makaBridge = {
  runtimeHost,
  uiExtensions: {
    list() {
      return invokeActiveRuntimeHost('ui-extensions:list');
    },
    importLocal() {
      return invokeActiveRuntimeHost('ui-extensions:importLocal');
    },
    setEnabled(extensionId: string, enabled: boolean) {
      return invokeActiveRuntimeHost('ui-extensions:setEnabled', extensionId, enabled);
    },
    getConfiguration(entryId: string) {
      return invokeActiveRuntimeHost('ui-extensions:getConfiguration', entryId);
    },
    configure(entryId: string, configuration: Record<string, string | number | boolean>) {
      return invokeActiveRuntimeHost('ui-extensions:configure', entryId, configuration);
    },
    export(extensionId: string, revision: string) {
      return invokeActiveRuntimeHost('ui-extensions:export', extensionId, revision);
    },
    remove(extensionId: string) {
      return invokeActiveRuntimeHost('ui-extensions:remove', extensionId);
    },
  },
  runtimeHostProfiles: {
    getSnapshot() {
      return ipcRenderer.invoke('runtime-host-profiles:getSnapshot');
    },
    addAndSelect(input: DesktopRuntimeHostProfileAddInput) {
      return ipcRenderer.invoke('runtime-host-profiles:add-and-select', input);
    },
    remove(profileId: string) {
      return ipcRenderer.invoke('runtime-host-profiles:remove', profileId);
    },
    select(profileId: string) {
      return ipcRenderer.invoke('runtime-host-profiles:select', profileId);
    },
    subscribeChanges(handler: (event: DesktopRuntimeHostProfileChangedEvent) => void) {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: RuntimeHostProfileWireEvent,
      ) => {
        const { hostId: _hostId, ...change } = payload;
        handler(change);
      };
      ipcRenderer.on('runtime-host-profiles:changed', listener);
      return () => ipcRenderer.off('runtime-host-profiles:changed', listener);
    },
  },
  runtimeHostSshTerminal: {
    getSnapshot(): Promise<DesktopRuntimeHostSshTerminalSnapshot> {
      return ipcRenderer.invoke('runtime-host-ssh-terminal:getSnapshot');
    },
    write(sessionId: string, data: string) {
      return ipcRenderer.invoke('runtime-host-ssh-terminal:write', {
        sessionId,
        data,
      });
    },
    resize(sessionId: string, cols: number, rows: number) {
      return ipcRenderer.invoke('runtime-host-ssh-terminal:resize', {
        sessionId,
        cols,
        rows,
      });
    },
    cancel(sessionId: string) {
      return ipcRenderer.invoke('runtime-host-ssh-terminal:cancel', sessionId);
    },
    subscribe(handler: (event: DesktopRuntimeHostSshTerminalEvent) => void) {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: DesktopRuntimeHostSshTerminalEvent,
      ) => handler(payload);
      ipcRenderer.on('runtime-host-ssh-terminal:event', listener);
      return () => ipcRenderer.off('runtime-host-ssh-terminal:event', listener);
    },
  },
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
      return invokeActiveRuntimeHost('tasks:list', sessionId);
    },
    subscribeChanges(handler: (event: TaskLedgerChangedEvent) => void): () => void {
      return subscribeActiveRuntimeHostEvent('tasks:changed', handler);
    },
  },
  deepResearch: {
    get(sessionId: string): Promise<DeepResearchClientProgress | undefined> {
      return invokeActiveRuntimeHost('deepResearch:get', sessionId);
    },
    subscribeChanges(handler: (event: DeepResearchChangedEvent) => void): () => void {
      return subscribeActiveRuntimeHostEvent('deepResearch:changed', handler);
    },
  },
  graphs: {
    getSnapshot(
      rootSessionId: string,
      options?: AgentGraphClientSnapshotOptions,
    ): Promise<AgentGraphClientSnapshot> {
      return invokeActiveRuntimeHost('graphs:getSnapshot', rootSessionId, options);
    },
    inspectOperator(
      rootSessionId: string,
      operatorId: string,
    ): Promise<AgentGraphOperatorInspection> {
      return invokeActiveRuntimeHost('graphs:inspectOperator', rootSessionId, operatorId);
    },
    stop(rootSessionId: string): Promise<void> {
      return invokeActiveRuntimeHost('graphs:stop', rootSessionId);
    },
    subscribe(
      rootSessionId: string,
      handler: () => void,
    ): () => void {
      const onChanged = (payload: { rootSessionId: string }): void => {
        if (payload.rootSessionId === rootSessionId) handler();
      };
      const unsubscribeChanged = subscribeActiveRuntimeHostEvent('graphs:changed', onChanged);
      const unsubscribeResync = subscribeActiveRuntimeHostEvent('graphs:resync', onChanged);
      return () => {
        unsubscribeChanged();
        unsubscribeResync();
      };
    },
  },
  sessions: {
    list(filter?: SessionListFilter): Promise<SessionSummary[]> {
      return invokeActiveRuntimeHost('sessions:list', filter);
    },
    /**
     * The single session-creation channel (#1433). `mode` names a
     * product intent — main derives the permission boundary, name and
     * labels it implies (`create-session-input.ts`); the renderer cannot
     * reach a boundary like `explore` by asking for it directly.
     */
    create(input?: CreateSessionRequestInput): Promise<SessionSummary> {
      return invokeActiveRuntimeHost('sessions:create', input);
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
          skillInvocation: import('@maka/runtime/skill-invocation').SkillInvocationResult;
        }
      | {
          ok: false;
          reason: 'skill_invocation_failed';
          skillInvocation: import('@maka/runtime/skill-invocation').SkillInvocationResult;
        }
    > {
      const scope = await activeRuntimeHostRef();
      if (command.type === 'send' && 'attachmentItems' in command && command.attachmentItems) {
        const encoded = await encodeIngestItems(command.attachmentItems as RendererIngestInput[]);
        return ipcRenderer.invoke('sessions:send', scope, sessionId, {
          ...command,
          attachmentItems: encoded,
        });
      }
      return ipcRenderer.invoke('sessions:send', scope, sessionId, command);
    },
    compact(sessionId: string): Promise<void> {
      return invokeActiveRuntimeHost('sessions:compact', sessionId);
    },
    resumeLatest(sessionId: string): Promise<
      | { disposition: 'started'; runId: string; turnId: string }
      | { disposition: 'park'; rejectionReasons: string[]; diagnostics: unknown[] }
    > {
      return invokeActiveRuntimeHost('sessions:resumeLatest', sessionId);
    },
    stop(sessionId: string, input?: { source?: 'stop_button' }): Promise<void> {
      return invokeActiveRuntimeHost('sessions:stop', sessionId, input);
    },
    steer(sessionId: string, text: string): Promise<QueueEnqueueOutcome> {
      return invokeActiveRuntimeHost('sessions:steer', sessionId, text);
    },
    readExecutionBoundary(sessionId: string): Promise<ExecutionBoundaryReadModel> {
      return invokeActiveRuntimeHost('sessions:readExecutionBoundary', sessionId);
    },
    listActiveInteractions(sessionId: string): Promise<ActiveInteractionRequestEvent[]> {
      return invokeActiveRuntimeHost('sessions:listActiveInteractions', sessionId);
    },
    subscribeActiveInteractions(
      handler: (event: {
        sessionId: string;
        interactions: ActiveInteractionRequestEvent[];
      }) => void,
    ): () => void {
      return subscribeActiveRuntimeHostEvent('sessions:active-interactions-changed', handler);
    },
    listTurns(sessionId: string): Promise<TurnRecord[]> {
      return invokeActiveRuntimeHost('sessions:listTurns', sessionId);
    },
    listTurnLandmarks(sessionId) {
      return invokeActiveRuntimeHost('sessions:listTurnLandmarks', sessionId);
    },
    regenerateTurn(sessionId: string, input: RegenerateTurnInput): Promise<void> {
      return invokeActiveRuntimeHost('sessions:regenerateTurn', sessionId, input);
    },
    branchFromTurn(sessionId: string, input: DesktopBranchFromTurnInput): Promise<SessionSummary> {
      return invokeActiveRuntimeHost('sessions:branchFromTurn', sessionId, input);
    },
    reviseBeforeTurn(sessionId: string, input: DesktopReviseBeforeTurnInput): Promise<SessionSummary> {
      return invokeActiveRuntimeHost('sessions:reviseBeforeTurn', sessionId, input);
    },
    respondToSandboxBoundary(sessionId: string, response: SandboxBoundaryResponse): Promise<void> {
      return invokeActiveRuntimeHost('sessions:respondToSandboxBoundary', sessionId, response);
    },
    respondToUserQuestion(sessionId: string, response: UserQuestionResponse): Promise<void> {
      return invokeActiveRuntimeHost('sessions:respondToUserQuestion', sessionId, response);
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
    subscribeEvents(
      sessionId: string,
      handler: (event: SessionEvent) => void,
      onSeeded?: () => void,
    ): () => void {
      const channel = `sessions:event:${sessionId}`;
      const unsubscribeEvents = subscribeActiveRuntimeHostEvent(channel, handler);
      const observerId = crypto.randomUUID();
      const scope = activeRuntimeHostRef();
      const observeDispatch = scope.then((resolved) => ({
        completion: ipcRenderer.invoke('sessions:observe', resolved, sessionId, observerId),
      }));
      const observing = observeDispatch.then(({ completion }) => completion);
      const disposeSeedNotification = notifyWhenSeeded(observing, onSeeded);
      return () => {
        disposeSeedNotification();
        unsubscribeEvents();
        void releaseSessionObservation(observeDispatch, () =>
          ipcRenderer.invoke('sessions:unobserve', observerId),
        ).catch(() => undefined);
      };
    },
    subscribeChanges(handler: (event: SessionChangedEvent) => void): () => void {
      return subscribeActiveRuntimeHostEvent('sessions:changed', handler);
    },
    archive(sessionId: string, options?: { revisionFamily?: boolean }): Promise<void> {
      return invokeActiveRuntimeHost('sessions:archive', sessionId, options);
    },
    unarchive(sessionId: string, options?: { revisionFamily?: boolean }): Promise<void> {
      return invokeActiveRuntimeHost('sessions:unarchive', sessionId, options);
    },
    setFlagged(sessionId: string, isFlagged: boolean, options?: { revisionFamily?: boolean }): Promise<void> {
      return invokeActiveRuntimeHost('sessions:setFlagged', sessionId, isFlagged, options);
    },
    rename(sessionId: string, name: string, options?: { revisionFamily?: boolean }): Promise<void> {
      return invokeActiveRuntimeHost('sessions:rename', sessionId, name, options);
    },
    setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary> {
      return invokeActiveRuntimeHost('sessions:setPermissionMode', sessionId, mode);
    },
    setCollaborationMode(sessionId: string, mode: CollaborationMode): Promise<SessionSummary> {
      return invokeActiveRuntimeHost('sessions:setCollaborationMode', sessionId, mode);
    },
    setOrchestrationMode(sessionId: string, mode: OrchestrationMode): Promise<SessionSummary> {
      return invokeActiveRuntimeHost('sessions:setOrchestrationMode', sessionId, mode);
    },
    getPlanState(sessionId: string): Promise<PlanSessionState> {
      return invokeActiveRuntimeHost('plan-mode:getState', sessionId);
    },
    subscribePlanChanges(sessionId: string, handler: () => void): () => void {
      const channel = 'plan-mode:changed';
      const listener = (payload: { sessionId: string }): void => {
        if (payload.sessionId === sessionId) handler();
      };
      return subscribeActiveRuntimeHostEvent(channel, listener);
    },
    requestPlanRevision(sessionId: string, proposalId: string): Promise<PlanSessionState> {
      return invokeActiveRuntimeHost('plan-mode:requestRevision', sessionId, proposalId);
    },
    abandonPlanProposal(
      sessionId: string,
      proposalId: string,
    ): Promise<PlanSessionState> {
      return invokeActiveRuntimeHost('plan-mode:abandon', sessionId, proposalId);
    },
    approvePlan(sessionId: string, input: {
      proposalId: string;
      expectedRevision: number;
      expectedStoreVersion: number;
      turnId: string;
    }): Promise<{ turnId: string; executionId: string }> {
      return invokeActiveRuntimeHost('plan-mode:approve', sessionId, input);
    },
    resumePlan(sessionId: string, executionId: string, turnId: string): Promise<{
      turnId: string;
      executionId: string;
    }> {
      return invokeActiveRuntimeHost('plan-mode:resume', sessionId, executionId, turnId);
    },
    abandonPlanExecution(sessionId: string, executionId: string): Promise<PlanSessionState> {
      return invokeActiveRuntimeHost('plan-mode:abandonExecution', sessionId, executionId);
    },
    setModel(sessionId: string, input: { llmConnectionSlug: string; model: string }): Promise<SessionSummary> {
      return invokeActiveRuntimeHost('sessions:setModel', sessionId, input);
    },
    setThinkingLevel(sessionId: string, level: ThinkingLevel | undefined | null): Promise<SessionSummary> {
      return invokeActiveRuntimeHost('sessions:setThinkingLevel', sessionId, level ?? undefined);
    },
    remove(sessionId: string, options?: { revisionFamily?: boolean }): Promise<void> {
      return invokeActiveRuntimeHost('sessions:remove', sessionId, options);
    },
    cleanupSessionCopy(sessionId: string): Promise<void> {
      return invokeActiveRuntimeHost('sessions:cleanupSessionCopy', sessionId);
    },
    abandonSessionCopy(sessionId: string): Promise<void> {
      return invokeActiveRuntimeHost('sessions:abandonSessionCopy', sessionId);
    },
  },
  transcripts: {
    async open(
      sessionId: string,
      handler: (batch: DesktopTranscriptBatch) => void,
      registerCancellation?: (cancel: () => void) => void,
    ): Promise<DesktopTranscriptHandle> {
      const consumerId = crypto.randomUUID();
      const channel = `sessions:transcript:${consumerId}`;
      let generation: string | undefined;
      let closed = false;
      let requestClose = () => {};
      let consumerScope: DesktopHostRef | undefined;
      const listener = (
        _event: Electron.IpcRendererEvent,
        scope: unknown,
        value: unknown,
      ) => {
        if (closed) return;
        let batch: DesktopTranscriptBatch;
        try {
          const host = requireDesktopHostRef(scope);
          if (
            !activeRuntimeHost ||
            host.hostId !== activeRuntimeHost.hostId ||
            host.targetEpoch !== activeRuntimeHost.targetEpoch
          ) return;
          batch = assertDesktopTranscriptBatch(value);
          if (batch.reset || generation === undefined) {
            generation = batch.generation;
            consumerScope = host;
          }
          if (batch.generation === generation) handler(batch);
        } catch (error) {
          requestClose();
          throw error;
        }
        if (consumerScope) {
          void ipcRenderer.invoke(
            'sessions:transcript:ack',
            consumerScope,
            consumerId,
            batch.generation,
            batch.deliverySequence,
          ).catch(requestClose);
        }
      };
      ipcRenderer.on(channel, listener);
      const openDispatch = activeRuntimeHostRef().then((scope) => {
        consumerScope = scope;
        return {
          completion: ipcRenderer.invoke(
            'sessions:transcript:open',
            scope,
            sessionId,
            consumerId,
          ) as Promise<DesktopTranscriptOpenResult>,
        };
      });
      let closeTask: Promise<void> | undefined;
      requestClose = () => {
        if (closed) return;
        closed = true;
        ipcRenderer.off(channel, listener);
        closeTask = releaseSessionObservation(openDispatch, () =>
          ipcRenderer.invoke('sessions:transcript:close', consumerId),
        );
        void closeTask.catch(() => undefined);
      };
      registerCancellation?.(requestClose);
      let opened: DesktopTranscriptOpenResult;
      try {
        opened = await openDispatch.then(({ completion }) => completion);
      } catch (error) {
        closed = true;
        ipcRenderer.off(channel, listener);
        throw error;
      }
      if (closed) throw new Error('Desktop transcript open was cancelled');
      generation ??= opened.generation;
      const range = (
        operation: 'sessions:transcript:load-before' | 'sessions:transcript:load-around',
        anchorSequence: number | null,
        maxBytes = DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
      ): Promise<void> =>
        ipcRenderer.invoke(operation, consumerScope, {
          consumerId,
          generation,
          anchorSequence,
          maxBytes,
        }) as Promise<void>;
      return {
        ...opened,
        loadBefore: (anchorSequence, maxBytes) =>
          range('sessions:transcript:load-before', anchorSequence, maxBytes),
        loadAround: (sequence, maxBytes) =>
          range('sessions:transcript:load-around', sequence, maxBytes),
        async close() {
          if (closed) return;
          requestClose();
          await closeTask;
        },
      };
    },
  },
  externalSessions: {
    listSources(): Promise<{ adapterIds: string[] }> {
      return invokeActiveRuntimeHost('external-sessions:listSources');
    },
    list(input: {
      adapterId: string;
      includeArchived?: boolean;
      cursor?: string;
    }): Promise<{ sessions: ExternalSessionSummary[]; nextCursor: string | null }> {
      return invokeActiveRuntimeHost('external-sessions:list', input);
    },
    import(input: {
      adapterId: string;
      sourceSessionId: string;
    }): Promise<ExternalSessionImportIpcResult> {
      return invokeActiveRuntimeHost('external-sessions:import', input);
    },
  },
  projects: {
    getSnapshot(): Promise<DesktopProjectSnapshot> {
      return invokeActiveRuntimeHost('projects:getSnapshot');
    },
    subscribeChanges(handler: () => void): () => void {
      return subscribeActiveRuntimeHostEvent('projects:changed', handler);
    },
    add(): Promise<
      { ok: true; project: ProjectRecord; path: string } | { ok: false; reason: 'cancelled' }
    > {
      return invokeActiveRuntimeHost('projects:add');
    },
    select(
      projectId: string | null,
    ): Promise<{ project: ProjectRecord | null; path: string }> {
      return invokeActiveRuntimeHost('projects:select', projectId);
    },
    relink(projectId: string): Promise<
      { ok: true; project: ProjectRecord } | { ok: false; reason: 'cancelled' }
    > {
      return invokeActiveRuntimeHost('projects:relink', projectId);
    },
    reveal(projectId: string): Promise<
      | { ok: true; opened: string }
      | {
          ok: false;
          reason: 'unknown-key' | 'not-allowed' | 'missing' | 'not-a-directory' | 'open-failed';
        }
    > {
      return invokeActiveRuntimeHost('projects:reveal', projectId);
    },
    rename(projectId: string, name: string): Promise<ProjectRecord> {
      return invokeActiveRuntimeHost('projects:rename', projectId, name);
    },
    archive(projectId: string): Promise<ProjectRecord> {
      return invokeActiveRuntimeHost('projects:archive', projectId);
    },
    restore(projectId: string): Promise<ProjectRecord> {
      return invokeActiveRuntimeHost('projects:restore', projectId);
    },
  },
  shellRuns: {
    list(sessionId: string): Promise<ShellRunUpdate[]> {
      return invokeActiveRuntimeHost('shell-runs:list', sessionId);
    },
    attach(input: {
      sessionId: string;
      ref: string;
    }): Promise<ShellRunPtySnapshot | null> {
      return invokeActiveRuntimeHost('shell-runs:attach', input);
    },
    detach(input: { sessionId: string; ref: string }): Promise<void> {
      return invokeActiveRuntimeHost('shell-runs:detach', input);
    },
    start(sessionId: string): Promise<ShellRunUpdate> {
      return invokeActiveRuntimeHost('shell-runs:start', sessionId);
    },
    write(input: {
      sessionId: string;
      ref: string;
      input?: string;
      size?: { cols: number; rows: number };
    }): Promise<ShellRunUpdate | null> {
      return invokeActiveRuntimeHost('shell-runs:write', input);
    },
    stop(input: {
      sessionId: string;
      ref: string;
    }): Promise<ShellRunUpdate | null> {
      return invokeActiveRuntimeHost('shell-runs:stop', input);
    },
    subscribeUpdates(handler: (update: ShellRunUpdate) => void): () => void {
      return subscribeActiveRuntimeHostEvent('shell-runs:update', handler);
    },
    subscribePtyData(handler: (event: ShellRunPtyDataEvent) => void): () => void {
      return subscribeActiveRuntimeHostEvent('shell-runs:pty-data', handler);
    },
    subscribeResync(handler: (event: { sessionId: string }) => void): () => void {
      return subscribeActiveRuntimeHostEvent('shell-runs:resync', handler);
    },
  },
  gitReview: {
    read(input: {
      sessionId: string;
      source: GitReviewSource;
      baseBranch?: string;
    }): Promise<GitReviewReadResult> {
      return invokeActiveRuntimeHost('git-review:read', input);
    },
    mutate(input: {
      sessionId: string;
      source: Extract<GitReviewSource, 'unstaged' | 'staged'>;
      revision: string;
      path: string;
      action: GitReviewMutationAction;
    }): Promise<GitReviewMutationResult> {
      return invokeActiveRuntimeHost('git-review:mutate', input);
    },
  },
  goal: {
    get(sessionId: string): Promise<GoalState | null> {
      return invokeActiveRuntimeHost('goal:get', sessionId);
    },
    clear(sessionId: string): Promise<void> {
      return invokeActiveRuntimeHost('goal:clear', sessionId);
    },
  },
  connections: {
    list(): Promise<LlmConnection[]> {
      return invokeActiveRuntimeHost('connections:list');
    },
    getDefault(): Promise<string | null> {
      return invokeActiveRuntimeHost('connections:getDefault');
    },
    setDefault(slug: string | null): Promise<void> {
      return invokeActiveRuntimeHost('connections:setDefault', slug);
    },
    setDefaultModel(input: { slug: string; model: string } | null): Promise<void> {
      return invokeActiveRuntimeHost('connections:setDefaultModel', input);
    },
    create(input: CreateConnectionInput): Promise<LlmConnection> {
      return invokeActiveRuntimeHost('connections:create', input);
    },
    update(slug: string, patch: UpdateConnectionInput): Promise<LlmConnection> {
      return invokeActiveRuntimeHost('connections:update', slug, patch);
    },
    delete(slug: string): Promise<void> {
      return invokeActiveRuntimeHost('connections:delete', slug);
    },
    test(slug: string, opts?: { model?: string }): Promise<ConnectionTestResult> {
      return invokeActiveRuntimeHost('connections:test', slug, opts);
    },
    fetchModels(slug: string): Promise<ModelDiscoveryResult> {
      return invokeActiveRuntimeHost('connections:fetchModels', slug);
    },
    hasSecret(slug: string): Promise<boolean> {
      return invokeActiveRuntimeHost('connections:hasSecret', slug);
    },
    getRequestHeaders(slug: string): Promise<import('@maka/core/llm-connections').SavedRequestHeaders> {
      return invokeActiveRuntimeHost('connections:getRequestHeaders', slug);
    },
    setRequestHeaders(
      slug: string,
      headers: readonly import('@maka/core/llm-connections').RequestHeaderUpdate[],
    ): Promise<import('@maka/core/llm-connections').SavedRequestHeaders> {
      return invokeActiveRuntimeHost('connections:setRequestHeaders', slug, headers);
    },
    subscribeEvents(handler: (event: ConnectionEvent) => void): () => void {
      return subscribeActiveRuntimeHostEvent('connections:event', handler);
    },
  },
  mcp: {
    getConfig(): Promise<McpConfigFile> {
      return invokeActiveRuntimeHost('mcp:getConfig');
    },
    listStatuses(): Promise<McpServerStatus[]> {
      return invokeActiveRuntimeHost('mcp:listStatuses');
    },
    setConfig(config: McpConfigFile): Promise<McpConfigFile> {
      return invokeActiveRuntimeHost('mcp:setConfig', config);
    },
    upsert(serverId: string, config: McpServerConfig): Promise<McpConfigFile> {
      return invokeActiveRuntimeHost('mcp:upsert', serverId, config);
    },
    install(serverId: string, config: McpServerConfig): Promise<McpConfigFile> {
      return invokeActiveRuntimeHost('mcp:install', serverId, config);
    },
    remove(serverId: string): Promise<McpConfigFile> {
      return invokeActiveRuntimeHost('mcp:remove', serverId);
    },
    cancelInstall(serverId: string): Promise<McpConfigFile> {
      return invokeActiveRuntimeHost('mcp:cancelInstall', serverId);
    },
    test(serverId: string): Promise<McpTestResult> {
      return invokeActiveRuntimeHost('mcp:test', serverId);
    },
    reconnect(serverId: string): Promise<McpServerStatus> {
      return invokeActiveRuntimeHost('mcp:reconnect', serverId);
    },
    subscribeChanges(handler: (statuses: McpServerStatus[]) => void): () => void {
      return subscribeActiveRuntimeHostEvent('mcp:changed', handler);
    },
  },
  // PR110b: onboarding snapshot + milestone IPCs. Renderer polls
  // `getSnapshot()` on app load and re-polls when
  // `sessions:changed` / `connections:changed` / settings change
  // events fire. There is no push event for OnboardingState — it is
  // a derived projection and refresh latency is acceptable.
  onboarding: {
    getSnapshot(): Promise<OnboardingSnapshot> {
      return invokeActiveRuntimeHost('onboarding:getSnapshot');
    },
    setMilestone(
      id: OnboardingMilestoneId,
      status: 'completed' | 'skipped',
    ): Promise<OnboardingSnapshot> {
      return invokeActiveRuntimeHost('onboarding:setMilestone', id, status);
    },
    clearMilestone(id: OnboardingMilestoneId): Promise<OnboardingSnapshot> {
      return invokeActiveRuntimeHost('onboarding:clearMilestone', id);
    },
  },
  taskReadiness: {
    getSnapshot(input?: DesktopTaskSubmissionReadinessRequest) {
      return invokeActiveRuntimeHost('taskReadiness:getSnapshot', input);
    },
  },
  permissions: {
    getSnapshot(): Promise<PermissionSnapshot> {
      return invokeActiveRuntimeHost('permissions:getSnapshot');
    },
    openSystemSettings(permId: string): Promise<PermissionActionResult> {
      return invokeActiveRuntimeHost('permissions:openSystemSettings', permId);
    },
    requestAccess(permId: string): Promise<PermissionActionResult> {
      return invokeActiveRuntimeHost('permissions:requestAccess', permId);
    },
    startDragOnboarding(permId: string): Promise<PermissionOverlayStartResult> {
      return invokeActiveRuntimeHost('permissions:startDragOnboarding', permId);
    },
  },
  capabilities: {
    getSnapshot(): Promise<CapabilitySnapshotCollection> {
      return invokeActiveRuntimeHost('capabilities:getSnapshot');
    },
  },
  health: {
    getSnapshot(): Promise<HealthSnapshot> {
      return invokeActiveRuntimeHost('health:getSnapshot');
    },
  },
  memory: {
    getState(): Promise<LocalMemoryState> {
      return invokeActiveRuntimeHost('memory:getState');
    },
    listProposals(): Promise<ReadonlyArray<LocalMemoryEntryPreview>> {
      return invokeActiveRuntimeHost('memory:listProposals');
    },
    propose(input: { title: string; content: string; scope?: 'workspace' | 'session'; sessionId?: string }): Promise<LocalMemoryMutationResult> {
      return invokeActiveRuntimeHost('memory:propose', input);
    },
    remember(input: { title: string; content: string; scope?: 'workspace' | 'session'; sessionId?: string }): Promise<LocalMemoryMutationResult> {
      return invokeActiveRuntimeHost('memory:remember', input);
    },
    approveProposal(proposalId: string): Promise<LocalMemoryMutationResult> {
      return invokeActiveRuntimeHost('memory:approveProposal', proposalId);
    },
    rejectProposal(proposalId: string): Promise<LocalMemoryMutationResult> {
      return invokeActiveRuntimeHost('memory:rejectProposal', proposalId);
    },
    archiveEntry(entryId: string, reason?: string): Promise<LocalMemoryMutationResult> {
      return invokeActiveRuntimeHost('memory:archiveEntry', entryId, reason);
    },
    restoreEntry(entryId: string): Promise<LocalMemoryMutationResult> {
      return invokeActiveRuntimeHost('memory:restoreEntry', entryId);
    },
    save(content: string): Promise<LocalMemoryState> {
      return invokeActiveRuntimeHost('memory:save', content);
    },
    reset(): Promise<LocalMemoryState> {
      return invokeActiveRuntimeHost('memory:reset');
    },
    restoreLatestBackup(): Promise<{ ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }> {
      return invokeActiveRuntimeHost('memory:restoreLatestBackup');
    },
    restoreBackup(kind: 'save' | 'reset' | 'restore'): Promise<{ ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }> {
      return invokeActiveRuntimeHost('memory:restoreBackup', kind);
    },
    setEnabled(enabled: boolean): Promise<LocalMemoryState> {
      return invokeActiveRuntimeHost('memory:setEnabled', enabled);
    },
    setAgentReadEnabled(enabled: boolean): Promise<LocalMemoryState> {
      return invokeActiveRuntimeHost('memory:setAgentReadEnabled', enabled);
    },
    openFile(): Promise<{ ok: true } | { ok: false; message: string }> {
      return invokeActiveRuntimeHost('memory:openFile');
    },
    openLatestBackup(): Promise<{ ok: true } | { ok: false; message: string }> {
      return invokeActiveRuntimeHost('memory:openLatestBackup');
    },
    openBackup(kind: 'save' | 'reset' | 'restore'): Promise<{ ok: true } | { ok: false; message: string }> {
      return invokeActiveRuntimeHost('memory:openBackup', kind);
    },
  },
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
      return invokeActiveRuntimeHost('attachments:readBytes', sessionId, relativePath);
    },
  },
  search: {
    // PR-SEARCH-2: local thread search. Renderer sends a `SearchRequest`
    // (source must be 'thread'); main responds with `SearchResult[]` or
    // an error envelope. The query body never leaves the device — the
    // helper is local-only and the IPC handler never emits the query
    // into telemetry.
    thread(request: SearchRequest): Promise<SearchResult[] | { ok: false; reason: SearchErrorReason; message: string }> {
      return invokeActiveRuntimeHost('search:thread', request);
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
      return invokeActiveRuntimeHost('claude-subscription:is-experimental-enabled');
    },
    getAuthUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
      return invokeActiveRuntimeHost('claude-subscription:get-auth-url');
    },
    openAuthUrl(authRequestId: string): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('claude-subscription:open-auth-url', authRequestId);
    },
    completeAuthorization(authRequestId: string, pasted: string): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('claude-subscription:complete-authorization', authRequestId, pasted);
    },
    cancelAuthorization(authRequestId?: string): Promise<{ ok: true }> {
      return invokeActiveRuntimeHost('claude-subscription:cancel-authorization', authRequestId);
    },
    getAccountState(): Promise<SubscriptionAccountState> {
      return invokeActiveRuntimeHost('claude-subscription:get-account-state');
    },
    refreshQuota(): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('claude-subscription:refresh-quota');
    },
    refreshTokens(): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('claude-subscription:refresh-tokens');
    },
    logout(): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('claude-subscription:logout');
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
      return invokeActiveRuntimeHost('openai-codex:is-experimental-enabled');
    },
    getAuthUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
      return invokeActiveRuntimeHost('openai-codex:get-auth-url');
    },
    openAuthUrl(authRequestId: string): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('openai-codex:open-auth-url', authRequestId);
    },
    completeAuthorization(authRequestId: string): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('openai-codex:complete-authorization', authRequestId);
    },
    cancelAuthorization(authRequestId?: string): Promise<{ ok: true }> {
      return invokeActiveRuntimeHost('openai-codex:cancel-authorization', authRequestId);
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
      return invokeActiveRuntimeHost('openai-codex:get-account-state');
    },
    refreshTokens(): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('openai-codex:refresh-tokens');
    },
    logout(): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('openai-codex:logout');
    },
  },
  xaiOAuth: {
    getAuthUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
      return invokeActiveRuntimeHost('xai-oauth:get-auth-url');
    },
    openAuthUrl(authRequestId: string): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('xai-oauth:open-auth-url', authRequestId);
    },
    completeAuthorization(authRequestId: string): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('xai-oauth:complete-authorization', authRequestId);
    },
    cancelAuthorization(authRequestId?: string): Promise<{ ok: true }> {
      return invokeActiveRuntimeHost('xai-oauth:cancel-authorization', authRequestId);
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
      return invokeActiveRuntimeHost('xai-oauth:get-account-state');
    },
    refreshTokens(): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('xai-oauth:refresh-tokens');
    },
    logout(): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('xai-oauth:logout');
    },
  },
  githubCopilotSubscription: {
    connectExistingLogin(): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('github-copilot:connect-existing-login');
    },
    getAccountState(): Promise<{
      provider: 'github-copilot';
      runtimeState: 'not_logged_in' | 'authenticated' | 'refreshing' | 'refresh_failed' | 'storage_failed';
      errorMessage?: string;
    }> {
      return invokeActiveRuntimeHost('github-copilot:get-account-state');
    },
    refreshTokens(): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('github-copilot:refresh-tokens');
    },
    logout(): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('github-copilot:logout');
    },
  },
  antigravitySubscription: {
    isExperimentalEnabled(): Promise<boolean> {
      return invokeActiveRuntimeHost('antigravity-subscription:is-experimental-enabled');
    },
    getAuthUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
      return invokeActiveRuntimeHost('antigravity-subscription:get-auth-url');
    },
    openAuthUrl(authRequestId: string): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('antigravity-subscription:open-auth-url', authRequestId);
    },
    completeAuthorization(authRequestId: string): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('antigravity-subscription:complete-authorization', authRequestId);
    },
    cancelAuthorization(authRequestId?: string): Promise<{ ok: true }> {
      return invokeActiveRuntimeHost('antigravity-subscription:cancel-authorization', authRequestId);
    },
    getAccountState(): Promise<{
      provider: 'antigravity-subscription';
      status: 'preview';
      runtimeState: 'not_logged_in' | 'authorizing' | 'authenticated' | 'refreshing' | 'refresh_failed';
      errorMessage?: string;
    }> {
      return invokeActiveRuntimeHost('antigravity-subscription:get-account-state');
    },
    refreshTokens(): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('antigravity-subscription:refresh-tokens');
    },
    logout(): Promise<SubscriptionActionResult> {
      return invokeActiveRuntimeHost('antigravity-subscription:logout');
    },
  },
  scheduledTasks: {
    list(): Promise<ScheduledTask[]> {
      return listScheduledTasks();
    },
    create(input: Omit<CreateScheduledTaskInput, 'createdBy'>): Promise<ScheduledTask> {
      return mutateScheduledTask({ kind: 'create', input });
    },
    update(id: string, patch: UpdateScheduledTaskInput): Promise<ScheduledTask> {
      return mutateScheduledTask({ kind: 'update', taskId: id, patch });
    },
    setEnabled(id: string, enabled: boolean): Promise<ScheduledTask> {
      return mutateScheduledTask({
        kind: enabled ? 'resume' : 'pause',
        taskId: id,
      });
    },
    triggerNow(id: string): Promise<ScheduledTask> {
      return mutateScheduledTask({ kind: 'trigger_now', taskId: id });
    },
    snooze(id: string): Promise<ScheduledTask> {
      return mutateScheduledTask({
        kind: 'snooze',
        taskId: id,
        delayMs: 10 * 60 * 1000,
      });
    },
    clearRunHistory(id: string): Promise<ScheduledTask> {
      return mutateScheduledTask({ kind: 'clear_history', taskId: id });
    },
    async delete(id: string): Promise<void> {
      await runtimeHost.command('scheduled-task.mutate', {
        kind: 'delete',
        taskId: id,
      });
    },
    subscribeChanges(handler: (event: { type: 'scheduled_tasks_changed'; reason: string; taskId?: string; ts: number }) => void): () => void {
      return subscribeActiveRuntimeHostEvent('scheduled-tasks:changed', handler);
    },
    subscribeDue(handler: (task: Pick<ScheduledTask, 'id' | 'title'>) => void): () => void {
      return subscribeActiveRuntimeHostEvent('scheduled-tasks:fired', handler);
    },
  },
  settings: {
    get(): Promise<AppSettings> {
      return invokeActiveRuntimeHost('settings:get');
    },
    update(patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsResult> {
      return invokeActiveRuntimeHost('settings:update', patch);
    },
    subscribeExternalChanged(handler: () => void): () => void {
      return subscribeActiveRuntimeHostEvent('settings:externalChanged', handler);
    },
    testNetworkProxy(input?: TestProxyInput): Promise<SettingsTestResult> {
      return invokeActiveRuntimeHost('settings:testNetworkProxy', input);
    },
    testBotChannel(provider: BotProvider): Promise<SettingsTestResult> {
      return invokeActiveRuntimeHost('settings:testBotChannel', provider);
    },
    usageStats(range?: UsageRange): Promise<UsageStats> {
      return invokeActiveRuntimeHost('settings:usageStats', range);
    },
    bots: {
      listStatuses(): Promise<Record<BotProvider, BotStatus>> {
        return invokeActiveRuntimeHost('settings:bots:listStatuses');
      },
      restart(provider: BotProvider): Promise<BotStatus> {
        return invokeActiveRuntimeHost('settings:bots:restart', provider);
      },
      wechatQrCode(): Promise<WechatBridgeQrCodeResult> {
        return invokeActiveRuntimeHost('settings:bots:wechatQrCode');
      },
      subscribeStatusChanges(handler: (status: BotStatus) => void): () => void {
        return subscribeActiveRuntimeHostEvent('settings:bots:statusChanged', handler);
      },
      onboarding: {
        start(input: BotOnboardingStartInput): Promise<Result<BotOnboardingSnapshot>> {
          return invokeActiveRuntimeHost('settings:bots:onboarding:start', input);
        },
        poll(sessionId: string): Promise<Result<BotOnboardingSnapshot>> {
          return invokeActiveRuntimeHost('settings:bots:onboarding:poll', sessionId);
        },
        cancel(sessionId: string): Promise<Result<BotOnboardingSnapshot>> {
          return invokeActiveRuntimeHost('settings:bots:onboarding:cancel', sessionId);
        },
        openInBrowser(sessionId: string): Promise<Result<void>> {
          return invokeActiveRuntimeHost('settings:bots:onboarding:open', sessionId);
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
      return bridgeResult(() => loadSessionTrace(sessionId), 'INSPECTOR_TRACE_FAILED');
    },
    /**
     * What the session's context is made of right now (#2323).
     *
     * A different question from "what happened in this session", and it has
     * its own typed owner on the Host — the same snapshot `/context` prints.
     * The Inspector asks that owner rather than widening the trace, so the two
     * surfaces cannot drift into two implementations of one fact.
     */
    context(sessionId: string): Promise<Result<ContextDiagnosticsResult>> {
      return bridgeResult(
        () => runtimeHost.query('context.diagnostics.query', { sessionId }),
        'INSPECTOR_CONTEXT_FAILED',
      );
    },
  },
  dailyReview: {
    day(offsetDays: number, daySpan?: number): Promise<Result<DailyReviewSummary>> {
      return bridgeResult(async () => {
        const result = await runtimeHost.query('daily-review.query', {
          kind: 'summary',
          offsetDays: integer(offsetDays, 0),
          daySpan: Math.max(1, Math.min(30, integer(daySpan, 1))),
        });
        if (result.kind !== 'summary') throw new Error('Invalid Daily Review summary');
        return result.summary;
      }, 'DAILY_REVIEW_DAY_FAILED');
    },
    async getConfig(): Promise<DailyReviewConfig> {
      const result = await runtimeHost.query('daily-review.query', {
        kind: 'config',
      });
      if (result.kind !== 'config') throw new Error('Invalid Daily Review config');
      return result.config;
    },
    setConfig(patch: Partial<DailyReviewConfig>): Promise<DailyReviewConfig> {
      return updateDailyReviewConfig(patch);
    },
    async runOnce(input: { range: DailyReviewRange; offsetDays?: number; modelKey?: string }): Promise<{ archiveId: string }> {
      const result = await runtimeHost.command('daily-review.mutate', {
        kind: 'run',
        range: DAILY_REVIEW_RANGES.includes(input.range) ? input.range : 1,
        offsetDays: integer(input.offsetDays, 0),
        modelKeyOverride: input.modelKey ?? '',
        replaceExisting: false,
      });
      if (result.kind !== 'archive') throw new Error('Invalid Daily Review run');
      return { archiveId: result.archive.id };
    },
    listArchives(): Promise<DailyReviewArchiveSummary[]> {
      return listDailyReviewArchives();
    },
    async getArchive(archiveId: string): Promise<DailyReviewArchive | null> {
      const result = await runtimeHost.query('daily-review.query', {
        kind: 'archive',
        archiveId,
      });
      if (result.kind !== 'archive') throw new Error('Invalid Daily Review archive');
      return result.archive;
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
      return executeWebSearchQuery(input);
    },
    test(input: { provider?: WebSearchProvider; apiKey?: string }): Promise<WebSearchResponse> {
      return executeWebSearchTest(input);
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
      return invokeActiveRuntimeHost('config:export', input);
    },
    import(input: { strategy: 'skip' | 'overwrite' }): Promise<
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
    > {
      return invokeActiveRuntimeHost('config:import', input);
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
      return invokeActiveRuntimeHost('app:info');
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
      return invokeActiveRuntimeHost('app:sessionProjectInfo', sessionId);
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
      return invokeActiveRuntimeHost('app:openPath', key, sessionId);
    },
    resolveProjectGitInfo(projectPath: string): Promise<
      | { ok: true; projectPath: string; projectGit: { isGitRepo: boolean; branch?: string } }
      | { ok: false; reason: 'invalid-path' | 'not-found' }
    > {
      return invokeActiveRuntimeHost('app:resolveProjectGitInfo', projectPath);
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
      return invokeActiveRuntimeHost('app:openArtifactPath', sessionId, artifactId);
    },
    saveArtifactAs(sessionId: string, artifactId: string): Promise<ArtifactSaveResult> {
      return invokeActiveRuntimeHost('app:saveArtifactAs', sessionId, artifactId);
    },
  },
  diagnostics: {
    copyErrorReport(input: DesktopErrorDiagnosticInput): Promise<DesktopDiagnosticCopyResult> {
      return invokeActiveRuntimeHost('diagnostics:copyErrorReport', input);
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
      return invokeActiveRuntimeHost('workspace:searchFiles', { query, ...options });
    },
  },
  e2eFixture: {
    getState(): Promise<E2eFixtureState | null> {
      return ipcRenderer.invoke('e2eFixture:getState');
    },
  },
  artifacts: {
    list(sessionId: string, opts?: { includeDeleted?: boolean }): Promise<ArtifactDescriptor[]> {
      return invokeActiveRuntimeHost('artifacts:list', sessionId, opts);
    },
    get(sessionId: string, artifactId: string): Promise<ArtifactDescriptor | null> {
      return invokeActiveRuntimeHost('artifacts:get', sessionId, artifactId);
    },
    readText(sessionId: string, artifactId: string): Promise<ArtifactTextReadResult> {
      return invokeActiveRuntimeHost('artifacts:readText', sessionId, artifactId);
    },
    readBinary(sessionId: string, artifactId: string): Promise<ArtifactBinaryReadResult> {
      return invokeActiveRuntimeHost('artifacts:readBinary', sessionId, artifactId);
    },
    delete(sessionId: string, artifactId: string): Promise<void> {
      return invokeActiveRuntimeHost('artifacts:delete', sessionId, artifactId);
    },
    subscribeChanges(handler: (event: ArtifactChangedEvent) => void): () => void {
      return subscribeActiveRuntimeHostEvent('artifacts:changed', handler);
    },
  },
  skills: {
    list(): Promise<SkillEntry[]> {
      return invokeActiveRuntimeHost('skills:list');
    },
    listInvocable(
      sessionId?: string,
      newSessionContext?: {
        llmConnectionSlug?: string;
        model?: string;
        collaborationMode?: 'agent' | 'plan';
      },
    ): Promise<import('@maka/runtime/skill-invocation').InvocableSkillEntry[]> {
      return invokeActiveRuntimeHost('skills:listInvocable', sessionId, newSessionContext);
    },
    catalog: {
      list(): Promise<BundledSkillCatalogEntry[]> {
        return invokeActiveRuntimeHost('skills:catalog:list');
      },
      install(id: string): Promise<
        | { ok: true; skill: SkillEntry }
        | { ok: false; reason: 'not_found' | 'already_exists' | 'blocked_path' | 'write_failed' }
      > {
        return invokeActiveRuntimeHost('skills:catalog:install', id);
      },
    },
    sources: {
      list(): Promise<ManagedSkillSourceEntry[]> {
        return invokeActiveRuntimeHost('skills:sources:list');
      },
      importLocalFile(): Promise<
        | { ok: true; source: ManagedSkillSourceEntry }
        | { ok: false; reason: 'cancelled' | 'invalid_skill' | 'already_exists' | 'blocked_path' | 'write_failed' }
      > {
        return invokeActiveRuntimeHost('skills:sources:importLocalFile');
      },
    },
    installManaged(sourceId: string): Promise<
      | { ok: true; skill: SkillEntry }
      | { ok: false; reason: 'not_found' | 'already_exists' | 'blocked_path' | 'write_failed' }
    > {
      return invokeActiveRuntimeHost('skills:installManaged', sourceId);
    },
    details(skillId: string): Promise<
      | { ok: true; details: SkillGovernanceDetails }
      | { ok: false; reason: 'not_found' | 'invalid_id' }
    > {
      return invokeActiveRuntimeHost('skills:details', skillId);
    },
    previewUpdate(skillId: string): Promise<
      | { ok: true; preview: ManagedSkillUpdatePreview }
      | { ok: false; reason: 'not_managed' | 'source_missing' | 'metadata_error' | 'blocked_path' | 'read_failed' }
    > {
      return invokeActiveRuntimeHost('skills:previewUpdate', skillId);
    },
    updateManaged(skillId: string, options?: { force?: boolean; expectedCurrentSha256?: string; expectedSourceSha256?: string }): Promise<
      | { ok: true; skill: SkillEntry }
      | { ok: false; reason: 'not_managed' | 'source_missing' | 'local_modified' | 'metadata_error' | 'blocked_path' | 'write_failed' }
    > {
      return invokeActiveRuntimeHost('skills:updateManaged', skillId, options);
    },
    setEnabled(skillId: string, enabled: boolean): Promise<
      | { ok: true; skill: SkillEntry }
      | { ok: false; reason: 'not_found' | 'blocked_path' | 'state_error' | 'write_failed' }
    > {
      return invokeActiveRuntimeHost('skills:setEnabled', skillId, enabled);
    },
    setPinned(skillRef: string, pinned: boolean): Promise<
      | { ok: true; skill: SkillEntry }
      | {
          ok: false;
          reason: 'not_found' | 'blocked_path' | 'state_error' | 'write_failed';
        }
    > {
      return invokeActiveRuntimeHost('skills:setPinned', skillRef, pinned);
    },
    createStarter(): Promise<
      | { ok: true; created: boolean; skill: SkillEntry; filePath: string }
      | { ok: false; reason: 'blocked_path' | 'already_exists' | 'write_failed' }
    > {
      return invokeActiveRuntimeHost('skills:createStarter');
    },
    delete(idOrRef: string): Promise<
      | { ok: true }
      | { ok: false; reason: 'not_found' | 'blocked_path' | 'blocked_scope' | 'delete_failed' }
    > {
      return invokeActiveRuntimeHost('skills:delete', idOrRef);
    },
    open(id: string, target: 'file' | 'directory' = 'file'): Promise<
      | { ok: true; target: 'file' | 'directory' }
      | { ok: false; reason: 'invalid_id' | 'missing' | 'blocked_path' | 'not_file' | 'not_directory' | 'open_failed' }
    > {
      return invokeActiveRuntimeHost('skills:open', id, target);
    },
  },
  // Embedded browser (P3). The native WebContentsView floats above the DOM; the
  // renderer panel only mirrors its strip's rect and drives navigation. No
  // automation endpoint/secret is ever exposed here — that stays main-internal.
  browser: {
    /** Tell main which conversation this window shows, so it can validate targets. */
    setActiveSession(sessionId: string | null): void {
      sendActiveRuntimeHost('browser:active-session', sessionId);
    },
    /** Mirror the panel strip's on-screen rect (null hides the native view). */
    setViewport(input: { sessionId: string; rect: BrowserViewRect | null }): void {
      sendActiveRuntimeHost('browser:setViewport', input);
    },
    navigate(sessionId: string, url: string): Promise<void> {
      return invokeActiveRuntimeHost('browser:navigate', sessionId, url);
    },
    back(sessionId: string): Promise<void> {
      return invokeActiveRuntimeHost('browser:back', sessionId);
    },
    forward(sessionId: string): Promise<void> {
      return invokeActiveRuntimeHost('browser:forward', sessionId);
    },
    reload(sessionId: string): Promise<void> {
      return invokeActiveRuntimeHost('browser:reload', sessionId);
    },
    stop(sessionId: string): Promise<void> {
      return invokeActiveRuntimeHost('browser:stop', sessionId);
    },
    close(sessionId: string): Promise<void> {
      return invokeActiveRuntimeHost('browser:close-page', sessionId);
    },
    getState(sessionId: string): Promise<BrowserState | null> {
      return invokeActiveRuntimeHost('browser:get-state', sessionId);
    },
    onState(handler: (payload: { sessionId: string; state: BrowserState }) => void): () => void {
      return subscribeActiveRuntimeHostEvent('browser:state', handler);
    },
    onLive(handler: (payload: { sessionIds: string[] }) => void): () => void {
      return subscribeActiveRuntimeHostEvent('browser:live', handler);
    },
  },
} satisfies MakaBridge;

contextBridge.exposeInMainWorld('maka', makaBridge);
