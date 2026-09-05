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
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  resolveRootControlNamespace,
  resolveRootOwnershipNamespace,
  resolveStorageRoot,
} from '@maka/storage/root-authority';
import {
  connectRemoteRuntimeHost,
  connectRuntimeHost,
  consumeAccessCredentialDelivery,
} from '../client/index.js';
import { connectOrSpawnRuntimeHostWithDependencies } from '../client/connect-or-spawn.js';
import { launchDetachedRuntimeHostCandidate } from '../client/launcher.js';
import { activateRuntimeHostManagedDeployment } from '../client/managed-activation.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../protocol/index.js';
import {
  claimRuntimeHostManagedDeployment,
  resolveRuntimeHostManagedDeploymentConfigPath,
  type RuntimeHostManagedDeploymentConfig,
} from '../operator/managed-deployment.js';
import { resolveRuntimeHostNpmDeploymentLayout } from '../operator/update-package-evidence.js';
import { waitFor } from '@maka/core/test-only/async-primitives';

const ROOT_ID = 'a'.repeat(64);
const config: RuntimeHostManagedDeploymentConfig = {
  schemaVersion: 1,
  state: 'active',
  deploymentId: '00000000-0000-4000-8000-000000000001',
  configRevision: 1,
  deploymentRoot: '/opt/maka/runtime-host',
  root: { path: '/srv/maka/state', id: ROOT_ID },
  projectDirectoryRoots: [],
  launch: {
    kind: 'exact_package',
    nodePath: '/usr/bin/node',
    package: {
      kind: 'npm_registry',
      version: '1.2.3',
      integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
    },
  },
  listeners: {
    localIpc: true,
    websocket: { host: '127.0.0.1', port: 0, path: '/runtime-host' },
  },
  lifecycle: { mode: 'on_demand', availability: 'activation' },
  reconciliation: { trigger: 'manual' },
};

test('activation reconciliation fails closed when no one-shot reconciler is installed', async () => {
  await assert.rejects(
    activateRuntimeHostManagedDeployment(
      { rootId: ROOT_ID },
      {
        resolveDeployment: async () =>
          ({
            capability: { canonicalPath: config.root.path, rootId: ROOT_ID },
            config: { ...config, reconciliation: { trigger: 'activation' } },
          }) as never,
      },
    ),
    { code: 'activation_reconciliation_unavailable' },
  );
});

test('two real managed activations converge on one Host and exit at true idle', {
  skip: process.platform === 'win32' ? 'requires a POSIX package-entrypoint symlink' : false,
  timeout: 30_000,
}, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-managed-activation-'));
  const rootPath = join(base, 'state');
  const deploymentRoot = join(base, 'deployment');
  const capability = await resolveStorageRoot({ path: rootPath, kind: 'interactive' });
  const integrationConfig: RuntimeHostManagedDeploymentConfig = {
    ...config,
    deploymentId: crypto.randomUUID(),
    deploymentRoot,
    root: { path: capability.canonicalPath, id: capability.rootId },
    launch: { ...config.launch, nodePath: process.execPath },
  };
  const layout = resolveRuntimeHostNpmDeploymentLayout(
    deploymentRoot,
    integrationConfig.launch.package.integrity,
  );
  await mkdir(dirname(layout.candidateEntrypoint), { recursive: true });
  await symlink(
    fileURLToPath(new URL('../execution-candidate-main.js', import.meta.url)),
    layout.candidateEntrypoint,
  );
  await claimRuntimeHostManagedDeployment(capability, integrationConfig);

  let pid: number | undefined;
  t.after(async () => {
    if (pid !== undefined && processExists(pid)) process.kill(pid, 'SIGTERM');
    await waitUntil(() => pid === undefined || !processExists(pid), 5_000).catch(() => undefined);
    await Promise.all([
      rm(base, { recursive: true, force: true }),
      rm(dirname(resolveRuntimeHostManagedDeploymentConfigPath(capability.rootId)), {
        recursive: true,
        force: true,
      }),
      rm(join(resolveRootControlNamespace(), capability.rootId), {
        recursive: true,
        force: true,
      }),
      rm(join(resolveRootOwnershipNamespace(), `${capability.rootId}.lock`), { force: true }),
    ]);
  });

  const [first, second] = await Promise.all([
    activateRuntimeHostManagedDeployment(
      { rootId: capability.rootId },
      { connectOrSpawn: connectOrSpawnWithShortIdleGrace },
    ),
    activateRuntimeHostManagedDeployment(
      { rootId: capability.rootId },
      { connectOrSpawn: connectOrSpawnWithShortIdleGrace },
    ),
  ]);
  pid = first.pid;
  assert.equal(second.pid, first.pid);
  assert.equal(second.rootId, first.rootId);
  assert.equal(second.hostEpoch, first.hostEpoch);
  assert.equal(processExists(first.pid), true);

  const local = await connectRuntimeHost({
    rootPath: capability.canonicalPath,
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
  });
  assert.equal(local.kind, 'connected');
  if (local.kind !== 'connected') return;
  const issued = await local.connection.request('access.credential.issue', {
    principalKind: 'remote_owner',
    principalId: 'activation-integration',
    operationGrants: [],
    canPublishClientCapabilities: false,
    canUseHostPaths: false,
  });
  const credential = await consumeAccessCredentialDelivery(
    capability.canonicalPath,
    issued.deliveryId,
    issued.credentialId,
  );
  await local.connection.close();
  const remote = await connectRemoteRuntimeHost({
    url: `ws://${first.endpoint.host}:${first.endpoint.port}${first.endpoint.websocketPath}`,
    credential,
    expectedRootId: capability.rootId,
    compositionId: 'maka.interactive',
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
  });
  assert.equal(remote.kind, 'connected');
  if (remote.kind === 'connected') await remote.connection.close();
  await waitUntil(() => !processExists(first.pid), 5_000);
  pid = undefined;
});

const connectOrSpawnWithShortIdleGrace: typeof import('../client/connect-or-spawn.js').connectOrSpawnRuntimeHost =
  (input) =>
    connectOrSpawnRuntimeHostWithDependencies(input, {
      launchCandidate: (candidate) =>
        launchDetachedRuntimeHostCandidate({ ...candidate, idleGraceMs: 250 }),
      random: Math.random,
    });

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  await waitFor(predicate, {
    timeoutMs,
    pollMs: 25,
    message: 'condition did not become true',
  });
}
