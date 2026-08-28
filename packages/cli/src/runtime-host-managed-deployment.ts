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

import { randomUUID } from 'node:crypto';
import { lstat, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  openRuntimeHostPackageDeployment,
  prepareRuntimeHostPackageDeployment,
  resolveRuntimeHostPackageCliPath,
  RuntimeHostPackageDeploymentError as RuntimeHostManagedDeploymentError,
  type RuntimeHostPackageDeployment,
} from './runtime-host-package-deployment.js';

export { RuntimeHostPackageDeploymentError as RuntimeHostManagedDeploymentError } from './runtime-host-package-deployment.js';

export interface RuntimeHostManagedPackageDeployment {
  readonly version: string;
  readonly root: string;
  readonly cliPath: string;
  readonly operatorPath: string;
  activate(): Promise<void>;
  cleanup(): Promise<void>;
  rollback(): Promise<void>;
}

export function resolveRuntimeHostManagedPackageCliPath(
  deploymentRoot: string,
  version: string,
  packageIntegrity?: string,
): string {
  return resolveRuntimeHostPackageCliPath(deploymentRoot, version, packageIntegrity);
}

export function isRuntimeHostDevelopmentPackageVersion(value: unknown): value is string {
  return typeof value === 'string' && /(?:-|\.)dev-[0-9a-f]{12}$/u.test(value);
}

export async function prepareRuntimeHostManagedPackageDeployment(
  input: {
    readonly serviceId: string;
    readonly clientDataRoot: string;
    readonly sourcePackageRoot: string;
    readonly version: string;
    readonly packageIntegrity?: string;
  },
  options: RuntimeHostManagedDeploymentPathOptions = {},
): Promise<RuntimeHostManagedPackageDeployment> {
  const clientDataRoot = resolve(input.clientDataRoot);
  const staged = await prepareRuntimeHostPackageDeployment({
    deploymentRoot: resolveRuntimeHostManagedDeploymentRoot(input.serviceId, options),
    sourcePackageRoot: input.sourcePackageRoot,
    version: input.version,
    ...(input.packageIntegrity ? { packageIntegrity: input.packageIntegrity } : {}),
  });
  return managedDeployment(staged, clientDataRoot);
}

export async function openRuntimeHostManagedPackageDeployment(input: {
  readonly serviceId: string;
  readonly clientDataRoot: string;
  readonly deploymentRoot: string;
  readonly cliPath: string;
  readonly version: string;
}): Promise<RuntimeHostManagedPackageDeployment> {
  let deploymentRoot: string;
  let cliPath: string;
  try {
    deploymentRoot = await realpath(resolve(input.deploymentRoot));
    cliPath = await realpath(input.cliPath);
  } catch (error) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_package',
      `The managed Maka ${input.version} package is unavailable`,
      { cause: error },
    );
  }
  if (resolveRuntimeHostManagedDeploymentForCli(input.serviceId, cliPath) !== deploymentRoot) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_package',
      'The configured Runtime Host package does not belong to its managed deployment',
    );
  }
  return managedDeployment(
    await openRuntimeHostPackageDeployment({
      deploymentRoot,
      cliPath,
      version: input.version,
    }),
    resolve(input.clientDataRoot),
  );
}

export interface RuntimeHostManagedDeploymentPathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
}

export function resolveRuntimeHostManagedDeploymentRoot(
  serviceId: string,
  options: RuntimeHostManagedDeploymentPathOptions = {},
): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const dataHome =
    (options.platform ?? process.platform) === 'darwin'
      ? join(homeDir, 'Library', 'Application Support')
      : env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
        ? env.XDG_DATA_HOME
        : join(homeDir, '.local', 'share');
  return join(dataHome, 'Maka', 'runtime-host-services', serviceId);
}

export function isRuntimeHostManagedDeploymentRoot(root: string, serviceId: string): boolean {
  const canonical = resolve(root);
  return (
    isAbsolute(root) &&
    basename(canonical) === serviceId &&
    basename(dirname(canonical)) === 'runtime-host-services' &&
    basename(dirname(dirname(canonical))) === 'Maka'
  );
}

