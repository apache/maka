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
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { resolveRuntimeHostNpmDeploymentLayout } from '@maka/runtime-host/operator';
import { syncDirectory, syncDirectoryChain, syncFile } from '@maka/storage/stable-storage';

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
  // The filesystem root is the one deterministic ancestor this workflow can
  // never have created in an interrupted earlier attempt. Visible intermediate
  // directories are not evidence that their directory entries are durable.
  const durabilityBoundary = await realpath(parse(resolve(input.deploymentRoot)).root);
  await mkdir(join(input.deploymentRoot, 'versions'), { recursive: true, mode: 0o700 });
  const deploymentRoot = await realpath(resolve(input.deploymentRoot));
  const versionsRoot = await validateOwnedPackageDirectory(
    join(deploymentRoot, 'versions'),
    deploymentRoot,
    'package store',
  );
  const layout = input.packageIntegrity
    ? registryPackageLayout(deploymentRoot, input.packageIntegrity)
    : {
        packageRoot: join(versionsRoot, input.version),
        cliPath: join(versionsRoot, input.version, 'dist', 'cli.js'),
      };
  const { packageRoot, cliPath } = layout;
  const packageDirectory = basename(packageRoot);
  if (await pathExists(packageRoot)) {
    await validateOwnedPackageDirectory(packageRoot, versionsRoot, 'published package');
    await stabilizePublishedPackage(packageRoot, input.version, versionsRoot, durabilityBoundary);
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
    await syncPackageTree(stagingRoot);
    try {
      await rename(stagingRoot, packageRoot);
      await validateOwnedPackageDirectory(packageRoot, versionsRoot, 'published package');
      await syncDirectoryChain(versionsRoot, durabilityBoundary);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'ENOTEMPTY')) throw error;
      await rm(stagingRoot, { recursive: true, force: true });
      await validateOwnedPackageDirectory(packageRoot, versionsRoot, 'published package');
      await stabilizePublishedPackage(packageRoot, input.version, versionsRoot, durabilityBoundary);
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

async function syncPackageTree(path: string): Promise<void> {
  const target = await lstat(path);
  if (target.isFile()) {
    await syncFile(path);
    return;
  }
  if (!target.isDirectory()) return;
  for (const entry of await readdir(path)) await syncPackageTree(join(path, entry));
  await syncDirectory(path);
}

async function stabilizePublishedPackage(
  packageRoot: string,
  version: string,
  versionsRoot: string,
  durabilityBoundary: string,
): Promise<void> {
  await validatePackage(packageRoot, version);
  await syncPackageTree(packageRoot);
  await syncDirectoryChain(versionsRoot, durabilityBoundary);
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

export async function pruneRuntimeHostPackageDeployments(
  deploymentRoot: string,
  retainedCliPath: string,
): Promise<void> {
  if (!isRuntimeHostPackageDeploymentCli(deploymentRoot, retainedCliPath)) {
    throw new RuntimeHostPackageDeploymentError(
      'invalid_package',
      'The retained Runtime Host package does not belong to its package store',
    );
  }
  const root = resolve(deploymentRoot);
  const versionsRoot = await validateOwnedPackageDirectory(
    join(root, 'versions'),
    root,
    'package store',
  );
  const retainedPackageRoot = dirname(dirname(resolve(retainedCliPath)));
  await validateOwnedPackageDirectory(retainedPackageRoot, versionsRoot, 'retained package');
  await pruneInactivePackages(versionsRoot, basename(retainedPackageRoot));
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
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function validateOwnedPackageDirectory(
  path: string,
  expectedParent: string,
  label: string,
): Promise<string> {
  const requested = resolve(path);
  const parent = resolve(expectedParent);
  if (dirname(requested) !== parent) {
    throw new RuntimeHostPackageDeploymentError(
      'invalid_package',
      `The Runtime Host ${label} escapes its expected store`,
    );
  }
  let canonical: string;
  let target: Awaited<ReturnType<typeof lstat>>;
  try {
    [canonical, target] = await Promise.all([realpath(requested), lstat(requested)]);
  } catch (error) {
    throw new RuntimeHostPackageDeploymentError(
      'invalid_package',
      `The Runtime Host ${label} is unavailable`,
      { cause: error },
    );
  }
  if (canonical !== requested || !target.isDirectory() || target.isSymbolicLink()) {
    throw new RuntimeHostPackageDeploymentError(
      'invalid_package',
      `The Runtime Host ${label} is redirected`,
    );
  }
  return canonical;
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
    cleanup: () => pruneRuntimeHostPackageDeployments(root, cliPath),
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
      await removeDeploymentDirectory(packageRoot);
      return;
    }
    const tombstone = join(versionsRoot, `.${packageName}.${randomUUID()}.deleted`);
    await rename(packageRoot, tombstone);
    await removeDeploymentDirectory(tombstone);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw new RuntimeHostPackageDeploymentError(
      'deployment_failed',
      'Unable to remove an inactive Runtime Host package',
      { cause: error },
    );
  }
}

export async function removeDeploymentDirectory(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    deferWindowsDirectoryRemovalUntilExit(path);
  }
}

function deferWindowsDirectoryRemovalUntilExit(path: string): void {
  // Loaded native addons remain locked until this operator exits. The caller
  // has already renamed the directory out of authority before reaching here.
  const script = `const { rm } = require('node:fs/promises');
const path = process.argv[1];
const parent = Number(process.argv[2]);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  for (let attempt = 0; attempt < 3000; attempt += 1) {
    try { process.kill(parent, 0); } catch { break; }
    await wait(100);
  }
  await rm(path, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
})().catch(() => { process.exitCode = 1; });`;
  const cleanup = spawn(process.execPath, ['-e', script, path, String(process.pid)], {
    cwd: dirname(process.execPath),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  cleanup.on('error', () => undefined);
  cleanup.unref();
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
