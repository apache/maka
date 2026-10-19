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
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  STORAGE_ROOT_MARKER_FILE,
  resolveStorageRoot,
  tryAcquireStateRootOwner,
} from '@maka/storage/root-authority';
import {
  claimRuntimeHostManagedDeployment,
  resolveRuntimeHostManagedDeploymentConfigPath,
  resolveRuntimeHostManagedDeployment,
  type RuntimeHostManagedDeploymentConfig,
} from '@maka/runtime-host/operator';
import {
  convergeRuntimeHostManagedOperator,
  resolveRuntimeHostManagedControlRoot,
} from '../runtime-host-managed-deployment.js';
import { parseRuntimeHostCommand } from '../runtime-host-cli.js';
import { repairRuntimeHostMissingWslNode } from '../runtime-host-wsl-node-recovery.js';

async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'maka-wsl-node-repair-')));
  const capability = await resolveStorageRoot({ path: join(base, 'state'), kind: 'interactive' });
  const rootId = capability.rootId;
  const deploymentRoot = join(base, 'deployment');
  await mkdir(deploymentRoot);
  const config: RuntimeHostManagedDeploymentConfig = {
    schemaVersion: 1,
    state: 'active',
    deploymentId: '00000000-0000-4000-8000-000000000001',
    configRevision: 1,
    deploymentRoot,
    root: { id: rootId, path: capability.canonicalPath },
    projectDirectoryRoots: [],
    launch: {
      kind: 'exact_package',
      nodePath: join(base, 'mise', 'deleted-node'),
      package: {
        kind: 'npm_registry',
        version: '1.2.3',
        integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
      },
    },
    listeners: { localIpc: true },
    lifecycle: { mode: 'on_demand', availability: 'activation' },
    reconciliation: { trigger: 'activation' },
  };
  await claimRuntimeHostManagedDeployment(capability, config);
  await convergeRuntimeHostManagedOperator(undefined, config);
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(dirname(resolveRuntimeHostManagedDeploymentConfigPath(rootId)), {
      recursive: true,
      force: true,
    });
    await rm(resolveRuntimeHostManagedControlRoot(rootId), { recursive: true, force: true });
  });
  return {
    config,
    capability,
    input: {
      rootId,
      expectedNodePath: config.launch.nodePath,
      expectedModulePath: join(deploymentRoot, 'operator.mjs'),
    },
  };
}

test('WSL repair changes only Node binding and revision, preserving the exact Host package (#6112)', async (t) => {
  const { config, input } = await fixture(t);
  const repaired = await repairRuntimeHostMissingWslNode(input, { isWsl: async () => true });
  assert.deepEqual(repaired, {
    ...config,
    configRevision: 2,
    launch: { ...config.launch, nodePath: await realpath(process.execPath) },
  });
  assert.deepEqual((await resolveRuntimeHostManagedDeployment(input.rootId)).config, repaired);
  assert.ok(
    (await readFile(input.expectedModulePath, 'utf8')).includes(
      JSON.stringify(await realpath(process.execPath)),
    ),
  );
  // Repeating a stale Desktop request after commit returns the canonical binding without another mutation.
  assert.deepEqual(
    await repairRuntimeHostMissingWslNode(input, { isWsl: async () => true }),
    repaired,
  );
});

test('WSL repair refuses existing Nodes, mismatched modules, non-WSL and live owners', async (t) => {
  const { config, capability, input } = await fixture(t);
  await assert.rejects(
    repairRuntimeHostMissingWslNode(input, { isWsl: async () => false }),
    /only in WSL/,
  );
  await assert.rejects(
    repairRuntimeHostMissingWslNode(
      { ...input, expectedModulePath: '/different/operator.mjs' },
      { isWsl: async () => true },
    ),
    /does not match/,
  );
  await mkdir(dirname(input.expectedNodePath), { recursive: true });
  await writeFile(input.expectedNodePath, 'existing but broken Node');
  await assert.rejects(
    repairRuntimeHostMissingWslNode(input, { isWsl: async () => true }),
    /still exists/,
  );
  await rm(input.expectedNodePath);
  const owner = await tryAcquireStateRootOwner(capability);
  assert.ok(owner);
  try {
    await assert.rejects(
      repairRuntimeHostMissingWslNode(input, { isWsl: async () => true }),
      /still running/,
    );
  } finally {
    await owner.close();
  }
  assert.deepEqual((await resolveRuntimeHostManagedDeployment(input.rootId)).config, config);
});

test('repair-wsl-node requires exact root and absolute source bindings', () => {
  const args = [
    'repair-wsl-node',
    '--root-id',
    'a'.repeat(64),
    '--expected-node-path',
    '/old/node',
    '--expected-module-path',
    '/operator.mjs',
  ];
  assert.equal(parseRuntimeHostCommand(args).kind, 'runtime-host-wsl-node-repair');
  assert.equal(parseRuntimeHostCommand(args.slice(0, -2)).kind, 'error');
  assert.equal(
    parseRuntimeHostCommand([...args, '--expected-node-path', '/other/node']).kind,
    'error',
  );
  assert.equal(
    parseRuntimeHostCommand(args.map((s) => (s === '/old/node' ? 'node' : s))).kind,
    'error',
  );
});

test('missing WSL Node recovery also repairs a device-only State Root remount', async (t) => {
  const { config, input } = await fixture(t);
  const markerPath = join(config.root.path, STORAGE_ROOT_MARKER_FILE);
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  marker.rootIdentity.dev = (BigInt(marker.rootIdentity.dev) + 1n).toString();
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
  const repaired = await repairRuntimeHostMissingWslNode(input, { isWsl: async () => true });
  assert.deepEqual(repaired, {
    ...config,
    configRevision: 2,
    launch: { ...config.launch, nodePath: await realpath(process.execPath) },
  });
  const currentMarker = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.equal(currentMarker.rootId, config.root.id);
  assert.equal(currentMarker.rootIdentity.ino, marker.rootIdentity.ino);
  assert.equal(
    currentMarker.rootIdentity.dev,
    (await lstat(config.root.path, { bigint: true })).dev.toString(),
  );
});

for (const mismatch of ['inode', 'root-id', 'live-owner'] as const) {
  test(`WSL Node remount recovery preserves the ${mismatch} fence`, async (t) => {
    const { config, capability, input } = await fixture(t);
    const owner =
      mismatch === 'live-owner' ? await tryAcquireStateRootOwner(capability) : undefined;
    if (mismatch === 'live-owner') assert.ok(owner);
    const markerPath = join(config.root.path, STORAGE_ROOT_MARKER_FILE);
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    marker.rootIdentity.dev = (BigInt(marker.rootIdentity.dev) + 1n).toString();
    if (mismatch === 'inode')
      marker.rootIdentity.ino = (BigInt(marker.rootIdentity.ino) + 1n).toString();
    if (mismatch === 'root-id') marker.rootId = 'f'.repeat(64);
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
    const operatorBefore = await readFile(input.expectedModulePath, 'utf8');
    try {
      await assert.rejects(
        repairRuntimeHostMissingWslNode(input, { isWsl: async () => true }),
        mismatch === 'live-owner' ? /still running/ : /root|directory/i,
      );
    } finally {
      await owner?.close();
    }
    assert.deepEqual(
      JSON.parse(
        await readFile(resolveRuntimeHostManagedDeploymentConfigPath(input.rootId), 'utf8'),
      ),
      config,
    );
    assert.equal(await readFile(input.expectedModulePath, 'utf8'), operatorBefore);
  });
}
