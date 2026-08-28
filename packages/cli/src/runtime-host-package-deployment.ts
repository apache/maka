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
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveRuntimeHostNpmDeploymentLayout } from '@maka/runtime-host/operator';

const PACKAGE_NAME = 'maka-agent';

export class RuntimeHostPackageDeploymentError extends Error {
  constructor(
    readonly code: 'invalid_package' | 'deployment_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostPackageDeploymentError';
  }
}

export interface RuntimeHostPackageDeployment {
  readonly version: string;
  readonly root: string;
  readonly packageRoot: string;
  readonly cliPath: string;
  cleanup(): Promise<void>;
  rollback(): Promise<void>;
}

export function resolveRuntimeHostPackageCliPath(
  deploymentRoot: string,
  version: string,
  packageIntegrity?: string,
): string {
  assertVersion(version);
  return packageIntegrity
    ? registryPackageLayout(deploymentRoot, packageIntegrity).cliPath
    : join(resolve(deploymentRoot), 'versions', version, 'dist', 'cli.js');
}

export async function prepareRuntimeHostPackageDeployment(input: {
  readonly deploymentRoot: string;
  readonly sourcePackageRoot: string;
  readonly version: string;
  readonly packageIntegrity?: string;
}): Promise<RuntimeHostPackageDeployment> {
  assertVersion(input.version);
  const sourcePackageRoot = await validatePackage(input.sourcePackageRoot, input.version);
  await mkdir(join(input.deploymentRoot, 'versions'), { recursive: true, mode: 0o700 });
  const deploymentRoot = await realpath(resolve(input.deploymentRoot));
  const versionsRoot = join(deploymentRoot, 'versions');
  const layout = input.packageIntegrity
    ? registryPackageLayout(deploymentRoot, input.packageIntegrity)
    : {
        packageRoot: join(versionsRoot, input.version),
        cliPath: join(versionsRoot, input.version, 'dist', 'cli.js'),
      };
  const { packageRoot, cliPath } = layout;
  const packageDirectory = basename(packageRoot);
  if (await pathExists(packageRoot)) {
    await validatePackage(packageRoot, input.version);
    return deployment(input.version, deploymentRoot, packageRoot, cliPath, false);
  }

  await removeAbandonedPackageWorkspaces(versionsRoot, packageDirectory);
  const stagingRoot = join(versionsRoot, `.${packageDirectory}.${randomUUID()}.tmp`);
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
      return deployment(input.version, deploymentRoot, packageRoot, cliPath, false);
    }
    return deployment(input.version, deploymentRoot, packageRoot, cliPath, true);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof RuntimeHostPackageDeploymentError) throw error;
    throw new RuntimeHostPackageDeploymentError(
      'deployment_failed',
      `Unable to install Maka ${input.version} into the Runtime Host package store`,
      { cause: error },
    );
  }
}

export async function openRuntimeHostPackageDeployment(input: {
  readonly deploymentRoot: string;
  readonly cliPath: string;
  readonly version: string;
}): Promise<RuntimeHostPackageDeployment> {
  assertVersion(input.version);
  let deploymentRoot: string;
  let cliPath: string;
  try {
    deploymentRoot = await realpath(resolve(input.deploymentRoot));
    cliPath = await realpath(input.cliPath);
  } catch (error) {
    throw new RuntimeHostPackageDeploymentError(
      'invalid_package',
      `The staged Maka ${input.version} package is unavailable`,
      { cause: error },
    );
  }
  if (!isRuntimeHostPackageDeploymentCli(deploymentRoot, cliPath)) {
    throw new RuntimeHostPackageDeploymentError(
      'invalid_package',
      'The configured Runtime Host package does not belong to its package store',
    );
  }
  const packageRoot = await validatePackage(dirname(dirname(cliPath)), input.version);
  if (cliPath !== join(packageRoot, 'dist', 'cli.js')) {
    throw new RuntimeHostPackageDeploymentError(
      'invalid_package',
      'The configured Runtime Host CLI does not match its staged package',
    );
  }
  return deployment(input.version, deploymentRoot, packageRoot, cliPath, false);
}

export function isRuntimeHostPackageDeploymentCli(root: string, cliPath: string): boolean {
  const pathFromVersions = relative(join(resolve(root), 'versions'), resolve(cliPath));
  return (
    pathFromVersions !== '' &&
    pathFromVersions !== '..' &&
    !pathFromVersions.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromVersions)
  );
}

async function removeAbandonedPackageWorkspaces(
  versionsRoot: string,
  packageDirectory: string,
): Promise<void> {
  const prefix = `.${packageDirectory}.`;
  await Promise.all(
    (await readdir(versionsRoot, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.name.startsWith(prefix) &&
          (entry.name.endsWith('.tmp') || entry.name.endsWith('.deleted')),
      )
      .map((entry) => rm(join(versionsRoot, entry.name), { recursive: true, force: true })),
  );
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
    throw new RuntimeHostPackageDeploymentError(
      'invalid_package',
      `Maka ${version} is not a self-contained release package`,
      { cause: error },
    );
  }
  if (!isRecord(manifest) || manifest.name !== PACKAGE_NAME || manifest.version !== version) {
    throw new RuntimeHostPackageDeploymentError(
      'invalid_package',
      `The staged package does not contain ${PACKAGE_NAME}@${version}`,
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
  created: boolean,
): RuntimeHostPackageDeployment {
  return {
    version,
    root,
    packageRoot,
    cliPath,
    cleanup: () => pruneInactivePackages(dirname(packageRoot), basename(packageRoot)),
    rollback: () =>
      created
        ? removePackageAtomically(dirname(packageRoot), basename(packageRoot))
        : Promise.resolve(),
  };
}

async function pruneInactivePackages(versionsRoot: string, retainedPackage: string): Promise<void> {
  await Promise.all(
    (await readdir(versionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.name !== retainedPackage)
      .map((entry) => removePackageAtomically(versionsRoot, entry.name)),
  );
}

async function removePackageAtomically(versionsRoot: string, packageName: string): Promise<void> {
  const packageRoot = join(versionsRoot, packageName);
  try {
    if (packageName.startsWith('.') && packageName.endsWith('.deleted')) {
      await rm(packageRoot, { recursive: true, force: true });
      return;
    }
    const tombstone = join(versionsRoot, `.${packageName}.${randomUUID()}.deleted`);
    await rename(packageRoot, tombstone);
    await rm(tombstone, { recursive: true, force: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw new RuntimeHostPackageDeploymentError(
      'deployment_failed',
      'Unable to remove an inactive Runtime Host package',
      { cause: error },
    );
  }
}

function registryPackageLayout(deploymentRoot: string, integrity: string) {
  try {
    return resolveRuntimeHostNpmDeploymentLayout(deploymentRoot, integrity);
  } catch (error) {
    throw new RuntimeHostPackageDeploymentError(
      'invalid_package',
      'The Runtime Host package integrity is invalid',
      { cause: error },
    );
  }
}

function assertVersion(version: string): void {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/u.test(version)) {
    throw new RuntimeHostPackageDeploymentError(
      'invalid_package',
      'The Maka package version cannot be used as a deployment identity',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
