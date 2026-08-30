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

export type ProcessTerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;

export interface ProcessTerminationOptions {
  readonly platform?: NodeJS.Platform;
  readonly runTaskkill?: (pid: number) => Promise<boolean>;
}

/**
 * Terminates a child using the platform's process lifecycle semantics.
 * Windows does not implement POSIX signals, so every termination request must
 * include descendants. Otherwise the root can exit before forced escalation
 * and leave its workers running.
 */
export function terminateProcess(
  child: ChildProcess | undefined,
  signal: ProcessTerminationSignal,
  options: ProcessTerminationOptions = {},
): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(false);

  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const pid = child.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
      return killChild(child);
    }
    return (options.runTaskkill ?? killWindowsTree)(pid).then((killed) =>
      killed ? true : killChild(child),
    );
  }

  return killChild(child, signal);
}

function killChild(child: ChildProcess, signal?: ProcessTerminationSignal): Promise<boolean> {
  try {
    // Omitting the signal is intentional on Windows: Node uses its native
    // graceful termination path instead of trying to emulate a POSIX signal.
    return Promise.resolve(signal === undefined ? child.kill() : child.kill(signal));
  } catch {
    return Promise.resolve(false);
  }
}

function killWindowsTree(pid: number): Promise<boolean> {
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
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
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
