import { contextBridge, ipcRenderer } from 'electron';
import { encodeIngestItems } from './attachment-ingest-payload.js';
import { collectThreadSearchResponses } from './multi-host-thread-search.js';
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
  DesktopRuntimeHostProfileSnapshot,
  DesktopRuntimeHostSshTerminalEvent,
  DesktopRuntimeHostSshTerminalSnapshot,
  DesktopNewTaskCatalog,
  DesktopNewTaskHost,
  DesktopNewTaskHostRef,
  DesktopNewTaskTarget,
  DesktopRuntimeHostRef,
  DesktopProjectSnapshot,
  DesktopAppInfo,
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
import { createBrowserSelectionCoordinator } from './browser-selection.js';
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
import type { BundledSkillCatalogEntry, ManagedSkillSourceEntry, ManagedSkillUpdatePreview, SkillEntry } from '@maka/ui';
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
  desktopSessionKey,
  parseDesktopSessionKey,
  requireDesktopTargetScope,
  type DesktopTargetScope,
} from '../shared/runtime-host-identity.js';
import {
  projectDesktopAttachmentRefs,
  projectDesktopDailyReviewSummary,
  projectDesktopSessionEvent,
  projectDesktopSessionSummary,
  projectDesktopTurnRecord,
  type DesktopSessionSummary,
} from '../shared/desktop-session-projection.js';

let activeRuntimeHost: DesktopTargetScope | undefined;
let activeRuntimeHostGeneration = 0;
const runtimeHostScopes = new Map<string, DesktopTargetScope>();
const runtimeHostProfiles = new Map<string, string>();
const runtimeHostMetadata = new Map<
  string,
  { readonly profileId: string; readonly profileName: string; readonly profileKind: 'local' | 'remote' }
>();
const runtimeHostSessionCache = new Map<string, DesktopSessionSummary[]>();
const newTaskChangeListeners = new Set<() => void>();

type RuntimeHostProfileWireEvent = DesktopRuntimeHostProfileChangedEvent;

ipcRenderer.on(
  'runtime-host-profiles:changed',
  (_event, change: RuntimeHostProfileWireEvent) => {
    const previousHostId = runtimeHostProfiles.get(change.profileId);
    if (
      previousHostId &&
      (change.removed || (change.hostId !== undefined && previousHostId !== change.hostId))
    ) {
      runtimeHostScopes.delete(previousHostId);
      if (change.removed) {
        runtimeHostMetadata.delete(previousHostId);
        runtimeHostSessionCache.delete(previousHostId);
        runtimeHostProfiles.delete(change.profileId);
      }
    }
    if (change.hostId) {
      const scope = { hostId: change.hostId, targetEpoch: change.epoch };
      runtimeHostScopes.set(scope.hostId, scope);
      runtimeHostProfiles.set(change.profileId, change.hostId);
      runtimeHostMetadata.set(change.hostId, {
        profileId: change.profileId,
        profileName: change.profileName,
        profileKind: change.profileKind,
      });
      if (change.isDefault) activeRuntimeHost = scope;
    } else if (change.isDefault) {
      activeRuntimeHost = undefined;
    }
    if (
      change.hostId ||
      change.removed ||
      change.isDefault ||
      change.readiness === 'unavailable'
    ) {
      activeRuntimeHostGeneration += 1;
    }
    for (const listener of newTaskChangeListeners) listener();
  },
);

function recordRuntimeHostIdentity(value: unknown): {
  readonly scope: DesktopTargetScope;
  readonly readiness: 'ready' | 'reconnecting';
} {
  const scope = requireDesktopTargetScope(value);
  const metadata = value as {
    profileId?: unknown;
    profileName?: unknown;
    profileKind?: unknown;
    readiness?: unknown;
  };
  if (
    typeof metadata.profileId !== 'string' ||
    typeof metadata.profileName !== 'string' ||
    (metadata.profileKind !== 'local' && metadata.profileKind !== 'remote') ||
    (metadata.readiness !== 'ready' && metadata.readiness !== 'reconnecting')
  ) {
    throw new Error('Desktop Runtime Host identity is invalid');
  }
  runtimeHostScopes.set(scope.hostId, scope);
  runtimeHostProfiles.set(metadata.profileId, scope.hostId);
  runtimeHostMetadata.set(scope.hostId, {
    profileId: metadata.profileId,
    profileName: metadata.profileName,
    profileKind: metadata.profileKind,
  });
  return { scope, readiness: metadata.readiness };
}

async function runtimeHostScopeList(): Promise<readonly DesktopTargetScope[]> {
  while (true) {
    const generation = activeRuntimeHostGeneration;
    const identities: unknown = await ipcRenderer.invoke('runtime-host:identities');
    if (generation !== activeRuntimeHostGeneration) continue;
    if (!Array.isArray(identities)) {
      throw new Error('Desktop Runtime Host identities are unavailable');
    }
    const authoritativeHostIds = new Set<string>();
    const readyScopes: DesktopTargetScope[] = [];
    for (const identity of identities) {
      const { scope, readiness } = recordRuntimeHostIdentity(identity);
      authoritativeHostIds.add(scope.hostId);
      if (readiness === 'ready') readyScopes.push(scope);
    }
    for (const hostId of runtimeHostScopes.keys()) {
      if (authoritativeHostIds.has(hostId)) continue;
      runtimeHostScopes.delete(hostId);
    }
    for (const hostId of runtimeHostSessionCache.keys()) {
      if (authoritativeHostIds.has(hostId)) continue;
      runtimeHostSessionCache.delete(hostId);
    }
    return readyScopes;
  }
}

async function runtimeHostSessionRef(sessionId: string): Promise<{
  readonly scope: DesktopTargetScope;
  readonly sessionId: string;
}> {
  const ref = parseDesktopSessionKey(sessionId);
  await runtimeHostScopeList();
  const scope = runtimeHostScopes.get(ref.hostId);
  if (!scope) throw new Error('The Runtime Host for this task is unavailable');
  return { scope, sessionId: ref.sessionId };
}

async function activeRuntimeHostRef(): Promise<DesktopTargetScope> {
  while (!activeRuntimeHost) {
    const generation = activeRuntimeHostGeneration;
    const snapshot = await ipcRenderer.invoke('runtime-host:activeIdentity');
    if (generation !== activeRuntimeHostGeneration) continue;
    activeRuntimeHost = recordRuntimeHostIdentity(snapshot).scope;
  }
  return activeRuntimeHost;
}

async function localRuntimeHostRef(): Promise<DesktopTargetScope> {
  const scopes = await runtimeHostScopeList();
  const scope = scopes.find(
    (candidate) => runtimeHostMetadata.get(candidate.hostId)?.profileKind === 'local',
  );
  if (!scope) throw new Error('The Local Runtime Host is unavailable');
  return scope;
}

async function runtimeHostScope(host: DesktopRuntimeHostRef): Promise<DesktopTargetScope> {
  if (!host.profileId || !host.hostId) {
    throw new Error('The Runtime Host target is invalid');
  }
  await runtimeHostScopeList();
  const currentHostId = runtimeHostProfiles.get(host.profileId);
  const scope = runtimeHostScopes.get(host.hostId);
  if (currentHostId !== host.hostId || !scope) {
    throw new Error('The selected Runtime Host is no longer available');
  }
  return scope;
}

async function selectedRuntimeHostScope(
  host: DesktopRuntimeHostRef | undefined,
): Promise<DesktopTargetScope> {
  return host ? runtimeHostScope(host) : activeRuntimeHostRef();
}

