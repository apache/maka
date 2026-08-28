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

import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  claimRuntimeHostManagedDeployment,
  decodeRuntimeHostSetupFrame,
  encodeRuntimeHostSetupFrame,
  resolveRuntimeHostManagedDeploymentConfigPath,
  RUNTIME_HOST_SETUP_FRAME_PREFIX,
  type RuntimeHostManagedDeploymentConfig,
} from '@maka/runtime-host/operator';
import {
  resolveRootControlNamespace,
  resolveRootOwnershipNamespace,
  resolveStorageRoot,
  tryAcquireStateRootOwner,
} from '@maka/storage/root-authority';
import {
  acknowledgeRuntimeHostManagedDeploymentCleanup,
  assertRuntimeHostManagedOperatorDeployment,
  convergeRuntimeHostManagedOperator,
  prepareRuntimeHostManagedPackageDeployment,
  pruneRuntimeHostManagedPackages,
  readRuntimeHostManagedDeploymentCleanupReceipt,
  resolveRuntimeHostManagedControlRoot,
  resolveRuntimeHostManagedDeploymentRoot,
} from '../runtime-host-managed-deployment.js';
import { runRuntimeHostSetupCli } from '../runtime-host-setup-command.js';
import { manageRuntimeHostManagedLifecycle } from '../runtime-host-managed-lifecycle-manager.js';
import {
  resolveRuntimeHostLifecycleProvider,
  selectRuntimeHostLifecycleProvider,
} from '../runtime-host-service-management-command.js';
import {
  resolveRuntimeHostManagedServiceId,
  RuntimeHostServiceManagerError,
  type RuntimeHostServiceBackend,
} from '../runtime-host-service-manager.js';

const execFile = promisify(execFileCallback);
const PACKAGE_INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

