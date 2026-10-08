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
import { fileURLToPath } from 'node:url';
import { buildSpawnStdio, type ChildFdInput } from './child-fd-input.js';
import { terminateProcessTree } from './process-tree-terminator.js';

export interface OwnedProcessInput {
  program: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell: boolean;
  stdin: 'ignore' | 'pipe';
  fdInputs?: readonly ChildFdInput[];
}

export interface OwnedProcessLaunch {
  kind: 'launch';
  program: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: boolean;
  inheritedFds: number[];
}

type SupervisorMessage =
  | { kind: 'started'; pid?: number }
  | { kind: 'completed' }
  | { kind: 'failed'; message: string; code?: string };

/** The returned PID owns the command group. Its private IPC channel is a
 * lifetime lease: only the supervisor can spawn the command, and losing the
 * owner tears down the group even when no Host cleanup callback can run.
 * Output and descriptor payloads flow directly through inherited OS handles.
 * `ready` resolves with the command's own PID once the supervisor admits it.
 */
export function spawnOwnedProcess(input: OwnedProcessInput): {
  child: ChildProcess;
  ready: Promise<number | undefined>;
} {
  const stdio = buildSpawnStdio(input.fdInputs, input.stdin);
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./owned-process-main.js', import.meta.url))],
    {
      cwd: input.cwd,
      // Caller-supplied environment belongs to the command, not this trusted supervisor.
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
      stdio: [...stdio, 'ipc'],
      // POSIX: the supervisor leads a new process group that the command joins.
      // Termination signals the group and removes descendants visible outside
      // it at each process-table snapshot. Windows has no process groups;
      // taskkill /T owns the equivalent cleanup. There, detaching also keeps
      // the supervisor out of the Host's libuv job, which would kill it with
      // the Host before it could stop the command's descendants; the command
      // itself stays in the supervisor's job.
      detached: true,
      windowsHide: true,
    },
  );
  let started = false;
  let completed = false;
  let failureReported = false;
  let resolveReady!: (commandPid: number | undefined) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<number | undefined>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Some callers observe ChildProcess errors instead of awaiting admission.
  void ready.catch(() => {});
  const timer = setTimeout(() => fail(new Error('Command supervisor startup timed out')), 10_000);
  timer.unref();
  const terminate = () => {
    if (child.pid) void terminateProcessTree({ pid: child.pid, signal: 'SIGKILL' }).catch(() => {});
  };
  // Once the supervisor is reaped its PID can be reused, so a tree walk from it
  // could reach unrelated processes. Its POSIX process group cannot be
  // reallocated while members remain, so it alone still names the command.
  // Windows has no such handle; taskkill /T on a reaped PID is skipped.
  const terminateOrphanedGroup = () => {
    if (process.platform === 'win32' || !child.pid) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The group is already empty.
    }
  };
  // Command output reaches these pipes directly, racing the IPC admission
  // message. Hold it until callers have observed `ready`, so output never
  // precedes admission, as with a direct spawn. Callers attach 'data'
  // listeners synchronously; an explicit pause keeps those from resuming.
  const outputs = [child.stdout, child.stderr].filter((stream) => stream !== null);
  for (const stream of outputs) stream.pause();
  let outputReleased = false;
  const releaseOutput = () => {
    if (outputReleased) return;
    outputReleased = true;
    for (const stream of outputs) stream.resume();
  };
  /**
   * `stop` says who stops the tree: `tree` walks it from the live supervisor;
   * `group` signals only its process group, because the supervisor is exiting
   * on its own and its PID may be reaped before a walk could start; `none`
   * leaves the stop to the supervisor, which walks its own tree.
   */
  function fail(error: Error, stop: 'tree' | 'group' | 'none' = 'tree'): void {
    if (failureReported) return;
    failureReported = true;
    clearTimeout(timer);
    rejectReady(error);
    releaseOutput();
    if (stop === 'tree') terminate();
    else if (stop === 'group') terminateOrphanedGroup();
    child.emit('error', error);
  }
  child.once('error', (error) => {
    clearTimeout(timer);
    rejectReady(error);
    releaseOutput();
  });
  child.once('spawn', () => {
    const request: OwnedProcessLaunch = {
      kind: 'launch',
      program: input.program,
      args: input.args,
      cwd: input.cwd,
      env: input.env ?? process.env,
      shell: input.shell,
      inheritedFds: (input.fdInputs ?? []).map(({ fd }) => fd),
    };
    child.send(request, (error) => {
      if (error && child.exitCode === null && child.signalCode === null) fail(error);
    });
  });
  child.on('message', (value) => {
    const message = value as SupervisorMessage;
    if (message.kind === 'started') {
      started = true;
      clearTimeout(timer);
      resolveReady(message.pid);
      // Promise continuations of `ready` run before the check phase; a
      // nextTick resume would deliver output ahead of them.
      setImmediate(releaseOutput);
    } else if (message.kind === 'completed') {
      completed = true;
    } else if (message.kind === 'failed') {
      // A result already arrived; a later report cannot replace it.
      if (completed) return;
      const error = Object.assign(new Error(message.message), { code: message.code });
      if (!started) {
        // The command never spawned; the supervisor is exiting on its own.
        completed = true;
        fail(error, 'group');
      } else {
        // A supervisor fault after admission: it stops its own tree, including
        // descendants that left its group, before exiting. Signalling the group
        // now would kill it mid-walk. The group kill on its exit stays the
        // backstop, so `completed` remains unset.
        fail(error, 'none');
      }
    }
  });
  child.once('exit', (code) => {
    clearTimeout(timer);
    releaseOutput();
    // `exit` is not ordered after IPC messages still being read; the channel's
    // close is. Decide a missing result only once the channel has drained.
    if (completed || !child.connected) settleExit(code);
    else child.once('disconnect', () => settleExit(code));
  });
  function settleExit(code: number | null): void {
    if (!started) rejectReady(new Error('Command supervisor exited before admission'));
    if (completed) return;
    // The group can outlive its leader. An unexpected supervisor exit must
    // not leave an admitted command running while the Host is still alive.
    terminateOrphanedGroup();
    // A clean exit without `completed` lost the command's result. On POSIX the
    // Host's own stops end the supervisor by signal, so any exit code there is
    // a supervisor fault too. On Windows taskkill, the Host's forced stop, also
    // ends with an ordinary code.
    const lost = code === 0 || (code !== null && process.platform !== 'win32');
    if (lost && !failureReported) {
      child.emit('error', new Error('Command supervisor lost its result'));
    }
  }
  return { child, ready };
}

/** A supervisor PID denotes the whole command group, including during startup. */
export function signalOwnedProcess(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  if (process.platform === 'win32' || !child.pid) return child.kill(signal);
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
