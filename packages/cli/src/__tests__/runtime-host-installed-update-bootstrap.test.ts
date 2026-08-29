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
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runRuntimeHostInstalledUpdateBootstrap } from '../runtime-host-installed-update-bootstrap.js';

const INTEGRITY = `sha512-${Buffer.alloc(64, 9).toString('base64')}`;

test('launches update coordination from a copy outside the mutable npm-global package', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-update-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'global', 'node_modules', 'maka-agent');
  const cliPath = join(packageRoot, 'dist', 'cli.js');
  const archivePath = join(root, 'target.tgz');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await Promise.all([
    writeFile(cliPath, '#!/usr/bin/env node\n'),
    writeFile(archivePath, 'archive'),
  ]);
  let launched = false;

  const exitCode = await runRuntimeHostInstalledUpdateBootstrap(
    {
      rootPath: join(root, 'state'),
      selector: { kind: 'channel', channel: 'next' },
      allowInterruptActiveTasks: true,
    },
    {
      resolveInstallation: async () => ({
        owner: { kind: 'cli', installationId: 'npm-global:slot' },
        observedRelease: { version: '1.0.0', packageRoot, cliPath },
      }),
      resolveCandidate: async () => ({
        kind: 'npm_registry',
        version: '2.0.0',
        integrity: INTEGRITY,
        compatibility: 2,
      }),
      withArchive: async (_target, use) => use(archivePath),
      async runCoordinator(input) {
        launched = true;
        assert.notEqual(input.coordinatorCliPath, cliPath);
        assert.equal((await stat(input.coordinatorCliPath)).isFile(), true);
        assert.equal(input.archivePath, archivePath);
        assert.equal(input.currentVersion, '1.0.0');
        assert.equal(input.targetVersion, '2.0.0');
        assert.equal(input.allowInterruptActiveTasks, true);
        return 7;
      },
    },
  );

  assert.equal(exitCode, 7);
  assert.equal(launched, true);
});

test('rejects unsupported downgrades before package acquisition', async () => {
  let acquired = false;
  await assert.rejects(
    runRuntimeHostInstalledUpdateBootstrap(
      {
        rootPath: '/state',
        selector: { kind: 'exact', version: '1.0.0' },
        allowInterruptActiveTasks: false,
      },
      {
        resolveInstallation: async () => ({
          owner: { kind: 'cli', installationId: 'npm-global:slot' },
          observedRelease: {
            version: '2.0.0',
            packageRoot: '/global/maka-agent',
            cliPath: '/global/maka-agent/dist/cli.js',
          },
        }),
        resolveCandidate: async () => ({
          kind: 'npm_registry',
          version: '1.0.0',
          integrity: INTEGRITY,
        }),
        withArchive: async () => {
          acquired = true;
          throw new Error('must not acquire');
        },
      },
    ),
    /Downgrading Maka/u,
  );
  assert.equal(acquired, false);
});
