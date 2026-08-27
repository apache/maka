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
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  resolveRootControlNamespace,
  resolveRootOwnershipNamespace,
  resolveStorageRoot,
} from '@maka/storage/root-authority';
import {
  RuntimeHostManagedDeploymentError,
  claimRuntimeHostManagedDeployment,
  decodeRuntimeHostManagedDeploymentConfig,
  readRuntimeHostManagedDeploymentConfig,
  resolveRuntimeHostManagedDeploymentConfigPath,
  runtimeHostManagedLaunchClaim,
  tryAcquireRuntimeHostLaunch,
  tryAcquireRuntimeHostLaunchOwner,
  type RuntimeHostManagedDeploymentAuthorityOptions,
  type RuntimeHostManagedDeploymentConfig,
} from '../operator/managed-deployment.js';
import { resolveRuntimeHostNpmDeploymentLayout } from '../operator/update-package-evidence.js';

const DEPLOYMENT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_DEPLOYMENT_ID = '00000000-0000-4000-8000-000000000002';
const PACKAGE_INTEGRITY = 'sha512-' + Buffer.alloc(64, 1).toString('base64');

interface Fixture {
  readonly capability: Awaited<ReturnType<typeof resolveStorageRoot>>;
  readonly authority: RuntimeHostManagedDeploymentAuthorityOptions;
  readonly config: RuntimeHostManagedDeploymentConfig;
}

