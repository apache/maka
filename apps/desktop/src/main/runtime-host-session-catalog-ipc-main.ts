import { randomUUID } from 'node:crypto';
import { isCollaborationMode } from '@maka/core/collaboration';
import { isOrchestrationMode } from '@maka/core/orchestration';
import { isPermissionMode } from '@maka/core/permission';
import { isThinkingLevel } from '@maka/core/model-thinking';
import { type CreateSessionRequestInput, type SessionListFilter } from '@maka/core/runtime-inputs';
import { type SessionChangedEvent, type SessionChangedReason, type SessionSummary } from '@maka/core/session';
import type {
  SessionCatalogFilter,
  SessionCatalogProjection,
  SessionCreateInput,
  WorkspaceTarget,
  SessionModelTarget,
} from '@maka/runtime-host/protocol';
import { resolveCreateSessionRequest } from './create-session-input.js';
import type {
  DesktopRuntimeHostClient,
  DesktopSessionConfigurationPatch,
} from './runtime-host-client.js';
import {
  requestsRevisionFamily,
  resolveSessionActionIds,
} from './session-family-action.js';
import { normalizeSessionModelSelection } from './session-model-input.js';
import type { SessionCopyCleanupAuthority } from './quote-companion-cleanup.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';

type RuntimeHostSessionCatalogClient = Pick<
  DesktopRuntimeHostClient,
  | 'createSession'
  | 'listSessions'
  | 'removeSession'
  | 'setSessionLifecycle'
  | 'updateSessionConfiguration'
  | 'updateSessionMetadata'
>;

export interface DesktopHostSessionSummary extends SessionSummary {
  labelsTruncated: boolean;
}

export interface RuntimeHostSessionCatalogIpcDeps {
  client: RuntimeHostSessionCatalogClient;
  resolveCreateProject: (
    input: Pick<CreateSessionRequestInput, 'cwd' | 'projectId'>,
  ) => Promise<WorkspaceTarget>;
  emitSessionsChanged: (
    reason: SessionChangedReason,
    sessionId?: string,
    extra?: Pick<SessionChangedEvent, 'connectionSlug' | 'modelId' | 'turnId'>,
  ) => void;
  releaseSessionResources: (sessionId: string) => void | Promise<void>;
  sessionCopyCleanup: SessionCopyCleanupAuthority;
  newId?: () => string;
}

