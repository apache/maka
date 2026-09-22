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

import { randomUUID } from 'node:crypto';
import { isCollaborationMode } from '@maka/core/collaboration';
import { isOrchestrationMode } from '@maka/core/orchestration';
import { isPermissionMode } from '@maka/core/permission';
import { isThinkingLevel, type ThinkingLevel } from '@maka/core/model-thinking';
import { type CreateSessionRequestInput, type SessionListFilter } from '@maka/core/runtime-inputs';
import { type SessionChangedEvent, type SessionChangedReason, type SessionCatalogSummary } from '@maka/core/session';
import { RuntimeHostOperationError, projectSessionCatalogSummary } from '@maka/runtime-host/client';
import type {
  SessionCatalogProjection,
  SessionCreateInput,
  WorkspaceTarget,
  SessionModelTarget,
} from '@maka/runtime-host/protocol';
import type {
  DesktopSessionUpdateFailureCode,
  DesktopSessionUpdateResult,
} from '../shared/desktop-session-projection.js';
import { resolveCreateSessionRequest } from './create-session-input.js';
import {
  type DesktopRuntimeHostClient,
  DesktopRuntimeHostClientError,
  type DesktopSessionConfigurationPatch,
} from './runtime-host-client.js';
import {
  requestsRevisionFamily,
  resolveSessionActionIds,
} from './session-family-action.js';
import { normalizeSessionModelSelection } from './session-model-input.js';
import type { SessionCopyCleanupAuthority } from '@maka/storage/session-copy-cleanup';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';

type RuntimeHostSessionCatalogClient = Pick<
  DesktopRuntimeHostClient,
  | 'createSession'
  | 'getSession'
  | 'listSessions'
  | 'previewSessionRemoval'
  | 'relocateSessionWorkspace'
  | 'removeSession'
  | 'setSessionLifecycle'
  | 'updateSessionConfiguration'
  | 'updateSessionMetadata'
>;

export interface DesktopHostSessionSummary extends SessionCatalogSummary {
  revision: number;
  labelsTruncated: boolean;
  shared?: true;
}

export interface RuntimeHostSessionCatalogIpcDeps {
  client: RuntimeHostSessionCatalogClient;
  /** Observer state supplements the Host catalog without falling back to the durable header. */
  runningTurnIds: (sessionId: string) => readonly string[];
  resolveCreateProject: (
    input: Pick<CreateSessionRequestInput, 'cwd' | 'projectId'>,
  ) => Promise<WorkspaceTarget>;
  emitSessionsChanged: (
    reason: SessionChangedReason,
    sessionId?: string,
    extra?: Pick<SessionChangedEvent, 'modelId' | 'turnId'>,
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
    const sessions = await deps.client.listSessions();
    return sessions
      .filter((session) => !pendingCleanup.has(session.id))
      .filter((session) =>
        parentSessionId === undefined ? true : session.subagent?.parentSessionId === parentSessionId,
      )
      .map((session) =>
        toDesktopHostSessionListSummary(session, deps.runningTurnIds(session.id)),
      );
  };
  const actionIds = (sessionId: string, options: unknown) =>
    resolveSessionActionIds(() => listSessions(), sessionId, options);

