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

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  candidateStartupFailureForExitCode,
  type CandidateStartupFailureReport,
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
  startupFailure?: Promise<CandidateStartupFailureReport | undefined>;
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
  const startupAttemptId = randomUUID();
  const child = spawnCandidate(input, true, startupAttemptId);
  const startupFailure = readStartupFailure(child, startupAttemptId);
  const spawned = spawnedPid(child).then(({ pid }) => {
    child.unref();
    return { pid, startupFailure };
  });
  return { spawned };
}

export function launchOwnedRuntimeHostCandidate(input: DetachedCandidateInput): {
  readonly spawned: Promise<OwnedCandidateAttempt>;
} {
  const startupAttemptId = randomUUID();
  const child = spawnCandidate(input, false, startupAttemptId);
  const startupFailure = readStartupFailure(child, startupAttemptId);
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

function spawnCandidate(
  input: DetachedCandidateInput,
  detached: boolean,
  startupAttemptId: string,
) {
  const executable = input.executable ?? process.execPath;
  const args = [
    typeof input.entrypoint === 'string' ? input.entrypoint : fileURLToPath(input.entrypoint),
    '--root',
    input.rootPath,
    '--expected-root-id',
    input.expectedRootId,
    '--startup-attempt-id',
    startupAttemptId,
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
  startupAttemptId: string,
): Promise<CandidateStartupFailureReport | undefined> {
  return new Promise((resolve) => {
    child.once('exit', (code) => {
      const failure = candidateStartupFailureForExitCode(code);
      resolve(failure ? { ...failure, startupAttemptId } : undefined);
    });
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
