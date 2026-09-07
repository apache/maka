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
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveStorageRoot } from '@maka/storage/root-authority';
import {
  claimRuntimeHostManagedDeployment,
  resolveRuntimeHostManagedDeploymentConfigPath,
  resolveRuntimeHostNpmDeploymentLayout,
  type RuntimeHostManagedDeploymentConfig,
} from '@maka/runtime-host/operator';
import { activateLocalManagedRuntimeHost } from '../runtime-host-local-managed-activation.js';
import { connectRuntimeHostCliConnection } from '../runtime-host-cli-context.js';

for (const legacy of [false, true]) {
  test(`local CLI cold-starts through the installed ${legacy ? 'legacy' : 'Node'} operator`, {
    skip: process.platform === 'win32',
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
    const modulePath = join(config.deploymentRoot, legacy ? 'legacy-entry.mjs' : 'operator.mjs');
    await writeFile(
      modulePath,
      `
      import { activateRuntimeHostManagedDeployment } from ${JSON.stringify(import.meta.resolve('@maka/runtime-host/client'))};
      import { encodeRuntimeHostActivationFrame } from ${JSON.stringify(import.meta.resolve('@maka/runtime-host/operator'))};
      const result = await activateRuntimeHostManagedDeployment({ rootId: process.argv.at(-1) });
      process.stdout.write(encodeRuntimeHostActivationFrame(result));
    `,
    );
    if (legacy) {
      const launcher = join(config.deploymentRoot, 'operator');
      await writeFile(
        launcher,
        '#!/bin/sh\nexec ' + "'" + process.execPath + "' '" + modulePath + '\' "$@"\n',
      );
      await chmod(launcher, 0o700);
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
      await rm(base, { recursive: true, force: true });
      await rm(dirname(resolveRuntimeHostManagedDeploymentConfigPath(capability.rootId)), {
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
