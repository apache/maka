#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
import { createMakaSessionDriver, type MakaSessionDriver } from './session-driver.js';
import { createMakaCliRuntimeContext } from './runtime-bootstrap.js';
import { selectableModelIdsForTarget } from './connection-target.js';
import { resolveMakaWorkspaceRoot } from './workspace-root.js';
import { runMakaPiTui, type MakaPiTuiGoalLifecycle } from './pi-tui-runner.js';
import { createApiKeyOnboardingSurface } from './onboarding.js';

export type MakaCliCommand =
  | { kind: 'tui'; resumeSessionId?: string }
  | { kind: 'run'; args: string[] }
  | { kind: 'eval'; args: string[] }
  | { kind: 'inspect'; args: string[] }
  | { kind: 'help'; text: string }
  | { kind: 'version'; text: string }
  | { kind: 'error'; message: string; exitCode: number };

export function parseMakaCliArgs(argv: string[], version: string): MakaCliCommand {
  if (argv.length === 0) return { kind: 'tui' };
  const [first] = argv;
  if (first === '--help' || first === '-h') return { kind: 'help', text: helpText() };
  if (first === '--version' || first === '-v') return { kind: 'version', text: version };
  if (first === '--resume') {
    const sessionId = argv[1];
    if (!sessionId || sessionId.startsWith('-')) {
      return { kind: 'error', message: '--resume requires a session id', exitCode: 2 };
    }
    const extra = argv[2];
    if (extra !== undefined) {
      return { kind: 'error', message: `Unexpected argument: ${extra}`, exitCode: 2 };
    }
    return { kind: 'tui', resumeSessionId: sessionId };
  }
  if (first === 'run' || first === '-p') return { kind: 'run', args: argv.slice(1) };
  if (first === 'eval') return { kind: 'eval', args: argv.slice(1) };
  if (first === 'inspect') return { kind: 'inspect', args: argv.slice(1) };
  return {
    kind: 'error',
    message: `Unexpected argument: ${first ?? ''}`,
    exitCode: 2,
  };
}

export function resolveMakaCliExitCode(
  commandExitCode: number,
  pendingExitCode: number | string | null | undefined,
): number | string {
  return pendingExitCode === undefined || pendingExitCode === null || pendingExitCode === 0
    ? commandExitCode
    : pendingExitCode;
}

export function formatMakaCliFatalError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

let processExitTimer: NodeJS.Timeout | undefined;

export function beginMakaCliExit(commandExitCode: number): void {
  const exitCode = resolveMakaCliExitCode(commandExitCode, process.exitCode);
  process.exitCode = exitCode;
  if (processExitTimer) return;
  processExitTimer = setTimeout(() => process.exit(process.exitCode ?? 0), PROCESS_EXIT_GRACE_MS);
  processExitTimer.unref();
}

export function handleMakaCliProcessExit(
  exitCode: number,
  error?: unknown,
  writeFatal: (message: string) => unknown = (message) => process.stderr.write(message),
): void {
  beginMakaCliExit(exitCode);
  if (error) writeFatal(`${formatMakaCliFatalError(error)}\n`);
}

function helpText(): string {
  return [
    'Usage: maka',
    '',
    'Launches the Maka terminal UI in the current working directory.',
    '',
    'Commands:',
    '  maka              Start the TUI',
    '  maka-agent        Start the TUI',
    '  maka run ...      Run one non-interactive model turn',
    '  maka -p ...       Alias for maka run',
    '  maka eval ...     Run evaluation and autonomous task commands',
    '  maka inspect ...  Inspect Session, AgentRun, or TaskRun evidence',
    '',
    'Options:',
    '  -h, --help        Show help',
    '  -v, --version     Show version',
    '  --resume <session-id>  Reopen a previous session in the TUI',
  ].join('\n');
}

export function formatResumeHint(sessionId: string | null): string | null {
  if (!sessionId) return null;
  return `Resume this session with:\n  maka --resume ${sessionId}`;
}

/** The connection/model a resumed session's stored header requests, used to
 *  anchor startup before `createMakaCliRuntimeContext` resolves any connection. */
export interface TuiResumeTarget {
  requestedConnectionSlug: string;
  requestedModel: string;
}

/**
 * Pre-check a `--resume` target before the runtime context — and its
 * default-connection resolution — is created. Without this, `tui` startup
 * always resolved the *default* connection first and only switched onto the
 * resumed session's connection/model afterward (inside the runner, via
 * `switchSession`); a session resumed on a non-default (or the only ready)
 * connection could misfire onboarding or fail outright before `switchSession`
 * ever ran. Reading the stored header here lets startup anchor the
 * connection/model to the session being resumed instead, so the later
 * `switchSession` call (still exercising the same transcript/header
 * validation) has a live driver to switch.
 *
 * Returns `undefined` when the header can't be read (session missing,
 * corrupt, etc.) — that failure is not reported here. `runMakaPiTui`'s
 * `switchSession` call already owns the user-visible resume-failure path
 * (a "Could not resume session ...: ... Starting fresh." notice, falling
 * back to a fresh session); this pre-check silently falls back to starting
 * the TUI against the default connection so that path runs and reports it.
 */
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