  handleReconnectableRead(ipcMain, 'sessions:list', (_event, filter?: unknown) =>
    listSessions(normalizeSessionListFilter(filter)),
  );
  handleReconnectableRead(ipcMain, 'sessions:get', async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Invalid Session id');
    }
    await recoveryTask;
    if (pendingCleanup.has(sessionId)) return null;
    const session = await deps.client.getSession(sessionId);
    return session === null
      ? null
      : toDesktopHostSessionListSummary(session, deps.runningTurnIds(sessionId));
  });
  ipcMain.handle('sessions:cleanupSessionCopy', async (_event, sessionId: string) => {
    await deps.sessionCopyCleanup.cleanup(sessionId);
    pendingCleanup.delete(sessionId);
  });
  ipcMain.handle('sessions:abandonSessionCopy', async (_event, sessionId: string) => {
    await deps.sessionCopyCleanup.schedule(sessionId);
    pendingCleanup.add(sessionId);
  });
  ipcMain.handle('sessions:create', async (_event, input?: CreateSessionRequestInput) => {
    const workspace = await deps.resolveCreateProject({
      ...(input?.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input?.projectId === undefined ? {} : { projectId: input.projectId }),
    });
    const session = await deps.client.createSession(resolveDesktopSessionCreateInput(input, newId(), workspace));
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
  // Two fields, two channels, one field each. Plan is a temporary
  // collaboration excursion that Runtime ends by itself on approval or
  // abandonment; orchestration is the Session's standing default for how a
  // turn fans out. Runtime resolves the overlap by stripping the subagent and
  // agent-graph tools while planning, and validates the two independently, so
  // neither channel has any business writing the other's field.
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
  ipcMain.handle(
    'sessions:setModelConfiguration',
    async (_event, sessionId: string, input: unknown) => {
      const modelTarget = normalizeExplicitModel(input);
      const thinkingLevel = normalizeRequiredThinkingLevel(input);
      return updateConfiguration(deps, sessionId, { modelTarget, thinkingLevel }, 'updated');
    },
  );
  ipcMain.handle(
    'sessions:setExecutorConfiguration',
    async (_event, sessionId: string, input: unknown) => {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new Error('Invalid executor configuration');
      }
      const record = input as Record<string, unknown>;
      const executorId = normalizeOptionalString(record.executorId, 'executor id');
      if (!executorId) throw new Error('Executor id is required');
      const model = normalizeOptionalString(record.model, 'executor model');
      const thinkingLevel = normalizeRequiredThinkingLevel(input);
      return updateConfiguration(
        deps,
        sessionId,
        { executorTarget: { executorId, ...(model ? { model } : {}) }, thinkingLevel },
        'updated',
      );
    },
  );
  ipcMain.handle('sessions:setThinkingLevel', async (_event, sessionId: string, level: unknown) => {
    if (level !== undefined && level !== null && !isThinkingLevel(level)) {
      throw new Error(`Invalid thinking level: ${String(level)}`);
    }
    return updateConfiguration(deps, sessionId, { thinkingLevel: level ?? null }, 'updated');
  });
  ipcMain.handle('sessions:remove', async (_event, sessionId: string, options?: unknown) => {
    requestsRevisionFamily(options);
    const ids = await actionIds(sessionId, { revisionFamily: true });
    // A task restored under the caller's decision is left alone, and nothing
    // downstream of the deletion runs for it.
    const outcome = await deps.client.removeSession(sessionId, {
      requireArchived: requiresArchivedSession(options),
    });
    if (outcome.disposition === 'removed') await finishSessionRetirement(deps, ids, 'deleted');
    return outcome;
  });
  ipcMain.handle('sessions:removePreview', async (_event, sessionId: string) => {
    // Read-only: how many subtasks the delete would archive, for the confirm.
    return deps.client.previewSessionRemoval(sessionId);
  });
  ipcMain.handle(
    'sessions:moveToProject',
    async (_event, sessionId: string, projectId: unknown) => {
      if (projectId !== null && (typeof projectId !== 'string' || projectId.length === 0)) {
        throw new Error('Invalid project id');
      }
      return moveSessionToProject(deps, sessionId, projectId);
    },
  );
}

/**
 * Re-files an existing Session into another Project, or out of every Project.
 *
 * Unlike the configuration updates, this is not a revision-family action: a
 * move re-points one working directory, and moving an archived or branched
 * sibling's cwd as a side effect is not what the user asked for.
 *
 * The revision is read once, here, and carried into the commit. Detaching needs
 * the Session's own cwd as the target, and that directory is only meaningful
 * paired with the revision it was read at: committing it against a later
 * revision would move the Session back to a directory a concurrent writer had
 * already left, which is exactly what the Host's compare-and-set exists to
 * stop. So a conflict is reported, not retried.
 */
async function moveSessionToProject(
  deps: RuntimeHostSessionCatalogIpcDeps,
  sessionId: string,
  projectId: string | null,
): Promise<DesktopSessionUpdateResult<DesktopHostSessionSummary>> {
  let session: SessionCatalogProjection;
  try {
    const current = await deps.client.getSession(sessionId);
    if (!current) {
      throw new DesktopRuntimeHostClientError(
        'session_not_found',
        `No such Session: ${sessionId}`,
      );
    }
    const workspace: WorkspaceTarget =
      projectId === null
        ? { kind: 'host_path', path: current.workspace.hostCwd }
        : { kind: 'project', projectId };
    session = await deps.client.relocateSessionWorkspace(
      sessionId,
      current.revision,
      workspace,
    );
  } catch (error) {
    const code = updateFailureCode(error);
    if (code) return { ok: false, code };
    throw error;
  }
  deps.emitSessionsChanged('updated', sessionId);
  return { ok: true, session: toDesktopHostSessionSummary(session) };
}

/**
 * Reads the archived premise off the remove options.
 *
 * This guards a permanent deletion, so it refuses anything it cannot read
 * rather than falling through to "no premise stated" — which would be the
 * destructive answer. It repeats the shape check its sibling does instead of
 * relying on the caller running that one first.
 */
function requiresArchivedSession(options: unknown): boolean {
  if (options === undefined) return false;
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Invalid session family action options');
  }
  const value = (options as { requireArchived?: unknown }).requireArchived;
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error('Invalid requireArchived option');
  return value;
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
  extra?: Pick<SessionChangedEvent, 'modelId' | 'turnId'>,
): Promise<DesktopSessionUpdateResult<DesktopHostSessionSummary>> {
  let session: SessionCatalogProjection;
  try {
    session = await deps.client.updateSessionConfiguration(sessionId, patch);
  } catch (error) {
    const code = updateFailureCode(error);
    if (code) return { ok: false, code };
    throw error;
  }
  deps.emitSessionsChanged(reason, sessionId, extra);
  return { ok: true, session: toDesktopHostSessionSummary(session) };
}