async function fixture(t: test.TestContext): Promise<Fixture> {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-managed-root-'));
  const authorityRoot = await mkdtemp(join(tmpdir(), 'maka-managed-authority-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  t.after(() => rm(authorityRoot, { recursive: true, force: true }));
  const capability = await resolveStorageRoot({ path: rootPath, kind: 'interactive' });
  t.after(() =>
    Promise.all([
      rm(join(resolveRootControlNamespace(), capability.rootId), {
        recursive: true,
        force: true,
      }),
      rm(join(resolveRootOwnershipNamespace(), `${capability.rootId}.lock`), { force: true }),
    ]),
  );
  const config = createConfig(
    capability.canonicalPath,
    capability.rootId,
    join(authorityRoot, 'runtime-host'),
    process.execPath,
  );
  const layout = resolveRuntimeHostNpmDeploymentLayout(
    config.deploymentRoot,
    config.launch.package.integrity,
  );
  await Promise.all([
    mkdir(dirname(layout.cliPath), { recursive: true }),
    mkdir(dirname(layout.candidateEntrypoint), { recursive: true }),
  ]);
  await Promise.all([writeFile(layout.cliPath, ''), writeFile(layout.candidateEntrypoint, '')]);
  return {
    capability,
    authority: { authorityRoot, durabilityBoundary: authorityRoot },
    config,
  };
}

function createConfig(
  rootPath: string,
  rootId: string,
  deploymentRoot = '/opt/maka/runtime-host',
  nodePath = '/usr/bin/node',
): RuntimeHostManagedDeploymentConfig {
  return {
    schemaVersion: 1,
    deploymentId: DEPLOYMENT_ID,
    configRevision: 1,
    deploymentRoot,
    root: { path: rootPath, id: rootId },
    projectDirectoryRoots: [{ label: 'projects', path: '/srv/projects' }],
    launch: {
      kind: 'exact_package',
      nodePath,
      package: {
        kind: 'npm_registry',
        version: '1.2.3',
        integrity: PACKAGE_INTEGRITY,
      },
    },
    listeners: {
      localIpc: true,
      websocket: {
        host: '127.0.0.1',
        port: 43_210,
        path: '/runtime-host',
      },
    },
    lifecycle: { mode: 'on_demand', availability: 'activation' },
    reconciliation: { trigger: 'activation' },
  };
}

function launchRequest(
  config: RuntimeHostManagedDeploymentConfig | undefined,
  lifecycleMode: 'on_demand' | 'supervised',
  claim?: ReturnType<typeof runtimeHostManagedLaunchClaim>,
) {
  const layout =
    config === undefined
      ? undefined
      : resolveRuntimeHostNpmDeploymentLayout(
          config.deploymentRoot,
          config.launch.package.integrity,
        );
  return {
    lifecycleMode,
    claim,
    processLaunch: {
      executablePath: config?.launch.nodePath ?? process.execPath,
      entrypointPath:
        layout === undefined
          ? (process.argv[1] ?? '')
          : lifecycleMode === 'on_demand'
            ? layout.candidateEntrypoint
            : layout.cliPath,
    },
  } as const;
}

test('strictly decodes every level of the canonical deployment contract', () => {
  const config = createConfig('/srv/maka/state', 'a'.repeat(64));
  assert.deepEqual(decodeRuntimeHostManagedDeploymentConfig(config), config);
  assert.throws(
    () =>
      decodeRuntimeHostManagedDeploymentConfig({
        ...config,
        launch: {
          ...config.launch,
          package: { ...config.launch.package, credential: 'must-not-be-persisted' },
        },
      }),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError && error.code === 'invalid_config',
  );
  assert.throws(
    () =>
      decodeRuntimeHostManagedDeploymentConfig({
        ...config,
        listeners: {
          ...config.listeners,
          websocket: { host: '127.0.0.1', port: 7443, path: '/runtime-host?secret=x' },
        },
      }),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError && error.code === 'invalid_config',
  );
});

test('rejects lifecycle and reconciliation combinations that cannot be honored', () => {
  const config = createConfig('/srv/maka/state', 'a'.repeat(64));
  assert.throws(
    () =>
      decodeRuntimeHostManagedDeploymentConfig({
        ...config,
        reconciliation: { trigger: 'scheduled', provider: 'systemd_timer' },
      }),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError && error.code === 'invalid_config',
  );
  assert.throws(
    () =>
      decodeRuntimeHostManagedDeploymentConfig({
        ...config,
        lifecycle: { mode: 'supervised', provider: 'launch_agent', availability: 'session' },
        reconciliation: { trigger: 'scheduled', provider: 'systemd_timer' },
      }),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError && error.code === 'invalid_config',
  );
});

test('claims one canonical deployment while fencing State Root ownership', async (t) => {
  const input = await fixture(t);
  const claimed = await claimRuntimeHostManagedDeployment(
    input.capability,
    input.config,
    input.authority,
  );
  const retried = await claimRuntimeHostManagedDeployment(
    input.capability,
    input.config,
    input.authority,
  );

  assert.equal(claimed.kind, 'applied');
  assert.equal(retried.kind, 'unchanged');
  assert.deepEqual(retried.claim, claimed.claim);
  assert.deepEqual(
    await readRuntimeHostManagedDeploymentConfig(input.capability, input.authority),
    input.config,
  );
  const path = resolveRuntimeHostManagedDeploymentConfigPath(
    input.capability.rootId,
    input.authority,
  );
  if (process.platform !== 'win32') assert.equal((await lstat(path)).mode & 0o777, 0o600);

  await assert.rejects(
    claimRuntimeHostManagedDeployment(
      input.capability,
      { ...input.config, deploymentId: OTHER_DEPLOYMENT_ID },
      input.authority,
    ),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError && error.code === 'lifecycle_owner_exists',
  );
});

test('launch acquisition atomically joins deployment authorization and State Root ownership', async (t) => {
  const input = await fixture(t);
  const unmanagedOwner = await tryAcquireRuntimeHostLaunchOwner(
    input.capability,
    launchRequest(undefined, 'on_demand'),
    input.authority,
  );
  assert.ok(unmanagedOwner);
  try {
    await assert.rejects(
      claimRuntimeHostManagedDeployment(input.capability, input.config, input.authority),
      (error: unknown) =>
        error instanceof RuntimeHostManagedDeploymentError && error.code === 'state_root_owned',
    );
  } finally {
    await unmanagedOwner.close();
  }

  const managed = await claimRuntimeHostManagedDeployment(
    input.capability,
    input.config,
    input.authority,
  );
  await assert.rejects(
    tryAcquireRuntimeHostLaunchOwner(
      input.capability,
      launchRequest(input.config, 'on_demand', undefined),
      input.authority,
    ),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError &&
      error.code === 'managed_root_requires_operator',
  );
  await assert.rejects(
    tryAcquireRuntimeHostLaunchOwner(
      input.capability,
      launchRequest(input.config, 'supervised', managed.claim),
      input.authority,
    ),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError &&
      error.code === 'deployment_lifecycle_mismatch',
  );
  await assert.rejects(
    tryAcquireRuntimeHostLaunchOwner(
      input.capability,
      {
        ...launchRequest(input.config, 'on_demand', managed.claim),
        processLaunch: {
          executablePath: input.config.launch.nodePath,
          entrypointPath: '/opt/maka/runtime-host/versions/unclaimed/candidate.js',
        },
      },
      input.authority,
    ),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError &&
      error.code === 'deployment_launch_mismatch',
  );
  const managedOwnership = await tryAcquireRuntimeHostLaunch(
    input.capability,
    launchRequest(input.config, 'on_demand', managed.claim),
    input.authority,
  );
  assert.ok(managedOwnership);
  assert.deepEqual(managedOwnership.managedConfig?.projectDirectoryRoots, [
    { label: 'projects', path: '/srv/projects' },
  ]);
  await managedOwnership.owner.close();
});

test('concurrent install and unmanaged launch cannot both cross the authority boundary', async (t) => {
  const input = await fixture(t);
  const [claimResult, launchResult] = await Promise.allSettled([
    claimRuntimeHostManagedDeployment(input.capability, input.config, input.authority),
    tryAcquireRuntimeHostLaunchOwner(
      input.capability,
      launchRequest(input.config, 'on_demand', undefined),
      input.authority,
    ),
  ]);

  const claimSucceeded = claimResult.status === 'fulfilled';
  const launchOwner = launchResult.status === 'fulfilled' ? launchResult.value : undefined;
  assert.notEqual(claimSucceeded, launchOwner !== undefined);
  await launchOwner?.close();

  if (claimSucceeded) {
    if (launchResult.status === 'rejected') {
      assert.ok(launchResult.reason instanceof RuntimeHostManagedDeploymentError);
      assert.equal(launchResult.reason.code, 'managed_root_requires_operator');
    } else {
      assert.equal(launchResult.value, undefined);
    }
  } else {
    assert.equal(claimResult.status, 'rejected');
    assert.ok(claimResult.reason instanceof RuntimeHostManagedDeploymentError);
    assert.equal(claimResult.reason.code, 'state_root_owned');
  }
});

test('concurrent claims cannot adopt an unsynced authority directory', async (t) => {
  const input = await fixture(t);
  const authorityBase = await mkdtemp(join(tmpdir(), 'maka-managed-durability-'));
  t.after(() => rm(authorityBase, { recursive: true, force: true }));
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = claimRuntimeHostManagedDeployment(input.capability, input.config, {
    homeDir: authorityBase,
    beforeDirectorySync: async (path) => {
      if (path !== authorityBase) return;
      entered();
      await released;
      throw new Error('injected directory sync failure');
    },
  });
  await firstEntered;
  try {
    await assert.rejects(
      claimRuntimeHostManagedDeployment(input.capability, input.config, {
        homeDir: authorityBase,
        beforeDirectorySync: (path) => {
          if (path === authorityBase) throw new Error('injected directory sync failure');
        },
      }),
      { code: 'deployment_io_failed' },
    );
  } finally {
    release();
  }
  await assert.rejects(first, { code: 'deployment_io_failed' });
  assert.equal(
    await readRuntimeHostManagedDeploymentConfig(input.capability, { homeDir: authorityBase }),
    undefined,
  );
});
