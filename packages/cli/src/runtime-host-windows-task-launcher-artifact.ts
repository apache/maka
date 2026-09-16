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

import { createHash } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { readStableBoundedFile } from '@maka/storage/stable-storage';

const LAUNCHER_FILE = 'maka-runtime-host-task-launcher.exe';
const MANAGED_LAUNCHER_PREFIX = 'maka-runtime-host-task-launcher-';
const WINDOWS_TASK_LAUNCHER_MAX_BYTES = 1024 * 1024;

export async function resolveRuntimeHostWindowsTaskLauncherPath(cliPath: string): Promise<string> {
  const packageRoot = dirname(dirname(await realpath(cliPath)));
  const packaged = await resolvePackagedRuntimeHostWindowsTaskLauncherPath(cliPath);
  const contents = await readRuntimeHostWindowsTaskLauncher(packaged);
  const projected = projectedLauncherPath(packageRoot, contents);
  if (projected) {
    const observed = await readRuntimeHostWindowsTaskLauncher(projected).catch(() => undefined);
    if (observed?.equals(contents)) return realpath(projected);
  }

  return packaged;
}

export async function resolvePackagedRuntimeHostWindowsTaskLauncherPath(
  cliPath: string,
): Promise<string> {
  const packageRoot = dirname(dirname(await realpath(cliPath)));
  const packaged = join(
    packageRoot,
    'native',
    'runtime-host-windows-task-launcher',
    'prebuilds',
    'win32-x64',
    LAUNCHER_FILE,
  );
  if (await isReadable(packaged)) return realpath(packaged);

  if (basename(packageRoot) === 'cli' && basename(dirname(packageRoot)) === 'packages') {
    const development = join(
      packageRoot,
      '..',
      '..',
      'native',
      'runtime-host-windows-task-launcher',
      'target',
      'release',
      LAUNCHER_FILE,
    );
    if (await isReadable(development)) return realpath(development);
  }

  throw new Error('Maka does not include the Windows Runtime Host task launcher');
}

export function runtimeHostManagedWindowsTaskLauncherPath(
  deploymentRoot: string,
  contents: Uint8Array,
): string {
  const digest = createHash('sha256').update(contents).digest('hex');
  return join(deploymentRoot, `${MANAGED_LAUNCHER_PREFIX}${digest}.exe`);
}

export function readRuntimeHostWindowsTaskLauncher(path: string): Promise<Buffer> {
  return readStableBoundedFile({
    path,
    maxBytes: WINDOWS_TASK_LAUNCHER_MAX_BYTES,
    invalidFile: () => new Error('The managed Runtime Host Windows task launcher is invalid'),
  });
}

function projectedLauncherPath(packageRoot: string, contents: Uint8Array): string | undefined {
  const versionsRoot = dirname(packageRoot);
  return basename(versionsRoot) === 'versions'
    ? runtimeHostManagedWindowsTaskLauncherPath(dirname(versionsRoot), contents)
    : undefined;
}

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
