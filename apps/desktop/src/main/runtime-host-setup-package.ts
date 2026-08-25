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
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  isExactRuntimeHostSetupPackageSpecifier,
  type DesktopRuntimeHostSetupPackage,
} from './runtime-host-ssh-terminal.js';

const DEVELOPMENT_ARCHIVE_ENV = 'MAKA_RUNTIME_HOST_SETUP_ARCHIVE';

export function createRuntimeHostSetupPackageResolver(input: {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly buildDevelopmentArchive?: (repoRoot: string) => Promise<string>;
}): (signal?: AbortSignal) => Promise<DesktopRuntimeHostSetupPackage> {
  let developmentArchive: Promise<DesktopRuntimeHostSetupPackage> | undefined;

  return async (signal) => {
    if (input.isPackaged) return packagedSetupPackage(input.appPath);

    const override = input.environment[DEVELOPMENT_ARCHIVE_ENV];
    if (override) return { kind: 'development_archive', path: override };

    const repoRoot = resolve(input.appPath, '..', '..');
    if (!developmentArchive) {
      const build =
        input.buildDevelopmentArchive ??
        ((root: string) => buildDevelopmentArchive(root, input.environment));
      const pending = build(repoRoot).then((path) => ({
        kind: 'development_archive' as const,
        path,
      }));
      developmentArchive = pending;
      void pending.catch(() => {
        if (developmentArchive === pending) developmentArchive = undefined;
      });
    }
    return waitForPackage(developmentArchive, signal);
  };
}

function packagedSetupPackage(appPath: string): DesktopRuntimeHostSetupPackage {
  const manifest = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')) as {
    runtimeHostSetupPackage?: unknown;
  };
  if (!isExactRuntimeHostSetupPackageSpecifier(manifest.runtimeHostSetupPackage)) {
    throw new Error('Desktop does not declare an exact Runtime Host setup package');
  }
  return { kind: 'npm', specifier: manifest.runtimeHostSetupPackage };
}

async function buildDevelopmentArchive(
  repoRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const script = join(repoRoot, 'scripts', 'release-cli-package.mjs');
  const nodeExecutable = environment.npm_node_execpath?.trim() || 'node';
  const stdout = await new Promise<string>((resolveOutput, reject) => {
    execFile(
      nodeExecutable,
      [script, '--development'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: environment,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, output, stderr) => {
        if (!error) {
          resolveOutput(output);
          return;
        }
        const detail = (stderr.trim() || error.message).slice(-2_000);
        reject(new Error(`Failed to prepare the local Runtime Host CLI: ${detail}`));
      },
    );
  });
  const archive = Array.from(stdout.matchAll(/^\[release-cli\] tarball: (.+)$/gmu)).at(-1)?.[1];
  if (!archive) throw new Error('The local Runtime Host CLI build did not report an archive');
  const resolvedArchive = resolve(archive.trim());
  const releaseRoot = join(repoRoot, 'packages', 'cli', 'release');
  const relativeArchive = relative(releaseRoot, resolvedArchive);
  if (
    !relativeArchive ||
    relativeArchive.startsWith('..') ||
    isAbsolute(relativeArchive) ||
    !resolvedArchive.endsWith('.tgz') ||
    !existsSync(resolvedArchive)
  ) {
    throw new Error('The local Runtime Host CLI build returned an invalid archive path');
  }
  return resolvedArchive;
}

function waitForPackage<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolvePackage, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolvePackage, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
