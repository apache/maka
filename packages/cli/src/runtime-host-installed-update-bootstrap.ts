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

import { spawn } from 'node:child_process';
import { cp, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareProductReleaseVersions } from '@maka/runtime-host/operator/update-package-evidence';
import { resolveRuntimeHostNpmGlobalInstallation } from './runtime-host-cli-installation.js';
import type { RuntimeHostUpdateSelector } from './runtime-host-cli.js';
import { resolveRuntimeHostRegistryUpdateCandidate } from './runtime-host-registry-update.js';
import { withRuntimeHostRegistryUpdateArchive } from './runtime-host-update-package.js';

interface RuntimeHostInstalledUpdateBootstrapDeps {
  readonly resolveInstallation: typeof resolveRuntimeHostNpmGlobalInstallation;
  readonly resolveCandidate: typeof resolveRuntimeHostRegistryUpdateCandidate;
  readonly withArchive: typeof withRuntimeHostRegistryUpdateArchive;
  readonly runCoordinator: (input: RuntimeHostInstalledUpdateCoordinatorLaunch) => Promise<number>;
}

interface RuntimeHostInstalledUpdateCoordinatorLaunch {
  readonly coordinatorCliPath: string;
  readonly rootPath: string;
  readonly archivePath: string;
  readonly installedPackageRoot: string;
  readonly installedCliPath: string;
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly targetIntegrity: string;
  readonly targetCompatibility?: number;
  readonly allowInterruptActiveTasks: boolean;
}

export async function runRuntimeHostInstalledUpdateBootstrap(
  input: {
    readonly rootPath: string;
    readonly selector: RuntimeHostUpdateSelector;
    readonly allowInterruptActiveTasks: boolean;
  },
  overrides: Partial<RuntimeHostInstalledUpdateBootstrapDeps> = {},
): Promise<number> {
  const deps: RuntimeHostInstalledUpdateBootstrapDeps = {
    resolveInstallation: resolveRuntimeHostNpmGlobalInstallation,
    resolveCandidate: resolveRuntimeHostRegistryUpdateCandidate,
    withArchive: withRuntimeHostRegistryUpdateArchive,
    runCoordinator: launchCoordinator,
    ...overrides,
  };
  const installation = await deps.resolveInstallation();
  const target = await deps.resolveCandidate(input.selector);
  if (compareProductReleaseVersions(target.version, installation.observedRelease.version) < 0) {
    throw new Error(
      `Downgrading Maka from ${installation.observedRelease.version} to ${target.version} is not supported`,
    );
  }

  return deps.withArchive(target, async (archivePath) => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'maka-installed-update-coordinator-'));
    try {
      const coordinatorPackageRoot = join(temporaryRoot, 'maka-agent');
      await cp(installation.observedRelease.packageRoot, coordinatorPackageRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });
      const coordinatorCliPath = await realpath(join(coordinatorPackageRoot, 'dist', 'cli.js'));
      if (!(await stat(coordinatorCliPath)).isFile()) {
        throw new Error('The copied Maka update coordinator has no CLI entry point');
      }
      return deps.runCoordinator({
        coordinatorCliPath,
        rootPath: input.rootPath,
        archivePath,
        installedPackageRoot: installation.observedRelease.packageRoot,
        installedCliPath: installation.observedRelease.cliPath,
        currentVersion: installation.observedRelease.version,
        targetVersion: target.version,
        targetIntegrity: target.integrity,
        ...(target.compatibility === undefined
          ? {}
          : { targetCompatibility: target.compatibility }),
        allowInterruptActiveTasks: input.allowInterruptActiveTasks,
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

function launchCoordinator(input: RuntimeHostInstalledUpdateCoordinatorLaunch): Promise<number> {
  const args = [
    input.coordinatorCliPath,
    'runtime-host',
    'local-update-apply',
    '--root',
    input.rootPath,
    '--archive',
    input.archivePath,
    '--installed-package-root',
    input.installedPackageRoot,
    '--installed-cli-path',
    input.installedCliPath,
    '--current-version',
    input.currentVersion,
    '--target-version',
    input.targetVersion,
    '--target-integrity',
    input.targetIntegrity,
    ...(input.targetCompatibility === undefined
      ? []
      : ['--target-compatibility', String(input.targetCompatibility)]),
    ...(input.allowInterruptActiveTasks ? ['--allow-interrupt-active-tasks'] : []),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: false });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`Maka update coordinator exited on ${signal}`));
      else resolve(code ?? 1);
    });
  });
}
