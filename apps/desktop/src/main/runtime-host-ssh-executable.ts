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

import { existsSync as defaultExistsSync } from 'node:fs';
import { win32 } from 'node:path';

export type RuntimeHostSshTerminalExecutable = 'ssh' | 'scp';

/**
 * Resolve the executable handed to node-pty for interactive SSH sessions.
 *
 * node-pty on Windows matches the file name literally against PATH entries
 * and never applies PATHEXT, so a bare `ssh` always fails with
 * `File not found: ` even when `ssh.exe` is installed. Resolve to an
 * absolute `.exe` path on Windows; every other platform keeps execvp-style
 * lookup and returns the bare name.
 */
export function resolveSshTerminalExecutable(
  executable: RuntimeHostSshTerminalExecutable,
  overrides: {
    readonly platform?: NodeJS.Platform;
    readonly environment?: NodeJS.ProcessEnv;
    readonly existsSync?: (path: string) => boolean;
  } = {},
): string {
  const platform = overrides.platform ?? process.platform;
  if (platform !== 'win32') return executable;
  const environment = overrides.environment ?? process.env;
  const exists = overrides.existsSync ?? defaultExistsSync;
  const fileName = `${executable}.exe`;
  for (const candidate of candidateWindowsSshExecutables(fileName, environment)) {
    if (exists(candidate)) return candidate;
  }
  throw new Error(
    `Unable to find ${fileName} for the interactive SSH session. Install the Windows OpenSSH Client (Settings > System > Optional features) and ensure ${fileName} is on PATH, then restart Maka Desktop.`,
  );
}

function candidateWindowsSshExecutables(
  fileName: string,
  environment: NodeJS.ProcessEnv,
): string[] {
  const candidates: string[] = [];
  const pathValue = environment.Path ?? environment.PATH;
  if (typeof pathValue === 'string') {
    for (const entry of pathValue.split(';')) {
      const directory = entry.trim().replace(/^"+|"+$/gu, '');
      if (!directory) continue;
      candidates.push(win32.resolve(directory, fileName));
    }
  }
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
  if (typeof systemRoot === 'string' && win32.isAbsolute(systemRoot)) {
    candidates.push(win32.join(systemRoot, 'System32', 'OpenSSH', fileName));
  }
  return candidates;
}