test('on-demand setup installs one exact deployment without a service backend', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-on-demand-setup-'));
  const stateRoot = join(base, 'state');
  const clientDataRoot = join(base, 'client');
  const canonicalDataHome = join(base, 'canonical-data-home');
  const dataHome = join(base, 'data-home');
  await mkdir(canonicalDataHome);
  await symlink(canonicalDataHome, dataHome);
  const previousDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  const outputs: string[] = [];
  let rootId = '';
  let projectedOperatorDeploymentRoot = '';
  t.after(async () => {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
    await Promise.all([
      rm(base, { recursive: true, force: true }),
      rootId
        ? rm(dirname(resolveRuntimeHostManagedDeploymentConfigPath(rootId)), {
            recursive: true,
            force: true,
          })
        : Promise.resolve(),
      rootId
        ? rm(join(resolveRootControlNamespace(), rootId), {
            recursive: true,
            force: true,
          })
        : Promise.resolve(),
      rootId
        ? rm(join(resolveRootOwnershipNamespace(), `${rootId}.lock`), {
            force: true,
          })
        : Promise.resolve(),
    ]);
  });

  const options = {
    json: true,
    lifecycle: 'on_demand',
    clientDataRoot,
    defaultRootPath: stateRoot,
    sourcePackageRoot: base,
    version: '1.2.3',
    principalId: 'desktop:client-1',
    preset: 'desktop-client',
  } as const;
  const deployment = (serviceId: string) => ({
    version: '1.2.3',
    root: join(canonicalDataHome, 'Maka', 'runtime-host-services', serviceId),
    cliPath: '/verified/package/dist/cli.js',
    operatorPath: '/opt/maka/operator',
    activate: async () => undefined,
    cleanup: async () => undefined,
    rollback: async () => undefined,
  });
  const activateManaged = async (input: { readonly rootId: string }) => {
    rootId = input.rootId;
    return {
      schemaVersion: 1 as const,
      kind: 'result' as const,
      deploymentId: `${rootId.slice(0, 8)}-${rootId.slice(8, 12)}-4${rootId.slice(13, 16)}-8${rootId.slice(17, 20)}-${rootId.slice(20, 32)}`,
      configRevision: 1,
      rootId,
      hostEpoch: 'host-epoch',
      pid: 1234,
      protocolVersion: 1,
      endpoint: {
        host: '127.0.0.1' as const,
        port: 43_210,
        websocketPath: '/runtime-host',
      },
    };
  };
  const overrides = {
    createBackend: () => assert.fail('on-demand setup must not create a service backend'),
    manageService: async () => assert.fail('on-demand setup must not manage a service'),
    resolveRegistryCandidate: async () => ({
      kind: 'npm_registry',
      version: '1.2.3',
      integrity: PACKAGE_INTEGRITY,
    }),
    withRegistryPackage: async (_candidate, use) => use('/verified/package'),
    prepareDeployment: async (input) => deployment(input.serviceId),
    openDeployment: async (input) => deployment(input.serviceId),
    prunePackages: async () => undefined,
    activateManaged,
    activateDesired: activateManaged,
    convergeOperator: async (_current, desired) => {
      projectedOperatorDeploymentRoot = desired?.deploymentRoot ?? '';
    },
    verifyOperator: async () => undefined,
    replaceCredential: async () => ({
      rootId,
      credential: 'secret-token',
      credentialId: 'credential-1',
      principalKind: 'remote_owner' as const,
      principalId: 'desktop:client-1',
      operationGrants: [] as const,
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
    }),
    verifyCredential: async ({ endpoint, rootId: expectedRootId }) => {
      assert.equal(endpoint, 'ws://127.0.0.1:43210/runtime-host');
      assert.equal(expectedRootId, rootId);
    },
    writeOutput: (value) => outputs.push(value),
  } satisfies NonNullable<Parameters<typeof runRuntimeHostSetupCli>[1]>;
  assert.equal(await runRuntimeHostSetupCli(options, overrides), 0);
  const complete = outputs
    .map(decodeRuntimeHostSetupFrame)
    .find((frame) => frame?.kind === 'complete');
  assert.ok(complete?.kind === 'complete');
  const persisted = JSON.parse(
    await readFile(resolveRuntimeHostManagedDeploymentConfigPath(rootId), 'utf8'),
  ) as {
    deploymentRoot: string;
    lifecycle: { mode: string };
    listeners: { websocket: { port: number } };
    reconciliation: { trigger: string };
  };
  assert.equal(
    persisted.deploymentRoot,
    join(canonicalDataHome, 'Maka', 'runtime-host-services', rootId),
  );
  assert.equal(projectedOperatorDeploymentRoot, persisted.deploymentRoot);
  assert.equal(persisted.lifecycle.mode, 'on_demand');
  assert.equal(persisted.listeners.websocket.port, 0);
  assert.equal(persisted.reconciliation.trigger, 'activation');

  const retryOutputs: string[] = [];
  projectedOperatorDeploymentRoot = '/stale/operator/projection';
  assert.equal(
    await runRuntimeHostSetupCli(options, {
      ...overrides,
      replaceLifecycle: async () => assert.fail('an idempotent retry must not replace lifecycle'),
      writeOutput: (value) => retryOutputs.push(value),
    }),
    0,
  );
  const retryComplete = retryOutputs
    .map(decodeRuntimeHostSetupFrame)
    .find((frame) => frame?.kind === 'complete');
  assert.equal(
    retryComplete?.kind === 'complete' ? retryComplete.deploymentId : undefined,
    complete.deploymentId,
  );
  assert.deepEqual(
    JSON.parse(await readFile(resolveRuntimeHostManagedDeploymentConfigPath(rootId), 'utf8')),
    persisted,
  );
  assert.equal(projectedOperatorDeploymentRoot, persisted.deploymentRoot);

  const rejected: string[] = [];
  assert.equal(
    await runRuntimeHostSetupCli(
      { ...options, directPeer: { coordinationRelays: [] } },
      { ...overrides, writeOutput: (value) => rejected.push(value) },
    ),
    1,
  );
  const failure = rejected
    .map(decodeRuntimeHostSetupFrame)
    .find((frame) => frame?.kind === 'error');
  assert.equal(
    failure?.kind === 'error' ? failure.error.code : undefined,
    'unsupported_lifecycle_configuration',
  );

  const replacementIntegrity = `sha512-${Buffer.alloc(64, 9).toString('base64')}`;
  const replacementOptions = { ...options, version: '1.2.4' } as const;
  const replacementPackage = {
    ...overrides,
    resolveRegistryCandidate: async () => ({
      kind: 'npm_registry' as const,
      version: '1.2.4',
      integrity: replacementIntegrity,
    }),
  };
  const refused: string[] = [];
  assert.equal(
    await runRuntimeHostSetupCli(replacementOptions, {
      ...replacementPackage,
      writeOutput: (value) => refused.push(value),
    }),
    1,
  );
  const refusedReplacement = refused
    .map(decodeRuntimeHostSetupFrame)
    .find((frame) => frame?.kind === 'error');
  assert.equal(
    refusedReplacement?.kind === 'error' ? refusedReplacement.error.code : undefined,
    'version_change_requires_update',
  );

  const replacementOutputs: string[] = [];
  assert.equal(
    await runRuntimeHostSetupCli(
      { ...replacementOptions, updateExisting: true },
      {
        ...replacementPackage,
        openDeployment: async () =>
          assert.fail('a changed exact package must be staged before replacement'),
        writeOutput: (value) => replacementOutputs.push(value),
      },
    ),
    0,
  );
  const replaced = JSON.parse(
    await readFile(resolveRuntimeHostManagedDeploymentConfigPath(rootId), 'utf8'),
  ) as RuntimeHostManagedDeploymentConfig;
  assert.equal(replaced.launch.package.version, '1.2.4');
  assert.equal(replaced.launch.package.integrity, replacementIntegrity);
  assert.equal(
    replacementOutputs.map(decodeRuntimeHostSetupFrame).some((frame) => frame?.kind === 'complete'),
    true,
  );

  const uninstalled = await manageRuntimeHostManagedLifecycle(
    rootId,
    {
      action: 'uninstall',
      clientDataRoot,
      defaultRootPath: stateRoot,
      nodePath: process.execPath,
      cliPath: '/verified/package/dist/cli.js',
      expectedTarget: {
        serviceId: rootId,
        rootPath: stateRoot,
        rootId,
        deploymentId: complete.deploymentId,
      },
    },
    {
      resolveProvider: () => assert.fail('on-demand uninstall must not resolve a provider'),
    },
  );
  assert.equal(uninstalled.action, 'uninstall');
  assert.equal(uninstalled.retirement.kind, 'stopped');
});

