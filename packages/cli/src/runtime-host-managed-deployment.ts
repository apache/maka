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
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  openRuntimeHostPackageDeployment,
  prepareRuntimeHostPackageDeployment,
  pruneRuntimeHostPackageDeployments,
  resolveRuntimeHostPackageCliPath,
  RuntimeHostPackageDeploymentError as RuntimeHostManagedDeploymentError,
  type RuntimeHostPackageDeployment,
} from './runtime-host-package-deployment.js';
import { readStableBoundedFile, syncDirectory } from '@maka/storage/stable-storage';
import { resolveExistingStorageRoot, tryAcquireStateRootOwner } from '@maka/storage/root-authority';
import {
  resolveRuntimeHostManagedDeploymentAuthorityRoot,
  resolveRuntimeHostManagedDeploymentAuthority,
  resolveRuntimeHostNpmDeploymentLayout,
  type RuntimeHostManagedDeploymentAuthorityOptions,
  type RuntimeHostManagedDeploymentConfig,
} from '@maka/runtime-host/operator';

export { RuntimeHostPackageDeploymentError as RuntimeHostManagedDeploymentError } from './runtime-host-package-deployment.js';

export interface RuntimeHostManagedPackageDeployment {
  readonly version: string;
  readonly root: string;
  readonly cliPath: string;
  readonly operatorPath: string;
  /** Legacy service replacement only; canonical deployments project the operator transactionally. */
  activate(): Promise<void>;
  cleanup(): Promise<void>;
  rollback(): Promise<void>;
}

interface RuntimeHostManagedDeploymentCleanupReceipt {
  readonly schemaVersion: 1;
  readonly serviceId: string;
  readonly deploymentId: string;
  readonly deploymentRoot: string;
  readonly stateRootPath: string;
}

const CLEANUP_RECEIPT_FILE = 'cleanup-approved.json';

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
    /** Existing canonical deployments persist their package-store location. */
    readonly deploymentRoot?: string;
  },
  options: RuntimeHostManagedDeploymentPathOptions = {},
): Promise<RuntimeHostManagedPackageDeployment> {
  const requestedRoot =
    input.deploymentRoot === undefined ? undefined : resolve(input.deploymentRoot);
  const selectedDataHome =
    requestedRoot !== undefined
      ? dirname(dirname(dirname(requestedRoot)))
      : resolveRuntimeHostManagedDataHome(options);
  const dataHome = await canonicalizePotentialPath(selectedDataHome);
  const deploymentRoot = join(dataHome, 'Maka', 'runtime-host-services', input.serviceId);
  if (requestedRoot !== undefined && requestedRoot !== deploymentRoot) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_failed',
      'The persisted managed Runtime Host deployment root is redirected or invalid',
    );
  }
  await assertUnredirectedManagedDeploymentSuffix(dataHome, deploymentRoot);
  await reapRuntimeHostManagedDeploymentRetirement(deploymentRoot, input.serviceId);
  const staged = await prepareRuntimeHostPackageDeployment({
    deploymentRoot,
    sourcePackageRoot: input.sourcePackageRoot,
    version: input.version,
    ...(input.packageIntegrity ? { packageIntegrity: input.packageIntegrity } : {}),
  });
  return managedDeployment(staged, resolve(input.clientDataRoot), input.serviceId);
}

