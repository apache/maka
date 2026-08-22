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
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const PACKAGE_NAME = 'maka-agent';

export class RuntimeHostManagedDeploymentError extends Error {
  constructor(
    readonly code: 'invalid_package' | 'deployment_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostManagedDeploymentError';
  }
}

export interface RuntimeHostManagedPackageDeployment {
  readonly version: string;
  readonly root: string;
  readonly cliPath: string;
  readonly operatorPath: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
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
  },
  options: RuntimeHostManagedDeploymentPathOptions = {},
): Promise<RuntimeHostManagedPackageDeployment> {
  assertVersion(input.version);
  const sourcePackageRoot = await validatePackage(input.sourcePackageRoot, input.version);
  const requestedDeploymentRoot = resolveRuntimeHostManagedDeploymentRoot(input.serviceId, options);
  await mkdir(join(requestedDeploymentRoot, 'versions'), { recursive: true, mode: 0o700 });
  const deploymentRoot = await realpath(requestedDeploymentRoot);
  const versionsRoot = join(deploymentRoot, 'versions');
  const packageRoot = join(versionsRoot, input.version);
  const cliPath = join(packageRoot, 'dist', 'cli.js');
  const clientDataRoot = resolve(input.clientDataRoot);
  if (await pathExists(packageRoot)) {
    await validatePackage(packageRoot, input.version);
    return deployment(input.version, deploymentRoot, packageRoot, cliPath, clientDataRoot, false);
  }

  await removeAbandonedStagingPackages(versionsRoot, input.version);
  const stagingRoot = join(versionsRoot, `.${input.version}.${randomUUID()}.tmp`);
  try {
    await cp(sourcePackageRoot, stagingRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    await validatePackage(stagingRoot, input.version);
    try {
      await rename(stagingRoot, packageRoot);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'ENOTEMPTY')) throw error;
      await validatePackage(packageRoot, input.version);
      await rm(stagingRoot, { recursive: true, force: true });
      return deployment(input.version, deploymentRoot, packageRoot, cliPath, clientDataRoot, false);
    }
    return deployment(input.version, deploymentRoot, packageRoot, cliPath, clientDataRoot, true);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof RuntimeHostManagedDeploymentError) throw error;
    throw new RuntimeHostManagedDeploymentError(
      'deployment_failed',
      `Unable to install Maka ${input.version} into the managed Runtime Host deployment`,
      { cause: error },
    );
  }
}

async function removeAbandonedStagingPackages(
  versionsRoot: string,
  version: string,
): Promise<void> {
  const prefix = `.${version}.`;
  await Promise.all(
    (await readdir(versionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.name.startsWith(prefix) && entry.name.endsWith('.tmp'))
      .map((entry) => rm(join(versionsRoot, entry.name), { recursive: true, force: true })),
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

export async function removeRuntimeHostManagedDeployment(
  root: string,
  serviceId: string,
): Promise<void> {
  if (!isRuntimeHostManagedDeploymentRoot(root, serviceId)) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_failed',
      'Refusing to remove an invalid managed Runtime Host deployment path',
    );
  }
  const requestedRoot = resolve(root);
  let inspected: readonly [string, Awaited<ReturnType<typeof lstat>>];
  try {
    inspected = await Promise.all([realpath(requestedRoot), lstat(requestedRoot)]);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw new RuntimeHostManagedDeploymentError(
      'deployment_failed',
      'Unable to inspect the managed Runtime Host deployment before removal',
      { cause: error },
    );
  }
  const [canonicalRoot, target] = inspected;
  if (canonicalRoot !== requestedRoot || !target.isDirectory() || target.isSymbolicLink()) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_failed',
      'Refusing to remove a redirected managed Runtime Host deployment path',
    );
  }
  const operatorPath = join(requestedRoot, 'operator');
  for (const entry of await readdir(requestedRoot)) {
    if (entry === 'operator') continue;
    await rm(join(requestedRoot, entry), { recursive: true, force: true });
  }
  await rm(operatorPath, { force: true });
  await rm(requestedRoot, { recursive: true, force: true });
}

async function validatePackage(path: string, version: string): Promise<string> {
  let packageRoot: string;
  let manifest: unknown;
  try {
    packageRoot = await realpath(resolve(path));
    manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as unknown;
    const cli = await stat(join(packageRoot, 'dist', 'cli.js'));
    const runtimeHost = await stat(
      join(packageRoot, 'node_modules', '@maka', 'runtime-host', 'package.json'),
    );
    if (!cli.isFile() || !runtimeHost.isFile()) throw new Error('Package payload is incomplete');
  } catch (error) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_package',
      `Maka ${version} is not a self-contained release package`,
      { cause: error },
    );
  }
  if (!isRecord(manifest) || manifest.name !== PACKAGE_NAME || manifest.version !== version) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_package',
      `The setup package does not contain ${PACKAGE_NAME}@${version}`,
    );
  }
  return packageRoot;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

function deployment(
  version: string,
  root: string,
  packageRoot: string,
  cliPath: string,
  clientDataRoot: string,
  created: boolean,
): RuntimeHostManagedPackageDeployment {
  const operatorPath = join(root, 'operator');
  return {
    version,
    root,
    cliPath,
    operatorPath,
    commit: async () => {
      await writeOperatorLauncher(operatorPath, process.execPath, cliPath, clientDataRoot);
      await pruneInactiveDevelopmentPackages(dirname(packageRoot), version);
    },
    rollback: () =>
      created ? rm(packageRoot, { recursive: true, force: true }) : Promise.resolve(),
  };
}

async function writeOperatorLauncher(
  path: string,
  nodePath: string,
  cliPath: string,
  clientDataRoot: string,
): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const deploymentRoot = dirname(path);
  const contents = [
    '#!/bin/sh',
    'if [ "$#" -eq 1 ] && [ "$1" = "__cleanup-managed-deployment" ]; then',
    `  for entry in ${quotePosix(deploymentRoot)}/* ${quotePosix(deploymentRoot)}/.[!.]* ${quotePosix(deploymentRoot)}/..?*; do`,
    `    [ "$entry" = ${quotePosix(path)} ] && continue`,
    '    if [ -e "$entry" ] || [ -L "$entry" ]; then',
    '      rm -rf -- "$entry" || exit 1',
    '    fi',
    '  done',
    `  rm -f -- ${quotePosix(path)} || exit 1`,
    `  rmdir -- ${quotePosix(deploymentRoot)} || exit 1`,
    '  exit 0',
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

async function pruneInactiveDevelopmentPackages(
  versionsRoot: string,
  retainedVersion: string,
): Promise<void> {
  if (!isRuntimeHostDevelopmentPackageVersion(retainedVersion)) return;
  await Promise.all(
    (await readdir(versionsRoot, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== retainedVersion &&
          isRuntimeHostDevelopmentPackageVersion(entry.name),
      )
      .map((entry) => rm(join(versionsRoot, entry.name), { recursive: true, force: true })),
  );
}

function assertVersion(version: string): void {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/u.test(version)) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_package',
      'The Maka package version cannot be used as a managed deployment identity',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
