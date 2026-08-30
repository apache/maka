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
import { join } from 'node:path';
import type { PermissionMode } from '@maka/core/permission';
import {
  createGenesisExecutionBoundary,
  executionBoundaryDisplayMode,
} from '@maka/core/sandbox-boundary';
import { findProjectByIdentity } from '@maka/core/project';
import type { ConnectionCatalogEntry, ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import { SessionActivityRegistry } from '@maka/runtime/goal-turn-lifecycle';
import { type InvocableSkillEntry } from '@maka/runtime/skill-invocation';
import {
  acquireProcessLifetimeOwner,
  type ProcessLifetimeOwner,
} from '@maka/storage/process-lifetime-owner';
import {
  readRuntimeHostAgentGraphEpochs,
  readRuntimeHostInvocableSkills,
  readRuntimeHostProjects,
  isRuntimeHostReconnectingConnection,
  type AgentGraphEpochDirectory,
  type RuntimeHostConnection,
  type RuntimeHostProfile,
} from '@maka/runtime-host/client';
import { runtimeHostProfileUsesHostWorkspace } from '@maka/runtime-host/profile-kind';
import type { AgentGraphClientSnapshot, WorkspaceTarget } from '@maka/runtime-host/protocol';
import {
  connectRuntimeHostCli,
  readHostChatDefaultPermissionMode,
  resolveRuntimeHostCliTarget,
} from './runtime-host-cli-context.js';
import type {
  MakaPiTuiTurnActivitySurface,
  ModelChoice,
  SessionRecapGenerator,
} from './pi-tui-contracts.js';
import {
  createRuntimeHostMakaSessionDriver,
  type RuntimeHostMakaSessionDriverInput,
} from './runtime-host-session-driver.js';
import {
  createRuntimeHostOnboardingSurface,
  projectRuntimeHostModelChoices,
} from './runtime-host-onboarding.js';
import {
  createTuiMcpController,
  type TuiMcpController,
  type TuiMcpManagement,
} from './tui-mcp-control.js';

export interface RuntimeHostTuiContext {
  readonly connection: RuntimeHostConnection;
  readonly driver: ReturnType<typeof createRuntimeHostMakaSessionDriver>;
  readonly cwd: string;
  readonly connectionSlug: string;
  readonly connectionId?: string;
  readonly connectionIdentities: readonly {
    readonly connectionId: string;
    readonly connectionSlug: string;
    readonly enabled: boolean;
  }[];
  readonly connectionName: string;
  readonly providerType?: ConnectionCatalogEntry['providerType'];
  readonly model: string;
  readonly modelContextWindow?: number;
  readonly modelChoices: readonly ModelChoice[];
  /**
   * Mode a Session created right now would start in, for display only. The
   * driver never receives it: an omitted create field is what lets the Host
   * stay the authority, and this snapshot goes stale the moment another client
   * changes the setting.
   */
  readonly prospectivePermissionMode: PermissionMode;
  readonly turnActivity: MakaPiTuiTurnActivitySurface;
  readonly listSkills: (cwd: string) => Promise<readonly InvocableSkillEntry[]>;
  readonly agentGraphHistory: {
    listEpochs(rootSessionId: string): Promise<AgentGraphEpochDirectory>;
    getSnapshot(rootSessionId: string, graphId: string): Promise<AgentGraphClientSnapshot>;
  };
  readonly recap: SessionRecapGenerator;
  readonly onboarding: ReturnType<typeof createRuntimeHostOnboardingSurface>;
  readonly mcp?: TuiMcpManagement;
  readonly profile: RuntimeHostProfile;
  close(): Promise<void>;
}

export interface CreateRuntimeHostTuiContextInput {
  readonly clientDataRoot: string;
  readonly rootPath: string;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly hostProfileId?: string;
  readonly projectId?: string;
}

export async function createRuntimeHostTuiContext(
  input: CreateRuntimeHostTuiContextInput,
): Promise<RuntimeHostTuiContext> {
  const connected = await connectRuntimeHostCli({
    clientDataRoot: input.clientDataRoot,
    rootPath: input.rootPath,
    interactiveSsh: true,
    ...(input.hostProfileId ? { profileId: input.hostProfileId } : {}),
  });
  const connection = connected.connection;
  let mcp: TuiMcpController | undefined;
  let sessionCopyCleanupOwner: ProcessLifetimeOwner | undefined;
  try {
    const catalog = connected.catalog;
    const workspace = await resolveRuntimeHostTuiWorkspace(connection, connected.profile, input);
    const selectedTarget = input.resumeSessionId
      ? await resolveResumeTarget(connection, catalog, input.resumeSessionId)
      : exactTuiTarget(resolveTarget(catalog));
    const modelChoices = projectRuntimeHostModelChoices(catalog);
    // Display state, never a create input. Deriving it through the same
    // boundary mapping every other surface uses keeps a prospective Session and
    // a live one from ever labelling the same permissions differently.
    const prospectivePermissionMode =
      executionBoundaryDisplayMode(
        createGenesisExecutionBoundary(await readHostChatDefaultPermissionMode(connection)),
      ) ?? 'ask';
    const sessionCopyCleanupRoot = join(input.clientDataRoot, 'tui-session-copies');
    const owner = await acquireProcessLifetimeOwner(
      join(sessionCopyCleanupRoot, connection.rootId),
    );
    sessionCopyCleanupOwner = owner;
    const driverInput: RuntimeHostMakaSessionDriverInput = {
      connection,
      cwd: input.cwd,
      ...(selectedTarget.connectionId === undefined
        ? {}
        : { llmConnectionId: selectedTarget.connectionId }),
      llmConnectionSlug: selectedTarget.connectionSlug,
      model: selectedTarget.model,
      prospectivePermissionMode,
      sessionCopyCleanupRoot,
      sessionCopyCleanupOwner: owner,
      executionLocation: runtimeHostProfileUsesHostWorkspace(connected.profile.kind)
        ? { kind: 'host' }
        : { kind: 'client_path' },
      ...(workspace ? { workspace } : {}),
    };
    const driver = createRuntimeHostMakaSessionDriver(driverInput);
    await driver.recoverSideConversations();
    if (!runtimeHostProfileUsesHostWorkspace(connected.profile.kind)) {
      if (!isRuntimeHostReconnectingConnection(connection)) {
        throw new Error('Local Runtime Host TUI connection is not reconnectable');
      }
      mcp = createTuiMcpController({
        workspaceRoot: input.rootPath,
        connection,
      });
    }
    const modelContextWindow = selectedTarget.connection?.models.find(
      (model) => model.id === selectedTarget.model,
    )?.contextWindow;
    return {
      connection,
      driver,
      cwd: input.cwd,
      connectionSlug: selectedTarget.connectionSlug,
      ...(selectedTarget.connectionId === undefined
        ? {}
        : { connectionId: selectedTarget.connectionId }),
      connectionIdentities: catalog.connections.map((entry) => ({
        connectionId: entry.connectionId,
        connectionSlug: entry.slug,
        enabled: entry.enabled,
      })),
      connectionName: selectedTarget.connection?.name ?? selectedTarget.connectionSlug,
      ...(selectedTarget.connection
        ? { providerType: selectedTarget.connection.providerType }
        : {}),
      model: selectedTarget.model,
      ...(modelContextWindow === undefined ? {} : { modelContextWindow }),
      modelChoices,
      prospectivePermissionMode,
      turnActivity: createHostOwnedTurnActivity(),
      listSkills: (cwd) =>
        listStablePresentedSkills(
          connection,
          driver.getSessionId(),
          workspace ??
            (runtimeHostProfileUsesHostWorkspace(connected.profile.kind)
              ? undefined
              : { kind: 'host_path', path: cwd }),
          driver.getPermissionMode?.() ?? prospectivePermissionMode,
        ),
      agentGraphHistory: createRuntimeHostAgentGraphHistory(connection),
      recap: createRuntimeHostRecapGenerator(connection),
      onboarding: createRuntimeHostOnboardingSurface(connection),
      ...(mcp ? { mcp } : {}),
      profile: connected.profile,
      close: () => closeRuntimeHostTuiContext(mcp, owner, connected.close),
    };
  } catch (error) {
    await closeRuntimeHostTuiContext(mcp, sessionCopyCleanupOwner, connected.close).catch(
      () => undefined,
    );
    throw error;
  }
}

async function closeRuntimeHostTuiContext(
  mcp: TuiMcpController | undefined,
  sessionCopyCleanupOwner: ProcessLifetimeOwner | undefined,
  closeConnection: () => Promise<void>,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await mcp?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await closeConnection();
  } catch (error) {
    errors.push(error);
  }
  try {
    await sessionCopyCleanupOwner?.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, 'Unable to close Runtime Host TUI context');
}

