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
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test, { after, mock } from 'node:test';
import {
  readRuntimeHostManagedDeploymentRecoveryTarget,
  claimRuntimeHostManagedDeployment,
  resolveRuntimeHostManagedDeploymentConfigPath,
  type RuntimeHostManagedDeploymentConfig,
} from '@maka/runtime-host/operator';
import {
  resolveStorageRoot,
  resolveExistingStorageRoot,
  StorageRootAuthorityError,
  STORAGE_ROOT_MARKER_FILE,
} from '@maka/storage/root-authority';
import { parseRuntimeHostCommand } from '../runtime-host-cli.js';
import {
  runRuntimeHostRootRepairCli,
  runtimeHostRootRepairError,
} from '../runtime-host-root-repair-command.js';
import { resolveRuntimeHostManagedServiceConfigPath } from '../runtime-host-service-manager.js';

// Keep account-scoped owner locks and control sockets inside this test process's
// temporary account, including when the suite runs in a filesystem sandbox.
const accountHome = await mkdtemp(join(tmpdir(), 'maka-root-repair-account-'));
const userInfo = os.userInfo;
mock.method(os, 'userInfo', () => ({ ...userInfo(), homedir: accountHome }));
syncBuiltinESMExports();
after(async () => {
  mock.restoreAll();
  syncBuiltinESMExports();
  await rm(accountHome, { recursive: true, force: true });
});

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'maka-service-root-repair-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'root');
  const clientDataRoot = join(directory, 'client');
  await mkdir(clientDataRoot);
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  marker.rootIdentity.dev = (BigInt(marker.rootIdentity.dev) + 1n).toString();
  await writeFile(markerPath, JSON.stringify(marker));
  const stale = await readFile(markerPath, 'utf8');
  const config = {
    schemaVersion: 1,
    rootPath: capability.canonicalPath,
    projectDirectoryRoots: [],
    websocket: { host: '127.0.0.1', port: 64150, path: '/runtime-host' },
    launch: { nodePath: process.execPath, cliPath: join(directory, 'cli.js') },
  };
  const legacyConfigPath = resolveRuntimeHostManagedServiceConfigPath(clientDataRoot);
  await writeFile(legacyConfigPath, JSON.stringify(config));
  const options = { clientDataRoot, defaultRootPath: root, cliPath: config.launch.cliPath };
  const quiet = {
    writeOutput: () => {},
    writeError: () => {},
    readDeployment: async () => undefined,
  };
  return {
    directory,
    root,
    capability,
    markerPath,
    stale,
    legacyConfigPath,
    config,
    options,
    quiet,
  };
}

test('repair-root is interactive and never accepts a persistent repair flag', () => {
  assert.deepEqual(parseRuntimeHostCommand(['service', 'repair-root']), {
    kind: 'runtime-host-service-repair-root',
  });
  const root = process.platform === 'win32' ? 'C:\\maka' : '/srv/maka';
  assert.deepEqual(parseRuntimeHostCommand(['service', 'repair-root', '--root', root]), {
    kind: 'runtime-host-service-repair-root',
    rootPath: root,
  });
  for (const args of [
    ['--root', 'relative'],
    ['--root', root, '--root', root],
    ['--managed-root-id', 'invalid'],
    ['--operator-deployment-id', '00000000-0000-4000-8000-000000000001'],
  ]) {
    assert.equal(parseRuntimeHostCommand(['service', 'repair-root', ...args]).kind, 'error');
  }
  for (const flag of ['--yes', '--json', '--framed', '--repair-root-after-remount']) {
    assert.equal(parseRuntimeHostCommand(['service', 'repair-root', flag]).kind, 'error');
  }
});

test('legacy managed service repairs the exact confirmed root and preserves rootId', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    resolveStorageRoot({ path: f.root, kind: 'interactive' }),
    (error: unknown) =>
      error instanceof StorageRootAuthorityError && error.code === 'root_identity_collision',
  );
  let confirmations = 0;
  assert.equal(
    await runRuntimeHostRootRepairCli(f.options, {
      ...f.quiet,
      confirm: async (candidate) => {
        confirmations++;
        assert.equal(candidate.canonicalPath, f.capability.canonicalPath);
        assert.equal(candidate.rootId, f.capability.rootId);
        return true;
      },
    }),
    0,
  );
  assert.equal(confirmations, 1);
  assert.equal(
    (await resolveStorageRoot({ path: f.root, kind: 'interactive' })).rootId,
    f.capability.rootId,
  );
});

test('declining confirmation leaves the marker unchanged', async (t) => {
  const f = await fixture(t);
  assert.equal(
    await runRuntimeHostRootRepairCli(f.options, { ...f.quiet, confirm: async () => false }),
    1,
  );
  assert.equal(await readFile(f.markerPath, 'utf8'), f.stale);
});

test('a marker changed during confirmation cannot inherit that confirmation', async (t) => {
  const f = await fixture(t);
  const replacement = JSON.parse(f.stale);
  replacement.rootId = 'b'.repeat(64);
  const changed = JSON.stringify(replacement);
  assert.equal(
    await runRuntimeHostRootRepairCli(f.options, {
      ...f.quiet,
      confirm: async () => {
        await writeFile(f.markerPath, changed);
        return true;
      },
    }),
    1,
  );
  assert.equal(await readFile(f.markerPath, 'utf8'), changed);
});

