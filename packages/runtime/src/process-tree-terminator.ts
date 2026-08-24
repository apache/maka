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

import { execFile, spawn, type ChildProcess } from 'node:child_process';

export type ProcessTerminationSignal = 'SIGTERM' | 'SIGKILL';

export const DEFAULT_PROCESS_TERMINATION_GRACE_MS = 2000;

const WINDOWS_TASKKILL_TIMEOUT_MS = 2000;
const POSIX_PS_PATHS = ['/bin/ps', '/usr/bin/ps'] as const;

interface ProcessTreeTerminationOptions {
  pid: number;
  signal: ProcessTerminationSignal;
  fallback?: () => boolean | void;
  hasExited?: () => boolean;
  /** Runs after asynchronous topology discovery and before the first OS action. */
  beforeSignal?: () => boolean;
}

interface PosixProcess {
  pid: number;
  ppid: number;
  pgid: number;
}

let posixProcessSnapshot: Promise<PosixProcess[]> | undefined;

export function terminateChildProcessTree(
  child: ChildProcess,
  signal: ProcessTerminationSignal,
): Promise<boolean> {
  const pid = child.pid;
  if (!pid) return Promise.resolve(false);
  return terminateProcessTree({
    pid,
    signal,
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
    fallback: () => {
      try {
        return child.kill(signal);
      } catch {
        return false;
      }
    },
  });
}

export async function terminateProcessTree(
  options: ProcessTreeTerminationOptions,
): Promise<boolean> {
  const { pid, signal, fallback, hasExited, beforeSignal } = options;
  if (hasExited?.()) return false;
  if (process.platform === 'win32') {
    if (beforeSignal && !beforeSignal()) return false;
    if (await killWindowsTree(pid)) return true;
    if (hasExited?.()) return false;
    return invokeFallback(fallback);
  }

  const processes = await readPosixProcesses();
  if (hasExited?.()) return false;
  if (beforeSignal && !beforeSignal()) return false;

  const escapedDescendantSignaled = forceKillEscapedDescendants(pid, processes);
  if (hasExited?.()) return escapedDescendantSignaled;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (isMissingProcessError(error) || hasExited?.()) return escapedDescendantSignaled;
    return invokeFallback(fallback) || escapedDescendantSignaled;
  }
}

function forceKillEscapedDescendants(rootPid: number, processes: PosixProcess[]): boolean {
  const root = processes.find((entry) => entry.pid === rootPid);
  if (!root) return false;

  const children = new Map<number, PosixProcess[]>();
  for (const processInfo of processes) {
    const siblings = children.get(processInfo.ppid) ?? [];
    siblings.push(processInfo);
    children.set(processInfo.ppid, siblings);
  }

  const descendants: Array<PosixProcess & { depth: number }> = [];
  const seen = new Set([rootPid]);
  const pending: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];
  while (pending.length > 0) {
    const parent = pending.pop();
    if (!parent) break;
    for (const child of children.get(parent.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      const depth = parent.depth + 1;
      descendants.push({ ...child, depth });
      pending.push({ pid: child.pid, depth });
    }
  }

  // Descendants already outside the root group must die before their current
  // ancestry disappears. New daemonization after this snapshot is best-effort.
  descendants.sort((left, right) => right.depth - left.depth);
  let signaled = false;
  for (const descendant of descendants) {
    if (descendant.pgid === root.pgid) continue;
    try {
      process.kill(descendant.pid, 'SIGKILL');
      signaled = true;
    } catch {
      // The descendant may have exited between the process snapshot and signal.
    }
  }
  return signaled;
}

function readPosixProcesses(): Promise<PosixProcess[]> {
  if (posixProcessSnapshot) return posixProcessSnapshot;
  const snapshot = readPosixProcessesUncached();
  posixProcessSnapshot = snapshot;
  void snapshot.finally(() => {
    if (posixProcessSnapshot === snapshot) posixProcessSnapshot = undefined;
  });
  return snapshot;
}

async function readPosixProcessesUncached(): Promise<PosixProcess[]> {
  for (const path of POSIX_PS_PATHS) {
    const output = await readPosixProcessTable(path);
    if (output === undefined) continue;
    try {
      const processes = parsePosixProcesses(output);
      if (processes.length > 0) return processes;
    } catch {
      // Try the next fixed system path before degrading to process groups.
    }
  }
  return [];
}

function readPosixProcessTable(path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        path,
        ['-axo', 'pid=,ppid=,pgid='],
        {
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
          timeout: 1_000,
        },
        (error, output) => {
          resolve(error ? undefined : output);
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

function parsePosixProcesses(output: string): PosixProcess[] {
  const processes: PosixProcess[] = [];
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/).map(Number);
    if (fields.length !== 3 || fields.some((value) => !Number.isSafeInteger(value) || value < 0))
      continue;
    const [pid, ppid, pgid] = fields;
    if (pid === undefined || ppid === undefined || pgid === undefined || pid === 0) continue;
    processes.push({ pid, ppid, pgid });
  }
  return processes;
}

function invokeFallback(fallback: (() => boolean | void) | undefined): boolean {
  if (!fallback) return false;
  try {
    return fallback() !== false;
  } catch {
    return false;
  }
}

function isMissingProcessError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
}

/** Force-kill a Windows process tree and wait for taskkill's exit status. */
export function killWindowsTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (succeeded: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(succeeded);
    };
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
      killer.once('error', () => finish(false));
      killer.once('close', (code) => finish(code === 0));
      timeout = setTimeout(() => {
        try {
          killer.kill();
        } catch {
          /* taskkill already exited */
        }
        finish(false);
      }, WINDOWS_TASKKILL_TIMEOUT_MS);
    } catch {
      finish(false);
    }
  });
}
