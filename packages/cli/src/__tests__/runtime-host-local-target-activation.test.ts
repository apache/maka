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
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  launchRuntimeHostTargetActivator,
  RuntimeHostTargetActivationError,
} from '../runtime-host-local-target-activation.js';

test('a parent deadline terminates and waits for a target activator with a hung settlement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-target-activator-'));
  const cliPath = join(directory, 'hung-activator.mjs');
  const readEnteredPath = join(directory, 'read-entered');
  const lease = await open(join(directory, 'authority-lease'), 'w');
  const activatorModuleUrl = new URL(
    '../runtime-host-installed-update-activator.js',
    import.meta.url,
  );
  await writeFile(
    cliPath,
    [
      `import { runRuntimeHostInstalledUpdateActivator } from ${JSON.stringify(activatorModuleUrl.href)};`,
      "import { writeFileSync } from 'node:fs';",
      'void runRuntimeHostInstalledUpdateActivator(',
      '  {',
      `    rootPath: ${JSON.stringify(directory)},`,
      `    expectedRootId: ${JSON.stringify('a'.repeat(64))},`,
      "    generation: 'target-generation',",
      `    candidateEntrypoint: ${JSON.stringify(join(directory, 'candidate.js'))},`,
      '    awaitCoordinatorCommit: true,',
      "    expectedOwnerInstallationId: 'npm-global:slot',",
      "    targetVersion: '2.0.0',",
      `    targetIntegrity: ${JSON.stringify(`sha512-${Buffer.alloc(64, 4).toString('base64')}`)},`,
      '  },',
      '  {',
      '    connectOrSpawn: async () => ({',
      "      kind: 'connected',",
      '      registration: {',
      `        rootId: ${JSON.stringify('a'.repeat(64))},`,
      "        generation: 'target-generation',",
      '        pid: process.pid,',
      '      },',
      "      connection: { hostEpoch: 'target-host', close: async () => {} },",
      '    }),',
      '    createLaunchBarrier: () => ({',
      "      connect: async () => { throw new Error('unexpected connect'); },",
      '      pause: () => {},',
      '      retireExcept: async () => {},',
      '      resume: () => {},',
      '      release: () => {},',
      '    }),',
      '    readRecord: () => {',
      `      writeFileSync(${JSON.stringify(readEnteredPath)}, 'entered');`,
      '      return new Promise(() => { setInterval(() => {}, 1_000); });',
      '    },',
      '  },',
      ');',
    ].join('\n'),
  );
  try {
    const activation = await launchRuntimeHostTargetActivator(
      {
        rootPath: directory,
        rootId: 'a'.repeat(64),
        staged: {
          version: '2.0.0',
          root: directory,
          packageRoot: directory,
          cliPath,
          candidateEntrypoint: join(directory, 'candidate.js'),
          launchGeneration: 'target-generation',
          cleanup: async () => {},
          rollback: async () => {},
        },
        ownerInstallationId: 'npm-global:slot',
        target: {
          kind: 'npm_registry',
          version: '2.0.0',
          integrity: `sha512-${Buffer.alloc(64, 4).toString('base64')}`,
        },
        inheritableAuthorityLeaseFd: lease.fd,
      },
      // 50 ms also covered child spawn and ESM load, so CI could SIGKILL before
      // read-entered was written (#4466). Two seconds fits startup; the hung
      // read still trips the settlement deadline.
      { settlementTimeoutMs: 2_000 },
    );
    assert.equal(activation.kind, 'ready');
    await assert.rejects(
      activation.settle(),
      (error: unknown) =>
        error instanceof RuntimeHostTargetActivationError &&
        error.code === 'recovery_required' &&
        /settlement deadline/u.test(error.message),
    );
    assert.equal(await readFile(readEnteredPath, 'utf8'), 'entered');
  } finally {
    await lease.close();
    await rm(directory, { recursive: true, force: true });
  }
});