export function registerRuntimeHostSessionCatalogIpc(
  deps: RuntimeHostSessionCatalogIpcDeps,
  ipcMain: ReconnectableReadIpcMain,
): void {
  const newId = deps.newId ?? randomUUID;
  const pendingCleanup = new Set<string>();
  const recoveryTask = deps.sessionCopyCleanup.recover().then((recovery) => {
    for (const { sessionId } of recovery.failed) pendingCleanup.add(sessionId);
  });
  void recoveryTask.catch(() => undefined);
  const listSessions = async (filter?: SessionListFilter): Promise<DesktopHostSessionSummary[]> => {
    await recoveryTask;
    const parentSessionId = normalizeParentSessionFilter(filter?.subagentParentSessionId);
    const sessions = await deps.client.listSessions(toHostCatalogFilter(filter));
    return sessions
      .filter((session) => !pendingCleanup.has(session.id))
      .filter((session) =>
        parentSessionId === undefined ? true : session.subagent?.parentSessionId === parentSessionId,
      )
      .map(toDesktopHostSessionSummary);
  };
  const actionIds = (sessionId: string, options: unknown) =>
    resolveSessionActionIds(() => listSessions(), sessionId, options);

  handleReconnectableRead(ipcMain, 'sessions:list', (_event, filter?: SessionListFilter) =>
    listSessions(filter),
  );
  ipcMain.handle('sessions:cleanupSessionCopy', async (_event, sessionId: string) => {
    await deps.sessionCopyCleanup.cleanup(sessionId);
    pendingCleanup.delete(sessionId);
  });
  ipcMain.handle('sessions:abandonSessionCopy', async (_event, sessionId: string) => {
    await deps.sessionCopyCleanup.schedule(sessionId);
    pendingCleanup.add(sessionId);
  });
  ipcMain.handle('sessions:create', async (_event, input?: CreateSessionRequestInput) => {
    if (input?.backend !== undefined && input.backend !== 'ai-sdk') {
      throw new Error('Unsupported Runtime Host Session backend');
    }
    const request = resolveCreateSessionRequest(input);
    const workspace = await deps.resolveCreateProject({
      ...(input?.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input?.projectId === undefined ? {} : { projectId: input.projectId }),
    });
    const session = await deps.client.createSession({
      sessionId: newId(),
      workspace,
      ...(request.mode === undefined ? {} : { mode: request.mode }),
      ...(request.mode === undefined ? { name: request.name } : {}),
      ...(request.labels === undefined ? {} : { labels: request.labels }),
      modelTarget: normalizeModelTarget(input),
      ...normalizeCreateThinkingLevel(input?.thinkingLevel),
      ...(request.mode !== undefined || request.permissionMode === undefined
        ? {}
        : { permissionMode: request.permissionMode }),
      collaborationMode: request.collaborationMode,
      orchestrationMode: request.orchestrationMode,
    });
    deps.emitSessionsChanged('created', session.id);
    return toDesktopHostSessionSummary(session);
  });
  ipcMain.handle('sessions:archive', async (_event, sessionId: string, options?: unknown) => {
    requestsRevisionFamily(options);
    const ids = await actionIds(sessionId, { revisionFamily: true });
    await deps.client.setSessionLifecycle(sessionId, 'archived');
    await finishSessionRetirement(deps, ids, 'archived');
  });
  ipcMain.handle('sessions:unarchive', async (_event, sessionId: string, options?: unknown) => {
    requestsRevisionFamily(options);
    const ids = await actionIds(sessionId, { revisionFamily: true });
    await deps.client.setSessionLifecycle(sessionId, 'active');
    for (const id of ids) deps.emitSessionsChanged('updated', id);
  });
  ipcMain.handle(
    'sessions:setFlagged',
    async (_event, sessionId: string, isFlagged: unknown, options?: unknown) => {
      if (typeof isFlagged !== 'boolean') throw new Error('Invalid flagged state');
      for (const id of await actionIds(sessionId, options)) {
        await deps.client.updateSessionMetadata(id, { isFlagged });
        deps.emitSessionsChanged('pinned', id);
      }
    },
  );
  ipcMain.handle(
    'sessions:rename',
    async (_event, sessionId: string, name: unknown, options?: unknown) => {
      if (typeof name !== 'string') throw new Error('Invalid Session name');
      for (const id of await actionIds(sessionId, options)) {
        await deps.client.updateSessionMetadata(id, { name });
        deps.emitSessionsChanged('renamed', id);
      }
    },
  );
  ipcMain.handle('sessions:setPermissionMode', async (_event, sessionId: string, mode: unknown) => {
    if (!isPermissionMode(mode)) throw new Error(`Invalid permission mode: ${String(mode)}`);
    return updateConfiguration(deps, sessionId, { permissionMode: mode }, 'mode-change');
  });
  ipcMain.handle(
    'sessions:setCollaborationMode',
    async (_event, sessionId: string, mode: unknown) => {
      if (!isCollaborationMode(mode)) {
        throw new Error(`Invalid collaboration mode: ${String(mode)}`);
      }
      return updateConfiguration(deps, sessionId, { collaborationMode: mode }, 'mode-change');
    },
  );
  ipcMain.handle(
    'sessions:setOrchestrationMode',
    async (_event, sessionId: string, mode: unknown) => {
      if (!isOrchestrationMode(mode)) {
        throw new Error(`Invalid orchestration mode: ${String(mode)}`);
      }
      return updateConfiguration(deps, sessionId, { orchestrationMode: mode }, 'mode-change');
    },
  );
  ipcMain.handle('sessions:setModel', async (_event, sessionId: string, input: unknown) => {
    const modelTarget = normalizeExplicitModel(input);
    return updateConfiguration(
      deps,
      sessionId,
      { modelTarget, thinkingLevel: null },
      'updated',
      { connectionSlug: modelTarget.connectionSlug, modelId: modelTarget.model },
    );
  });
  ipcMain.handle('sessions:setThinkingLevel', async (_event, sessionId: string, level: unknown) => {
    if (level !== undefined && level !== null && !isThinkingLevel(level)) {
      throw new Error(`Invalid thinking level: ${String(level)}`);
    }
    return updateConfiguration(deps, sessionId, { thinkingLevel: level ?? null }, 'updated');
  });
  ipcMain.handle('sessions:remove', async (_event, sessionId: string, options?: unknown) => {
    requestsRevisionFamily(options);
    const ids = await actionIds(sessionId, { revisionFamily: true });
    await deps.client.removeSession(sessionId);
    await finishSessionRetirement(deps, ids, 'deleted');
  });
}

async function finishSessionRetirement(
  deps: RuntimeHostSessionCatalogIpcDeps,
  sessionIds: readonly string[],
  reason: Extract<SessionChangedReason, 'archived' | 'deleted'>,
): Promise<void> {
  const results = await Promise.allSettled(
    sessionIds.map((sessionId) => deps.releaseSessionResources(sessionId)),
  );
  for (const sessionId of sessionIds) deps.emitSessionsChanged(reason, sessionId);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}

