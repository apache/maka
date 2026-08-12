import { spawn } from 'node:child_process';
import type { PreToolUseHookInput, ResolvedHookDefinition } from '@maka/core/hooks';
import { BashTailBuffer } from '../bash-tail-buffer.js';
import {
  DEFAULT_PROCESS_IO_DRAIN_TIMEOUT_MS,
  manageChildProcessLifecycle,
} from '../child-process-lifecycle.js';
import { DEFAULT_PROCESS_TERMINATION_GRACE_MS } from '../process-tree-terminator.js';

const HOOK_OUTPUT_LIMIT = 64 * 1024;

export interface HookCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

export interface HookCommandRunner {
  run(
    definition: ResolvedHookDefinition,
    input: PreToolUseHookInput,
    abortSignal: AbortSignal,
  ): Promise<HookCommandResult>;
}

export function createHookCommandRunner(): HookCommandRunner {
  return { run: runHookCommand };
}

async function runHookCommand(
  definition: ResolvedHookDefinition,
  input: PreToolUseHookInput,
  abortSignal: AbortSignal,
): Promise<HookCommandResult> {
  if (abortSignal.aborted) return emptyResult({ aborted: true });
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(definition.command, definition.args, {
      cwd: input.cwd,
      env: minimalHookEnvironment(),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    return emptyResult({ spawnError: errorMessage(error) });
  }

  const stdout = new BashTailBuffer(HOOK_OUTPUT_LIMIT);
  const stderr = new BashTailBuffer(HOOK_OUTPUT_LIMIT);
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: string) => stderr.push(chunk));

  const lifecycle = manageChildProcessLifecycle(
    child,
    [
      ...(child.stdout ? [{ key: 'stdout' as const, stream: child.stdout }] : []),
      ...(child.stderr ? [{ key: 'stderr' as const, stream: child.stderr }] : []),
    ],
    {
      killGraceMs: DEFAULT_PROCESS_TERMINATION_GRACE_MS,
      ioDrainTimeoutMs: DEFAULT_PROCESS_IO_DRAIN_TIMEOUT_MS,
    },
  );

  let timedOut = false;
  let aborted = false;
  let inputError: string | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    lifecycle.terminate();
  }, definition.timeoutMs);
  const abort = () => {
    aborted = true;
    lifecycle.terminate();
  };
  abortSignal.addEventListener('abort', abort, { once: true });

  try {
    await writeHookInput(child.stdin, input).catch((error) => {
      inputError = errorMessage(error);
      lifecycle.terminate();
    });
    const result = await lifecycle.completion;
    return {
      exitCode: result.exitCode,
      stdout: stdout.value(),
      stderr: stderr.value(),
      timedOut,
      aborted,
      ...(inputError ? { spawnError: `Failed to write Hook stdin: ${inputError}` } : {}),
    };
  } catch (error) {
    return {
      ...emptyResult({ spawnError: errorMessage(error) }),
      stdout: stdout.value(),
      stderr: stderr.value(),
      timedOut,
      aborted,
    };
  } finally {
    clearTimeout(timer);
    abortSignal.removeEventListener('abort', abort);
  }
}

function writeHookInput(
  stdin: NodeJS.WritableStream | null,
  input: PreToolUseHookInput,
): Promise<void> {
  if (!stdin) return Promise.reject(new Error('Hook stdin is unavailable'));
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    stdin.once('error', onError);
    stdin.end(`${JSON.stringify(input)}\n`, () => {
      stdin.removeListener('error', onError);
      resolve();
    });
  });
}

function minimalHookEnvironment(): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function emptyResult(input: { aborted?: boolean; spawnError?: string }): HookCommandResult {
  return {
    exitCode: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    aborted: input.aborted ?? false,
    ...(input.spawnError ? { spawnError: input.spawnError } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
