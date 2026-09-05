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
  removeDeploymentDirectory,
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
  runtimeHostManagedOperatorModulePath,
  type RuntimeHostManagedDeploymentAuthorityOptions,
  type RuntimeHostManagedDeploymentConfig,
} from '@maka/runtime-host/operator';
import {
  readRuntimeHostWindowsTaskLauncher,
  resolvePackagedRuntimeHostWindowsTaskLauncherPath,
  runtimeHostManagedWindowsTaskLauncherPath,
} from './runtime-host-windows-task-launcher-artifact.js';

export { RuntimeHostPackageDeploymentError as RuntimeHostManagedDeploymentError } from './runtime-host-package-deployment.js';

export interface RuntimeHostManagedPackageDeployment {
  readonly version: string;
  readonly root: string;
  readonly cliPath: string;
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
  const platform = options.platform ?? process.platform;
  return platform === 'darwin'
    ? join(homeDir, 'Library', 'Application Support')
    : platform === 'win32'
      ? env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA)
        ? env.LOCALAPPDATA
        : join(homeDir, 'AppData', 'Local')
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
  await removeDeploymentDirectory(retiredRoot);
  await syncDirectory(parent);
}

function managedDeployment(
  staged: RuntimeHostPackageDeployment,
  clientDataRoot: string,
  managedRootId: string,
): RuntimeHostManagedPackageDeployment {
  const modulePath = runtimeHostManagedOperatorModulePath(
    staged.root,
    process.platform === 'win32' ? 'win32' : 'posix',
  );
  return {
    version: staged.version,
    root: staged.root,
    cliPath: staged.cliPath,
    activate: async () => {
      await writeOperatorLauncher(
        modulePath,
        process.execPath,
        staged.cliPath,
        clientDataRoot,
        managedRootId,
      );
      await forwardLegacyOperatorIfPresent(staged.root, process.execPath, modulePath);
    },
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
  const contents = operatorLauncherContents(
    nodePath,
    cliPath,
    clientDataRoot,
    managedRootId,
    deploymentId,
  );
  await writeStableArtifact(path, contents);
}

async function writeStableArtifact(path: string, contents: string | Uint8Array): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, 'wx', 0o700);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
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
  const fixedServiceArguments = [
    '--client-data-root',
    clientDataRoot,
    '--managed-root-id',
    managedRootId,
    ...(deploymentId ? ['--operator-deployment-id', deploymentId] : []),
  ];
  return `import { spawn } from 'node:child_process';

const [action, ...args] = process.argv.slice(2);
const direct = new Set(['access', 'activate', 'connect', 'serve']);
const cliArgs = action === '__cleanup-managed-deployment'
  ? ['runtime-host', 'service', 'cleanup-deployment', ...args, ...${JSON.stringify(fixedServiceArguments)}]
  : direct.has(action)
    ? ['runtime-host', action, ...args]
    : ['runtime-host', 'service', ...(action === undefined ? [] : [action]), ...args, ...${JSON.stringify(fixedServiceArguments)}];
const child = spawn(${JSON.stringify(nodePath)}, [${JSON.stringify(cliPath)}, ...cliArgs], {
  stdio: 'inherit',
  windowsHide: true,
});
const signalForwarders = new Map();
for (const signal of ['SIGINT', 'SIGTERM']) {
  const forward = () => child.kill(signal);
  signalForwarders.set(signal, forward);
  process.on(signal, forward);
}
const stopForwardingSignals = () => {
  for (const [signal, forward] of signalForwarders) process.off(signal, forward);
};
child.once('error', (error) => {
  stopForwardingSignals();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  stopForwardingSignals();
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
`;
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
  const operatorPath = runtimeHostManagedOperatorModulePath(
    deployment.deploymentRoot,
    process.platform === 'win32' ? 'win32' : 'posix',
  );
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
  if (process.platform === 'win32') {
    await convergeRuntimeHostManagedWindowsTaskLauncher(desired);
  }
  await forwardLegacyOperatorIfPresent(
    deployment.deploymentRoot,
    desired.launch.nodePath,
    operatorPath,
  );
}

function legacyOperatorLauncherContents(nodePath: string, modulePath: string): string {
  return `#!/bin/sh\nexec ${quotePosix(nodePath)} ${quotePosix(modulePath)} "$@"\n`;
}

async function forwardLegacyOperatorIfPresent(
  deploymentRoot: string,
  nodePath: string,
  modulePath: string,
): Promise<void> {
  if (process.platform === 'win32') return;
  const path = join(deploymentRoot, 'operator');
  const exists = await access(path, constants.F_OK).then(
    () => true,
    (error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return false;
      throw error;
    },
  );
  if (exists) {
    await writeStableArtifact(path, legacyOperatorLauncherContents(nodePath, modulePath));
  }
}

