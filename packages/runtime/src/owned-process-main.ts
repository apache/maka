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
import { terminateProcessTree } from './process-tree-terminator.js';
import type { OwnedProcessLaunch } from './owned-child-process.js';

let command: ChildProcess | undefined;
let stopping = false;
let completed = false;
let ownerLost = false;
let finishing = false;

function loseOwner(): void {
  if (completed || ownerLost) return;
  ownerLost = true;
  stopping = true;
  // This process is the POSIX group leader; the command joins its group. The
  // Windows implementation uses taskkill /T. Discovery also includes descendants
  // that have moved into another process group while still attached to this tree.
  void terminateProcessTree({
    pid: process.pid,
    signal: 'SIGKILL',
    fallback: () => process.exit(1),
  }).then(
    () => process.exit(1),
    () => process.exit(1),
  );
}

/** An unexpected supervisor error. Stopping the tree ends this process with
 * its own group's SIGKILL, which the Host cannot tell from a forced stop, so
 * report the fault first while the lease is still up. */
function fault(error: unknown): void {
  if (completed || ownerLost) return;
  // The command has exited and its result is already on the way; a fault
  // now must not turn it into a failure. Only make sure this process ends.
  if (finishing) {
    setTimeout(() => process.exit(1), 1_000);
    return;
  }
  if (!process.connected) {
    loseOwner();
    return;
  }
  // The tree stops whether or not the report goes through.
  setTimeout(loseOwner, 1_000);
  const message = error instanceof Error ? error.message : String(error);
  try {
    process.send!({ kind: 'failed', message: `Command supervisor failed: ${message}` }, () =>
      loseOwner(),
    );
  } catch {
    loseOwner();
  }
}

process.on('disconnect', loseOwner);
process.on('uncaughtException', fault);
process.on('unhandledRejection', fault);
// The command shares this process group, so a group-wide signal its own script
// sends (`kill -HUP 0`) reaches the supervisor too. Ignore the ones whose
// default action would end it, or for SIGUSR1 start the inspector, so the
// command alone decides how to handle them. Windows cannot listen for these.
if (process.platform !== 'win32') {
  for (const signal of ['SIGHUP', 'SIGUSR1', 'SIGUSR2', 'SIGQUIT', 'SIGALRM'] as const) {
    process.on(signal, () => {});
  }
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stopping = true;
    // On POSIX the Host signals our entire group, including the command. Do not
    // forward the signal a second time. Before admission, stop without spawning.
    if (!command) finish(null, signal);
  });
}

function send(message: object, then?: () => void): void {
  if (!process.connected) {
    loseOwner();
    return;
  }
  process.send!(message, (error: Error | null) => {
    if (error) loseOwner();
    else then?.();
  });
}

function finish(code: number | null, signal: NodeJS.Signals | null): void {
  finishing = true;
  send({ kind: 'completed' }, () => {
    completed = true;
    if (signal) exitWithSignal(signal);
    else process.exit(code ?? 1);
  });
}

/** Mirror the command's terminating signal. Node ignores SIGPIPE and reserves
 * SIGUSR1 for its inspector even without listeners; removing a listener resets
 * the handler to the default action, so the re-raised signal ends this process.
 */
function exitWithSignal(signal: NodeJS.Signals): void {
  process.removeAllListeners(signal);
  try {
    process.on(signal, () => {});
    process.removeAllListeners(signal);
  } catch {
    // SIGKILL and SIGSTOP accept no listener; their default action already applies.
  }
  process.kill(process.pid, signal);
  // Never outlive the command if the signal did not end this process.
  setTimeout(() => process.exit(1), 1_000);
}

if (!process.connected) process.exit(1);
process.once('message', (message) => {
  if (!process.connected) {
    loseOwner();
    return;
  }
  // A stop that arrived before the launch is already finishing.
  if (stopping) return;
  const input = message as OwnedProcessLaunch;
  if (input.kind !== 'launch') {
    loseOwner();
    return;
  }
  // A group signal can be pending in this loop turn alongside the launch.
  // Spawn in the check phase, after its handler has run, so a stop that
  // arrived first ends the supervisor without starting the command.
  setImmediate(() => {
    if (stopping) return;
    if (!process.connected) {
      loseOwner();
      return;
    }
    launch(input);
  });
});

function launch(input: OwnedProcessLaunch): void {
  const stdio: Array<number | 'ignore'> = [0, 1, 2];
  for (const fd of input.inheritedFds) {
    while (stdio.length <= fd) stdio.push('ignore');
    stdio[fd] = fd;
  }
  try {
    command = spawn(input.program, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      shell: input.shell,
      stdio,
      detached: false,
      windowsHide: true,
    });
    command.once('spawn', () => send({ kind: 'started', pid: command?.pid }));
    command.once('error', failed);
    command.once('exit', finish);
  } catch (error) {
    failed(error as Error);
  }
}

function failed(error: Error): void {
  send(
    { kind: 'failed', message: error.message, code: (error as NodeJS.ErrnoException).code },
    () => {
      completed = true;
      process.exit(1);
    },
  );
}
