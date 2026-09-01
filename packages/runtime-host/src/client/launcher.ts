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

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  candidateStartupFailureForExitCode,
  type CandidateStartupFailureReport,
} from '../candidate-startup-failure.js';
import {
  RUNTIME_HOST_LAUNCH_OWNER_GUARD_ENV,
  RUNTIME_HOST_LAUNCH_OWNER_CLIENT_ID_ENV,
  RUNTIME_HOST_LAUNCH_OWNER_LEASE_FD_ENV,
  runtimeHostLaunchOwnerReleaseMessage,
} from '../candidate-launch-owner-guard.js';
import type { RuntimeHostManagedLaunchClaim } from '../operator/managed-deployment.js';
import { RUNTIME_HOST_STDERR_PIPE_ENV } from '../process-diagnostics.js';

const CANDIDATE_STDERR_MAX_BYTES = 4 * 1024;

export interface CandidateExitDetails {
  readonly pid: number | undefined;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface DetachedCandidateInput {
  rootPath: string;
  expectedRootId: string;
  generation?: string;
  initialConnectionTimeoutMs?: number;
  idleGraceMs?: number;
  handshakeTimeoutMs?: number;
  managedLaunchClaim?: RuntimeHostManagedLaunchClaim;
  executable?: string;
  entrypoint: string | URL;
  env?: NodeJS.ProcessEnv;
  /** Existing authority lease inherited only by a launch-owner-supervised Candidate. */
  inheritableAuthorityLeaseFd?: number;
  /** Keep this Candidate bound to the launcher process for its whole lifetime. */
  closeOnLauncherExit?: boolean;
  /** Opaque Client identity admitted while the launch-owner lease remains held. */
  launchOwnerClientInstanceId?: string;
  /** Called with the candidate's exit details; the embedder owns the sink. */
  readonly onExit?: (details: CandidateExitDetails) => void;
}

export interface DetachedCandidateAttempt {
  pid: number;
  startupAttemptId?: string;
  exited?: Promise<CandidateProcessExit>;
  startupFailure?: Promise<CandidateStartupFailureReport | undefined>;
}

export interface CandidateProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
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
  const child = spawnCandidate(input, true, startupAttemptId, input.closeOnLauncherExit === true);
  const exited = observeCandidateExit(child);
  notifyCandidateExit(child, exited, input.onExit);
  const startupFailure = readStartupFailure(exited, startupAttemptId);
  const spawned = spawnedPid(child).then(({ pid }) => {
    child.unref();
    return { pid, startupAttemptId, exited, startupFailure };
  });
  return { spawned };
}

export function launchOwnedRuntimeHostCandidate(input: DetachedCandidateInput): {
  readonly spawned: Promise<OwnedCandidateAttempt>;
} {
  const startupAttemptId = randomUUID();
  const guarded =
    input.inheritableAuthorityLeaseFd !== undefined || input.closeOnLauncherExit === true;
  if (input.inheritableAuthorityLeaseFd !== undefined && !input.launchOwnerClientInstanceId) {
    throw new Error('A launch-owner-supervised Candidate requires its Client identity');
  }
  const child = spawnCandidate(input, false, startupAttemptId, guarded);
  const exited = observeCandidateExit(child);
  notifyCandidateExit(child, exited, input.onExit);
  const startupFailure = readStartupFailure(exited, startupAttemptId);
  let released = false;
  return {
    spawned: spawnedPid(child).then(({ pid }) => ({
      pid,
      startupAttemptId,
      exited,
      startupFailure,
      releaseToEnvironment(): void {
        if (released) return;
        released = true;
        if (!guarded || !child.connected) {
          child.unref();
          return;
        }
        child.send(runtimeHostLaunchOwnerReleaseMessage(), () => {
          if (child.connected) child.disconnect();
          child.unref();
        });
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
  guarded: boolean,
): ChildProcess {
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
  if (input.managedLaunchClaim !== undefined) {
    appendArgument(args, '--managed-deployment-id', input.managedLaunchClaim.deploymentId);
    appendArgument(args, '--managed-config-revision', input.managedLaunchClaim.configRevision);
  }

  // spawn() commits the side effect synchronously; spawned only reports that commit's outcome.
  const inheritedLeaseFd = input.inheritableAuthorityLeaseFd;
  const childLeaseFd = inheritedLeaseFd === undefined ? undefined : 4;
  const guardedStdio: Array<number | 'ignore' | 'pipe' | 'ipc'> =
    childLeaseFd === undefined
      ? ['ignore', 'ignore', 'pipe', 'ipc']
      : ['ignore', 'ignore', 'pipe', 'ipc', inheritedLeaseFd!];
  const child = spawn(executable, args, {
    cwd: dirname(isAbsolute(executable) ? executable : process.execPath),
    detached,
    stdio: guarded ? guardedStdio : ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...input.env,
      [RUNTIME_HOST_STDERR_PIPE_ENV]: '1',
      ...(guarded ? { [RUNTIME_HOST_LAUNCH_OWNER_GUARD_ENV]: '1' } : {}),
      ...(childLeaseFd === undefined
        ? {}
        : {
            [RUNTIME_HOST_LAUNCH_OWNER_LEASE_FD_ENV]: String(childLeaseFd),
            [RUNTIME_HOST_LAUNCH_OWNER_CLIENT_ID_ENV]: input.launchOwnerClientInstanceId!,
          }),
    },
  });
  const stderr = child.stderr as (NodeJS.ReadableStream & { unref?: () => void }) | null;
  stderr?.unref?.();
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

function notifyCandidateExit(
  child: ChildProcess,
  exited: Promise<CandidateProcessExit>,
  onExit: DetachedCandidateInput['onExit'],
): void {
  if (!onExit) return;
  void exited.then(({ code, signal }) => {
    try {
      onExit({ pid: child.pid, code, signal });
    } catch {
      // The embedder owns this diagnostics sink; it must not affect process settlement.
    }
  });
}

function readStartupFailure(
  exited: Promise<CandidateProcessExit>,
  startupAttemptId: string,
): Promise<CandidateStartupFailureReport | undefined> {
  return exited.then(({ code }) => {
    const failure = candidateStartupFailureForExitCode(code);
    return failure ? { ...failure, startupAttemptId } : undefined;
  });
}

function observeCandidateExit(child: ChildProcess): Promise<CandidateProcessExit> {
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderrTruncated = false;
  child.stderr?.on('data', (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (chunk.length > CANDIDATE_STDERR_MAX_BYTES) {
      stderr = chunk.subarray(chunk.length - CANDIDATE_STDERR_MAX_BYTES);
      stderrTruncated = true;
      return;
    }
    const combined = Buffer.concat([stderr, chunk]);
    if (combined.length > CANDIDATE_STDERR_MAX_BYTES) {
      stderr = combined.subarray(combined.length - CANDIDATE_STDERR_MAX_BYTES);
      stderrTruncated = true;
    } else {
      stderr = combined;
    }
  });
  return new Promise((resolve) => {
    child.once('close', (code, signal) => {
      resolve({
        code,
        signal,
        stderr: stderr.toString('utf8'),
        stderrTruncated,
      });
    });
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
