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

import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import { isReadOnlyPermissionProfile, type PermissionProfile } from '@maka/core/permission-profile';

const XCODE_SELECT_TIMEOUT_MS = 1_000;
const CODESIGN_TIMEOUT_MS = 1_000;

interface MacosDeveloperCommandResult {
  status: number | null;
  stdout?: string;
}

export type MacosDeveloperCommandRunner = (
  executable: string,
  args: readonly string[],
  options: {
    encoding?: 'utf8';
    timeout: number;
    stdio: ['ignore', 'pipe', 'ignore'] | 'ignore';
  },
) => MacosDeveloperCommandResult | Promise<MacosDeveloperCommandResult>;

export interface MacosCommandPaths {
  executableRoots: readonly string[];
}

export interface MacosDeveloperPathOptions {
  developerDir?: string;
  homeDir?: string;
  selectDeveloperDir?: () => string | undefined | Promise<string | undefined>;
  validateAppleBinary?: (path: string) => boolean | Promise<boolean>;
  runCommand?: MacosDeveloperCommandRunner;
}

/** Resolve only the dynamic-library directories used by the selected Apple toolchain. */
export async function resolveMacosDeveloperExecutableRoots(
  options: MacosDeveloperPathOptions = {},
): Promise<readonly string[]> {
  const runCommand = options.runCommand ?? runDeveloperCommand;
  const selected =
    options.developerDir?.trim() ||
    (await (options.selectDeveloperDir ?? (() => readSelectedDeveloperDirectory(runCommand)))());
  if (!selected || !isAbsolute(selected)) return [];

  let developerRoot: string;
  try {
    developerRoot = realpathSync(selected);
  } catch {
    return [];
  }

  const homeRoot = canonicalDirectory(options.homeDir ?? homedir());
  if (developerRoot === '/' || (homeRoot && isPathWithin(developerRoot, homeRoot))) return [];

  const libraryRoot = canonicalDirectory(join(developerRoot, 'usr', 'lib'));
  if (!libraryRoot || !isPathWithin(libraryRoot, developerRoot)) return [];
  const xcrunLibrary = canonicalRegularFile(join(libraryRoot, 'libxcrun.dylib'));
  if (!xcrunLibrary || !isPathWithin(xcrunLibrary, libraryRoot)) return [];
  if (
    !(await (options.validateAppleBinary ?? ((path) => validateAppleBinary(path, runCommand)))(
      xcrunLibrary,
    ))
  ) {
    return [];
  }

  if (basename(developerRoot) === 'CommandLineTools') return [libraryRoot];

  if (basename(developerRoot) !== 'Developer' || basename(dirname(developerRoot)) !== 'Contents') {
    return [];
  }

  const contentsRoot = dirname(developerRoot);
  const sharedFrameworks = canonicalDirectory(join(contentsRoot, 'SharedFrameworks'));
  if (!sharedFrameworks || !isPathWithin(sharedFrameworks, contentsRoot)) return [];
  return [libraryRoot, sharedFrameworks];
}

export async function resolveMacosCommandPaths(
  profile: PermissionProfile,
  env: Readonly<Record<string, string | undefined>>,
  options: Omit<MacosDeveloperPathOptions, 'developerDir' | 'homeDir'> = {},
): Promise<MacosCommandPaths> {
  // Runtime roots are an implementation allowance for writable command
  // sessions. They must not silently widen a restricted read-only profile.
  if (profile.type === 'managed' && isReadOnlyPermissionProfile(profile)) {
    return { executableRoots: [] };
  }
  return {
    executableRoots: await resolveMacosDeveloperExecutableRoots({
      developerDir: env.DEVELOPER_DIR,
      homeDir: env.HOME,
      ...options,
    }),
  };
}

async function readSelectedDeveloperDirectory(
  runCommand: MacosDeveloperCommandRunner,
): Promise<string | undefined> {
  const result = await runCommand('/usr/bin/xcode-select', ['-p'], {
    encoding: 'utf8',
    timeout: XCODE_SELECT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout?.trim() || undefined : undefined;
}

async function validateAppleBinary(
  path: string,
  runCommand: MacosDeveloperCommandRunner,
): Promise<boolean> {
  const result = await runCommand(
    '/usr/bin/codesign',
    ['--verify', '--strict', '-R=anchor apple', path],
    {
      timeout: CODESIGN_TIMEOUT_MS,
      stdio: 'ignore',
    },
  );
  return result.status === 0;
}

const runDeveloperCommand: MacosDeveloperCommandRunner = (executable, args, options) =>
  new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      { encoding: 'utf8', timeout: options.timeout, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        resolve({
          status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          ...(options.encoding === 'utf8' ? { stdout } : {}),
        });
      },
    );
  });

function canonicalDirectory(path: string): string | undefined {
  try {
    const canonical = realpathSync(path);
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function canonicalRegularFile(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const canonical = realpathSync(path);
    return statSync(canonical).isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function isPathWithin(path: string, root: string): boolean {
  const delta = relative(root, path);
  return delta === '' || (delta !== '..' && !delta.startsWith(`..${sep}`));
}
