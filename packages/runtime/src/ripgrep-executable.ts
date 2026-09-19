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

import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

export function defaultRipgrepCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const executableName = platform === 'win32' ? 'rg.exe' : 'rg';
  return [
    ...(env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, executableName)),
    ...(platform === 'win32' ? [] : ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg']),
    // winget adds this directory to PATH only for processes started after the
    // install. A running Host must probe it explicitly for install-and-retry.
    ...(platform === 'win32' && env.LOCALAPPDATA
      ? [join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', executableName)]
      : []),
  ];
}

export async function* resolveRipgrepCandidates(
  candidates: readonly string[],
): AsyncGenerator<string> {
  const resolved = new Set<string>();
  for (const candidate of candidates) {
    const executable = await resolveExecutable(candidate);
    if (!executable || resolved.has(executable)) continue;
    resolved.add(executable);
    yield executable;
  }
}

export async function resolveRipgrepExecutable(
  candidates: readonly string[],
): Promise<string | undefined> {
  for await (const executable of resolveRipgrepCandidates(candidates)) return executable;
  return undefined;
}

async function resolveExecutable(candidate: string): Promise<string | undefined> {
  if (!candidate || !isAbsolute(candidate)) return undefined;
  try {
    await access(candidate, constants.X_OK);
    return await realpath(candidate);
  } catch {
    return undefined;
  }
}
