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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkStagedWithBiome } from './biome-staged-check.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const biomePath = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'biome.cmd' : 'biome',
);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'maka-biome-staged-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(
    join(root, 'biome.json'),
    JSON.stringify({ formatter: { enabled: true }, linter: { enabled: false } }),
  );
  return root;
}

test('checks staged bytes when the working tree was formatted afterward', () => {
  const root = fixture();
  try {
    const path = join(root, 'example.js');
    writeFileSync(path, 'const value={answer:42};\n');
    execFileSync('git', ['add', 'example.js'], { cwd: root });
    writeFileSync(path, 'const value = { answer: 42 };\n');

    assert.equal(checkStagedWithBiome({ root, biomePath }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ignores unstaged formatting drift when staged bytes are formatted', () => {
  const root = fixture();
  try {
    const path = join(root, 'example.js');
    writeFileSync(path, 'const value = { answer: 42 };\n');
    execFileSync('git', ['add', 'example.js'], { cwd: root });
    writeFileSync(path, 'const value={answer:42};\n');

    assert.equal(checkStagedWithBiome({ root, biomePath }), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