test('managed setup frames reject malformed machine output', () => {
  assert.equal(
    decodeRuntimeHostSetupFrame(
      encodeRuntimeHostSetupFrame({
        schemaVersion: 1,
        sequence: 0,
        kind: 'progress',
        phase: 'checking_environment',
      }),
    )?.kind,
    'progress',
  );
  assert.equal(
    decodeRuntimeHostSetupFrame(
      `${RUNTIME_HOST_SETUP_FRAME_PREFIX}${Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          sequence: 0,
          kind: 'complete',
          version: '0.2.0',
          rootId: 'root',
          endpoint: 'ws://example.com/runtime-host',
          credentialId: 'credential',
          credential: 'secret',
        }),
      ).toString('base64url')}\n`,
    ),
    undefined,
  );
});

test('lifecycle discovery records environment scope and persisted providers are never reselected', () => {
  assert.deepEqual(
    selectRuntimeHostLifecycleProvider({
      platform: 'linux',
      environment: { WSL_DISTRO_NAME: 'Ubuntu' },
    }),
    { provider: 'systemd_user', availability: 'environment' },
  );
  assert.throws(
    () => resolveRuntimeHostLifecycleProvider('a'.repeat(64), 'openrc_user'),
    (error: unknown) =>
      error instanceof RuntimeHostServiceManagerError &&
      error.code === 'service_manager_unavailable',
  );
});

