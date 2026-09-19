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
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveStorageRoot, STORAGE_ROOT_MARKER_FILE } from '@maka/storage/root-authority';
import {
  claimRuntimeHostManagedDeployment,
  prepareRuntimeHostRoot,
  readRuntimeHostManagedDeploymentAuthorityRecord,
  resolveRuntimeHostManagedDeploymentAuthorityRoot,
  resolveRuntimeHostNpmDeploymentLayout,
  type RuntimeHostManagedDeploymentConfig,
} from '@maka/runtime-host/operator';
import { activateLocalManagedRuntimeHost } from '../runtime-host-local-managed-activation.js';
import { connectRuntimeHostCliConnection } from '../runtime-host-cli-context.js';
import {
  connectRuntimeHost,
  HostHandoffCancelledError,
  HostHandoffRequiredError,
} from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostIncompatible,
} from '@maka/runtime-host/protocol';

for (const interrupted of [false, true]) {
  test(`local CLI cold-starts the exact package ${interrupted ? 'after format upgrade before deployment activation' : 'with active deployment authority'}`, {
    skip: process.platform === 'win32' ? 'requires a POSIX package-entrypoint symlink' : false,
    timeout: 30_000,
  }, async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'maka-local-managed-'));
    const capability = await resolveStorageRoot({ path: join(base, 'state'), kind: 'interactive' });
    const config: RuntimeHostManagedDeploymentConfig = {
      schemaVersion: 1,
      state: 'active',
      deploymentId: randomUUID(),
      configRevision: 1,
      deploymentRoot: join(base, 'deployment'),
      root: { path: capability.canonicalPath, id: capability.rootId },
      projectDirectoryRoots: [],
      launch: {
        kind: 'exact_package',
        nodePath: process.execPath,
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
    const layout = resolveRuntimeHostNpmDeploymentLayout(
      config.deploymentRoot,
      config.launch.package.integrity,
    );
    await mkdir(dirname(layout.candidateEntrypoint), { recursive: true });
    await symlink(
      fileURLToPath(import.meta.resolve('@maka/runtime-host/execution-candidate-main')),
      layout.candidateEntrypoint,
    );
    await claimRuntimeHostManagedDeployment(capability, config);
    const modulePath = layout.cliPath;
    await mkdir(dirname(modulePath), { recursive: true });
    await writeFile(
      modulePath,
      `
      import { activateRuntimeHostManagedDeploymentWithReconciliation } from ${JSON.stringify(new URL('../runtime-host-activation-command.js', import.meta.url).href)};
      import { encodeRuntimeHostActivationFrame } from ${JSON.stringify(import.meta.resolve('@maka/runtime-host/operator'))};
      const result = await activateRuntimeHostManagedDeploymentWithReconciliation({ rootId: process.argv.at(-1) });
      process.stdout.write(encodeRuntimeHostActivationFrame(result));
    `,
    );
    if (interrupted) {
      const legacy = join(resolveRuntimeHostManagedDeploymentAuthorityRoot(), capability.rootId);
      const home = userInfo().homedir;
      const cache =
        process.platform === 'darwin'
          ? join(home, 'Library', 'Caches', 'Maka')
          : join(home, '.cache', 'maka');
      const durable = dirname(resolveRuntimeHostManagedDeploymentAuthorityRoot());
      const identity = await stat(capability.canonicalPath, { bigint: true });
      const bootstrap = createHash('sha256')
        .update(`${identity.dev}:${identity.ino}`)
        .digest('hex');
      t.after(async () => {
        await rm(join(cache, 'runtime-hosts', capability.rootId), { recursive: true, force: true });
        await rm(join(cache, 'runtime-hosts', 'artifact-writer-bootstrap', `${bootstrap}.lock`), {
          force: true,
        });
        await rm(join(durable, 'state-root-owners', `${capability.rootId}.lock`), { force: true });
      });
      await writeFile(join(legacy, 'runtime-host-deployment.json'), JSON.stringify(config));
      await rm(join(capability.canonicalPath, '.maka-host', 'state'), {
        recursive: true,
        force: true,
      });
      const markerPath = join(capability.canonicalPath, STORAGE_ROOT_MARKER_FILE);
      const marker = JSON.parse(await readFile(markerPath, 'utf8'));
      await writeFile(markerPath, JSON.stringify({ ...marker, schemaVersion: 1 }));
      const authorityModule = join(
        layout.packageRoot,
        'node_modules',
        '@maka',
        'storage',
        'dist',
        'root-authority.js',
      );
      await mkdir(dirname(authorityModule), { recursive: true });
      await writeFile(authorityModule, 'export const STORAGE_ROOT_MARKER_SCHEMA_VERSION = 1;');
      await assert.rejects(
        prepareRuntimeHostRoot(capability.canonicalPath),
        /cannot open the upgraded/,
      );
      assert.equal(JSON.parse(await readFile(markerPath, 'utf8')).schemaVersion, 1);
      await writeFile(authorityModule, 'export const STORAGE_ROOT_MARKER_SCHEMA_VERSION = 2;');
      const upgraded = await prepareRuntimeHostRoot(capability.canonicalPath, {
        prepareDeployment: async (current) => ({ ...current, configRevision: 2 }),
      });
      assert.equal(
        (await readRuntimeHostManagedDeploymentAuthorityRecord(upgraded))?.state,
        'transition',
      );
    }
    let first: Awaited<ReturnType<typeof connectRuntimeHostCliConnection>> | undefined;
    let second: typeof first;
    t.after(async () => {
      await second?.close();
      if (first) {
        const diagnostics = await first.connection.request('host.diagnostics.query', {});
        await first.close();
        try {
          process.kill(diagnostics.pid, 'SIGTERM');
        } catch {}
      }
      await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(join(resolveRuntimeHostManagedDeploymentAuthorityRoot(), capability.rootId), {
        recursive: true,
        force: true,
      });
    });
    first = await connectRuntimeHostCliConnection({ rootPath: capability.canonicalPath });
    second = await connectRuntimeHostCliConnection(
      { rootPath: capability.canonicalPath },
      {
        activateLocalManagedHost: async () =>
          assert.fail('a running managed Host must be joined directly'),
      },
    );
    assert.equal(first.connection.rootId, capability.rootId);
    assert.equal(second.connection.hostEpoch, first.connection.hostEpoch);
    const observation = await connectRuntimeHost({
      rootPath: capability.canonicalPath,
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    });
    assert.equal(observation.kind, 'connected');
    if (observation.kind !== 'connected') return;
    await observation.connection.close();
    const incompatible = {
      kind: 'incompatible' as const,
      registration: observation.registration,
      handshake: {
        kind: 'incompatible',
        hostEpoch: observation.registration.hostEpoch,
        protocolMin: 0,
        protocolMax: 0,
        compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH - 1,
        compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
        compositionRevision: 'legacy',
        state: 'ready',
        replacement: 'wait_for_idle_exit',
      } satisfies HostIncompatible,
    };
    // Managed on-demand registers as ephemeral too. Both cold activation and
    // an already-running conflict must read the actual managed authority, not
    // offer a local npm owner claim based on that process lifetime label.
    for (const cold of [true, false]) {
      let activations = 0;
      const dependencies = {
        connectOrSpawn: async () =>
          cold
            ? { kind: 'failed' as const, reason: 'managed_root_requires_operator' as const }
            : incompatible,
        activateLocalManagedHost: async () => {
          activations += 1;
        },
        connectActivatedHost: async () => incompatible,
        resolveInstallation: async () => assert.fail('managed Host is not a local npm owner'),
        restartDeployment: async () => assert.fail('managed Host must never be replaced here'),
      };
      await assert.rejects(
        connectRuntimeHostCliConnection({ rootPath: capability.canonicalPath }, dependencies),
        (error: unknown) => {
          assert.ok(error instanceof HostHandoffRequiredError);
          assert.equal(error.view.reason, 'operator_required');
          assert.deepEqual(error.view.actions, ['cancel', 'retry']);
          assert.equal(error.view.mayExitNaturally, false);
          return true;
        },
      );
      assert.equal(activations, cold ? 1 : 0);
      await assert.rejects(
        connectRuntimeHostCliConnection(
          {
            rootPath: capability.canonicalPath,
            handoffSurface: (submit) => ({
              update: (view) => submit(view.revision, 'cancel'),
              close() {},
            }),
          },
          dependencies,
        ),
        HostHandoffCancelledError,
      );
    }
    // Exercise the real operator subprocess failure contract, including nonzero exit.
    await writeFile(
      modulePath,
      `
      import { encodeRuntimeHostActivationFrame } from ${JSON.stringify(import.meta.resolve('@maka/runtime-host/operator'))};
      process.stdout.write(encodeRuntimeHostActivationFrame({schemaVersion: 1, kind: 'error', error: {code: 'activation_failed', message: 'Operator recovery is required'}}));
      process.exitCode = 1;
    `,
    );
    await assert.rejects(activateLocalManagedRuntimeHost({ rootPath: capability.canonicalPath }), {
      message: 'Operator recovery is required',
    });
    await writeFile(modulePath, `process.stdout.write('not an activation frame');`);
    await assert.rejects(
      activateLocalManagedRuntimeHost({ rootPath: capability.canonicalPath }),
      /invalid activation result/,
    );
    const controller = new AbortController();
    controller.abort(new Error('activation cancelled'));
    await assert.rejects(
      activateLocalManagedRuntimeHost({
        rootPath: capability.canonicalPath,
        signal: controller.signal,
      }),
      /activation cancelled/,
    );
  });
}