async function reapRuntimeHostManagedDeploymentRetirement(
  root: string,
  serviceId: string,
): Promise<void> {
  if (!isRuntimeHostManagedDeploymentRoot(root, serviceId)) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_failed',
      'Refusing to reclaim an invalid managed Runtime Host deployment path',
    );
  }
  const cleanup = await readRuntimeHostManagedDeploymentCleanupReceipt(serviceId);
  if (cleanup) {
    const authority = await resolveRuntimeHostManagedDeploymentAuthority(serviceId);
    if (authority) {
      await clearRuntimeHostManagedDeploymentCleanupReceipt(serviceId);
    } else {
      const capability = await resolveExistingStorageRoot({
        path: cleanup.stateRootPath,
        kind: 'interactive',
        expectedRootId: serviceId,
      });
      const owner = await tryAcquireStateRootOwner(capability);
      if (!owner) {
        throw new RuntimeHostManagedDeploymentError(
          'deployment_failed',
          'The Runtime Host still owns the State Root pending deployment cleanup',
        );
      }
      try {
        const fencedAuthority = await resolveRuntimeHostManagedDeploymentAuthority(serviceId);
        if (!fencedAuthority) {
          await removeRuntimeHostManagedDeployment(cleanup.deploymentRoot, serviceId);
        }
        await clearRuntimeHostManagedDeploymentCleanupReceipt(serviceId);
      } finally {
        await owner.close();
      }
    }
  }
  const parent = await resolveExistingRuntimeHostManagedDeploymentParent(root, serviceId);
  if (!parent) return;
  await rm(join(parent, `.${serviceId}.retired`), {
    recursive: true,
    force: true,
  });
  await syncDirectory(parent);
}

async function canonicalizePotentialPath(path: string): Promise<string> {
  const requestedPath = resolve(path);
  let existing = requestedPath;
  for (;;) {
    try {
      const canonical = await realpath(existing);
      return resolve(canonical, relative(existing, requestedPath));
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

async function assertUnredirectedManagedDeploymentSuffix(
  dataHome: string,
  deploymentRoot: string,
): Promise<void> {
  let current = resolve(dataHome);
  for (const segment of relative(current, resolve(deploymentRoot)).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const target = await lstat(current);
      if (!target.isDirectory() || target.isSymbolicLink()) {
        throw new RuntimeHostManagedDeploymentError(
          'deployment_failed',
          'Refusing to use a redirected managed Runtime Host deployment path',
        );
      }
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return;
      throw error;
    }
  }
}

export async function acknowledgeRuntimeHostManagedDeploymentCleanup(input: {
  readonly serviceId: string;
  readonly deploymentId: string;
  readonly deploymentRoot: string;
  readonly stateRootPath: string;
}): Promise<void> {
  if (!isRuntimeHostManagedDeploymentRoot(input.deploymentRoot, input.serviceId)) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_failed',
      'Refusing to acknowledge cleanup for an invalid managed deployment path',
    );
  }
  const controlRoot = resolveRuntimeHostManagedControlRoot(input.serviceId);
  await mkdir(controlRoot, { recursive: true, mode: 0o700 });
  const path = join(controlRoot, CLEANUP_RECEIPT_FILE);
  const receipt: RuntimeHostManagedDeploymentCleanupReceipt = {
    schemaVersion: 1,
    serviceId: input.serviceId,
    deploymentId: input.deploymentId,
    deploymentRoot: resolve(input.deploymentRoot),
    stateRootPath: resolve(input.stateRootPath),
  };
  const existing = await readRuntimeHostManagedDeploymentCleanupReceipt(input.serviceId);
  if (existing) {
    if (
      existing.deploymentId !== receipt.deploymentId ||
      existing.deploymentRoot !== receipt.deploymentRoot ||
      existing.stateRootPath !== receipt.stateRootPath
    ) {
      throw new RuntimeHostManagedDeploymentError(
        'deployment_failed',
        'Another managed Runtime Host deployment is already pending cleanup',
      );
    }
    await syncDirectory(controlRoot);
    return;
  }
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(receipt)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    await syncDirectory(controlRoot);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function readRuntimeHostManagedDeploymentCleanupReceipt(
  serviceId: string,
): Promise<RuntimeHostManagedDeploymentCleanupReceipt | undefined> {
  const path = join(resolveRuntimeHostManagedControlRoot(serviceId), CLEANUP_RECEIPT_FILE);
  let value: unknown;
  try {
    const contents = await readStableBoundedFile({
      path,
      maxBytes: 16 * 1024,
      invalidFile: () =>
        new RuntimeHostManagedDeploymentError(
          'deployment_failed',
          'The managed Runtime Host cleanup receipt is not a stable regular file',
        ),
    });
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents));
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.serviceId !== serviceId ||
    typeof value.deploymentId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value.deploymentId,
    ) ||
    typeof value.deploymentRoot !== 'string' ||
    typeof value.stateRootPath !== 'string' ||
    !isAbsolute(value.stateRootPath) ||
    !isRuntimeHostManagedDeploymentRoot(value.deploymentRoot, serviceId)
  ) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_failed',
      'The managed Runtime Host cleanup receipt is invalid',
    );
  }
  return {
    schemaVersion: 1,
    serviceId,
    deploymentId: value.deploymentId,
    deploymentRoot: resolve(value.deploymentRoot),
    stateRootPath: resolve(value.stateRootPath),
  };
}