export function isRuntimeHostManagedDeploymentCli(
  root: string,
  serviceId: string,
  cliPath: string,
): boolean {
  if (!isRuntimeHostManagedDeploymentRoot(root, serviceId)) return false;
  const pathFromVersions = relative(join(resolve(root), 'versions'), resolve(cliPath));
  return (
    pathFromVersions !== '' &&
    pathFromVersions !== '..' &&
    !pathFromVersions.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromVersions)
  );
}

export function resolveRuntimeHostManagedDeploymentForCli(
  serviceId: string,
  cliPath: string,
): string | undefined {
  const root = dirname(dirname(dirname(dirname(resolve(cliPath)))));
  return isRuntimeHostManagedDeploymentCli(root, serviceId, cliPath) ? root : undefined;
}

export async function resolveExistingRuntimeHostManagedDeploymentRoot(
  root: string,
  serviceId: string,
): Promise<string | undefined> {
  if (!isRuntimeHostManagedDeploymentRoot(root, serviceId)) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_failed',
      'Refusing to inspect an invalid managed Runtime Host deployment path',
    );
  }
  const requestedRoot = resolve(root);
  let inspected: readonly [string, Awaited<ReturnType<typeof lstat>>];
  try {
    inspected = await Promise.all([realpath(requestedRoot), lstat(requestedRoot)]);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw new RuntimeHostManagedDeploymentError(
      'deployment_failed',
      'Unable to inspect the managed Runtime Host deployment',
      { cause: error },
    );
  }
  const [canonicalRoot, target] = inspected;
  if (canonicalRoot !== requestedRoot || !target.isDirectory() || target.isSymbolicLink()) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_failed',
      'Refusing to use a redirected managed Runtime Host deployment path',
    );
  }
  return canonicalRoot;
}

export async function removeRuntimeHostManagedDeployment(
  root: string,
  serviceId: string,
): Promise<void> {
  const requestedRoot = await resolveExistingRuntimeHostManagedDeploymentRoot(root, serviceId);
  if (!requestedRoot) return;
  const operatorPath = join(requestedRoot, 'operator');
  for (const entry of await readdir(requestedRoot)) {
    if (entry === 'operator') continue;
    await rm(join(requestedRoot, entry), { recursive: true, force: true });
  }
  await rm(operatorPath, { force: true });
  await rm(requestedRoot, { recursive: true, force: true });
}

function managedDeployment(
  staged: RuntimeHostPackageDeployment,
  clientDataRoot: string,
): RuntimeHostManagedPackageDeployment {
  const operatorPath = join(staged.root, 'operator');
  return {
    version: staged.version,
    root: staged.root,
    cliPath: staged.cliPath,
    operatorPath,
    activate: () =>
      writeOperatorLauncher(operatorPath, process.execPath, staged.cliPath, clientDataRoot),
    cleanup: staged.cleanup,
    rollback: staged.rollback,
  };
}

async function writeOperatorLauncher(
  path: string,
  nodePath: string,
  cliPath: string,
  clientDataRoot: string,
): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const contents = [
    '#!/bin/sh',
    'if [ "$#" -ge 1 ] && [ "$1" = "__cleanup-managed-deployment" ]; then',
    '  shift',
    `  exec ${quotePosix(nodePath)} ${quotePosix(cliPath)} runtime-host service cleanup-deployment "$@" --client-data-root ${quotePosix(clientDataRoot)}`,
    'fi',
    'if [ "$#" -ge 1 ] && [ "$1" = "access" ]; then',
    '  shift',
    `  exec ${quotePosix(nodePath)} ${quotePosix(cliPath)} runtime-host access "$@"`,
    'fi',
    'if [ "$#" -ge 1 ] && [ "$1" = "activate" ]; then',
    '  shift',
    `  exec ${quotePosix(nodePath)} ${quotePosix(cliPath)} runtime-host activate "$@"`,
    'fi',
    `exec ${quotePosix(nodePath)} ${quotePosix(cliPath)} runtime-host service "$@" --client-data-root ${quotePosix(clientDataRoot)}`,
    '',
  ].join('\n');
  try {
    const file = await open(temporaryPath, 'wx', 0o700);
    try {
      await file.writeFile(contents, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    const parent = await open(dirname(path), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
