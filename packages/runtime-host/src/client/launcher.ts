import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  candidateStartupFailureForExitCode,
  type CandidateStartupFailure,
} from '../candidate-startup-failure.js';

export interface DetachedCandidateInput {
  rootPath: string;
  expectedRootId: string;
  generation?: string;
  initialConnectionTimeoutMs?: number;
  idleGraceMs?: number;
  handshakeTimeoutMs?: number;
  executable?: string;
  entrypoint: string | URL;
  env?: NodeJS.ProcessEnv;
  stderrPath?: string;
}

export interface DetachedCandidateAttempt {
  pid: number;
  startupFailure?: Promise<CandidateStartupFailure | undefined>;
}

export interface OwnedCandidateAttempt extends DetachedCandidateAttempt {
  releaseToEnvironment(): void;
  settle(timeoutMs: number): Promise<boolean>;
}

export interface DetachedCandidateLaunch {
  spawned: Promise<DetachedCandidateAttempt>;
}

export type CandidateLauncher = (input: DetachedCandidateInput) => DetachedCandidateLaunch;

export function launchDetachedRuntimeHostCandidate(
  input: DetachedCandidateInput,
): DetachedCandidateLaunch {
  const { child } = spawnCandidate(input, true);
  const startupFailure = readStartupFailure(child);
  const spawned = spawnedPid(child).then(({ pid }) => {
    child.unref();
    return { pid, startupFailure };
  });
  return { spawned };
}

export function launchOwnedRuntimeHostCandidate(input: DetachedCandidateInput): {
  readonly spawned: Promise<OwnedCandidateAttempt>;
} {
  const { child, closed } = spawnCandidate(input, false);
  const startupFailure = readStartupFailure(child);
  return {
    spawned: spawnedPid(child).then(({ pid }) => ({
      pid,
      startupFailure,
      releaseToEnvironment(): void {
        child.unref();
      },
      async settle(timeoutMs: number): Promise<boolean> {
        const result = await within(closed, timeoutMs);
        if (result) return result.code === 0 && result.signal === null;
        child.kill('SIGKILL');
        await closed;
        return false;
      },
    })),
  };
}

function spawnCandidate(input: DetachedCandidateInput, detached: boolean) {
  const executable = input.executable ?? process.execPath;
  const args = [
    typeof input.entrypoint === 'string' ? input.entrypoint : fileURLToPath(input.entrypoint),
    '--root',
    input.rootPath,
    '--expected-root-id',
    input.expectedRootId,
  ];
  appendArgument(args, '--initial-connection-timeout-ms', input.initialConnectionTimeoutMs);
  appendArgument(args, '--idle-grace-ms', input.idleGraceMs);
  appendArgument(args, '--handshake-timeout-ms', input.handshakeTimeoutMs);
  appendArgument(args, '--generation', input.generation);

  const stderr = openCandidateStderr(input.stderrPath);
  let child: ReturnType<typeof spawn>;
  try {
    // spawn() commits the side effect synchronously; spawned only reports that commit's outcome.
    child = spawn(executable, args, {
      cwd: dirname(isAbsolute(executable) ? executable : process.execPath),
      detached,
      stdio: ['ignore', 'ignore', stderr?.descriptor ?? 'ignore'],
      windowsHide: true,
      env: {
        ...process.env,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        ...input.env,
      },
    });
  } catch (error) {
    stderr?.close();
    throw error;
  }
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, errorCode?: string) => {
      if (settled) return;
      settled = true;
      stderr?.finish(code, signal, errorCode);
      resolve({ code, signal });
    };
    child.once('close', (code, signal) => finish(code, signal));
    child.once('error', (error) =>
      finish(
        null,
        null,
        typeof (error as NodeJS.ErrnoException).code === 'string'
          ? (error as NodeJS.ErrnoException).code
          : 'UNKNOWN',
      ),
    );
  });
  return { child, closed };
}

function openCandidateStderr(path: string | undefined):
  | {
      descriptor: number;
      finish(code: number | null, signal: NodeJS.Signals | null, errorCode?: string): void;
      close(): void;
    }
  | undefined {
  if (!path) return undefined;
  const descriptor = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    0o600,
  );
  if (!fstatSync(descriptor).isFile()) {
    closeSync(descriptor);
    throw new Error('Runtime Host candidate stderr target is not a file');
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeSync(descriptor);
  };
  return {
    descriptor,
    finish: (code, signal, errorCode) => {
      if (closed) return;
      const marker = errorCode
        ? `MAKA_RUNTIME_HOST_EXIT_V1 code=none signal=none error=${errorCode}\n`
        : `MAKA_RUNTIME_HOST_EXIT_V1 code=${code ?? 'none'} signal=${signal ?? 'none'}\n`;
      writeSync(descriptor, marker);
      close();
    },
    close,
  };
}

function spawnedPid(child: ReturnType<typeof spawn>): Promise<{ pid: number }> {
  return new Promise<{ pid: number }>((resolve, reject) => {
    const onSpawn = () => {
      child.off('error', onError);
      const pid = child.pid;
      if (pid === undefined) {
        reject(new Error('Runtime Host candidate did not receive a process id'));
        return;
      }
      resolve({ pid });
    };
    const onError = (error: Error) => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function readStartupFailure(
  child: ReturnType<typeof spawn>,
): Promise<CandidateStartupFailure | undefined> {
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(candidateStartupFailureForExitCode(code)));
    child.once('error', () => resolve(undefined));
  });
}

async function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function appendArgument(args: string[], key: string, value: string | number | undefined): void {
  if (value === undefined) return;
  args.push(key, String(value));
}
