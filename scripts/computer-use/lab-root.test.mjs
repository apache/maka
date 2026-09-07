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
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { requireComputerUseLabRoot } from './lab-root.mjs';

test('Computer Use CLI advertises only the supported evidence commands', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../computer-use.mjs', import.meta.url)), '--help'],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `Usage: node scripts/computer-use.mjs <command> [options]\n\nCommands:\n  prepare\n  real-ax\n  real-model\n  restart-soak\n  provider-matrix\n`,
  );
});

test('rejects missing and invalid Computer Use Lab roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-cu-lab-root-invalid-'));
  try {
    assert.throws(
      () => requireComputerUseLabRoot({}),
      new Error(
        'MAKA_CU_AX_MODEL_LAB_ROOT is required: point it at a local checkout of the Codex CUA Lab fixture',
      ),
    );
    assert.throws(
      () => requireComputerUseLabRoot({ MAKA_CU_AX_MODEL_LAB_ROOT: '   ' }),
      /MAKA_CU_AX_MODEL_LAB_ROOT is required/,
    );
    assert.throws(
      () => requireComputerUseLabRoot({ MAKA_CU_AX_MODEL_LAB_ROOT: 'relative/lab' }),
      /MAKA_CU_AX_MODEL_LAB_ROOT must be an absolute path/,
    );
    assert.throws(
      () => requireComputerUseLabRoot({ MAKA_CU_AX_MODEL_LAB_ROOT: join(root, 'missing') }),
      /MAKA_CU_AX_MODEL_LAB_ROOT must point to an existing directory/,
    );
    assert.throws(
      () => requireComputerUseLabRoot({ MAKA_CU_AX_MODEL_LAB_ROOT: root }),
      /MAKA_CU_AX_MODEL_LAB_ROOT must contain an executable test-app\/launch\.sh/,
    );
    const nonExecutableRoot = join(root, 'non-executable');
    const launcherPath = join(nonExecutableRoot, 'test-app', 'launch.sh');
    await mkdir(join(nonExecutableRoot, 'test-app'), { recursive: true });
    await writeFile(launcherPath, '#!/usr/bin/env bash\n');
    await chmod(launcherPath, 0o644);
    assert.throws(
      () => requireComputerUseLabRoot({ MAKA_CU_AX_MODEL_LAB_ROOT: nonExecutableRoot }),
      /MAKA_CU_AX_MODEL_LAB_ROOT must contain an executable test-app\/launch\.sh/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('canonicalizes a valid Computer Use Lab root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-cu-lab-root-valid-'));
  try {
    const fixtureRoot = join(root, 'fixture');
    const linkedRoot = join(root, 'fixture-link');
    const launcherPath = join(fixtureRoot, 'test-app', 'launch.sh');
    await mkdir(join(fixtureRoot, 'test-app'), { recursive: true });
    await writeFile(launcherPath, '#!/usr/bin/env bash\n');
    await chmod(launcherPath, 0o755);
    await symlink(fixtureRoot, linkedRoot);

    assert.equal(
      requireComputerUseLabRoot({ MAKA_CU_AX_MODEL_LAB_ROOT: linkedRoot }),
      await realpath(fixtureRoot),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Lab-backed entry points require the configured root', async () => {
  const entryPoints = [
    'process-restart-harness.mjs',
    'process-restart-launcher.mjs',
    'real-ax-harness.mjs',
    'real-ax-launcher.mjs',
  ];

  for (const entryPoint of entryPoints) {
    const source = await readFile(new URL(entryPoint, import.meta.url), 'utf8');
    assert.match(
      source,
      /const labRoot = requireComputerUseLabRoot\(\);/,
      `${entryPoint} must require the configured Lab root`,
    );
    assert.doesNotMatch(
      source,
      /codex-computer-use-lab/i,
      `${entryPoint} must not embed a contributor-specific Lab checkout`,
    );
  }
});