export async function runMakaCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const version = await readPackageVersion();
  const command = parseMakaCliArgs(argv, version);
  switch (command.kind) {
    case 'run': {
      const { runMakaTextCli } = await import('./run-command.js');
      return runMakaTextCli(command.args);
    }
    case 'eval': {
      const { runMakaEvalCli } = await import('@maka/headless/eval-router');
      return runMakaEvalCli(command.args);
    }
    case 'inspect': {
      const { runMakaInspectCli } = await import('./inspect-command.js');
      return runMakaInspectCli(command.args);
    }
    case 'help':
      process.stdout.write(`${command.text}\n`);
      return 0;
    case 'version':
      process.stdout.write(`${command.text}\n`);
      return 0;
    case 'error':
      process.stderr.write(`${command.message}\n\n${helpText()}\n`);
      return command.exitCode;
    case 'tui': {
      const workspaceRoot = resolveMakaWorkspaceRoot();
      let sessionTitleListener: ((sessionId: string) => void) | undefined;
      const resumeTarget = command.resumeSessionId
        ? await resolveTuiResumeTarget(workspaceRoot, command.resumeSessionId)
        : undefined;
      const contextInput = {
        surface: 'tui' as const,
        workspaceRoot,
        cwd: process.cwd(),
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
        if (!isFirstRun) {
          const guidance = formatStartupConnectionError(error, workspaceRoot);
          if (guidance === null) throw error;
          process.stderr.write(`${guidance}\n`);
          return 1;
        }
        // Fresh install with no connection: run the in-TUI onboarding wizard
        // before giving up, then retry context creation with the new connection.
        const configured = await runFirstRunOnboarding(workspaceRoot);
        if (!configured) {
          process.stderr.write(`${formatStartupConnectionError(error, workspaceRoot)}\n`);
          return 1;
        }
        try {
          context = await createMakaCliRuntimeContext(contextInput);
        } catch (retryError) {
          // A failure after onboarding (e.g. the saved connection still isn't
          // ready) gets the same classified guidance as the first attempt,
          // not a raw stack propagated to the top-level handler.
          const guidance = formatStartupConnectionError(retryError, workspaceRoot);
          if (guidance === null) throw retryError;
          process.stderr.write(`${guidance}\n`);
          return 1;
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
          onProcessExit: handleMakaCliProcessExit,
          resumeSessionId: command.resumeSessionId,
        });
        const hint = formatResumeHint(driver.getSessionId());
        if (hint) process.stdout.write(`${hint}\n`);
        return 0;
      } finally {
        await context.close();
      }
    }
  }
}

/**
 * Turn a startup failure into first-run connection guidance, or `null` when the
 * error is not a `NO_REAL_CONNECTION` failure (so the caller re-throws it). The
 * reason-specific line reuses the shared core copy; the footer explains the CLI
 * has no in-app settings — connections are configured in the desktop app, which
 * writes the same workspace this CLI reads.
 */
export function formatStartupConnectionError(error: unknown, workspaceRoot: string): string | null {
  // `resolveDefaultSessionTarget` is the only producer of `NO_REAL_CONNECTION`
  // on this startup path. A matched error with an unknown reason still yields
  // generic fix copy below; a non-match returns null so the real error keeps
  // propagating to the top-level handler unchanged.
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

/** Run the first-run onboarding wizard when no connection exists yet. Returns
 *  true if the user configured a connection, false if they cancelled. The host
 *  owns the stores; the wizard only collects provider + key (see MakaOnboardingSurface). */
async function runFirstRunOnboarding(workspaceRoot: string): Promise<boolean> {
  const connectionStore = createConnectionStore(workspaceRoot);
  const credentialStore = createFileCredentialStore(workspaceRoot);
  await runMakaPiTui({
    driver: createFirstRunSessionDriver(),
    title: 'Maka',
    cwd: process.cwd(),
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
  // Configured iff a connection was actually persisted during the wizard — the
  // wizard only closes after a successful save (or on cancel; see runner firstRun).
  return (await connectionStore.getDefault()) !== null;
}

/** A minimal session driver for the first-run wizard. The wizard never runs an
 *  agent turn (the editor only collects the API key via the onboarding
 *  intercept), so runtime/chat methods are unreachable stubs. */
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

async function readPackageVersion(): Promise<string> {
  const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
}

if (isMainModule()) {
  runMakaCli().then(
    (code) => {
      beginMakaCliExit(code);
    },
    (error) => {
      handleMakaCliProcessExit(1, error);
    },
  );
}

// ShellRun escalates SIGTERM to SIGKILL after two seconds. Keep the CLI alive
// long enough for that cleanup to finish before the final process fallback.
const PROCESS_EXIT_GRACE_MS = 3_000;

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
