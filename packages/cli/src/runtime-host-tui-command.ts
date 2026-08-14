import { parseNoRealConnectionError } from '@maka/core/connection-error-copy';
import { createInterface } from 'node:readline/promises';
import { SessionActivityRegistry } from '@maka/runtime/goal-turn-lifecycle';
import { readRuntimeHostConnectionCatalog } from '@maka/runtime-host/client';
import { createForeignSessionStore } from '@maka/storage';
import { formatMakaResumeHint } from './cli-invocation.js';
import { connectRuntimeHostCli, RuntimeHostCliConflictError } from './runtime-host-cli-context.js';
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
  readonly resumeSessionId?: string;
  readonly resumeCwd?: string;
  readonly hostProfileId?: string;
  readonly projectId?: string;
  readonly onProcessExit: (exitCode: number, error?: Error) => void;
}

export async function runRuntimeHostTui(input: RunRuntimeHostTuiInput): Promise<number> {
  const foreignSessions = createForeignSessionStore();
  const contextInput = {
    clientDataRoot: input.clientDataRoot,
    rootPath: input.workspaceRoot,
    cwd: input.cwd,
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
    ...(input.hostProfileId ? { hostProfileId: input.hostProfileId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
  let context;
  try {
    context = await createTuiContextWithHostConflictPrompt(contextInput);
    if (!context) return 1;
  } catch (error) {
    if (!isMissingDefaultConnection(error) || input.resumeSessionId) throw error;
    const configured = await runFirstRunOnboarding(
      input.clientDataRoot,
      input.workspaceRoot,
      input.cwd,
      input.hostProfileId,
    );
    if (!configured) throw error;
    context = await createRuntimeHostTuiContext(contextInput);
  }
  try {
    await runMakaPiTui({
      driver: context.driver,
      title: context.profile.kind === 'local' ? 'Maka' : `Maka — ${context.profile.name}`,
      cwd: context.cwd,
      model: context.model,
      models: context.modelChoices
        .filter((choice) => choice.connectionSlug === context.connectionSlug)
        .map((choice) => choice.model),
      modelChoices: context.modelChoices,
      connectionSlug: context.connectionSlug,
      providerType: context.providerType,
      modelContextWindow: context.modelContextWindow,
      permissionMode: 'ask',
      turnActivity: context.turnActivity,
      listSkills: context.listSkills,
      onboarding: context.onboarding,
      recap: context.recap,
      ...(context.profile.kind === 'local'
        ? { foreignSessions }
        : {
            sessionListScope: 'all' as const,
            clientPathAuthority: 'none' as const,
          }),
      subscribeShellRunUpdates: (listener) => context.driver.subscribeShellRunUpdates(listener),
      listShellRunUpdates: (sessionId) => context.driver.listShellRunUpdates(sessionId),
      onProcessExit: input.onProcessExit,
      cliCommand: input.cliCommand,
      resumeSessionId: input.resumeSessionId,
      resumeCwd: input.resumeCwd,
      ...(context.profile.kind === 'remote' && input.resumeSessionId
        ? { resumeFailure: 'exit' as const }
        : {}),
    });
    const sessionId = context.driver.getSessionId();
    const hint = formatMakaResumeHint(input.cliCommand, sessionId, {
      ...(context.profile.kind === 'remote' ? { hostProfileId: context.profile.id } : {}),
    });
    if (hint) process.stdout.write(`${hint}\n`);
    return 0;
  } finally {
    await context.close();
  }
}

async function createTuiContextWithHostConflictPrompt(
  input: Parameters<typeof createRuntimeHostTuiContext>[0],
): Promise<Awaited<ReturnType<typeof createRuntimeHostTuiContext>> | null> {
  let waitingForHost = false;
  while (true) {
    try {
      return await createRuntimeHostTuiContext(input);
    } catch (error) {
      if (!(error instanceof RuntimeHostCliConflictError) || !process.stdin.isTTY) throw error;
      if (waitingForHost) {
        await waitForHostRetry();
        continue;
      }
      process.stderr.write(`${error.message}\n`);
      const readline = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = (await readline.question('Wait and try again, or cancel? [W/c] '))
          .trim()
          .toLowerCase();
        if (answer === 'c' || answer === 'cancel') return null;
        waitingForHost = true;
      } finally {
        readline.close();
      }
      await waitForHostRetry();
    }
  }
}

function waitForHostRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2_000));
}

async function runFirstRunOnboarding(
  clientDataRoot: string,
  rootPath: string,
  cwd: string,
  hostProfileId?: string,
): Promise<boolean> {
  const connected = await connectRuntimeHostCli({
    clientDataRoot,
    rootPath,
    surface: 'tui',
    ...(hostProfileId ? { profileId: hostProfileId } : {}),
  });
  try {
    await runMakaPiTui({
      driver: createFirstRunSessionDriver(),
      title: 'Maka',
      cwd,
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
    compactSession: async function* () {},
    respondToSandboxBoundary: async () => {},
    setModel: async () => {},
    setThinkingLevel: async () => {},
    setPermissionMode: async () => {},
    renameSession: async () => {},
    switchSession: unavailable,
    listRewindTargets: async () => [],
    rewindToTurn: unavailable,
    startNewSession: () => {},
    stop: async () => {},
  };
}

function isMissingDefaultConnection(error: unknown): boolean {
  const parsed = parseNoRealConnectionError(error);
  return parsed.matched && parsed.reason === 'missing_default_connection';
}