const EXPECTED_UPDATE_FAILURES = [
  'session_busy',
  'operation_conflict',
  'operation_unavailable',
  'not_found',
] as const;

function updateFailureCode(error: unknown): DesktopSessionUpdateFailureCode | undefined {
  if (error instanceof RuntimeHostOperationError) {
    return EXPECTED_UPDATE_FAILURES.find((code) => code === error.code);
  }
  if (error instanceof DesktopRuntimeHostClientError) {
    if (error.code === 'revision_conflict') return 'operation_conflict';
    if (error.code === 'session_not_found') return 'not_found';
  }
  return undefined;
}

function normalizeParentSessionFilter(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Invalid subagent parent Session filter');
  }
  return value;
}

function normalizeSessionListFilter(value: unknown): SessionListFilter | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Session list filter');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'subagentParentSessionId')) {
    throw new Error('Invalid Session list filter keys');
  }
  return {
    ...(record.subagentParentSessionId === undefined
      ? {}
      : {
          subagentParentSessionId: normalizeParentSessionFilter(
            record.subagentParentSessionId,
          ),
        }),
  };
}

export function resolveDesktopSessionCreateInput(input: CreateSessionRequestInput | undefined, sessionId: string, workspace: WorkspaceTarget): SessionCreateInput {
  const request = resolveCreateSessionRequest(input);
  const executorId = normalizeOptionalString(input?.executorId, 'executor id');
  if (executorId && (input?.llmConnectionId !== undefined || input?.llmConnectionSlug !== undefined)) {
    throw new Error('Plugin executor selection cannot include a model connection');
  }
  return {
    sessionId, workspace,
    ...(request.mode === undefined ? {} : { mode: request.mode }),
    name: request.name,
    ...(request.labels === undefined ? {} : { labels: request.labels }),
    ...(executorId
      ? {
          executorId,
          ...(normalizeOptionalString(input?.model, 'executor model')
            ? { executorModel: normalizeOptionalString(input?.model, 'executor model') }
            : {}),
        }
      : { modelTarget: normalizeModelTarget(input) }),
    ...normalizeCreateThinkingLevel(input?.thinkingLevel),
    ...(request.mode !== undefined || request.permissionMode === undefined ? {} : { permissionMode: request.permissionMode }),
    collaborationMode: request.collaborationMode,
    orchestrationMode: request.orchestrationMode,
  };
}

function normalizeModelTarget(input: CreateSessionRequestInput | undefined): SessionModelTarget {
  const connectionId = normalizeOptionalString(input?.llmConnectionId, 'model connection id');
  const slug = normalizeOptionalString(input?.llmConnectionSlug, 'model connection');
  const model = normalizeOptionalString(input?.model, 'model');
  if (connectionId === undefined && slug === undefined && model === undefined) {
    return { kind: 'default' };
  }
  if (connectionId === undefined || slug === undefined || model === undefined) {
    throw new Error('Explicit model selection requires connection id, connection, and model');
  }
  return { kind: 'explicit', connectionId, connectionSlug: slug, model };
}

function normalizeExplicitModel(input: unknown): Extract<SessionModelTarget, { kind: 'explicit' }> {
  const selection = normalizeSessionModelSelection(input);
  return {
    kind: 'explicit',
    connectionId: selection.llmConnectionId,
    connectionSlug: selection.llmConnectionSlug,
    model: selection.model,
  };
}

function normalizeRequiredThinkingLevel(input: unknown): ThinkingLevel | null {
  const level = (input as Record<string, unknown> | null)?.thinkingLevel;
  if (level !== null && !isThinkingLevel(level)) {
    throw new Error(`Invalid thinking level: ${String(level)}`);
  }
  return level;
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
  if (value === null) return { thinkingLevel: null };
  if (!isThinkingLevel(value)) throw new Error(`Invalid thinking level: ${String(value)}`);
  return { thinkingLevel: value };
}

export function toDesktopHostSessionSummary(
  session: SessionCatalogProjection,
): DesktopHostSessionSummary {
  return {
    ...projectSessionCatalogSummary(session),
    revision: session.revision,
    labelsTruncated: session.labelsTruncated,
  };
}

function toDesktopHostSessionListSummary(
  session: SessionCatalogProjection,
  runningTurnIds: readonly string[],
): DesktopHostSessionSummary {
  const summary = toDesktopHostSessionSummary(session);
  return runningTurnIds.length === 0
    ? summary
    : {
        ...summary,
        runningTurnIds: [...new Set([...(summary.runningTurnIds ?? []), ...runningTurnIds])],
      };
}