async function updateConfiguration(
  deps: RuntimeHostSessionCatalogIpcDeps,
  sessionId: string,
  patch: DesktopSessionConfigurationPatch,
  reason: SessionChangedReason,
  extra?: Pick<SessionChangedEvent, 'connectionSlug' | 'modelId' | 'turnId'>,
): Promise<DesktopHostSessionSummary> {
  const session = await deps.client.updateSessionConfiguration(sessionId, patch);
  deps.emitSessionsChanged(reason, sessionId, extra);
  return toDesktopHostSessionSummary(session);
}

function toHostCatalogFilter(filter: SessionListFilter | undefined): SessionCatalogFilter | undefined {
  if (!filter) return undefined;
  const result: SessionCatalogFilter = {
    ...(filter.isArchived === undefined ? {} : { isArchived: filter.isArchived }),
    ...(filter.isFlagged === undefined ? {} : { isFlagged: filter.isFlagged }),
    ...(filter.labelSlug === undefined ? {} : { labelSlug: filter.labelSlug }),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

function normalizeParentSessionFilter(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Invalid subagent parent Session filter');
  }
  return value;
}

function normalizeModelTarget(input: CreateSessionRequestInput | undefined): SessionModelTarget {
  const slug = normalizeOptionalString(input?.llmConnectionSlug, 'model connection');
  const model = normalizeOptionalString(input?.model, 'model');
  if (slug === undefined && model === undefined) return { kind: 'default' };
  if (slug === undefined || model === undefined) {
    throw new Error('Explicit model selection requires both connection and model');
  }
  return { kind: 'explicit', connectionSlug: slug, model };
}

function normalizeExplicitModel(input: unknown): Extract<SessionModelTarget, { kind: 'explicit' }> {
  const selection = normalizeSessionModelSelection(input);
  return {
    kind: 'explicit',
    connectionSlug: selection.llmConnectionSlug,
    model: selection.model,
  };
}

function normalizeOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value.trim();
}

function normalizeCreateThinkingLevel(
  value: unknown,
): Pick<SessionCreateInput, 'thinkingLevel'> | Record<string, never> {
  if (value === undefined) return {};
  if (!isThinkingLevel(value)) throw new Error(`Invalid thinking level: ${String(value)}`);
  return { thinkingLevel: value };
}

export function toDesktopHostSessionSummary(
  session: SessionCatalogProjection,
): DesktopHostSessionSummary {
  return {
    id: session.id,
    cwd: session.workspace.hostCwd,
    ...(session.workspace.target.kind === 'project'
      ? { projectId: session.workspace.target.projectId }
      : {}),
    name: session.name,
    isFlagged: session.isFlagged,
    isArchived: session.isArchived,
    labels: [...session.labels],
    labelsTruncated: session.labelsTruncated,
    hasUnread: session.hasUnread,
    ...(session.lastMessageAt === undefined ? {} : { lastMessageAt: session.lastMessageAt }),
    ...(session.lastMessagePreview === undefined
      ? {}
      : { lastMessagePreview: session.lastMessagePreview }),
    status: session.status,
    ...(session.blockedReason === undefined ? {} : { blockedReason: session.blockedReason }),
    ...(session.statusUpdatedAt === undefined ? {} : { statusUpdatedAt: session.statusUpdatedAt }),
    ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
    ...(session.branchOfTurnId === undefined ? {} : { branchOfTurnId: session.branchOfTurnId }),
    ...(session.subagent === undefined ? {} : { subagent: session.subagent }),
    ...(session.revisionRootSessionId === undefined
      ? {}
      : { revisionRootSessionId: session.revisionRootSessionId }),
    ...(session.revisionParentSessionId === undefined
      ? {}
      : { revisionParentSessionId: session.revisionParentSessionId }),
    ...(session.revisionOfTurnId === undefined
      ? {}
      : { revisionOfTurnId: session.revisionOfTurnId }),
    ...(session.revisionIndex === undefined ? {} : { revisionIndex: session.revisionIndex }),
    ...(session.revisionState === undefined ? {} : { revisionState: session.revisionState }),
    backend: session.backend,
    llmConnectionSlug: session.llmConnectionSlug,
    connectionLocked: session.connectionLocked,
    model: session.model,
    ...(session.thinkingLevel === undefined ? {} : { thinkingLevel: session.thinkingLevel }),
    permissionMode: session.permissionMode,
    collaborationMode: session.collaborationMode,
    orchestrationMode: session.orchestrationMode,
  };
}