export async function clearRuntimeHostManagedDeploymentCleanupReceipt(
  serviceId: string,
): Promise<void> {
  const controlRoot = resolveRuntimeHostManagedControlRoot(serviceId);
  await rm(join(controlRoot, CLEANUP_RECEIPT_FILE), { force: true });
  await syncDirectory(controlRoot);
}

async function resolveExistingRuntimeHostManagedDeploymentParent(
  root: string,
  serviceId: string,
): Promise<string | undefined> {
  if (!isRuntimeHostManagedDeploymentRoot(root, serviceId)) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_failed',
      'Refusing to inspect an invalid managed Runtime Host deployment path',
    );
  }
  const requestedParent = dirname(resolve(root));
  try {
    const [canonicalParent, target] = await Promise.all([
      realpath(requestedParent),
      lstat(requestedParent),
    ]);
    if (canonicalParent !== requestedParent || !target.isDirectory() || target.isSymbolicLink()) {
      throw new RuntimeHostManagedDeploymentError(
        'deployment_failed',
        'Refusing to use a redirected managed Runtime Host deployment path',
      );
    }
    return canonicalParent;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export async function pruneRuntimeHostManagedPackages(
  config: RuntimeHostManagedDeploymentConfig,
): Promise<void> {
  const layout = resolveRuntimeHostNpmDeploymentLayout(
    config.deploymentRoot,
    config.launch.package.integrity,
  );
  await pruneRuntimeHostPackageDeployments(config.deploymentRoot, layout.cliPath);
}

export async function pruneRuntimeHostManagedPeerKeys(
  config: RuntimeHostManagedDeploymentConfig,
): Promise<void> {
  const root = resolve(config.deploymentRoot);
  const retained = config.listeners.directPeer?.keyPath;
  if (retained && dirname(resolve(retained)) !== root) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_package',
      'The managed Runtime Host peer key does not belong to its deployment',
    );
  }
  const removable = (await readdir(root, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name === 'runtime-host-service.peer.key' ||
          /^runtime-host-peer\.[0-9a-f-]{36}\.key$/iu.test(entry.name)) &&
        (!retained || entry.name !== basename(retained)),
    )
    .map((entry) => join(root, entry.name));
  if (removable.length === 0) return;
  await Promise.all(removable.map((path) => rm(path, { force: true })));
  await syncDirectory(root);
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
    input.serviceId,
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
  return join(
    resolveRuntimeHostManagedDataHome(options),
    'Maka',
    'runtime-host-services',
    serviceId,
  );
}

function resolveRuntimeHostManagedDataHome(
  options: RuntimeHostManagedDeploymentPathOptions = {},
): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  return (options.platform ?? process.platform) === 'darwin'
    ? join(homeDir, 'Library', 'Application Support')
    : env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : join(homeDir, '.local', 'share');
}

export function resolveRuntimeHostManagedControlRoot(serviceId: string): string {
  return join(resolveRuntimeHostManagedDeploymentAuthorityRoot(), serviceId, 'control');
}