export async function restoreRuntimeHostLegacyManagedOperator(input: {
  readonly deploymentRoot: string;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly clientDataRoot: string;
  readonly serviceId: string;
}): Promise<void> {
  await writeOperatorLauncher(
    runtimeHostManagedOperatorModulePath(input.deploymentRoot, 'posix'),
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
  const operatorPath = runtimeHostManagedOperatorModulePath(
    config.deploymentRoot,
    process.platform === 'win32' ? 'win32' : 'posix',
  );
  const observed = await readStableBoundedFile({
    path: operatorPath,
    maxBytes: Buffer.byteLength(expected),
    invalidFile: () => new Error('The managed Runtime Host operator is not a stable regular file'),
  }).then((contents) => new TextDecoder('utf-8', { fatal: true }).decode(contents));
  if (observed !== expected)
    throw new Error('The managed Runtime Host operator does not match its deployment');
  await access(operatorPath, constants.R_OK).catch((error: unknown) => {
    throw new Error('The managed Runtime Host operator is not readable', {
      cause: error,
    });
  });
  if (process.platform === 'win32') {
    await verifyRuntimeHostManagedWindowsTaskLauncher(config, { allowAbsent: true });
  }
  const legacyOperatorPath = join(config.deploymentRoot, 'operator');
  const legacyExpected = legacyOperatorLauncherContents(config.launch.nodePath, operatorPath);
  const legacyExists = await access(legacyOperatorPath, constants.F_OK).then(
    () => true,
    (error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return false;
      throw error;
    },
  );
  const legacyObserved = legacyExists
    ? await readStableBoundedFile({
        path: legacyOperatorPath,
        maxBytes: Buffer.byteLength(legacyExpected),
        invalidFile: () => new Error('The legacy managed Runtime Host operator is invalid'),
      }).then((contents) => new TextDecoder('utf-8', { fatal: true }).decode(contents))
    : null;
  if (legacyObserved !== null && legacyObserved !== legacyExpected) {
    throw new Error('The legacy managed Runtime Host operator does not match its deployment');
  }
  if (legacyObserved !== null) {
    await access(legacyOperatorPath, constants.X_OK).catch((error: unknown) => {
      throw new Error('The legacy managed Runtime Host operator is not executable', {
        cause: error,
      });
    });
  }
}

export async function convergeRuntimeHostManagedWindowsTaskLauncher(
  config: RuntimeHostManagedDeploymentConfig,
): Promise<void> {
  const layout = resolveRuntimeHostNpmDeploymentLayout(
    config.deploymentRoot,
    config.launch.package.integrity,
  );
  const sourcePath = await resolvePackagedRuntimeHostWindowsTaskLauncherPath(layout.cliPath);
  const expected = await readRuntimeHostWindowsTaskLauncher(sourcePath);
  const projectedPath = runtimeHostManagedWindowsTaskLauncherPath(config.deploymentRoot, expected);
  const projectedExists = await access(projectedPath, constants.F_OK).then(
    () => true,
    (error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return false;
      throw error;
    },
  );
  if (projectedExists) {
    const observed = await readRuntimeHostWindowsTaskLauncher(projectedPath);
    if (!observed.equals(expected)) {
      throw new Error('The managed Runtime Host Windows task launcher is invalid');
    }
    return;
  }
  await writeStableArtifact(projectedPath, expected);
}

export async function verifyRuntimeHostManagedWindowsTaskLauncher(
  config: RuntimeHostManagedDeploymentConfig,
  options: { readonly allowAbsent?: boolean } = {},
): Promise<void> {
  const layout = resolveRuntimeHostNpmDeploymentLayout(
    config.deploymentRoot,
    config.launch.package.integrity,
  );
  const sourcePath = await resolvePackagedRuntimeHostWindowsTaskLauncherPath(layout.cliPath);
  const expected = await readRuntimeHostWindowsTaskLauncher(sourcePath);
  const projectedPath = runtimeHostManagedWindowsTaskLauncherPath(config.deploymentRoot, expected);
  const projectedExists = await access(projectedPath, constants.F_OK).then(
    () => true,
    (error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return false;
      throw error;
    },
  );
  if (!projectedExists) {
    if (options.allowAbsent) return;
    throw new Error('The managed Runtime Host Windows task launcher does not match its deployment');
  }
  const observed = await readRuntimeHostWindowsTaskLauncher(projectedPath);
  if (!observed.equals(expected)) {
    throw new Error('The managed Runtime Host Windows task launcher does not match its deployment');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