async function loadNewTaskCatalog(): Promise<DesktopNewTaskCatalog> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const generation = activeRuntimeHostGeneration;
    const profiles = await ipcRenderer.invoke(
      'runtime-host-profiles:getSnapshot',
    ) as DesktopRuntimeHostProfileSnapshot;
    await runtimeHostScopeList();
    const hosts = await Promise.all(
      profiles.entries.filter((entry) => entry.enabled).map(async (entry): Promise<DesktopNewTaskHost> => {
        if (entry.readiness !== 'ready' || !entry.hostId) {
          return {
            profile: entry.profile,
            readiness: entry.readiness === 'ready'
              ? 'reconnecting'
              : entry.readiness === 'disabled'
                ? 'unavailable'
                : entry.readiness,
            ...(entry.message ? { message: entry.message } : {}),
          };
        }
        const host = { profileId: entry.profile.id, hostId: entry.hostId };
        try {
          const scope = await runtimeHostScope(host);
          const [snapshot, info, settings] = await Promise.all([
            ipcRenderer.invoke('projects:getSnapshot', scope) as Promise<DesktopProjectSnapshot>,
            ipcRenderer.invoke('app:info', scope) as Promise<DesktopAppInfo>,
            ipcRenderer.invoke('settings:get', scope) as Promise<AppSettings>,
          ]);
          return {
            profile: entry.profile,
            hostId: entry.hostId,
            readiness: 'ready',
            state: 'available',
            projects: snapshot.projects,
            capabilities: snapshot.capabilities,
            selectedProjectId: info.projectId,
            ...(settings.projects.defaultProjectId
              ? { defaultProjectId: settings.projects.defaultProjectId }
              : {}),
            chatDefaults: settings.chatDefaults,
            ...(snapshot.capabilities.viewClientPath && info.projectPath
              ? { projectPath: info.projectPath }
              : {}),
            ...(info.projectGit.branch ? { branch: info.projectGit.branch } : {}),
          };
        } catch (error) {
          return {
            profile: entry.profile,
            hostId: entry.hostId,
            readiness: 'ready',
            state: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    if (generation !== activeRuntimeHostGeneration) continue;
    return { defaultProfileId: profiles.defaultProfileId, hosts };
  }
  throw new Error('Runtime Host targets changed while the new-task catalog was loading');
}

async function invokeActiveRuntimeHost<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, await activeRuntimeHostRef(), ...args) as Promise<T>;
}

async function invokeSelectedRuntimeHost<T>(
  host: DesktopRuntimeHostRef | undefined,
  channel: string,
  ...args: unknown[]
): Promise<T> {
  return ipcRenderer.invoke(channel, await selectedRuntimeHostScope(host), ...args) as Promise<T>;
}

function scopedRuntimeHost(scope: DesktopTargetScope): MakaBridge['runtimeHost'] {
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

async function invokeSessionRuntimeHost<T>(
  channel: string,
  sessionId: string,
  ...args: unknown[]
): Promise<T> {
  const session = await runtimeHostSessionRef(sessionId);
  return ipcRenderer.invoke(channel, session.scope, session.sessionId, ...args) as Promise<T>;
}

async function invokeRuntimeHostForSession<T>(
  channel: string,
  sessionId: string,
  ...args: unknown[]
): Promise<T> {
  const session = await runtimeHostSessionRef(sessionId);
  return ipcRenderer.invoke(channel, session.scope, ...args) as Promise<T>;
}

async function invokeProjectedSessionRuntimeHost<T>(
  channel: string,
  sessionId: string,
  ...args: unknown[]
): Promise<T> {
  const session = await runtimeHostSessionRef(sessionId);
  const value = await ipcRenderer.invoke(
    channel,
    session.scope,
    session.sessionId,
    ...args,
  ) as T;
  return projectProtocolSessionIds(session.scope.hostId, value);
}

async function invokeSessionSummary(
  channel: string,
  sessionId: string,
  ...args: unknown[]
): Promise<DesktopSessionSummary> {
  const session = await runtimeHostSessionRef(sessionId);
  const summary = await ipcRenderer.invoke(
    channel,
    session.scope,
    session.sessionId,
    ...args,
  ) as SessionSummary;
  return projectSessionSummary(session.scope, summary);
}

async function invokeSessionInput<T, I extends { readonly sessionId: string }>(
  channel: string,
  input: I,
  ...args: unknown[]
): Promise<T> {
  const session = await runtimeHostSessionRef(input.sessionId);
  return ipcRenderer.invoke(
    channel,
    session.scope,
    { ...input, sessionId: session.sessionId },
    ...args,
  ) as Promise<T>;
}

function projectSessionSummary(
  scope: DesktopTargetScope,
  session: SessionSummary,
): DesktopSessionSummary {
  const metadata = runtimeHostMetadata.get(scope.hostId);
  if (!metadata) throw new Error('Desktop Runtime Host metadata is unavailable');
  return projectDesktopSessionSummary(
    { ...scope, ...metadata },
    session,
  );
}

function projectOnboardingSnapshot(
  scope: DesktopTargetScope,
  snapshot: OnboardingSnapshot,
): OnboardingSnapshot {
  return {
    ...snapshot,
    sessions: snapshot.sessions.map((session) => projectSessionSummary(scope, session)),
    sessionSendOutcomes: Object.fromEntries(
      Object.entries(snapshot.sessionSendOutcomes).map(([sessionId, outcome]) => [
        desktopSessionKey({ hostId: scope.hostId, sessionId }),
        outcome,
      ]),
    ),
  };
}

async function loadDesktopOnboardingSnapshot(): Promise<OnboardingSnapshot> {
  const defaultScope = await activeRuntimeHostRef();
  const readyScopes = await runtimeHostScopeList();
  const scopes = [
    defaultScope,
    ...readyScopes.filter(
      (scope) =>
        scope.hostId !== defaultScope.hostId || scope.targetEpoch !== defaultScope.targetEpoch,
    ),
  ];
  const results = await Promise.allSettled(
    scopes.map(async (scope) => ({
      scope,
      snapshot: await ipcRenderer.invoke('onboarding:getSnapshot', scope) as OnboardingSnapshot,
    })),
  );
  const primary = results[0];
  if (!primary || primary.status === 'rejected') {
    throw primary?.reason ?? new Error('Default Runtime Host onboarding is unavailable');
  }
  const snapshots = results.flatMap((result) =>
    result.status === 'fulfilled'
      ? [projectOnboardingSnapshot(result.value.scope, result.value.snapshot)]
      : [],
  );
  return {
    ...snapshots[0],
    sessions: snapshots.flatMap((snapshot) => snapshot.sessions),
    sessionSendOutcomes: Object.assign(
      {},
      ...snapshots.map((snapshot) => snapshot.sessionSendOutcomes),
    ),
  };
}

function projectShellRunUpdate(
  scope: DesktopTargetScope,
  update: ShellRunUpdate,
): ShellRunUpdate {
  const sessionId = (value: string): string =>
    desktopSessionKey({ hostId: scope.hostId, sessionId: value });
  return {
    ...update,
    sessionId: sessionId(update.sessionId),
    ownership: update.ownership.kind === 'local'
      ? update.ownership
      : update.ownership.kind === 'source_owned'
        ? {
            ...update.ownership,
            sourceSessionId: sessionId(update.ownership.sourceSessionId),
            ownerSessionId: sessionId(update.ownership.ownerSessionId),
          }
        : {
            ...update.ownership,
            sourceSessionId: sessionId(update.ownership.sourceSessionId),
          },
  };
}

const SESSION_ID_FIELDS = new Set([
  'sessionId',
  'rootSessionId',
  'childSessionId',
  'sourceSessionId',
  'ownerSessionId',
]);

// Closed client models may be projected structurally. Opaque tool/provider data
// must use the typed projection above so user content is never rewritten.
function projectProtocolSessionIds<T>(hostId: string, value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => projectProtocolSessionIds(hostId, entry)) as T;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SESSION_ID_FIELDS.has(key) && typeof entry === 'string'
        ? desktopSessionKey({ hostId, sessionId: entry })
        : projectProtocolSessionIds(hostId, entry),
    ]),
  ) as T;
}