export async function assertRuntimeHostManagedOperatorDeployment(
  serviceId: string,
  deploymentId: string | undefined,
  cliPath: string,
  options: {
    readonly allowAbsent?: boolean;
    readonly authority?: RuntimeHostManagedDeploymentAuthorityOptions;
  } = {},
): Promise<void> {
  if (!deploymentId) return;
  const authority = await resolveRuntimeHostManagedDeploymentAuthority(
    serviceId,
    options.authority,
  );
  if (!authority && options.allowAbsent) return;
  const record = authority?.record;
  const endpoints = record?.state === 'active' ? [record] : record ? [record.from, record.to] : [];
  if (
    !endpoints.some(
      (config) =>
        config !== null && runtimeHostManagedOperatorMatches(config, deploymentId, cliPath),
    )
  ) {
    throw operatorClaimMismatch();
  }
}

export function assertRuntimeHostManagedOperatorConfig(
  config: RuntimeHostManagedDeploymentConfig,
  deploymentId: string | undefined,
  cliPath: string,
): void {
  if (!deploymentId) return;
  if (!runtimeHostManagedOperatorMatches(config, deploymentId, cliPath)) {
    throw operatorClaimMismatch();
  }
}

function runtimeHostManagedOperatorMatches(
  config: RuntimeHostManagedDeploymentConfig,
  deploymentId: string,
  cliPath: string,
): boolean {
  return (
    config.deploymentId === deploymentId &&
    resolve(
      resolveRuntimeHostNpmDeploymentLayout(config.deploymentRoot, config.launch.package.integrity)
        .cliPath,
    ) === resolve(cliPath)
  );
}

function operatorClaimMismatch(): RuntimeHostManagedDeploymentError {
  return new RuntimeHostManagedDeploymentError(
    'deployment_failed',
    'The managed Runtime Host operator belongs to a different deployment generation or exact package',
  );
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
  if (!isRuntimeHostManagedDeploymentRoot(root, serviceId)) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_failed',
      'Refusing to remove an invalid managed Runtime Host deployment path',
    );
  }
  const requestedRoot = resolve(root);
  const parent = await resolveExistingRuntimeHostManagedDeploymentParent(root, serviceId);
  if (!parent) return;
  const retiredRoot = join(parent, `.${serviceId}.retired`);
  await rm(retiredRoot, { recursive: true, force: true });
  await syncDirectory(parent);
  const existing = await resolveExistingRuntimeHostManagedDeploymentRoot(requestedRoot, serviceId);
  if (existing) {
    await rename(existing, retiredRoot);
    // The rename is the logical cleanup commit. After this barrier the public
    // operator path is absent, so an interrupted physical delete is safely
    // recognized as already complete and reclaimed by the next deployment.
    await syncDirectory(parent);
  }
  await rm(retiredRoot, { recursive: true, force: true });
  await syncDirectory(parent);
}

function managedDeployment(
  staged: RuntimeHostPackageDeployment,
  clientDataRoot: string,
  managedRootId: string,
): RuntimeHostManagedPackageDeployment {
  const operatorPath = join(staged.root, 'operator');
  return {
    version: staged.version,
    root: staged.root,
    cliPath: staged.cliPath,
    operatorPath,
    activate: () =>
      writeOperatorLauncher(
        operatorPath,
        process.execPath,
        staged.cliPath,
        clientDataRoot,
        managedRootId,
      ),
    cleanup: staged.cleanup,
    rollback: staged.rollback,
  };
}

async function writeOperatorLauncher(
  path: string,
  nodePath: string,
  cliPath: string,
  clientDataRoot: string,
  managedRootId: string,
  deploymentId?: string,
): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const contents = operatorLauncherContents(
    nodePath,
    cliPath,
    clientDataRoot,
    managedRootId,
    deploymentId,
  );
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

