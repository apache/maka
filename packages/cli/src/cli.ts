#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveMakaWorkspaceRoot } from './workspace-root.js';

export type MakaCliCommand =
  | { kind: 'tui'; resumeSessionId?: string }
  | { kind: 'run'; args: string[] }
  | { kind: 'activate'; args: string[] }
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
  if (first === 'activate') return { kind: 'activate', args: argv.slice(1) };
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
    '  maka activate ... Run one Cloud Session activation and emit JSONL',
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

export async function runMakaCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const version = await readPackageVersion();
  const command = parseMakaCliArgs(argv, version);
  switch (command.kind) {
    case 'run': {
      const { runRuntimeHostTextCli } = await import('./runtime-host-run-command.js');
      return runRuntimeHostTextCli(command.args);
    }
    case 'activate': {
      const { runMakaActivationCli } = await import('./activation-command.js');
      return runMakaActivationCli(command.args);
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
      const { runRuntimeHostTui } = await import('./runtime-host-tui-command.js');
      return runRuntimeHostTui({
        workspaceRoot,
        cwd: process.cwd(),
        onProcessExit: handleMakaCliProcessExit,
        ...(command.resumeSessionId ? { resumeSessionId: command.resumeSessionId } : {}),
      });
    }
  }
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
