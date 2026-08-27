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
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  resolveRootControlNamespace,
  resolveRootOwnershipNamespace,
  resolveStorageRoot,
  tryAcquireStateRootOwner,
} from '@maka/storage/root-authority';
import { classifyCandidateStartupFailure } from '../candidate-startup-failure.js';
import {
  RuntimeHostManagedDeploymentError,
  claimRuntimeHostManagedDeployment,
  decodeRuntimeHostManagedDeploymentConfig,
  readRuntimeHostManagedDeploymentConfig,
  resolveRuntimeHostManagedDeploymentAuthorityRoot,
  resolveRuntimeHostManagedDeploymentConfigPath,
  runtimeHostManagedLaunchClaim,
  runtimeHostManagedLaunchRejection,
  tryAcquireRuntimeHostLaunchOwner,
  type RuntimeHostManagedDeploymentAuthorityOptions,
  type RuntimeHostManagedDeploymentConfig,
} from '../operator/managed-deployment.js';

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
  return {
    capability,
    authority: { authorityRoot, durabilityBoundary: authorityRoot },
    config: createConfig(capability.canonicalPath, capability.rootId),
  };
}

function createConfig(rootPath: string, rootId: string): RuntimeHostManagedDeploymentConfig {
  return {
    schemaVersion: 1,
    deploymentId: DEPLOYMENT_ID,
    configRevision: 1,
    deploymentRoot: '/opt/maka/runtime-host',
    root: { path: rootPath, id: rootId },
    projectDirectoryRoots: [{ label: 'projects', path: '/srv/projects' }],
    launch: {
      kind: 'exact_package',
      nodePath: '/usr/bin/node',
      cliPath: '/opt/maka/runtime-host/versions/1.2.3/cli.js',
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

test('resolves managed deployment authority under durable application data, never cache', () => {
  assert.equal(
    resolveRuntimeHostManagedDeploymentAuthorityRoot({ homeDir: '/home/maka', platform: 'linux' }),
    '/home/maka/.local/share/Maka/runtime-host-deployments',
  );
  assert.equal(
    resolveRuntimeHostManagedDeploymentAuthorityRoot({
      homeDir: '/Users/maka',
      platform: 'darwin',
    }),
    '/Users/maka/Library/Application Support/Maka/runtime-host-deployments',
  );
  assert.equal(
    resolveRuntimeHostManagedDeploymentAuthorityRoot({
      homeDir: 'C:\\Users\\maka',
      platform: 'win32',
    }),
    'C:\\Users\\maka\\AppData\\Local\\Maka\\runtime-host-deployments',
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

test('cannot publish a managed deployment while another Host owns the State Root', async (t) => {
  const input = await fixture(t);
  const owner = await tryAcquireStateRootOwner(input.capability);
  assert.ok(owner);
  try {
    await assert.rejects(
      claimRuntimeHostManagedDeployment(input.capability, input.config, input.authority),
      (error: unknown) =>
        error instanceof RuntimeHostManagedDeploymentError && error.code === 'state_root_owned',
    );
  } finally {
    await owner.close();
  }
  assert.equal(
    await readRuntimeHostManagedDeploymentConfig(input.capability, input.authority),
    undefined,
  );
});

test('launch acquisition atomically joins deployment authorization and State Root ownership', async (t) => {
  const input = await fixture(t);
  const unmanagedOwner = await tryAcquireRuntimeHostLaunchOwner(
    input.capability,
    'on_demand',
    undefined,
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
    tryAcquireRuntimeHostLaunchOwner(input.capability, 'on_demand', undefined, input.authority),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError &&
      error.code === 'managed_root_requires_operator',
  );
  await assert.rejects(
    tryAcquireRuntimeHostLaunchOwner(
      input.capability,
      'supervised',
      managed.claim,
      input.authority,
    ),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError &&
      error.code === 'deployment_lifecycle_mismatch',
  );
  const managedOwner = await tryAcquireRuntimeHostLaunchOwner(
    input.capability,
    'on_demand',
    managed.claim,
    input.authority,
  );
  assert.ok(managedOwner);
  await managedOwner.close();
});

test('concurrent install and unmanaged launch cannot both cross the authority boundary', async (t) => {
  const input = await fixture(t);
  const [claimResult, launchResult] = await Promise.allSettled([
    claimRuntimeHostManagedDeployment(input.capability, input.config, input.authority),
    tryAcquireRuntimeHostLaunchOwner(input.capability, 'on_demand', undefined, input.authority),
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

test('concurrent managed activations elect exactly one State Root owner', async (t) => {
  const input = await fixture(t);
  const { claim } = await claimRuntimeHostManagedDeployment(
    input.capability,
    input.config,
    input.authority,
  );
  const owners = await Promise.all([
    tryAcquireRuntimeHostLaunchOwner(input.capability, 'on_demand', claim, input.authority),
    tryAcquireRuntimeHostLaunchOwner(input.capability, 'on_demand', claim, input.authority),
  ]);

  assert.equal(owners.filter((owner) => owner !== undefined).length, 1);
  await Promise.all(owners.map((owner) => owner?.close()));
});

test('managed ownership survives deletion of the disposable control cache', {
  skip: process.platform === 'win32' ? 'Windows does not unlink an open native lock file' : false,
}, async (t) => {
  const input = await fixture(t);
  const { claim } = await claimRuntimeHostManagedDeployment(
    input.capability,
    input.config,
    input.authority,
  );
  const owner = await tryAcquireRuntimeHostLaunchOwner(
    input.capability,
    'on_demand',
    claim,
    input.authority,
  );
  assert.ok(owner);
  await rm(owner.controlDirectory, { recursive: true, force: true });

  assert.equal(
    await tryAcquireRuntimeHostLaunchOwner(input.capability, 'on_demand', claim, input.authority),
    undefined,
  );
  await owner.close();
});

test('maps missing and stale claims to fail-closed launch decisions', () => {
  const config = createConfig('/srv/maka/state', 'a'.repeat(64));
  const claim = runtimeHostManagedLaunchClaim(config);
  assert.equal(runtimeHostManagedLaunchRejection(undefined, undefined, 'on_demand'), undefined);
  assert.equal(
    runtimeHostManagedLaunchRejection(undefined, claim, 'on_demand'),
    'deployment_record_missing',
  );
  assert.equal(
    runtimeHostManagedLaunchRejection(config, undefined, 'on_demand'),
    'managed_root_requires_operator',
  );
  assert.equal(
    runtimeHostManagedLaunchRejection(
      config,
      { ...claim, configRevision: claim.configRevision + 1 },
      'on_demand',
    ),
    'deployment_claim_mismatch',
  );
  assert.equal(runtimeHostManagedLaunchRejection(config, claim, 'on_demand'), undefined);
});

test('rejects oversized deployment records before parsing', async (t) => {
  const input = await fixture(t);
  const path = resolveRuntimeHostManagedDeploymentConfigPath(
    input.capability.rootId,
    input.authority,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'x'.repeat(64 * 1024 + 1));

  await assert.rejects(
    readRuntimeHostManagedDeploymentConfig(input.capability, input.authority),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError && error.code === 'invalid_config',
  );
});

test('normalizes unreadable deployment records at the launch authority boundary', async (t) => {
  const input = await fixture(t);
  const path = resolveRuntimeHostManagedDeploymentConfigPath(
    input.capability.rootId,
    input.authority,
  );
  await mkdir(path, { recursive: true });

  await assert.rejects(
    tryAcquireRuntimeHostLaunchOwner(
      input.capability,
      'on_demand',
      runtimeHostManagedLaunchClaim(input.config),
      input.authority,
    ),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError &&
      error.code === 'deployment_record_invalid',
  );
});

test('keeps transient deployment record I/O retryable at the Candidate boundary', {
  skip:
    process.platform === 'win32'
      ? 'POSIX file permissions are required to make the record unreadable'
      : false,
}, async (t) => {
  const input = await fixture(t);
  const { claim } = await claimRuntimeHostManagedDeployment(
    input.capability,
    input.config,
    input.authority,
  );
  const path = resolveRuntimeHostManagedDeploymentConfigPath(
    input.capability.rootId,
    input.authority,
  );
  await chmod(path, 0o000);

  await assert.rejects(
    tryAcquireRuntimeHostLaunchOwner(input.capability, 'on_demand', claim, input.authority),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeHostManagedDeploymentError);
      assert.equal(error.code, 'deployment_io_failed');
      assert.deepEqual(classifyCandidateStartupFailure(error), {
        reason: 'internal_startup_failure',
      });
      return true;
    },
  );
});

test('concurrent first claims cannot adopt an unsynced directory as their durability boundary', async (t) => {
  const input = await fixture(t);
  const authorityBase = await mkdtemp(join(tmpdir(), 'maka-managed-durability-'));
  t.after(() => rm(authorityBase, { recursive: true, force: true }));
  let reportDirectoriesCreated!: () => void;
  const directoriesCreated = new Promise<void>((resolve) => {
    reportDirectoriesCreated = resolve;
  });
  let resumeFirst!: () => void;
  const firstMayContinue = new Promise<void>((resolve) => {
    resumeFirst = resolve;
  });
  let firstSync = true;

  const firstClaim = claimRuntimeHostManagedDeployment(input.capability, input.config, {
    homeDir: authorityBase,
    beforeDirectorySync: async (path) => {
      if (firstSync) {
        firstSync = false;
        reportDirectoriesCreated();
        await firstMayContinue;
      }
      if (path === authorityBase) throw new Error('injected first directory sync failure');
    },
  });
  await directoriesCreated;

  try {
    await assert.rejects(
      claimRuntimeHostManagedDeployment(input.capability, input.config, {
        homeDir: authorityBase,
        beforeDirectorySync: (path) => {
          if (path === authorityBase) {
            throw new Error('injected concurrent directory sync failure');
          }
        },
      }),
      (error: unknown) =>
        error instanceof RuntimeHostManagedDeploymentError && error.code === 'deployment_io_failed',
    );
  } finally {
    resumeFirst();
  }
  await assert.rejects(
    firstClaim,
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError && error.code === 'deployment_io_failed',
  );
  assert.equal(
    await readRuntimeHostManagedDeploymentConfig(input.capability, {
      homeDir: authorityBase,
    }),
    undefined,
  );
});