function operatorLauncherContents(
  nodePath: string,
  cliPath: string,
  clientDataRoot: string,
  managedRootId: string,
  deploymentId?: string,
): string {
  return [
    '#!/bin/sh',
    'if [ "$#" -ge 1 ] && [ "$1" = "__cleanup-managed-deployment" ]; then',
    '  shift',
    `  exec ${quotePosix(nodePath)} ${quotePosix(cliPath)} runtime-host service cleanup-deployment "$@" --client-data-root ${quotePosix(clientDataRoot)} --managed-root-id ${quotePosix(managedRootId)}${deploymentId ? ` --operator-deployment-id ${quotePosix(deploymentId)}` : ''}`,
    'fi',
    'if [ "$#" -ge 1 ] && [ "$1" = "access" ]; then',
    '  shift',
    `  exec ${quotePosix(nodePath)} ${quotePosix(cliPath)} runtime-host access "$@"`,
    'fi',
    'if [ "$#" -ge 1 ] && [ "$1" = "activate" ]; then',
    '  shift',
    `  exec ${quotePosix(nodePath)} ${quotePosix(cliPath)} runtime-host activate "$@"`,
    'fi',
    'if [ "$#" -ge 1 ] && [ "$1" = "connect" ]; then',
    '  shift',
    `  exec ${quotePosix(nodePath)} ${quotePosix(cliPath)} runtime-host connect "$@"`,
    'fi',
    'if [ "$#" -ge 1 ] && [ "$1" = "serve" ]; then',
    '  shift',
    `  exec ${quotePosix(nodePath)} ${quotePosix(cliPath)} runtime-host serve "$@"`,
    'fi',
    `exec ${quotePosix(nodePath)} ${quotePosix(cliPath)} runtime-host service "$@" --client-data-root ${quotePosix(clientDataRoot)} --managed-root-id ${quotePosix(managedRootId)}${deploymentId ? ` --operator-deployment-id ${quotePosix(deploymentId)}` : ''}`,
    '',
  ].join('\n');
}

export async function convergeRuntimeHostManagedOperator(
  current: RuntimeHostManagedDeploymentConfig | undefined,
  desired: RuntimeHostManagedDeploymentConfig | undefined,
): Promise<void> {
  const deployment = desired ?? current;
  if (!deployment) return;
  // The stable operator is the bounded cleanup and recovery route after authority
  // is removed. Package cleanup removes it with the deployment root.
  if (!desired) return;
  const operatorPath = join(deployment.deploymentRoot, 'operator');
  const layout = resolveRuntimeHostNpmDeploymentLayout(
    desired.deploymentRoot,
    desired.launch.package.integrity,
  );
  await writeOperatorLauncher(
    operatorPath,
    desired.launch.nodePath,
    layout.cliPath,
    resolveRuntimeHostManagedControlRoot(desired.root.id),
    desired.root.id,
    desired.deploymentId,
  );
}

export async function restoreRuntimeHostLegacyManagedOperator(input: {
  readonly deploymentRoot: string;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly clientDataRoot: string;
  readonly serviceId: string;
}): Promise<void> {
  await writeOperatorLauncher(
    join(input.deploymentRoot, 'operator'),
    input.nodePath,
    input.cliPath,
    input.clientDataRoot,
    input.serviceId,
  );
}

export async function verifyRuntimeHostManagedOperator(
  config: RuntimeHostManagedDeploymentConfig,
): Promise<void> {
  const layout = resolveRuntimeHostNpmDeploymentLayout(
    config.deploymentRoot,
    config.launch.package.integrity,
  );
  const expected = operatorLauncherContents(
    config.launch.nodePath,
    layout.cliPath,
    resolveRuntimeHostManagedControlRoot(config.root.id),
    config.root.id,
    config.deploymentId,
  );
  const observed = await readStableBoundedFile({
    path: join(config.deploymentRoot, 'operator'),
    maxBytes: Buffer.byteLength(expected),
    invalidFile: () => new Error('The managed Runtime Host operator is not a stable regular file'),
  }).then((contents) => new TextDecoder('utf-8', { fatal: true }).decode(contents));
  if (observed !== expected)
    throw new Error('The managed Runtime Host operator does not match its deployment');
  await access(join(config.deploymentRoot, 'operator'), constants.X_OK).catch((error: unknown) => {
    throw new Error('The managed Runtime Host operator is not executable', {
      cause: error,
    });
  });
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