function subscribeRuntimeHostEvent<T extends readonly unknown[]>(
  channel: string,
  scope: DesktopTargetScope,
  handler: (...args: T) => void,
): () => void {
  const listener = (
    _event: Electron.IpcRendererEvent,
    value: unknown,
    ...args: unknown[]
  ): void => {
    let eventScope: DesktopTargetScope;
    try {
      eventScope = requireDesktopTargetScope(value);
    } catch {
      return;
    }
    const current = runtimeHostScopes.get(scope.hostId);
    if (
      !current ||
      eventScope.hostId !== current.hostId ||
      eventScope.targetEpoch !== current.targetEpoch ||
      eventScope.targetEpoch !== scope.targetEpoch
    ) return;
    handler(...(args as unknown as T));
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

function subscribeEveryRuntimeHostEvent<T extends readonly unknown[]>(
  channel: string,
  handler: (scope: DesktopTargetScope, ...args: T) => void,
): () => void {
  const listener = (
    _event: Electron.IpcRendererEvent,
    value: unknown,
    ...args: unknown[]
  ): void => {
    let scope: DesktopTargetScope;
    try {
      scope = requireDesktopTargetScope(value);
    } catch {
      return;
    }
    const current = runtimeHostScopes.get(scope.hostId);
    if (!current || current.targetEpoch !== scope.targetEpoch) return;
    handler(scope, ...(args as unknown as T));
  };
  ipcRenderer.on(channel, listener);
  void runtimeHostScopeList().catch(() => undefined);
  return () => {
    ipcRenderer.off(channel, listener);
  };
}

async function listDesktopSessions(
  filter?: SessionListFilter,
): Promise<DesktopSessionSummary[]> {
  if (filter?.subagentParentSessionId) {
    const parent = await runtimeHostSessionRef(filter.subagentParentSessionId);
    const sessions = await ipcRenderer.invoke(
      'sessions:list',
      parent.scope,
      { ...filter, subagentParentSessionId: parent.sessionId },
    ) as SessionSummary[];
    return sessions.map((session) => projectSessionSummary(parent.scope, session));
  }
  const scopes = await runtimeHostScopeList();
  const settled = await Promise.allSettled(
    scopes.map(async (scope) => {
      const sessions = await ipcRenderer.invoke('sessions:list', scope, filter) as SessionSummary[];
      const projected = sessions.map((session) => projectSessionSummary(scope, session));
      if (!filter) runtimeHostSessionCache.set(scope.hostId, projected);
      return projected;
    }),
  );
  const groups = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  if (groups.length === 0) {
    throw settled.find((result) => result.status === 'rejected')?.reason ??
      new Error('No Runtime Host is available');
  }
  const sessions = filter
    ? groups.flat()
    : [...runtimeHostSessionCache.values()].flat();
  return sessions.sort(
    (left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0),
  );
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
    let host: DesktopTargetScope;
    try {
      host = requireDesktopTargetScope(scope);
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

function subscribeSelectedRuntimeHostEvent<T extends readonly unknown[]>(
  channel: string,
  host: DesktopRuntimeHostRef | undefined,
  handler: (...args: T) => void,
): () => void {
  if (!host) return subscribeActiveRuntimeHostEvent(channel, handler);
  return subscribeEveryRuntimeHostEvent(channel, (scope, ...args: T) => {
    if (
      scope.hostId !== host.hostId ||
      runtimeHostProfiles.get(host.profileId) !== scope.hostId
    ) return;
    handler(...args);
  });
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
  const session = await runtimeHostSessionRef(sessionId);
  const host = scopedRuntimeHost(session.scope);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const first = await host.query('execution.inspect.query', {
      kind: 'session_trace_start',
      sessionId: session.sessionId,
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
        sessionId: session.sessionId,
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
  target?: DesktopRuntimeHostRef,
): Promise<DailyReviewConfig> {
  const host = scopedRuntimeHost(await selectedRuntimeHostScope(target));
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
}, host?: DesktopRuntimeHostRef): Promise<WebSearchResponse> {
  if (input.provider !== undefined && !isWebSearchProvider(input.provider)) {
    return Promise.resolve(unsupportedWebSearchProvider());
  }
  if (input.provider === 'model') {
    return Promise.resolve({
      ok: false,
      reason: 'unsupported_provider',
      message: '原生联网搜索由任务中的主模型请求执行，不支持从设置页单独调用。',
    });
  }
  const query = normalizeWebSearchQuery(input.query);
  if (!query) {
    return Promise.resolve({ ok: false, reason: 'invalid_query', message: '请输入有效的搜索关键词。' });
  }
  const apiKey = webSearchCredentialOverride(input.apiKey);
  return selectedRuntimeHostScope(host).then((scope) =>
    scopedRuntimeHost(scope).command('web-search.execute', {
      kind: 'query',
      query,
      limit: normalizeWebSearchLimit(input.limit),
      ...(apiKey ? { apiKey } : {}),
    }));
}

function executeWebSearchTest(input: {
  provider?: WebSearchProvider;
  apiKey?: string;
}, host?: DesktopRuntimeHostRef): Promise<WebSearchResponse> {
  if (input.provider !== undefined && !isWebSearchProvider(input.provider)) {
    return Promise.resolve(unsupportedWebSearchProvider());
  }
  if (input.provider === 'model') {
    return Promise.resolve({
      ok: false,
      reason: 'unsupported_provider',
      message: '原生联网搜索由任务中的主模型请求执行，不需要单独测试搜索凭据。',
    });
  }
  const apiKey = webSearchCredentialOverride(input.apiKey);
  return selectedRuntimeHostScope(host).then((scope) =>
    scopedRuntimeHost(scope).command('web-search.execute', {
      kind: 'test',
      provider: 'tavily',
      ...(apiKey ? { apiKey } : {}),
    }));
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

const browserDocumentId = crypto.randomUUID();
ipcRenderer.send('browser:document-ready', browserDocumentId);
const browserSelection = createBrowserSelectionCoordinator(runtimeHostSessionRef, {
  show(documentId, generation, session) {
    ipcRenderer.send(
      'browser:active-session',
      session.scope,
      session.sessionId,
      documentId,
      generation,
    );
  },
  hide(documentId, generation) {
    ipcRenderer.send('browser:hide-active-session', documentId, generation);
  },
  setViewport(documentId, generation, session, rect) {
    ipcRenderer.send(
      'browser:setViewport',
      session.scope,
      { sessionId: session.sessionId, rect },
      documentId,
      generation,
    );
  },
}, browserDocumentId);

const makaBridge = {
  runtimeHost,
  runtimeHostProfiles: {
    getSnapshot() {
      return ipcRenderer.invoke('runtime-host-profiles:getSnapshot');
    },
    addAndEnable(input: DesktopRuntimeHostProfileAddInput) {
      return ipcRenderer.invoke('runtime-host-profiles:add-and-enable', input);
    },
    remove(profileId: string) {
      return ipcRenderer.invoke('runtime-host-profiles:remove', profileId);
    },
    setEnabled(profileId: string, enabled: boolean) {
      return ipcRenderer.invoke('runtime-host-profiles:set-enabled', profileId, enabled);
    },
    setDefault(profileId: string) {
      return ipcRenderer.invoke('runtime-host-profiles:set-default', profileId);
    },
    subscribeChanges(handler: (event: DesktopRuntimeHostProfileChangedEvent) => void) {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: RuntimeHostProfileWireEvent,
      ) => {
        handler(payload);
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
  newTasks: {
    getCatalog(): Promise<DesktopNewTaskCatalog> {
      return loadNewTaskCatalog();
    },
    subscribeChanges(handler: () => void): () => void {
      newTaskChangeListeners.add(handler);
      const unsubscribes = [
        subscribeEveryRuntimeHostEvent('projects:changed', handler),
        subscribeEveryRuntimeHostEvent('connections:event', handler),
        subscribeEveryRuntimeHostEvent('mcp:changed', handler),
        subscribeEveryRuntimeHostEvent('settings:externalChanged', handler),
      ];
      return () => {
        newTaskChangeListeners.delete(handler);
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    async addProject(host: DesktopNewTaskHostRef) {
      const result = await ipcRenderer.invoke(
        'projects:add',
        await runtimeHostScope(host),
        { select: false },
      ) as
        | { ok: true; project: ProjectRecord; path: string }
        | { ok: false; reason: 'cancelled' };
      return result.ok ? { ok: true as const, project: result.project } : result;
    },
    async relinkProject(host: DesktopNewTaskHostRef, projectId: string) {
      return ipcRenderer.invoke(
        'projects:relink',
        await runtimeHostScope(host),
        projectId,
      );
    },
    async getConnections(host: DesktopNewTaskHostRef) {
      return ipcRenderer.invoke(
        'connections:getSnapshot',
        await runtimeHostScope(host),
      );
    },
    async listInvocableSkills(
      target: DesktopNewTaskTarget,
      context?: {
        llmConnectionSlug?: string;
        model?: string;
        collaborationMode?: 'agent' | 'plan';
        permissionMode?: import('@maka/core/settings').ChatDefaultPermissionMode;
      },
    ) {
      return ipcRenderer.invoke(
        'skills:listInvocable',
        await runtimeHostScope(target),
        undefined,
        { ...context, projectId: target.projectId },
      );
    },
    async getReadiness(
      target: DesktopNewTaskTarget,
      input?: DesktopTaskSubmissionReadinessRequest,
    ) {
      return ipcRenderer.invoke(
        'taskReadiness:getSnapshot',
        await runtimeHostScope(target),
        input,
      );
    },
    async searchFiles(
      target: DesktopNewTaskTarget,
      query: string,
      options?: { limit?: number },
    ) {
      return ipcRenderer.invoke(
        'workspace:searchFiles',
        await runtimeHostScope(target),
        { query, projectId: target.projectId, ...options },
      );
    },
    async create(
      target: DesktopNewTaskTarget,
      input?: CreateSessionRequestInput,
    ): Promise<DesktopSessionSummary> {
      const scope = await runtimeHostScope(target);
      const session = await ipcRenderer.invoke('sessions:create', scope, {
        ...input,
        projectId: target.projectId,
      }) as SessionSummary;
      return projectSessionSummary(scope, session);
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
      return invokeProjectedSessionRuntimeHost('tasks:list', sessionId);
    },
    subscribeChanges(handler: (event: TaskLedgerChangedEvent) => void): () => void {
      return subscribeEveryRuntimeHostEvent('tasks:changed', (scope, event: TaskLedgerChangedEvent) =>
        handler({
          ...event,
          sessionId: desktopSessionKey({ hostId: scope.hostId, sessionId: event.sessionId }),
        }),
      );
    },
  },
  deepResearch: {
    get(sessionId: string): Promise<DeepResearchClientProgress | undefined> {
      return invokeProjectedSessionRuntimeHost('deepResearch:get', sessionId);
    },
    subscribeChanges(handler: (event: DeepResearchChangedEvent) => void): () => void {
      return subscribeEveryRuntimeHostEvent('deepResearch:changed', (scope, event: DeepResearchChangedEvent) =>
        handler({
          ...event,
          sessionId: desktopSessionKey({ hostId: scope.hostId, sessionId: event.sessionId }),
        }),
      );
    },
  },
  graphs: {
    async getSnapshot(
      rootSessionId: string,
      options?: AgentGraphClientSnapshotOptions,
    ): Promise<AgentGraphClientSnapshot> {
      const session = await runtimeHostSessionRef(rootSessionId);
      const snapshot = await ipcRenderer.invoke(
        'graphs:getSnapshot', session.scope, session.sessionId, options,
      ) as AgentGraphClientSnapshot;
      return projectProtocolSessionIds(session.scope.hostId, snapshot);
    },
    async inspectOperator(
      rootSessionId: string,
      operatorId: string,
    ): Promise<AgentGraphOperatorInspection> {
      const session = await runtimeHostSessionRef(rootSessionId);
      const inspection = await ipcRenderer.invoke(
        'graphs:inspectOperator', session.scope, session.sessionId, operatorId,
      ) as AgentGraphOperatorInspection;
      return projectProtocolSessionIds(session.scope.hostId, inspection);
    },
    stop(rootSessionId: string): Promise<void> {
      return invokeSessionRuntimeHost('graphs:stop', rootSessionId);
    },
    subscribe(
      rootSessionId: string,
      handler: () => void,
    ): () => void {
      let disposed = false;
      const unsubscribes: Array<() => void> = [];
      void runtimeHostSessionRef(rootSessionId)
        .then(({ scope, sessionId }) => {
          if (disposed) return;
          const onChanged = (payload: { rootSessionId: string }): void => {
            if (payload.rootSessionId === sessionId) handler();
          };
          unsubscribes.push(
            subscribeRuntimeHostEvent('graphs:changed', scope, onChanged),
            subscribeRuntimeHostEvent('graphs:resync', scope, onChanged),
          );
        })
        .catch(() => undefined);
      return () => {
        disposed = true;
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
  },
  sessions: {
    list(filter?: SessionListFilter): Promise<DesktopSessionSummary[]> {
      return listDesktopSessions(filter);
    },
    /**
     * The single session-creation channel (#1433). `mode` names a
     * product intent — main derives the permission boundary, name and
     * labels it implies (`create-session-input.ts`); the renderer cannot
     * reach a boundary like `explore` by asking for it directly.
     */
    async create(input?: CreateSessionRequestInput): Promise<DesktopSessionSummary> {
      const scope = await activeRuntimeHostRef();
      const session = await ipcRenderer.invoke('sessions:create', scope, input) as SessionSummary;
      return projectSessionSummary(scope, session);
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
      const session = await runtimeHostSessionRef(sessionId);
      const send = async (input: SessionCommand | Record<string, unknown>) => {
        const result = await ipcRenderer.invoke(
          'sessions:send',
          session.scope,
          session.sessionId,
          input,
        ) as Awaited<ReturnType<MakaBridge['sessions']['send']>>;
        return result.ok
          ? {
              ...result,
              attachments: projectDesktopAttachmentRefs(session.scope, result.attachments),
            }
          : result;
      };
      if (command.type === 'send' && 'attachmentItems' in command && command.attachmentItems) {
        const encoded = await encodeIngestItems(command.attachmentItems as RendererIngestInput[]);
        return send({
          ...command,
          attachmentItems: encoded,
        });
      }
      return send(command);
    },
    compact(sessionId: string): Promise<void> {
      return invokeSessionRuntimeHost('sessions:compact', sessionId);
    },
    resumeLatest(sessionId: string): Promise<
      | { disposition: 'started'; runId: string; turnId: string }
      | { disposition: 'park'; rejectionReasons: string[]; diagnostics: unknown[] }
    > {
      return invokeSessionRuntimeHost('sessions:resumeLatest', sessionId);
    },
    stop(sessionId: string, input?: { source?: 'stop_button' }): Promise<void> {
      return invokeSessionRuntimeHost('sessions:stop', sessionId, input);
    },
    steer(sessionId: string, text: string): Promise<QueueEnqueueOutcome> {
      return invokeSessionRuntimeHost('sessions:steer', sessionId, text);
    },
    readExecutionBoundary(sessionId: string): Promise<ExecutionBoundaryReadModel> {
      return invokeSessionRuntimeHost('sessions:readExecutionBoundary', sessionId);
    },
    listActiveInteractions(sessionId: string): Promise<ActiveInteractionRequestEvent[]> {
      return invokeSessionRuntimeHost('sessions:listActiveInteractions', sessionId);
    },
    subscribeActiveInteractions(
      handler: (event: {
        sessionId: string;
        interactions: ActiveInteractionRequestEvent[];
      }) => void,
    ): () => void {
      return subscribeEveryRuntimeHostEvent(
        'sessions:active-interactions-changed',
        (scope, event: { sessionId: string; interactions: ActiveInteractionRequestEvent[] }) =>
          handler({
            ...event,
            sessionId: desktopSessionKey({ hostId: scope.hostId, sessionId: event.sessionId }),
          }),
      );
    },
    async listTurns(sessionId: string): Promise<TurnRecord[]> {
      const session = await runtimeHostSessionRef(sessionId);
      const turns = await ipcRenderer.invoke(
        'sessions:listTurns',
        session.scope,
        session.sessionId,
      ) as TurnRecord[];
      return turns.map((turn) => projectDesktopTurnRecord(session.scope, turn));
    },
    listTurnLandmarks(sessionId) {
      return invokeProjectedSessionRuntimeHost('sessions:listTurnLandmarks', sessionId);
    },
    regenerateTurn(sessionId: string, input: RegenerateTurnInput): Promise<void> {
      return invokeSessionRuntimeHost('sessions:regenerateTurn', sessionId, input);
    },
    async branchFromTurn(sessionId: string, input: DesktopBranchFromTurnInput): Promise<DesktopSessionSummary> {
      const ref = await runtimeHostSessionRef(sessionId);
      const summary = await ipcRenderer.invoke(
        'sessions:branchFromTurn', ref.scope, ref.sessionId, input,
      ) as SessionSummary;
      return projectSessionSummary(ref.scope, summary);
    },
    async reviseBeforeTurn(sessionId: string, input: DesktopReviseBeforeTurnInput): Promise<DesktopSessionSummary> {
      const ref = await runtimeHostSessionRef(sessionId);
      const summary = await ipcRenderer.invoke(
        'sessions:reviseBeforeTurn', ref.scope, ref.sessionId, input,
      ) as SessionSummary;
      return projectSessionSummary(ref.scope, summary);
    },
    respondToSandboxBoundary(sessionId: string, response: SandboxBoundaryResponse): Promise<void> {
      return invokeSessionRuntimeHost('sessions:respondToSandboxBoundary', sessionId, response);
    },
    respondToUserQuestion(sessionId: string, response: UserQuestionResponse): Promise<void> {
      return invokeSessionRuntimeHost('sessions:respondToUserQuestion', sessionId, response);
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
      onObservationSeed?: (phase: 'pending' | 'ready') => void,
    ): () => void {
      const observerId = crypto.randomUUID();
      let disposed = false;
      let unsubscribeEvents = () => {};
      let unsubscribeObservationSeed = () => {};
      const observeDispatch = runtimeHostSessionRef(sessionId).then((session) => {
        if (disposed) return { completion: Promise.resolve() };
        unsubscribeEvents = subscribeRuntimeHostEvent(
          `sessions:event:${session.sessionId}`,
          session.scope,
          (event: SessionEvent) => handler(projectDesktopSessionEvent(session.scope, event)),
        );
        unsubscribeObservationSeed = subscribeRuntimeHostEvent(
          'sessions:observation-seed',
          session.scope,
          (payload: { sessionId?: string; phase?: string }) => {
            if (payload.sessionId !== session.sessionId) return;
            if (payload.phase === 'pending' || payload.phase === 'ready') {
              onObservationSeed?.(payload.phase);
            }
          },
        );
        return {
          completion: ipcRenderer.invoke(
            'sessions:observe',
            session.scope,
            session.sessionId,
            observerId,
          ),
        };
      });
      const observing = observeDispatch.then(({ completion }) => completion);
      const disposeSeedNotification = notifyWhenSeeded(observing, onSeeded);
      return () => {
        disposed = true;
        disposeSeedNotification();
        unsubscribeObservationSeed();
        unsubscribeEvents();
        void releaseSessionObservation(observeDispatch, () =>
          ipcRenderer.invoke('sessions:unobserve', observerId),
        ).catch(() => undefined);
      };
    },
    subscribeChanges(handler: (event: SessionChangedEvent) => void): () => void {
      return subscribeEveryRuntimeHostEvent(
        'sessions:changed',
        (scope, event: SessionChangedEvent) =>
          handler({
            ...event,
            ...(event.sessionId
              ? {
                  sessionId: desktopSessionKey({
                    hostId: scope.hostId,
                    sessionId: event.sessionId,
                  }),
                }
              : {}),
          }),
      );
    },
    archive(sessionId: string, options?: { revisionFamily?: boolean }): Promise<void> {
      return invokeSessionRuntimeHost('sessions:archive', sessionId, options);
    },
    unarchive(sessionId: string, options?: { revisionFamily?: boolean }): Promise<void> {
      return invokeSessionRuntimeHost('sessions:unarchive', sessionId, options);
    },
    setFlagged(sessionId: string, isFlagged: boolean, options?: { revisionFamily?: boolean }): Promise<void> {
      return invokeSessionRuntimeHost('sessions:setFlagged', sessionId, isFlagged, options);
    },
    rename(sessionId: string, name: string, options?: { revisionFamily?: boolean }): Promise<void> {
      return invokeSessionRuntimeHost('sessions:rename', sessionId, name, options);
    },
    setPermissionMode(sessionId: string, mode: PermissionMode): Promise<DesktopSessionSummary> {
      return invokeSessionSummary('sessions:setPermissionMode', sessionId, mode);
    },
    setCollaborationMode(sessionId: string, mode: CollaborationMode): Promise<DesktopSessionSummary> {
      return invokeSessionSummary('sessions:setCollaborationMode', sessionId, mode);
    },
    setOrchestrationMode(sessionId: string, mode: OrchestrationMode): Promise<DesktopSessionSummary> {
      return invokeSessionSummary('sessions:setOrchestrationMode', sessionId, mode);
    },
    getPlanState(sessionId: string): Promise<PlanSessionState> {
      return invokeProjectedSessionRuntimeHost('plan-mode:getState', sessionId);
    },
    subscribePlanChanges(sessionId: string, handler: () => void): () => void {
      let disposed = false;
      let unsubscribe = () => {};
      void runtimeHostSessionRef(sessionId)
        .then((session) => {
          if (disposed) return;
          unsubscribe = subscribeRuntimeHostEvent(
            'plan-mode:changed',
            session.scope,
            (payload: { sessionId: string }) => {
              if (payload.sessionId === session.sessionId) handler();
            },
          );
        })
        .catch(() => undefined);
      return () => {
        disposed = true;
        unsubscribe();
      };
    },
    requestPlanRevision(sessionId: string, proposalId: string): Promise<PlanSessionState> {
      return invokeProjectedSessionRuntimeHost('plan-mode:requestRevision', sessionId, proposalId);
    },
    abandonPlanProposal(
      sessionId: string,
      proposalId: string,
    ): Promise<PlanSessionState> {
      return invokeProjectedSessionRuntimeHost('plan-mode:abandon', sessionId, proposalId);
    },
    approvePlan(sessionId: string, input: {
      proposalId: string;
      expectedRevision: number;
      expectedStoreVersion: number;
      turnId: string;
    }): Promise<{ turnId: string; executionId: string }> {
      return invokeSessionRuntimeHost('plan-mode:approve', sessionId, input);
    },
    resumePlan(sessionId: string, executionId: string, turnId: string): Promise<{
      turnId: string;
      executionId: string;
    }> {
      return invokeSessionRuntimeHost('plan-mode:resume', sessionId, executionId, turnId);
    },
    abandonPlanExecution(sessionId: string, executionId: string): Promise<PlanSessionState> {
      return invokeProjectedSessionRuntimeHost('plan-mode:abandonExecution', sessionId, executionId);
    },
    setModel(sessionId: string, input: { llmConnectionSlug: string; model: string }): Promise<DesktopSessionSummary> {
      return invokeSessionSummary('sessions:setModel', sessionId, input);
    },
    setThinkingLevel(sessionId: string, level: ThinkingLevel | undefined | null): Promise<DesktopSessionSummary> {
      return invokeSessionSummary('sessions:setThinkingLevel', sessionId, level ?? undefined);
    },
    remove(
      sessionId: string,
      options?: { revisionFamily?: boolean; requireArchived?: boolean },
    ): Promise<'removed' | 'restored'> {
      return invokeSessionRuntimeHost('sessions:remove', sessionId, options);
    },
    cleanupSessionCopy(sessionId: string): Promise<void> {
      return invokeSessionRuntimeHost('sessions:cleanupSessionCopy', sessionId);
    },
    async abandonSessionCopy(sourceSessionId: string, copyId: string): Promise<void> {
      const source = await runtimeHostSessionRef(sourceSessionId);
      await ipcRenderer.invoke('sessions:abandonSessionCopy', source.scope, copyId);
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
      let consumerScope: DesktopTargetScope | undefined;
      const listener = (
        _event: Electron.IpcRendererEvent,
        scope: unknown,
        value: unknown,
      ) => {
        if (closed) return;
        let batch: DesktopTranscriptBatch;
        try {
          const host = requireDesktopTargetScope(scope);
          if (
            !consumerScope ||
            host.hostId !== consumerScope.hostId ||
            host.targetEpoch !== consumerScope.targetEpoch
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
      const openDispatch = runtimeHostSessionRef(sessionId).then((session) => {
        consumerScope = session.scope;
        return {
          completion: ipcRenderer.invoke(
            'sessions:transcript:open',
            session.scope,
            session.sessionId,
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
        sessionId,
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
    listSources(host?: DesktopRuntimeHostRef): Promise<{ adapterIds: string[] }> {
      return invokeSelectedRuntimeHost(host, 'external-sessions:listSources');
    },
    list(input: {
      adapterId: string;
      includeArchived?: boolean;
      cursor?: string;
    }, host?: DesktopRuntimeHostRef): Promise<{
      sessions: ExternalSessionSummary[];
      nextCursor: string | null;
    }> {
      return invokeSelectedRuntimeHost(host, 'external-sessions:list', input);
    },
    async import(input: {
      adapterId: string;
      sourceSessionId: string;
    }, host?: DesktopRuntimeHostRef): Promise<ExternalSessionImportIpcResult<DesktopSessionSummary>> {
      const scope = await selectedRuntimeHostScope(host);
      const result = await ipcRenderer.invoke(
        'external-sessions:import', scope, input,
      ) as ExternalSessionImportIpcResult;
      return result.ok
        ? { ...result, session: projectSessionSummary(scope, result.session) }
        : result;
    },
  },
  projects: {
    async getDefaultContext(): Promise<{
      snapshot: DesktopProjectSnapshot;
      info: DesktopAppInfo;
    }> {
      const scope = await activeRuntimeHostRef();
      const [snapshot, info] = await Promise.all([
        ipcRenderer.invoke('projects:getSnapshot', scope) as Promise<DesktopProjectSnapshot>,
        ipcRenderer.invoke('app:info', scope) as Promise<DesktopAppInfo>,
      ]);
      return { snapshot, info };
    },
    getSnapshot(sessionId?: string, host?: DesktopRuntimeHostRef): Promise<DesktopProjectSnapshot> {
      return sessionId
        ? invokeSessionRuntimeHost('projects:getSnapshot', sessionId)
        : invokeSelectedRuntimeHost(host, 'projects:getSnapshot');
    },
    subscribeChanges(handler: () => void, sessionId?: string, host?: DesktopRuntimeHostRef): () => void {
      if (!sessionId) return subscribeSelectedRuntimeHostEvent('projects:changed', host, handler);
      let disposed = false;
      let unsubscribe = (): void => {};
      void runtimeHostSessionRef(sessionId).then((session) => {
        if (disposed) return;
        unsubscribe = subscribeRuntimeHostEvent('projects:changed', session.scope, handler);
      }).catch(() => undefined);
      return () => {
        disposed = true;
        unsubscribe();
      };
    },
    async getLocalSnapshot(): Promise<DesktopProjectSnapshot> {
      return ipcRenderer.invoke(
        'projects:getSnapshot',
        await localRuntimeHostRef(),
      ) as Promise<DesktopProjectSnapshot>;
    },
    subscribeLocalChanges(handler: () => void): () => void {
      return subscribeEveryRuntimeHostEvent('projects:changed', (scope) => {
        if (runtimeHostMetadata.get(scope.hostId)?.profileKind === 'local') handler();
      });
    },
    add(host?: DesktopRuntimeHostRef): Promise<
      { ok: true; project: ProjectRecord; path: string } | { ok: false; reason: 'cancelled' }
    > {
      return invokeSelectedRuntimeHost(host, 'projects:add');
    },
    getDirectoryRoots(host: DesktopRuntimeHostRef) {
      return invokeSelectedRuntimeHost(host, 'projects:directoryRoots');
    },
    listDirectory(
      input: { readonly rootId: string; readonly segments: readonly string[] },
      host: DesktopRuntimeHostRef,
    ) {
      return invokeSelectedRuntimeHost(host, 'projects:listDirectory', input);
    },
    registerDirectory(
      input: { readonly rootId: string; readonly segments: readonly string[] },
      host: DesktopRuntimeHostRef,
    ) {
      return invokeSelectedRuntimeHost(host, 'projects:registerDirectory', input);
    },
    select(
      projectId: string | null,
      host?: DesktopRuntimeHostRef,
    ): Promise<{ project: ProjectRecord | null; path: string }> {
      return invokeSelectedRuntimeHost(host, 'projects:select', projectId);
    },
    relink(projectId: string, host?: DesktopRuntimeHostRef): Promise<
      { ok: true; project: ProjectRecord } | { ok: false; reason: 'cancelled' }
    > {
      return invokeSelectedRuntimeHost(host, 'projects:relink', projectId);
    },
    reveal(projectId: string, host?: DesktopRuntimeHostRef): Promise<
      | { ok: true; opened: string }
      | {
          ok: false;
          reason: 'unknown-key' | 'not-allowed' | 'missing' | 'not-a-directory' | 'open-failed';
        }
    > {
      return invokeSelectedRuntimeHost(host, 'projects:reveal', projectId);
    },
    rename(projectId: string, name: string, host?: DesktopRuntimeHostRef): Promise<ProjectRecord> {
      return invokeSelectedRuntimeHost(host, 'projects:rename', projectId, name);
    },
    archive(projectId: string, host?: DesktopRuntimeHostRef): Promise<ProjectRecord> {
      return invokeSelectedRuntimeHost(host, 'projects:archive', projectId);
    },
    restore(projectId: string, host?: DesktopRuntimeHostRef): Promise<ProjectRecord> {
      return invokeSelectedRuntimeHost(host, 'projects:restore', projectId);
    },
  },
  shellRuns: {
    async list(sessionId: string): Promise<ShellRunUpdate[]> {
      const session = await runtimeHostSessionRef(sessionId);
      const updates = await ipcRenderer.invoke(
        'shell-runs:list', session.scope, session.sessionId,
      ) as ShellRunUpdate[];
      return updates.map((update) => projectShellRunUpdate(session.scope, update));
    },
    async attach(input: {
      sessionId: string;
      ref: string;
    }): Promise<ShellRunPtySnapshot | null> {
      const session = await runtimeHostSessionRef(input.sessionId);
      const snapshot = await ipcRenderer.invoke('shell-runs:attach', session.scope, {
        ...input,
        sessionId: session.sessionId,
      }) as ShellRunPtySnapshot | null;
      return snapshot
        ? {
            ...snapshot,
            sessionId: desktopSessionKey({
              hostId: session.scope.hostId,
              sessionId: snapshot.sessionId,
            }),
          }
        : null;
    },
    detach(input: { sessionId: string; ref: string }): Promise<void> {
      return invokeSessionInput('shell-runs:detach', input);
    },
    async start(sessionId: string): Promise<ShellRunUpdate> {
      const session = await runtimeHostSessionRef(sessionId);
      const update = await ipcRenderer.invoke(
        'shell-runs:start', session.scope, session.sessionId,
      ) as ShellRunUpdate;
      return projectShellRunUpdate(session.scope, update);
    },
    async write(input: {
      sessionId: string;
      ref: string;
      input?: string;
      size?: { cols: number; rows: number };
    }): Promise<ShellRunUpdate | null> {
      const session = await runtimeHostSessionRef(input.sessionId);
      const update = await ipcRenderer.invoke('shell-runs:write', session.scope, {
        ...input,
        sessionId: session.sessionId,
      }) as ShellRunUpdate | null;
      return update ? projectShellRunUpdate(session.scope, update) : null;
    },
    async stop(input: {
      sessionId: string;
      ref: string;
    }): Promise<ShellRunUpdate | null> {
      const session = await runtimeHostSessionRef(input.sessionId);
      const update = await ipcRenderer.invoke('shell-runs:stop', session.scope, {
        ...input,
        sessionId: session.sessionId,
      }) as ShellRunUpdate | null;
      return update ? projectShellRunUpdate(session.scope, update) : null;
    },
    subscribeUpdates(handler: (update: ShellRunUpdate) => void): () => void {
      return subscribeEveryRuntimeHostEvent('shell-runs:update', (scope, update: ShellRunUpdate) =>
        handler(projectShellRunUpdate(scope, update)),
      );
    },
    subscribePtyData(handler: (event: ShellRunPtyDataEvent) => void): () => void {
      return subscribeEveryRuntimeHostEvent('shell-runs:pty-data', (scope, event: ShellRunPtyDataEvent) =>
        handler({
          ...event,
          sessionId: desktopSessionKey({ hostId: scope.hostId, sessionId: event.sessionId }),
        }),
      );
    },
    subscribeResync(handler: (event: { sessionId: string }) => void): () => void {
      return subscribeEveryRuntimeHostEvent('shell-runs:resync', (scope, event: { sessionId: string }) =>
        handler({
          sessionId: desktopSessionKey({ hostId: scope.hostId, sessionId: event.sessionId }),
        }),
      );
    },
  },
  gitReview: {
    read(input: {
      sessionId: string;
      source: GitReviewSource;
      baseBranch?: string;
    }): Promise<GitReviewReadResult> {
      return invokeSessionInput('git-review:read', input);
    },
  },
  goal: {
    get(sessionId: string): Promise<GoalState | null> {
      return invokeProjectedSessionRuntimeHost('goal:get', sessionId);
    },
    clear(sessionId: string): Promise<void> {
      return invokeSessionRuntimeHost('goal:clear', sessionId);
    },
  },
  connections: {
    getSnapshot(sessionId?: string, host?: DesktopRuntimeHostRef) {
      return sessionId
        ? invokeRuntimeHostForSession('connections:getSnapshot', sessionId)
        : invokeSelectedRuntimeHost(host, 'connections:getSnapshot');
    },
    setDefault(slug: string | null, host?: DesktopRuntimeHostRef): Promise<void> {
      return invokeSelectedRuntimeHost(host, 'connections:setDefault', slug);
    },
    setDefaultModel(input: { slug: string; model: string } | null, host?: DesktopRuntimeHostRef): Promise<void> {
      return invokeSelectedRuntimeHost(host, 'connections:setDefaultModel', input);
    },
    create(input: CreateConnectionInput, host?: DesktopRuntimeHostRef): Promise<LlmConnection> {
      return invokeSelectedRuntimeHost(host, 'connections:create', input);
    },
    update(slug: string, patch: UpdateConnectionInput, host?: DesktopRuntimeHostRef): Promise<LlmConnection> {
      return invokeSelectedRuntimeHost(host, 'connections:update', slug, patch);
    },
    delete(slug: string, host?: DesktopRuntimeHostRef): Promise<void> {
      return invokeSelectedRuntimeHost(host, 'connections:delete', slug);
    },
    test(slug: string, opts?: { model?: string }, host?: DesktopRuntimeHostRef): Promise<ConnectionTestResult> {
      return invokeSelectedRuntimeHost(host, 'connections:test', slug, opts);
    },
    fetchModels(slug: string, host?: DesktopRuntimeHostRef): Promise<ModelDiscoveryResult> {
      return invokeSelectedRuntimeHost(host, 'connections:fetchModels', slug);
    },
    hasSecret(slug: string, host?: DesktopRuntimeHostRef): Promise<boolean> {
      return invokeSelectedRuntimeHost(host, 'connections:hasSecret', slug);
    },
    getRequestHeaders(slug: string, host?: DesktopRuntimeHostRef): Promise<import('@maka/core/llm-connections').SavedRequestHeaders> {
      return invokeSelectedRuntimeHost(host, 'connections:getRequestHeaders', slug);
    },
    setRequestHeaders(
      slug: string,
      headers: readonly import('@maka/core/llm-connections').RequestHeaderUpdate[],
      host?: DesktopRuntimeHostRef,
    ): Promise<import('@maka/core/llm-connections').SavedRequestHeaders> {
      return invokeSelectedRuntimeHost(host, 'connections:setRequestHeaders', slug, headers);
    },
    subscribeEvents(handler: (event: ConnectionEvent) => void, host?: DesktopRuntimeHostRef): () => void {
      return host
        ? subscribeSelectedRuntimeHostEvent('connections:event', host, handler)
        : subscribeEveryRuntimeHostEvent(
            'connections:event',
            (_scope, event: ConnectionEvent) => handler(event),
          );
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
    subscribeChanges(handler: (statuses: McpServerStatus[]) => void): () => void {
      return subscribeActiveRuntimeHostEvent('mcp:changed', handler);
    },
  },
  // PR110b: onboarding snapshot + milestone IPCs. Renderer polls
  // `getSnapshot()` on app load and re-polls on existing invalidations.
  // Onboarding state and connection setup belong to the default Host; bounded
  // Session summaries and send outcomes are merged from every ready Host.
  onboarding: {
    getSnapshot(): Promise<OnboardingSnapshot> {
      return loadDesktopOnboardingSnapshot();
    },
    async setMilestone(
      id: OnboardingMilestoneId,
      status: 'completed' | 'skipped',
    ): Promise<OnboardingSnapshot> {
      const scope = await activeRuntimeHostRef();
      const snapshot = await ipcRenderer.invoke(
        'onboarding:setMilestone', scope, id, status,
      ) as OnboardingSnapshot;
      return projectOnboardingSnapshot(scope, snapshot);
    },
  },
  taskReadiness: {
    getSnapshot(input?: DesktopTaskSubmissionReadinessRequest, sessionId?: string) {
      return sessionId
        ? invokeRuntimeHostForSession('taskReadiness:getSnapshot', sessionId, input)
        : invokeActiveRuntimeHost('taskReadiness:getSnapshot', input);
    },
  },
  permissions: {
    getSnapshot(host?: DesktopRuntimeHostRef): Promise<PermissionSnapshot> {
      return invokeSelectedRuntimeHost(host, 'permissions:getSnapshot');
    },
    openSystemSettings(permId: string, host?: DesktopRuntimeHostRef): Promise<PermissionActionResult> {
      return invokeSelectedRuntimeHost(host, 'permissions:openSystemSettings', permId);
    },
    requestAccess(permId: string, host?: DesktopRuntimeHostRef): Promise<PermissionActionResult> {
      return invokeSelectedRuntimeHost(host, 'permissions:requestAccess', permId);
    },
    startDragOnboarding(permId: string, host?: DesktopRuntimeHostRef): Promise<PermissionOverlayStartResult> {
      return invokeSelectedRuntimeHost(host, 'permissions:startDragOnboarding', permId);
    },
  },
  capabilities: {
    getSnapshot(host?: DesktopRuntimeHostRef): Promise<CapabilitySnapshotCollection> {
      return invokeSelectedRuntimeHost(host, 'capabilities:getSnapshot');
    },
  },
  health: {
    getSnapshot(host?: DesktopRuntimeHostRef): Promise<HealthSnapshot> {
      return invokeSelectedRuntimeHost(host, 'health:getSnapshot');
    },
  },
  memory: {
    getState(sessionId?: string, host?: DesktopRuntimeHostRef): Promise<LocalMemoryState> {
      return sessionId
        ? invokeRuntimeHostForSession('memory:getState', sessionId)
        : invokeSelectedRuntimeHost(host, 'memory:getState');
    },
    save(content: string, host?: DesktopRuntimeHostRef): Promise<LocalMemoryState> {
      return invokeSelectedRuntimeHost(host, 'memory:save', content);
    },
    reset(host?: DesktopRuntimeHostRef): Promise<LocalMemoryState> {
      return invokeSelectedRuntimeHost(host, 'memory:reset');
    },
    restoreLatestBackup(host?: DesktopRuntimeHostRef): Promise<{ ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }> {
      return invokeSelectedRuntimeHost(host, 'memory:restoreLatestBackup');
    },
    restoreBackup(kind: 'save' | 'reset' | 'restore', host?: DesktopRuntimeHostRef): Promise<{ ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }> {
      return invokeSelectedRuntimeHost(host, 'memory:restoreBackup', kind);
    },
    setEnabled(enabled: boolean, host?: DesktopRuntimeHostRef): Promise<LocalMemoryState> {
      return invokeSelectedRuntimeHost(host, 'memory:setEnabled', enabled);
    },
    setAgentReadEnabled(enabled: boolean, host?: DesktopRuntimeHostRef): Promise<LocalMemoryState> {
      return invokeSelectedRuntimeHost(host, 'memory:setAgentReadEnabled', enabled);
    },
    openFile(host?: DesktopRuntimeHostRef): Promise<{ ok: true } | { ok: false; message: string }> {
      return invokeSelectedRuntimeHost(host, 'memory:openFile');
    },
    openLatestBackup(host?: DesktopRuntimeHostRef): Promise<{ ok: true } | { ok: false; message: string }> {
      return invokeSelectedRuntimeHost(host, 'memory:openLatestBackup');
    },
    openBackup(kind: 'save' | 'reset' | 'restore', host?: DesktopRuntimeHostRef): Promise<{ ok: true } | { ok: false; message: string }> {
      return invokeSelectedRuntimeHost(host, 'memory:openBackup', kind);
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
      return invokeSessionRuntimeHost('attachments:readBytes', sessionId, relativePath);
    },
  },
  search: {
    // Search each ready Host independently; a remote profile sends the query
    // over that Host's authenticated connection, never through telemetry.
    async thread(request: SearchRequest): Promise<SearchResult[] | { ok: false; reason: SearchErrorReason; message: string }> {
      const scopes = await runtimeHostScopeList();
      return collectThreadSearchResponses(
        scopes.map(async (scope) => {
          const result = await ipcRenderer.invoke('search:thread', scope, request) as
            | SearchResult[]
            | { ok: false; reason: SearchErrorReason; message: string };
          return Array.isArray(result)
            ? result.map((entry) =>
                entry.target?.kind === 'thread'
                  ? {
                      ...entry,
                      target: {
                        ...entry.target,
                        sessionId: desktopSessionKey({
                          hostId: scope.hostId,
                          sessionId: entry.target.sessionId,
                        }),
                      },
                    }
                  : entry,
              )
            : result;
        }),
        request.limit,
      );
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
    isExperimentalEnabled(host?: DesktopRuntimeHostRef): Promise<boolean> {
      return invokeSelectedRuntimeHost(host, 'claude-subscription:is-experimental-enabled');
    },
    getAuthUrl(host?: DesktopRuntimeHostRef): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'claude-subscription:get-auth-url');
    },
    openAuthUrl(authRequestId: string, host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'claude-subscription:open-auth-url', authRequestId);
    },
    completeAuthorization(authRequestId: string, pasted: string, host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'claude-subscription:complete-authorization', authRequestId, pasted);
    },
    cancelAuthorization(authRequestId?: string, host?: DesktopRuntimeHostRef): Promise<{ ok: true }> {
      return invokeSelectedRuntimeHost(host, 'claude-subscription:cancel-authorization', authRequestId);
    },
    getAccountState(host?: DesktopRuntimeHostRef): Promise<SubscriptionAccountState> {
      return invokeSelectedRuntimeHost(host, 'claude-subscription:get-account-state');
    },
    refreshQuota(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'claude-subscription:refresh-quota');
    },
    refreshTokens(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'claude-subscription:refresh-tokens');
    },
    logout(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'claude-subscription:logout');
    },
  },
  // Browser-assisted Codex account bridge. Same shape as
  // `claudeSubscription`: no token-shaped fields cross preload, the
  // authorization attempt stays opaque, and actions return envelopes.
  openAiCodex: {
    isExperimentalEnabled(host?: DesktopRuntimeHostRef): Promise<boolean> {
      return invokeSelectedRuntimeHost(host, 'openai-codex:is-experimental-enabled');
    },
    getAuthUrl(host?: DesktopRuntimeHostRef): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'openai-codex:get-auth-url');
    },
    openAuthUrl(authRequestId: string, host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'openai-codex:open-auth-url', authRequestId);
    },
    completeAuthorization(authRequestId: string, host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'openai-codex:complete-authorization', authRequestId);
    },
    cancelAuthorization(authRequestId?: string, host?: DesktopRuntimeHostRef): Promise<{ ok: true }> {
      return invokeSelectedRuntimeHost(host, 'openai-codex:cancel-authorization', authRequestId);
    },
    getAccountState(host?: DesktopRuntimeHostRef): Promise<{
      provider: 'openai-codex';
      runtimeState: 'not_logged_in' | 'authorizing' | 'authenticated' | 'refreshing' | 'refresh_failed';
      accountId?: string;
      email?: string;
      plan?: string;
      picture?: string;
      errorMessage?: string;
    }> {
      return invokeSelectedRuntimeHost(host, 'openai-codex:get-account-state');
    },
    refreshTokens(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'openai-codex:refresh-tokens');
    },
    logout(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'openai-codex:logout');
    },
  },
  xaiOAuth: {
    getAuthUrl(host?: DesktopRuntimeHostRef): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'xai-oauth:get-auth-url');
    },
    openAuthUrl(authRequestId: string, host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'xai-oauth:open-auth-url', authRequestId);
    },
    completeAuthorization(authRequestId: string, host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'xai-oauth:complete-authorization', authRequestId);
    },
    cancelAuthorization(authRequestId?: string, host?: DesktopRuntimeHostRef): Promise<{ ok: true }> {
      return invokeSelectedRuntimeHost(host, 'xai-oauth:cancel-authorization', authRequestId);
    },
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
    }> {
      return invokeSelectedRuntimeHost(host, 'xai-oauth:get-account-state');
    },
    refreshTokens(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'xai-oauth:refresh-tokens');
    },
    logout(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'xai-oauth:logout');
    },
  },
  githubCopilotSubscription: {
    connectExistingLogin(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'github-copilot:connect-existing-login');
    },
    getAccountState(host?: DesktopRuntimeHostRef): Promise<{
      provider: 'github-copilot';
      runtimeState: 'not_logged_in' | 'authenticated' | 'refreshing' | 'refresh_failed' | 'storage_failed';
      errorMessage?: string;
    }> {
      return invokeSelectedRuntimeHost(host, 'github-copilot:get-account-state');
    },
    refreshTokens(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'github-copilot:refresh-tokens');
    },
    logout(host?: DesktopRuntimeHostRef): Promise<SubscriptionActionResult> {
      return invokeSelectedRuntimeHost(host, 'github-copilot:logout');
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
      return subscribeEveryRuntimeHostEvent(
        'scheduled-tasks:fired',
        (_scope, task: Pick<ScheduledTask, 'id' | 'title'>) => handler(task),
      );
    },
  },
  settings: {
    getClient(): Promise<AppSettings> {
      return ipcRenderer.invoke('settings:client:get');
    },
    get(host?: DesktopRuntimeHostRef): Promise<AppSettings> {
      return invokeSelectedRuntimeHost(host, 'settings:get');
    },
    updateClient(patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsResult> {
      return ipcRenderer.invoke('settings:client:update', patch);
    },
    update(patch: UpdateAppSettingsInput, host?: DesktopRuntimeHostRef): Promise<UpdateAppSettingsResult> {
      return invokeSelectedRuntimeHost(host, 'settings:update', patch);
    },
    subscribeClientChanged(handler: () => void): () => void {
      const listener = () => handler();
      ipcRenderer.on('settings:clientChanged', listener);
      return () => ipcRenderer.off('settings:clientChanged', listener);
    },
    subscribeExternalChanged(handler: () => void, host?: DesktopRuntimeHostRef): () => void {
      return subscribeSelectedRuntimeHostEvent('settings:externalChanged', host, handler);
    },
    testNetworkProxy(input?: TestProxyInput, host?: DesktopRuntimeHostRef): Promise<SettingsTestResult> {
      return invokeSelectedRuntimeHost(host, 'settings:testNetworkProxy', input);
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
        const listener = (_event: Electron.IpcRendererEvent, status: BotStatus) => handler(status);
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
        async () => {
          const session = await runtimeHostSessionRef(sessionId);
          return scopedRuntimeHost(session.scope).query('context.diagnostics.query', {
            sessionId: session.sessionId,
          });
        },
        'INSPECTOR_CONTEXT_FAILED',
      );
    },
  },
  dailyReview: {
    day(offsetDays: number, daySpan?: number): Promise<Result<DailyReviewSummary>> {
      return bridgeResult(async () => {
        const scope = await activeRuntimeHostRef();
        const result = await scopedRuntimeHost(scope).query('daily-review.query', {
          kind: 'summary',
          offsetDays: integer(offsetDays, 0),
          daySpan: Math.max(1, Math.min(30, integer(daySpan, 1))),
        });
        if (result.kind !== 'summary') throw new Error('Invalid Daily Review summary');
        return projectDesktopDailyReviewSummary(scope, result.summary);
      }, 'DAILY_REVIEW_DAY_FAILED');
    },
    async getConfig(host?: DesktopRuntimeHostRef): Promise<DailyReviewConfig> {
      const result = await scopedRuntimeHost(
        await selectedRuntimeHostScope(host),
      ).query('daily-review.query', {
        kind: 'config',
      });
      if (result.kind !== 'config') throw new Error('Invalid Daily Review config');
      return result.config;
    },
    setConfig(patch: Partial<DailyReviewConfig>, host?: DesktopRuntimeHostRef): Promise<DailyReviewConfig> {
      return updateDailyReviewConfig(patch, host);
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
    }, host?: DesktopRuntimeHostRef): Promise<WebSearchResponse> {
      return executeWebSearchQuery(input, host);
    },
    test(input: { provider?: WebSearchProvider; apiKey?: string }, host?: DesktopRuntimeHostRef): Promise<WebSearchResponse> {
      return executeWebSearchTest(input, host);
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
    export(input: { categories: ConfigCategory[] }, host?: DesktopRuntimeHostRef): Promise<
      | { ok: false; reason: 'no_categories' | 'canceled' }
      | { ok: true; path: string; includedData: ConfigCategory[] }
    > {
      return invokeSelectedRuntimeHost(host, 'config:export', input);
    },
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
    > {
      return invokeSelectedRuntimeHost(host, 'config:import', input);
    },
  },
  app: {
    info(host?: DesktopRuntimeHostRef): Promise<DesktopAppInfo> {
      return invokeSelectedRuntimeHost(host, 'app:info');
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
      return invokeSessionRuntimeHost('app:sessionProjectInfo', sessionId);
    },
    openPath(
      key: 'workspace' | 'skills' | 'memory' | 'project',
      sessionId?: string,
      host?: DesktopRuntimeHostRef,
    ): Promise<
      | { ok: true; opened: string }
      | {
          ok: false;
          reason: 'unknown-key' | 'not-allowed' | 'missing' | 'not-a-directory' | 'open-failed';
        }
    > {
      if (!sessionId) return invokeSelectedRuntimeHost(host, 'app:openPath', key, undefined);
      return runtimeHostSessionRef(sessionId).then((session) =>
        ipcRenderer.invoke('app:openPath', session.scope, key, session.sessionId),
      );
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
      return invokeSessionRuntimeHost('app:openArtifactPath', sessionId, artifactId);
    },
    saveArtifactAs(sessionId: string, artifactId: string): Promise<ArtifactSaveResult> {
      return invokeSessionRuntimeHost('app:saveArtifactAs', sessionId, artifactId);
    },
  },
  diagnostics: {
    async copyErrorReport(input: DesktopErrorDiagnosticInput): Promise<DesktopDiagnosticCopyResult> {
      if (!input.execution) {
        return invokeActiveRuntimeHost('diagnostics:copyErrorReport', input);
      }
      const session = await runtimeHostSessionRef(input.execution.sessionId);
      return ipcRenderer.invoke('diagnostics:copyErrorReport', session.scope, {
        ...input,
        execution: { ...input.execution, sessionId: session.sessionId },
      });
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
      return options?.sessionId
        ? invokeSessionInput('workspace:searchFiles', { query, ...options } as {
            query: string;
            sessionId: string;
            limit?: number;
          })
        : invokeActiveRuntimeHost('workspace:searchFiles', { query, ...options });
    },
  },
  e2eFixture: {
    async getState(): Promise<E2eFixtureState | null> {
      const state = await ipcRenderer.invoke('e2eFixture:getState') as E2eFixtureState | null;
      if (!state?.activeSessionId) return state;
      const scope = await activeRuntimeHostRef();
      return {
        ...state,
        activeSessionId: desktopSessionKey({
          hostId: scope.hostId,
          sessionId: state.activeSessionId,
        }),
      };
    },
  },
  artifacts: {
    list(sessionId: string, opts?: { includeDeleted?: boolean }): Promise<ArtifactDescriptor[]> {
      return invokeProjectedSessionRuntimeHost('artifacts:list', sessionId, opts);
    },
    readText(sessionId: string, artifactId: string): Promise<ArtifactTextReadResult> {
      return invokeSessionRuntimeHost('artifacts:readText', sessionId, artifactId);
    },
    readBinary(sessionId: string, artifactId: string): Promise<ArtifactBinaryReadResult> {
      return invokeSessionRuntimeHost('artifacts:readBinary', sessionId, artifactId);
    },
    delete(sessionId: string, artifactId: string): Promise<void> {
      return invokeSessionRuntimeHost('artifacts:delete', sessionId, artifactId);
    },
    subscribeChanges(handler: (event: ArtifactChangedEvent) => void): () => void {
      return subscribeEveryRuntimeHostEvent('artifacts:changed', (scope, event: ArtifactChangedEvent) =>
        handler({
          ...event,
          sessionId: desktopSessionKey({ hostId: scope.hostId, sessionId: event.sessionId }),
        }),
      );
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
      return sessionId
        ? invokeSessionRuntimeHost('skills:listInvocable', sessionId, newSessionContext)
        : invokeActiveRuntimeHost('skills:listInvocable', undefined, newSessionContext);
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
      browserSelection.setActiveSession(sessionId);
    },
    /** Mirror the panel strip's on-screen rect (null hides the native view). */
    setViewport(input: { sessionId: string; rect: BrowserViewRect | null }): void {
      browserSelection.setViewport(input);
    },
    navigate(sessionId: string, url: string): Promise<void> {
      return invokeSessionRuntimeHost('browser:navigate', sessionId, url);
    },
    back(sessionId: string): Promise<void> {
      return invokeSessionRuntimeHost('browser:back', sessionId);
    },
    forward(sessionId: string): Promise<void> {
      return invokeSessionRuntimeHost('browser:forward', sessionId);
    },
    reload(sessionId: string): Promise<void> {
      return invokeSessionRuntimeHost('browser:reload', sessionId);
    },
    stop(sessionId: string): Promise<void> {
      return invokeSessionRuntimeHost('browser:stop', sessionId);
    },
    close(sessionId: string): Promise<void> {
      return invokeSessionRuntimeHost('browser:close-page', sessionId);
    },
    getState(sessionId: string): Promise<BrowserState | null> {
      return invokeSessionRuntimeHost('browser:get-state', sessionId);
    },
    onState(handler: (payload: { sessionId: string; state: BrowserState }) => void): () => void {
      return subscribeEveryRuntimeHostEvent(
        'browser:state',
        (scope, payload: { sessionId: string; state: BrowserState }) =>
        handler({
          ...payload,
          sessionId: desktopSessionKey({ hostId: scope.hostId, sessionId: payload.sessionId }),
        }),
      );
    },
    onLive(handler: (payload: { sessionIds: string[] }) => void): () => void {
      return subscribeEveryRuntimeHostEvent(
        'browser:live',
        (scope, payload: { sessionIds: string[] }) =>
        handler({
          sessionIds: payload.sessionIds.map((sessionId) =>
            desktopSessionKey({ hostId: scope.hostId, sessionId }),
          ),
        }),
      );
    },
  },
} satisfies MakaBridge;

contextBridge.exposeInMainWorld('maka', makaBridge);
