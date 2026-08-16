import { spawn } from 'node:child_process';
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
  const child = spawnCandidate(input, true);
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
  const child = spawnCandidate(input, false);
  const startupFailure = readStartupFailure(child);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    spawned: spawnedPid(child).then(({ pid }) => ({
      pid,
      startupFailure,
      releaseToEnvironment(): void {
        child.unref();
      },
      async settle(timeoutMs: number): Promise<boolean> {
        const result = await within(exited, timeoutMs);
        if (result) return result.code === 0 && result.signal === null;
        child.kill('SIGKILL');
        await exited;
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

  // spawn() commits the side effect synchronously; spawned only reports that commit's outcome.
  const child = spawn(executable, args, {
    cwd: dirname(isAbsolute(executable) ? executable : process.execPath),
    detached,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...input.env,
    },
  });
  return child;
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
