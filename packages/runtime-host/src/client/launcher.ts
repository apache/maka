import { spawn } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DetachedCandidateInput {
  rootPath: string;
  expectedRootId: string;
  legacyConfigurationRoot?: string;
  idleGraceMs?: number;
  handshakeTimeoutMs?: number;
  executable?: string;
  entrypoint: string | URL;
  env?: NodeJS.ProcessEnv;
}

export interface DetachedCandidateAttempt {
  pid: number;
}

export interface DetachedCandidateLaunch {
  spawned: Promise<DetachedCandidateAttempt>;
}

export type CandidateLauncher = (input: DetachedCandidateInput) => DetachedCandidateLaunch;

export function launchDetachedRuntimeHostCandidate(
  input: DetachedCandidateInput,
): DetachedCandidateLaunch {
  const executable = input.executable ?? process.execPath;
  const args = [
    typeof input.entrypoint === 'string' ? input.entrypoint : fileURLToPath(input.entrypoint),
    '--root',
    input.rootPath,
    '--expected-root-id',
    input.expectedRootId,
  ];
  appendArgument(args, '--idle-grace-ms', input.idleGraceMs);
  appendArgument(args, '--handshake-timeout-ms', input.handshakeTimeoutMs);
  appendArgument(args, '--legacy-configuration-root', input.legacyConfigurationRoot);

  // spawn() commits the side effect synchronously; spawned only reports that commit's outcome.
  const child = spawn(executable, args, {
    cwd: dirname(isAbsolute(executable) ? executable : process.execPath),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...input.env,
    },
  });
  const spawned = new Promise<DetachedCandidateAttempt>((resolve, reject) => {
    const onSpawn = () => {
      child.off('error', onError);
      const pid = child.pid;
      if (pid === undefined) {
        reject(new Error('Runtime Host candidate did not receive a process id'));
        return;
      }
      child.unref();
      resolve({ pid });
    };
    const onError = (error: Error) => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
  return { spawned };
}

function appendArgument(args: string[], key: string, value: string | number | undefined): void {
  if (value === undefined) return;
  args.push(key, String(value));
}
