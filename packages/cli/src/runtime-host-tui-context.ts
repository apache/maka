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
import type { PermissionMode } from '@maka/core/permission';
import { findProjectByIdentity } from '@maka/core/project';
import type { ConnectionCatalogEntry, ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import { SessionActivityRegistry } from '@maka/runtime/goal-turn-lifecycle';
import { type InvocableSkillEntry } from '@maka/runtime/skill-invocation';
import {
  readRuntimeHostAgentGraphEpochs,
  readRuntimeHostInvocableSkills,
  readRuntimeHostProjects,
  type AgentGraphEpochDirectory,
  type RuntimeHostConnection,
  type RuntimeHostProfile,
} from '@maka/runtime-host/client';
import type { AgentGraphClientSnapshot, WorkspaceTarget } from '@maka/runtime-host/protocol';
import { connectRuntimeHostCli, resolveRuntimeHostCliTarget } from './runtime-host-cli-context.js';
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

export interface RuntimeHostTuiContext {
  readonly connection: RuntimeHostConnection;
  readonly driver: ReturnType<typeof createRuntimeHostMakaSessionDriver>;
  readonly cwd: string;
  readonly connectionSlug: string;
  readonly connectionName: string;
  readonly providerType: ConnectionCatalogEntry['providerType'];
  readonly model: string;
  readonly modelContextWindow?: number;
  readonly modelChoices: readonly ModelChoice[];
  readonly turnActivity: MakaPiTuiTurnActivitySurface;
  readonly listSkills: (cwd: string) => Promise<readonly InvocableSkillEntry[]>;
  readonly agentGraphHistory: {
    listEpochs(rootSessionId: string): Promise<AgentGraphEpochDirectory>;
    getSnapshot(rootSessionId: string, graphId: string): Promise<AgentGraphClientSnapshot>;
  };
  readonly recap: SessionRecapGenerator;
  readonly onboarding: ReturnType<typeof createRuntimeHostOnboardingSurface>;
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
  try {
    const catalog = connected.catalog;
    const workspace = await resolveRuntimeHostTuiWorkspace(connection, connected.profile, input);
    const target = input.resumeSessionId
      ? await resolveResumeTarget(connection, catalog, input.resumeSessionId)
      : resolveTarget(catalog);
    const modelChoices = projectRuntimeHostModelChoices(catalog);
    const driverInput: RuntimeHostMakaSessionDriverInput = {
      connection,
      cwd: input.cwd,
      llmConnectionSlug: target.connection.slug,
      model: target.model,
      permissionMode: 'ask',
      executionLocation:
        connected.profile.kind === 'local' ? { kind: 'client_path' } : { kind: 'host' },
      ...(workspace ? { workspace } : {}),
    };
    const driver = createRuntimeHostMakaSessionDriver(driverInput);
    return {
      connection,
      driver,
      cwd: input.cwd,
      connectionSlug: target.connection.slug,
      connectionName: target.connection.name,
      providerType: target.connection.providerType,
      model: target.model,
      modelContextWindow: target.connection.models.find((model) => model.id === target.model)
        ?.contextWindow,
      modelChoices,
      turnActivity: createHostOwnedTurnActivity(),
      listSkills: (cwd) =>
        listStablePresentedSkills(
          connection,
          driver.getSessionId(),
          workspace ??
            (connected.profile.kind === 'local' ? { kind: 'host_path', path: cwd } : undefined),
          driver.getPermissionMode?.() ?? 'ask',
        ),
      agentGraphHistory: createRuntimeHostAgentGraphHistory(connection),
      recap: createRuntimeHostRecapGenerator(connection),
      onboarding: createRuntimeHostOnboardingSurface(connection),
      profile: connected.profile,
      close: () => connected.close(),
    };
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
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
  if (profile.kind === 'local') {
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
): Promise<{ connection: ConnectionCatalogEntry; model: string }> {
  const result = await connection.request('session.catalog.query', { kind: 'get', sessionId });
  const session = result.kind === 'session' ? result.session : null;
  if (session && !('kind' in session)) {
    const sessionConnection = catalog.connections.find(
      (candidate) => candidate.slug === session.llmConnectionSlug && candidate.enabled,
    );
    if (sessionConnection) return { connection: sessionConnection, model: session.model };
  }
  return resolveTarget(catalog);
}

function createHostOwnedTurnActivity(): MakaPiTuiTurnActivitySurface {
  return { activities: new SessionActivityRegistry() };
}
