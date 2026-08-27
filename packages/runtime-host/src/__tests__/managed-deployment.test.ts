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
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveStorageRoot } from '@maka/storage/root-authority';
import {
  RuntimeHostManagedDeploymentError,
  assertRuntimeHostManagedLaunchAuthorized,
  claimRuntimeHostLifecycleFence,
  decodeRuntimeHostManagedDeploymentConfig,
  readRuntimeHostLifecycleFence,
  readRuntimeHostManagedDeploymentConfig,
  releaseRuntimeHostLifecycleFence,
  resolveRuntimeHostManagedDeploymentConfigPath,
  runtimeHostManagedLaunchRejection,
  writeRuntimeHostManagedDeploymentConfig,
  type RuntimeHostManagedDeploymentConfig,
  type RuntimeHostManagedLaunchClaim,
} from '../operator/managed-deployment.js';

const DEPLOYMENT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_DEPLOYMENT_ID = '00000000-0000-4000-8000-000000000002';
const ROOT_ID = 'a'.repeat(64);
const PACKAGE_INTEGRITY = 'sha512-' + Buffer.alloc(64, 1).toString('base64');
const ON_DEMAND_CLAIM: RuntimeHostManagedLaunchClaim = {
  deploymentId: DEPLOYMENT_ID,
  configRevision: 1,
  lifecycle: { mode: 'on_demand' },
};

function config(
  overrides: Partial<RuntimeHostManagedDeploymentConfig> = {},
): RuntimeHostManagedDeploymentConfig {
  return {
    schemaVersion: 1,
    deploymentId: DEPLOYMENT_ID,
    configRevision: 1,
    deploymentRoot: '/opt/maka/runtime-host',
    root: { path: '/srv/maka/state', id: ROOT_ID },
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
    reconciliation: {
      policy: 'automatic',
      trigger: { kind: 'activation' },
    },
    ...overrides,
  };
}

async function root(t: test.TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'maka-managed-deployment-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return resolveStorageRoot({ path, kind: 'interactive' });
}

test('strictly decodes the canonical on-demand deployment contract', () => {
  assert.deepEqual(decodeRuntimeHostManagedDeploymentConfig(config()), config());
  assert.throws(
    () =>
      decodeRuntimeHostManagedDeploymentConfig({
        ...config(),
        credential: 'must-not-be-persisted',
      }),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError && error.code === 'invalid_config',
  );
});

test('rejects lifecycle and reconciliation combinations that cannot be honored', () => {
  assert.throws(
    () =>
      decodeRuntimeHostManagedDeploymentConfig(
        config({
          reconciliation: {
            policy: 'automatic',
            trigger: { kind: 'scheduled', provider: 'systemd_timer' },
          },
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError && error.code === 'invalid_config',
  );
  assert.throws(
    () =>
      decodeRuntimeHostManagedDeploymentConfig(
        config({
          lifecycle: {
            mode: 'supervised',
            provider: 'launch_agent',
            availability: 'session',
          },
          reconciliation: {
            policy: 'automatic',
            trigger: { kind: 'scheduled', provider: 'systemd_timer' },
          },
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError && error.code === 'invalid_config',
  );
});

test('writes and reads a bounded private canonical deployment file', async (t) => {
  const clientDataRoot = await mkdtemp(join(tmpdir(), 'maka-managed-config-'));
  t.after(() => rm(clientDataRoot, { recursive: true, force: true }));
  const path = resolveRuntimeHostManagedDeploymentConfigPath(clientDataRoot);

  await writeRuntimeHostManagedDeploymentConfig(path, config());

  assert.deepEqual(await readRuntimeHostManagedDeploymentConfig(path), config());
  if (process.platform !== 'win32') {
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
  }
});

test('rejects oversized deployment documents before parsing', async (t) => {
  const clientDataRoot = await mkdtemp(join(tmpdir(), 'maka-managed-config-large-'));
  t.after(() => rm(clientDataRoot, { recursive: true, force: true }));
  const path = resolveRuntimeHostManagedDeploymentConfigPath(clientDataRoot);
  await writeFile(path, 'x'.repeat(64 * 1024 + 1));

  await assert.rejects(
    readRuntimeHostManagedDeploymentConfig(path),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError && error.code === 'invalid_config',
  );
});

test('claims one idempotent lifecycle owner and refuses a competing deployment', async (t) => {
  const capability = await root(t);
  const first = await claimRuntimeHostLifecycleFence(capability, ON_DEMAND_CLAIM);
  const retried = await claimRuntimeHostLifecycleFence(capability, ON_DEMAND_CLAIM);

  assert.equal(first.kind, 'applied');
  assert.equal(retried.kind, 'unchanged');
  assert.deepEqual(retried.fence, first.fence);
  await assert.rejects(
    claimRuntimeHostLifecycleFence(capability, {
      ...ON_DEMAND_CLAIM,
      deploymentId: OTHER_DEPLOYMENT_ID,
    }),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError && error.code === 'lifecycle_owner_exists',
  );
});

test('releases only the exact observed lifecycle fence revision', async (t) => {
  const capability = await root(t);
  const claimed = await claimRuntimeHostLifecycleFence(capability, ON_DEMAND_CLAIM);

  await assert.rejects(
    releaseRuntimeHostLifecycleFence(capability, {
      revision: OTHER_DEPLOYMENT_ID,
      deploymentId: DEPLOYMENT_ID,
      configRevision: 1,
    }),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError &&
      error.code === 'lifecycle_owner_changed',
  );
  assert.equal(
    await releaseRuntimeHostLifecycleFence(capability, {
      revision: claimed.fence.revision,
      deploymentId: DEPLOYMENT_ID,
      configRevision: 1,
    }),
    'released',
  );
  assert.equal(await readRuntimeHostLifecycleFence(capability), undefined);
});

test('maps lifecycle fence states and claims to fail-closed launch decisions', async (t) => {
  const capability = await root(t);
  assert.equal(runtimeHostManagedLaunchRejection(undefined, undefined), undefined);
  assert.equal(
    runtimeHostManagedLaunchRejection(undefined, ON_DEMAND_CLAIM),
    'deployment_fence_missing',
  );

  const claimed = await claimRuntimeHostLifecycleFence(capability, ON_DEMAND_CLAIM);
  assert.equal(
    runtimeHostManagedLaunchRejection(claimed.fence, undefined),
    'managed_root_requires_operator',
  );
  assert.equal(
    runtimeHostManagedLaunchRejection(claimed.fence, {
      ...ON_DEMAND_CLAIM,
      configRevision: 2,
    }),
    'deployment_fence_mismatch',
  );
  assert.equal(runtimeHostManagedLaunchRejection(claimed.fence, ON_DEMAND_CLAIM), undefined);
  await assert.rejects(
    assertRuntimeHostManagedLaunchAuthorized(capability, undefined),
    (error: unknown) =>
      error instanceof RuntimeHostManagedDeploymentError &&
      error.code === 'managed_root_requires_operator',
  );
  await assert.doesNotReject(assertRuntimeHostManagedLaunchAuthorized(capability, ON_DEMAND_CLAIM));
});
