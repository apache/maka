import { describeChatConfigurationReason, parseNoRealConnectionError } from '@maka/core';
import {
  fetchProviderModels,
  resolveSelectedModelContextWindow,
  SessionActivityRegistry,
} from '@maka/runtime';
import {
  createConnectionStore,
  createFileCredentialStore,
  createSessionStore,
} from '@maka/storage';
import { selectableModelIdsForTarget } from './connection-target.js';
import { createApiKeyOnboardingSurface } from './onboarding.js';
import type { MakaPiTuiGoalLifecycle } from './pi-tui-contracts.js';
import { runMakaPiTui } from './pi-tui-runner.js';
import { createMakaCliRuntimeContext } from './runtime-bootstrap.js';
import { createMakaSessionDriver, type MakaSessionDriver } from './session-driver.js';

export interface RunEmbeddedTuiInput {
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly onProcessExit: (exitCode: number, error?: Error) => void;
}

/** The connection/model a resumed session's stored header requests. */
export interface TuiResumeTarget {
  requestedConnectionSlug: string;
  requestedModel: string;
}

export async function resolveTuiResumeTarget(
  workspaceRoot: string,
  sessionId: string,
): Promise<TuiResumeTarget | undefined> {
  const store = createSessionStore(workspaceRoot);
  try {
    const header = await store.readHeader(sessionId);
    return {
      requestedConnectionSlug: header.llmConnectionSlug,
      requestedModel: header.model,
    };
  } catch {
    return undefined;
  }
}

export async function runEmbeddedTui(input: RunEmbeddedTuiInput): Promise<number> {
  let sessionTitleListener: ((sessionId: string) => void) | undefined;
  const resumeTarget = input.resumeSessionId
    ? await resolveTuiResumeTarget(input.workspaceRoot, input.resumeSessionId)
    : undefined;
  const contextInput = {
    surface: 'tui' as const,
    workspaceRoot: input.workspaceRoot,
    cwd: input.cwd,
    onSessionTitleChanged: (sessionId: string) => sessionTitleListener?.(sessionId),
    ...(resumeTarget
      ? {
          requestedConnectionSlug: resumeTarget.requestedConnectionSlug,
          requestedModel: resumeTarget.requestedModel,
        }
      : {}),
  };
  let context;
  try {
    context = await createMakaCliRuntimeContext(contextInput);
  } catch (error) {
    const { matched, reason } = parseNoRealConnectionError(error);
    const isFirstRun = matched && reason === 'missing_default_connection';
    if (!isFirstRun) return reportStartupError(error, input.workspaceRoot);
    const configured = await runFirstRunOnboarding(input.workspaceRoot, input.cwd);
    if (!configured) return reportStartupError(error, input.workspaceRoot);
    try {
      context = await createMakaCliRuntimeContext(contextInput);
    } catch (retryError) {
      return reportStartupError(retryError, input.workspaceRoot);
    }
  }

  try {
    const driver = createMakaSessionDriver({
      runtime: context.runtime,
      cwd: context.cwd,
      llmConnectionSlug: context.target.connection.slug,
      model: context.target.model,
      permissionMode: 'ask',
    });
    await runMakaPiTui({
      driver,
      title: 'Maka',
      cwd: context.cwd,
      model: context.target.model,
      models: selectableModelIdsForTarget(context.target),
      modelChoices: context.modelChoices,
      connectionSlug: context.target.connection.slug,
      providerType: context.target.connection.providerType,
      modelContextWindow: resolveSelectedModelContextWindow(
        context.target.connection,
        context.target.model,
      ),
      permissionMode: 'ask',
      subscribeShellRunUpdates: context.subscribeShellRunUpdates,
      subscribeSessionTitleChanges: (listener) => {
        sessionTitleListener = listener;
        return () => {
          if (sessionTitleListener === listener) sessionTitleListener = undefined;
        };
      },
      listShellRunUpdates: context.listShellRunUpdates,
      skills: context.skills,
      goalLifecycle: context.goalContinuation,
      onboarding: context.onboarding,
      recap: context.recap,
      foreignSessions: context.foreignSessions,
      onProcessExit: input.onProcessExit,
      resumeSessionId: input.resumeSessionId,
    });
    const sessionId = driver.getSessionId();
    if (sessionId)
      process.stdout.write(`Resume this session with:\n  maka --resume ${sessionId}\n`);
    return 0;
  } finally {
    await context.close();
  }
}

export function formatStartupConnectionError(error: unknown, workspaceRoot: string): string | null {
  const { matched, reason } = parseNoRealConnectionError(error);
  if (!matched) return null;
  return [
    '无法启动 Maka：还没有可用的模型连接。',
    '',
    describeChatConfigurationReason(reason),
    '',
    'Maka CLI 复用 Maka 桌面应用的配置。请打开 Maka 桌面应用，在 设置 · 模型',
    '添加并启用一个模型连接（含 API key），然后重新运行 maka。',
    `连接与凭据存储于：${workspaceRoot}`,
  ].join('\n');
}

function reportStartupError(error: unknown, workspaceRoot: string): number {
  const guidance = formatStartupConnectionError(error, workspaceRoot);
  if (guidance === null) throw error;
  process.stderr.write(`${guidance}\n`);
  return 1;
}

async function runFirstRunOnboarding(workspaceRoot: string, cwd: string): Promise<boolean> {
  const connectionStore = createConnectionStore(workspaceRoot);
  const credentialStore = createFileCredentialStore(workspaceRoot);
  await runMakaPiTui({
    driver: createFirstRunSessionDriver(),
    title: 'Maka',
    cwd,
    model: '',
    connectionSlug: '',
    permissionMode: 'ask',
    firstRun: true,
    goalLifecycle: {
      activities: new SessionActivityRegistry(),
      beginObservedTurn: () => ({ kind: 'registered', settle: async () => {} }),
      bindHost: () => () => {},
    } satisfies MakaPiTuiGoalLifecycle,
    onboarding: createApiKeyOnboardingSurface({
      connectionStore,
      credentialStore,
      fetchModels: fetchProviderModels,
    }),
  });
  return (await connectionStore.getDefault()) !== null;
}

function createFirstRunSessionDriver(): MakaSessionDriver {
  const notReady = async (): Promise<never> => {
    throw new Error('first-run onboarding: no agent turn before a connection exists');
  };
  return {
    getSessionId: () => null,
    listSessions: async () => [],
    preparePrompt: notReady,
    compactSession: async function* () {},
    respondToSandboxBoundary: async () => {},
    setModel: async () => {},
    setThinkingLevel: async () => {},
    setPermissionMode: async () => {},
    renameSession: async () => {},
    switchSession: notReady,
    listRewindTargets: async () => [],
    rewindToTurn: notReady,
    startNewSession: () => {},
    stop: async () => {},
  };
}
