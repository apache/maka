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
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { requireComputerUseLabRoot } from './lab-root.mjs';

test('returns the configured Computer Use Lab root', () => {
  assert.equal(
    requireComputerUseLabRoot({ MAKA_CU_AX_MODEL_LAB_ROOT: '/tmp/codex-cua-lab' }),
    '/tmp/codex-cua-lab',
  );
});

test('rejects a missing Computer Use Lab root', () => {
  assert.throws(
    () => requireComputerUseLabRoot({}),
    new Error(
      'MAKA_CU_AX_MODEL_LAB_ROOT is required: point it at a local checkout of the Codex CUA Lab fixture',
    ),
  );
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