test('registry package identity avoids local content and recovers an interrupted removal', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-registry-package-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const version = '0.2.0';
  const localPackage = await createReleasePackage(join(base, 'local'), version);
  const registryPackage = await createReleasePackage(join(base, 'registry'), version);
  await writeFile(join(localPackage, 'dist', 'cli.js'), 'local package\n');
  await writeFile(join(registryPackage, 'dist', 'cli.js'), 'registry package\n');
  const clientDataRoot = join(base, 'config', 'Maka');
  const serviceId = resolveRuntimeHostManagedServiceId(clientDataRoot);
  await mkdir(join(base, 'durable-data'));
  await symlink(join(base, 'durable-data'), join(base, 'data'));
  const pathOptions = {
    env: { XDG_DATA_HOME: join(base, 'data') },
    homeDir: join(base, 'home'),
    platform: 'linux' as const,
  };
  const local = await prepareRuntimeHostManagedPackageDeployment(
    { serviceId, clientDataRoot, sourcePackageRoot: localPackage, version },
    pathOptions,
  );
  const registry = await prepareRuntimeHostManagedPackageDeployment(
    {
      serviceId,
      clientDataRoot,
      sourcePackageRoot: registryPackage,
      version,
      packageIntegrity: PACKAGE_INTEGRITY,
    },
    pathOptions,
  );

  assert.equal(
    registry.root,
    join(base, 'durable-data', 'Maka', 'runtime-host-services', serviceId),
  );
  assert.notEqual(local.cliPath, registry.cliPath);
  assert.match(registry.cliPath, /\/versions\/registry-[a-f0-9]{64}\/dist\/cli\.js$/u);
  assert.equal(await readFile(registry.cliPath, 'utf8'), 'registry package\n');
  await registry.cleanup();
  assert.deepEqual(await readdir(dirname(dirname(dirname(registry.cliPath)))), [
    basename(dirname(dirname(registry.cliPath))),
  ]);

  const registryRoot = dirname(dirname(registry.cliPath));
  const versionsRoot = dirname(registryRoot);
  await rename(registryRoot, join(versionsRoot, `.${basename(registryRoot)}.interrupted.deleted`));
  const recovered = await prepareRuntimeHostManagedPackageDeployment(
    {
      serviceId,
      clientDataRoot,
      sourcePackageRoot: registryPackage,
      version,
      packageIntegrity: PACKAGE_INTEGRITY,
    },
    pathOptions,
  );
  assert.equal(await readFile(recovered.cliPath, 'utf8'), 'registry package\n');
  assert.deepEqual(await readdir(versionsRoot), [basename(registryRoot)]);

  const retiredRoot = join(dirname(recovered.root), `.${serviceId}.retired`);
  await rename(recovered.root, retiredRoot);
  const republished = await prepareRuntimeHostManagedPackageDeployment(
    {
      serviceId,
      clientDataRoot,
      sourcePackageRoot: registryPackage,
      version,
      packageIntegrity: PACKAGE_INTEGRITY,
    },
    pathOptions,
  );
  assert.equal(await readFile(republished.cliPath, 'utf8'), 'registry package\n');
  assert.deepEqual(await readdir(dirname(republished.root)), [serviceId]);

  const redirectedDataHome = join(base, 'redirected-data');
  const outsideMaka = join(base, 'outside', 'Maka');
  await mkdir(redirectedDataHome);
  await mkdir(outsideMaka, { recursive: true });
  await writeFile(join(outsideMaka, 'sentinel'), 'outside\n');
  await symlink(outsideMaka, join(redirectedDataHome, 'Maka'));
  await assert.rejects(
    prepareRuntimeHostManagedPackageDeployment(
      {
        serviceId,
        clientDataRoot,
        sourcePackageRoot: registryPackage,
        version,
        packageIntegrity: PACKAGE_INTEGRITY,
      },
      { ...pathOptions, env: { XDG_DATA_HOME: redirectedDataHome } },
    ),
    /redirected managed Runtime Host deployment path/u,
  );
  assert.equal(await readFile(join(outsideMaka, 'sentinel'), 'utf8'), 'outside\n');
  assert.deepEqual(await readdir(outsideMaka), ['sentinel']);

  const redirectedServiceDataHome = join(base, 'redirected-service-data');
  const managedServices = join(redirectedServiceDataHome, 'Maka', 'runtime-host-services');
  const outsideServiceRoot = join(
    base,
    'outside-service',
    'Maka',
    'runtime-host-services',
    serviceId,
  );
  await mkdir(managedServices, { recursive: true });
  await mkdir(outsideServiceRoot, { recursive: true });
  await writeFile(join(outsideServiceRoot, 'sentinel'), 'outside service\n');
  await symlink(outsideServiceRoot, join(managedServices, serviceId));
  await assert.rejects(
    prepareRuntimeHostManagedPackageDeployment(
      {
        serviceId,
        clientDataRoot,
        sourcePackageRoot: registryPackage,
        version,
        packageIntegrity: PACKAGE_INTEGRITY,
      },
      { ...pathOptions, env: { XDG_DATA_HOME: redirectedServiceDataHome } },
    ),
    /redirected managed Runtime Host deployment path/u,
  );
  assert.equal(await readFile(join(outsideServiceRoot, 'sentinel'), 'utf8'), 'outside service\n');
  assert.deepEqual(await readdir(outsideServiceRoot), ['sentinel']);

  const redirectedVersionsDataHome = join(base, 'redirected-versions-data');
  const redirectedVersionsDeploymentRoot = resolveRuntimeHostManagedDeploymentRoot(serviceId, {
    ...pathOptions,
    env: { XDG_DATA_HOME: redirectedVersionsDataHome },
  });
  const outsideVersions = join(base, 'outside-versions');
  await mkdir(redirectedVersionsDeploymentRoot, { recursive: true });
  await mkdir(outsideVersions);
  await writeFile(join(outsideVersions, 'sentinel'), 'outside versions\n');
  await symlink(outsideVersions, join(redirectedVersionsDeploymentRoot, 'versions'));
  await assert.rejects(
    prepareRuntimeHostManagedPackageDeployment(
      {
        serviceId,
        clientDataRoot,
        sourcePackageRoot: registryPackage,
        version,
        packageIntegrity: PACKAGE_INTEGRITY,
      },
      { ...pathOptions, env: { XDG_DATA_HOME: redirectedVersionsDataHome } },
    ),
    /package store is redirected/u,
  );
  assert.equal(await readFile(join(outsideVersions, 'sentinel'), 'utf8'), 'outside versions\n');
  assert.deepEqual(await readdir(outsideVersions), ['sentinel']);

  const redirectedPackageDataHome = join(base, 'redirected-package-data');
  const redirectedPackageDeploymentRoot = resolveRuntimeHostManagedDeploymentRoot(serviceId, {
    ...pathOptions,
    env: { XDG_DATA_HOME: redirectedPackageDataHome },
  });
  const redirectedPackageVersions = join(redirectedPackageDeploymentRoot, 'versions');
  const outsideRetainedPackage = await createReleasePackage(
    join(base, 'outside-retained'),
    version,
  );
  await mkdir(redirectedPackageVersions, { recursive: true });
  await writeFile(join(outsideRetainedPackage, 'sentinel'), 'outside retained\n');
  await symlink(outsideRetainedPackage, join(redirectedPackageVersions, basename(registryRoot)));
  await assert.rejects(
    prepareRuntimeHostManagedPackageDeployment(
      {
        serviceId,
        clientDataRoot,
        sourcePackageRoot: registryPackage,
        version,
        packageIntegrity: PACKAGE_INTEGRITY,
      },
      { ...pathOptions, env: { XDG_DATA_HOME: redirectedPackageDataHome } },
    ),
    /published package is redirected/u,
  );
  assert.equal(
    await readFile(join(outsideRetainedPackage, 'sentinel'), 'utf8'),
    'outside retained\n',
  );

  const authorityStateRoot = join(base, 'authority-state');
  const capability = await resolveStorageRoot({
    path: authorityStateRoot,
    kind: 'interactive',
  });
  const authorityServiceId = capability.rootId;
  t.after(() =>
    Promise.all([
      rm(dirname(resolveRuntimeHostManagedDeploymentConfigPath(authorityServiceId)), {
        recursive: true,
        force: true,
      }),
      rm(join(resolveRootControlNamespace(), authorityServiceId), {
        recursive: true,
        force: true,
      }),
      rm(join(resolveRootOwnershipNamespace(), `${authorityServiceId}.lock`), {
        force: true,
      }),
    ]),
  );
  const currentPathOptions = {
    env: { XDG_DATA_HOME: join(base, 'current-data') },
    homeDir: join(base, 'home'),
    platform: 'linux' as const,
  };
  const currentDeploymentRoot = resolveRuntimeHostManagedDeploymentRoot(
    authorityServiceId,
    currentPathOptions,
  );
  const currentConfig: RuntimeHostManagedDeploymentConfig = {
    schemaVersion: 1,
    state: 'active',
    deploymentId: '00000000-0000-4000-8000-000000000002',
    configRevision: 1,
    deploymentRoot: currentDeploymentRoot,
    root: { path: capability.canonicalPath, id: authorityServiceId },
    projectDirectoryRoots: [],
    launch: {
      kind: 'exact_package',
      nodePath: process.execPath,
      package: { kind: 'npm_registry', version, integrity: PACKAGE_INTEGRITY },
    },
    listeners: { localIpc: true },
    lifecycle: { mode: 'on_demand', availability: 'activation' },
    reconciliation: { trigger: 'manual' },
  };
  await claimRuntimeHostManagedDeployment(capability, currentConfig);
  await acknowledgeRuntimeHostManagedDeploymentCleanup({
    serviceId: authorityServiceId,
    deploymentId: '00000000-0000-4000-8000-000000000001',
    deploymentRoot: resolveRuntimeHostManagedDeploymentRoot(authorityServiceId, {
      ...currentPathOptions,
      env: { XDG_DATA_HOME: join(base, 'retired-data') },
    }),
    stateRootPath: capability.canonicalPath,
  });
  const liveOwner = await tryAcquireStateRootOwner(capability);
  assert.ok(liveOwner);
  try {
    const preparedWithLiveAuthority = await prepareRuntimeHostManagedPackageDeployment(
      {
        serviceId: authorityServiceId,
        clientDataRoot,
        sourcePackageRoot: registryPackage,
        version,
        packageIntegrity: PACKAGE_INTEGRITY,
        deploymentRoot: currentDeploymentRoot,
      },
      {
        ...currentPathOptions,
        env: { XDG_DATA_HOME: join(base, 'drifted-data') },
      },
    );
    assert.equal(preparedWithLiveAuthority.root, currentDeploymentRoot);
    assert.equal(await readFile(preparedWithLiveAuthority.cliPath, 'utf8'), 'registry package\n');
    assert.equal(
      await readRuntimeHostManagedDeploymentCleanupReceipt(authorityServiceId),
      undefined,
    );
    assert.equal(liveOwner.closed, false);
  } finally {
    await liveOwner.close();
  }
  await convergeRuntimeHostManagedOperator(undefined, currentConfig);
  assert.equal(
    (await readFile(join(currentDeploymentRoot, 'operator'), 'utf8')).includes(
      join(currentDeploymentRoot, 'versions', basename(registryRoot), 'dist', 'cli.js'),
    ),
    true,
  );
  await pruneRuntimeHostManagedPackages(currentConfig);
  assert.deepEqual(await readdir(join(currentDeploymentRoot, 'versions')), [
    basename(registryRoot),
  ]);
  await assert.rejects(readdir(join(base, 'drifted-data')), { code: 'ENOENT' });
});