test('a replaced legacy service configuration invalidates confirmation', async (t) => {
  const f = await fixture(t);
  assert.equal(
    await runRuntimeHostRootRepairCli(f.options, {
      ...f.quiet,
      confirm: async () => {
        await writeFile(
          f.legacyConfigPath,
          JSON.stringify({ ...f.config, websocket: { ...f.config.websocket, port: 64151 } }),
        );
        return true;
      },
    }),
    1,
  );
  assert.equal(await readFile(f.markerPath, 'utf8'), f.stale);
});

test('a noninteractive invocation cannot repair a root', {
  skip: Boolean(process.stdin.isTTY && process.stderr.isTTY),
}, async (t) => {
  const f = await fixture(t);
  // The test runner does not attach a terminal; use the real default confirmation.
  assert.equal(await runRuntimeHostRootRepairCli(f.options, f.quiet), 1);
  assert.equal(await readFile(f.markerPath, 'utf8'), f.stale);
});

test('canonical deployment recovery reads a stale root without granting launch authority', async (t) => {
  const f = await fixture(t);
  const authorityRoot = join(f.directory, 'authority');
  await mkdir(authorityRoot);
  const authority = { authorityRoot, durabilityBoundary: authorityRoot };
  const config: RuntimeHostManagedDeploymentConfig = {
    schemaVersion: 1,
    state: 'active',
    deploymentId: '00000000-0000-4000-8000-000000000001',
    configRevision: 1,
    deploymentRoot: join(f.directory, 'deployment'),
    root: { path: f.capability.canonicalPath, id: f.capability.rootId },
    projectDirectoryRoots: [],
    launch: {
      kind: 'exact_package',
      nodePath: process.execPath,
      package: {
        kind: 'npm_registry',
        version: '0.2.2',
        integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
      },
    },
    listeners: { localIpc: true },
    lifecycle: { mode: 'supervised', provider: 'launch_agent', availability: 'session' },
    reconciliation: { trigger: 'manual' },
  };
  // Publish the record while the marker is valid, then restore the stale marker.
  const marker = JSON.parse(f.stale);
  marker.rootIdentity.dev = (await stat(f.root, { bigint: true })).dev.toString();
  await writeFile(f.markerPath, JSON.stringify(marker));
  await claimRuntimeHostManagedDeployment(
    await resolveStorageRoot({ path: f.root, kind: 'interactive' }),
    config,
    authority,
  );
  await writeFile(f.markerPath, f.stale);
  const readDeployment = (id: string) =>
    readRuntimeHostManagedDeploymentRecoveryTarget(id, authority);
  assert.deepEqual(await readDeployment(config.root.id), config);
  await assert.rejects(
    resolveExistingStorageRoot({
      path: f.root,
      kind: 'interactive',
      expectedRootId: config.root.id,
    }),
    (original: unknown) => {
      assert.ok(original instanceof StorageRootAuthorityError);
      assert.equal(original.code, 'root_identity_changed');
      const error = runtimeHostRootRepairError(original, { rootId: config.root.id });
      assert.ok(error instanceof Error);
      assert.equal(error.cause, original);
      assert.ok(error.message.includes(`service repair-root --managed-root-id ${config.root.id}`));
      return true;
    },
  );
  assert.equal(await readFile(f.markerPath, 'utf8'), f.stale);
  assert.equal(
    await runRuntimeHostRootRepairCli(
      { ...f.options, managedRootId: config.root.id },
      {
        ...f.quiet,
        readDeployment,
        confirm: async () => {
          await writeFile(
            resolveRuntimeHostManagedDeploymentConfigPath(config.root.id, authority),
            JSON.stringify({ ...config, configRevision: 2 }),
          );
          return true;
        },
      },
    ),
    1,
  );
  assert.equal(await readFile(f.markerPath, 'utf8'), f.stale);
  await writeFile(
    resolveRuntimeHostManagedDeploymentConfigPath(config.root.id, authority),
    JSON.stringify(config),
  );
  assert.equal(
    await runRuntimeHostRootRepairCli(
      { ...f.options, managedRootId: config.root.id },
      {
        ...f.quiet,
        readDeployment,
        confirm: async () => true,
      },
    ),
    0,
  );
  assert.equal(
    (await resolveStorageRoot({ path: f.root, kind: 'interactive' })).rootId,
    config.root.id,
  );
});

test('startup guidance retains the original failure and selects the managed target', () => {
  const original = new StorageRootAuthorityError(
    'root_identity_collision',
    'Storage root marker belongs to a different directory',
  );
  const error = runtimeHostRootRepairError(original, {
    rootId: 'a'.repeat(64),
    rootPath: '/unused',
    clientDataRoot: '/unused-client',
  });
  assert.ok(error instanceof Error);
  assert.equal(error.cause, original);
  assert.match(error.message, /service repair-root --managed-root-id a{64}/u);
  assert.doesNotMatch(error.message, /--client-data-root/u);
  const legacyError = runtimeHostRootRepairError(original, {
    rootPath: '/legacy root',
    clientDataRoot: '/custom client',
  });
  assert.ok(legacyError instanceof Error);
  assert.match(legacyError.message, /--root "\/legacy root" --client-data-root "\/custom client"/u);
  const unrelated = new Error('unrelated');
  assert.equal(runtimeHostRootRepairError(unrelated, { rootPath: '/root' }), unrelated);
});
