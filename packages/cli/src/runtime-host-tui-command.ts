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

import { parseNoRealConnectionError } from '@maka/core/connection-error-copy';
import type { UiLocale } from '@maka/core/ui-locale';
import { SessionActivityRegistry } from '@maka/runtime/goal-turn-lifecycle';
import {
  readRuntimeHostConnectionCatalog,
  HostHandoffCancelledError,
} from '@maka/runtime-host/client';
import { runtimeHostProfileUsesHostWorkspace } from '@maka/runtime-host/profile-kind';
import { createForeignSessionStore } from '@maka/storage/foreign-session-store';
import { formatMakaResumeHint } from './cli-invocation.js';
import { connectRuntimeHostCli } from './runtime-host-cli-context.js';
import { createCliHostHandoffSurface } from './runtime-host-handoff-surface.js';
import { createRuntimeHostOnboardingSurface } from './runtime-host-onboarding.js';
import type { MakaPiTuiTurnActivitySurface } from './pi-tui-contracts.js';
import { runMakaPiTui } from './pi-tui-runner.js';
import { createRuntimeHostTuiContext } from './runtime-host-tui-context.js';
import type { MakaSessionDriver } from './session-driver.js';

export interface RunRuntimeHostTuiInput {
  readonly cliCommand: string;
  readonly clientDataRoot: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly locale: UiLocale;
  readonly resumeSessionId?: string;
  readonly resumeCwd?: string;
  readonly hostProfileId?: string;
  readonly projectId?: string;
  readonly onProcessExit: (exitCode: number, error?: Error) => void;
}

export async function runRuntimeHostTui(input: RunRuntimeHostTuiInput): Promise<number> {
  const foreignSessions = createForeignSessionStore();
  const contextInput = {
    ...(process.stdin.isTTY ? { handoffSurface: createCliHostHandoffSurface(input.locale) } : {}),
    clientDataRoot: input.clientDataRoot,
    rootPath: input.workspaceRoot,
    cwd: input.cwd,
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
    ...(input.hostProfileId ? { hostProfileId: input.hostProfileId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
  let context;
  try {
    context = await createRuntimeHostTuiContext(contextInput);
  } catch (error) {
    if (error instanceof HostHandoffCancelledError) return 1;
    if (!isMissingDefaultConnection(error) || input.resumeSessionId) throw error;
    const configured = await runFirstRunOnboarding(
      input.clientDataRoot,
      input.workspaceRoot,
      input.cwd,
      input.locale,
      input.hostProfileId,
    );
    if (!configured) throw error;
    context = await createRuntimeHostTuiContext(contextInput);
  }
  try {
    await runMakaPiTui({
      driver: context.driver,
      title: runtimeHostProfileUsesHostWorkspace(context.profile.kind)
        ? `Maka — ${context.profile.name}`
        : 'Maka',
      cwd: context.cwd,
      locale: input.locale,
      model: context.model,
      models: context.modelChoices
        .filter(
          (choice) =>
            choice.connectionId === context.connectionId &&
            choice.connectionSlug === context.connectionSlug,
        )
        .map((choice) => choice.model),
      modelChoices: context.modelChoices,
      subscribeModelCatalogChanges: context.subscribeModelCatalogChanges,
      connectionSlug: context.connectionSlug,
      connectionId: context.connectionId,
      connectionIdentities: context.connectionIdentities,
      modelContextWindow: context.modelContextWindow,
      permissionMode: context.prospectivePermissionMode,
      turnActivity: context.turnActivity,
      listSkills: context.listSkills,
      agentGraphHistory: context.agentGraphHistory,
      onboarding: context.onboarding,
      ...(context.mcp ? { mcp: context.mcp } : {}),
      recap: context.recap,
      ...(runtimeHostProfileUsesHostWorkspace(context.profile.kind)
        ? {
            sessionListScope: 'all' as const,
            clientPathAuthority: 'none' as const,
          }
        : { foreignSessions }),
      subscribeShellRunUpdates: (listener) => context.driver.subscribeShellRunUpdates(listener),
      listShellRunUpdates: (sessionId) => context.driver.listShellRunUpdates(sessionId),
      onProcessExit: input.onProcessExit,
      cliCommand: input.cliCommand,
      resumeSessionId: input.resumeSessionId,
      resumeCwd: input.resumeCwd,
      ...(runtimeHostProfileUsesHostWorkspace(context.profile.kind) && input.resumeSessionId
        ? { resumeFailure: 'exit' as const }
        : {}),
    });
    const sessionId = context.driver.getSessionId();
    const hint = formatMakaResumeHint(input.cliCommand, sessionId, {
      ...(runtimeHostProfileUsesHostWorkspace(context.profile.kind)
        ? { hostProfileId: context.profile.id }
        : {}),
    });
    if (hint) process.stdout.write(`${hint}\n`);
    return 0;
  } finally {
    await context.driver.cleanupOwnedSideConversations().catch(() => undefined);
    await context.close();
  }
}

async function runFirstRunOnboarding(
  clientDataRoot: string,
  rootPath: string,
  cwd: string,
  locale: UiLocale,
  hostProfileId?: string,
): Promise<boolean> {
  const connected = await connectRuntimeHostCli({
    clientDataRoot,
    rootPath,
    interactiveSsh: true,
    ...(process.stdin.isTTY ? { handoffSurface: createCliHostHandoffSurface(locale) } : {}),
    ...(hostProfileId ? { profileId: hostProfileId } : {}),
  });
  try {
    await runMakaPiTui({
      driver: createFirstRunSessionDriver(),
      title: 'Maka',
      cwd,
      locale,
      model: '',
      connectionSlug: '',
      permissionMode: 'ask',
      firstRun: true,
      turnActivity: {
        activities: new SessionActivityRegistry(),
      } satisfies MakaPiTuiTurnActivitySurface,
      onboarding: createRuntimeHostOnboardingSurface(connected.connection),
    });
    return (await readRuntimeHostConnectionCatalog(connected.connection)).defaultTarget !== null;
  } finally {
    await connected.close();
  }
}

function createFirstRunSessionDriver(): MakaSessionDriver {
  const unavailable = async (): Promise<never> => {
    throw new Error('First-run onboarding cannot start an agent turn');
  };
  return {
    getSessionId: () => null,
    listSessions: async () => [],
    preparePrompt: unavailable,
    submitMessage: unavailable,
    queryCancelledMessages: async () => ({ cancelledMessageIds: [] }),
    compactSession: async function* () {},
    respondToSandboxBoundary: async () => {},
    setModel: async () => {},
    setThinkingLevel: async () => {},
    setPermissionMode: async () => {},
    renameSession: async () => {},
    switchSession: unavailable,
    listRewindTargets: async () => [],
    rewindToTurn: unavailable,
    startNewSession: () => Promise.resolve(),
    stop: async () => {},
  };
}

function isMissingDefaultConnection(error: unknown): boolean {
  const parsed = parseNoRealConnectionError(error);
  return parsed.matched && parsed.reason === 'missing_default_connection';
}