test('managed operator binds its Client Data Root and routes deployment cleanup', {
  skip: process.platform === 'win32',
}, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-operator-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const version = '0.2.0';
  const sourcePackageRoot = await createReleasePackage(base, version);
  const clientDataRoot = join(base, 'config', 'Maka');
  const capability = await resolveStorageRoot({
    path: join(base, 'state'),
    kind: 'interactive',
  });
  const serviceId = capability.rootId;
  const deployment = await prepareRuntimeHostManagedPackageDeployment(
    {
      serviceId,
      clientDataRoot,
      sourcePackageRoot,
      version,
      packageIntegrity: PACKAGE_INTEGRITY,
    },
    {
      env: { XDG_DATA_HOME: join(base, 'data') },
      homeDir: join(base, 'home'),
      platform: 'linux',
    },
  );
  const config: RuntimeHostManagedDeploymentConfig = {
    schemaVersion: 1,
    state: 'active',
    deploymentId: '00000000-0000-4000-8000-000000000001',
    configRevision: 1,
    deploymentRoot: deployment.root,
    root: { id: serviceId, path: capability.canonicalPath },
    projectDirectoryRoots: [],
    launch: {
      kind: 'exact_package',
      nodePath: process.execPath,
      package: {
        kind: 'npm_registry',
        version,
        integrity: PACKAGE_INTEGRITY,
      },
    },
    listeners: { localIpc: true },
    lifecycle: { mode: 'on_demand', availability: 'activation' },
    reconciliation: { trigger: 'manual' },
  };
  await convergeRuntimeHostManagedOperator(undefined, config);
  const authorityRoot = join(base, 'authority');
  await mkdir(authorityRoot);
  const authority = { authorityRoot, durabilityBoundary: authorityRoot };
  await claimRuntimeHostManagedDeployment(capability, config, authority);
  await assertRuntimeHostManagedOperatorDeployment(
    serviceId,
    config.deploymentId,
    deployment.cliPath,
    { authority },
  );
  await assert.rejects(
    assertRuntimeHostManagedOperatorDeployment(
      serviceId,
      config.deploymentId,
      join(deployment.root, 'versions', 'stale', 'dist', 'cli.js'),
      { authority },
    ),
    /different deployment generation or exact package/u,
  );
  await deployment.cleanup();

  const invocationPath = join(base, 'operator-argv.json');
  await writeFile(
    deployment.cliPath,
    `require('node:fs').writeFileSync(process.env.MAKA_TEST_OUTPUT, JSON.stringify(process.argv.slice(2)));\n`,
  );
  await execFile(deployment.operatorPath, ['status'], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(base, 'different-config'),
      MAKA_TEST_OUTPUT: invocationPath,
    },
  });
  assert.deepEqual(JSON.parse(await readFile(invocationPath, 'utf8')), [
    'runtime-host',
    'service',
    'status',
    '--client-data-root',
    resolveRuntimeHostManagedControlRoot(serviceId),
    '--managed-root-id',
    serviceId,
    '--operator-deployment-id',
    '00000000-0000-4000-8000-000000000001',
  ]);

  await execFile(
    deployment.operatorPath,
    ['access', 'list', '--root', '/runtime-root', '--framed'],
    {
      env: { ...process.env, MAKA_TEST_OUTPUT: invocationPath },
    },
  );
  assert.deepEqual(JSON.parse(await readFile(invocationPath, 'utf8')), [
    'runtime-host',
    'access',
    'list',
    '--root',
    '/runtime-root',
    '--framed',
  ]);

  await execFile(deployment.operatorPath, ['activate', '--framed', '--root-id', 'a'.repeat(64)], {
    env: { ...process.env, MAKA_TEST_OUTPUT: invocationPath },
  });
  assert.deepEqual(JSON.parse(await readFile(invocationPath, 'utf8')), [
    'runtime-host',
    'activate',
    '--framed',
    '--root-id',
    'a'.repeat(64),
  ]);

  await execFile(deployment.operatorPath, ['connect', '--framed', '--root-id', 'a'.repeat(64)], {
    env: { ...process.env, MAKA_TEST_OUTPUT: invocationPath },
  });
  assert.deepEqual(JSON.parse(await readFile(invocationPath, 'utf8')), [
    'runtime-host',
    'connect',
    '--framed',
    '--root-id',
    'a'.repeat(64),
  ]);

  await execFile(
    deployment.operatorPath,
    [
      '__cleanup-managed-deployment',
      '--expected-service-id',
      serviceId,
      '--expected-root-path',
      '/srv/maka',
      '--expected-root-id',
      'a'.repeat(64),
    ],
    {
      env: { ...process.env, MAKA_TEST_OUTPUT: invocationPath },
    },
  );
  assert.deepEqual(JSON.parse(await readFile(invocationPath, 'utf8')), [
    'runtime-host',
    'service',
    'cleanup-deployment',
    '--expected-service-id',
    serviceId,
    '--expected-root-path',
    '/srv/maka',
    '--expected-root-id',
    'a'.repeat(64),
    '--client-data-root',
    resolveRuntimeHostManagedControlRoot(serviceId),
    '--managed-root-id',
    serviceId,
    '--operator-deployment-id',
    '00000000-0000-4000-8000-000000000001',
  ]);
});

async function createReleasePackage(base: string, version: string): Promise<string> {
  const root = join(base, `source-package-${version}`);
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'node_modules', '@maka', 'runtime-host'), {
    recursive: true,
  });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'maka-agent', version }));
  await writeFile(join(root, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
  await writeFile(
    join(root, 'node_modules', '@maka', 'runtime-host', 'package.json'),
    JSON.stringify({ name: '@maka/runtime-host', version: '0.1.0' }),
  );
  return root;
}

function unusedBackend(): RuntimeHostServiceBackend {
  return {
    preflightDeployment: async () => undefined,
    stageDeployment: async () => assert.fail('Backend is not expected'),
    replace: async () => assert.fail('Backend is not expected'),
    verifyReplacementPreconditions: async () => assert.fail('Backend is not expected'),
    verifyDeployment: async () => assert.fail('Backend is not expected'),
    status: async () => assert.fail('Backend is not expected'),
    start: async () => assert.fail('Backend is not expected'),
    stop: async () => assert.fail('Backend is not expected'),
    restart: async () => assert.fail('Backend is not expected'),
    retire: async () => assert.fail('Backend is not expected'),
    logs: async () => assert.fail('Backend is not expected'),
    uninstall: async () => assert.fail('Backend is not expected'),
  };
}