function createRuntimeHostAgentGraphHistory(
  connection: RuntimeHostConnection,
): RuntimeHostTuiContext['agentGraphHistory'] {
  return {
    listEpochs: (rootSessionId) => readRuntimeHostAgentGraphEpochs(connection, rootSessionId),
    getSnapshot: (rootSessionId, graphId) =>
      connection.request('agent.graph.query', { rootSessionId, graphId }),
  };
}

function createRuntimeHostRecapGenerator(connection: RuntimeHostConnection): SessionRecapGenerator {
  return {
    generate: async (sessionId, reason) => {
      try {
        const result = await connection.request('session.recap.generate', {
          sessionId,
          effectId: randomUUID(),
          reason,
        });
        return result.kind === 'generated'
          ? { ok: true, text: result.text, raw: result.raw }
          : { ok: false, error: result.errorClass };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

async function listStablePresentedSkills(
  connection: RuntimeHostConnection,
  sessionId: string | null,
  fallbackWorkspace: WorkspaceTarget | undefined,
  permissionMode: PermissionMode,
): Promise<InvocableSkillEntry[]> {
  const workspace = sessionId
    ? await readSessionWorkspace(connection, sessionId, fallbackWorkspace)
    : fallbackWorkspace;
  if (!workspace) throw new Error('The remote Session workspace is unavailable');
  return [
    ...(await readRuntimeHostInvocableSkills(connection, {
      kind: 'new_session',
      context: { workspace },
      collaborationMode: 'agent',
      permissionMode,
    })),
  ];
}

export async function resolveRuntimeHostTuiWorkspace(
  connection: RuntimeHostConnection,
  profile: RuntimeHostProfile,
  input: Pick<CreateRuntimeHostTuiContextInput, 'resumeSessionId' | 'projectId'>,
): Promise<WorkspaceTarget | undefined> {
  if (input.resumeSessionId) return undefined;
  if (!runtimeHostProfileUsesHostWorkspace(profile.kind)) {
    return input.projectId ? { kind: 'project', projectId: input.projectId } : undefined;
  }
  if (!input.projectId) {
    throw new Error(`Runtime Host profile ${profile.id} requires --project for a new Session`);
  }
  const project = findProjectByIdentity(await readRuntimeHostProjects(connection), input.projectId);
  if (!project || project.archivedAt !== null || !project.available) {
    throw new Error(`Runtime Host Project is unavailable: ${input.projectId}`);
  }
  return { kind: 'project', projectId: project.id };
}

async function readSessionWorkspace(
  connection: RuntimeHostConnection,
  sessionId: string,
  fallback: WorkspaceTarget | undefined,
): Promise<WorkspaceTarget> {
  const result = await connection.request('session.catalog.query', { kind: 'get', sessionId });
  if (result.kind === 'session' && result.session && !('kind' in result.session)) {
    return result.session.workspace.target;
  }
  if (fallback) return fallback;
  throw new Error(`Runtime Host Session is unavailable: ${sessionId}`);
}

function resolveTarget(catalog: ConnectionCatalogSnapshot): {
  connection: ConnectionCatalogEntry;
  model: string;
} {
  return resolveRuntimeHostCliTarget(catalog);
}

async function resolveResumeTarget(
  connection: RuntimeHostConnection,
  catalog: ConnectionCatalogSnapshot,
  sessionId: string,
): Promise<ResolvedTuiTarget> {
  const result = await connection.request('session.catalog.query', { kind: 'get', sessionId });
  const session = result.kind === 'session' ? result.session : null;
  if (session && !('kind' in session)) {
    const sessionConnection = catalog.connections.find(
      (candidate) =>
        session.llmConnectionId !== null &&
        candidate.connectionId === session.llmConnectionId &&
        candidate.slug === session.llmConnectionSlug,
    );
    return {
      ...(session.llmConnectionId === null ? {} : { connectionId: session.llmConnectionId }),
      connectionSlug: session.llmConnectionSlug,
      model: session.model,
      ...(sessionConnection ? { connection: sessionConnection } : {}),
    };
  }
  return exactTuiTarget(resolveTarget(catalog));
}

interface ResolvedTuiTarget {
  readonly connectionId?: string;
  readonly connectionSlug: string;
  readonly model: string;
  readonly connection?: ConnectionCatalogEntry;
}

function exactTuiTarget(target: {
  readonly connection: ConnectionCatalogEntry;
  readonly model: string;
}): ResolvedTuiTarget {
  return {
    connectionId: target.connection.connectionId,
    connectionSlug: target.connection.slug,
    model: target.model,
    connection: target.connection,
  };
}

function createHostOwnedTurnActivity(): MakaPiTuiTurnActivitySurface {
  return { activities: new SessionActivityRegistry() };
}
