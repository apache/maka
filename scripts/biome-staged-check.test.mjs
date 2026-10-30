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

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'maka-biome-staged-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(
    join(root, 'biome.json'),
    JSON.stringify({
      files: { maxSize: 4 * 1024 * 1024 },
      formatter: { enabled: true },
      linter: { enabled: false },
      markdown: { formatter: { enabled: false } },
    }),
  );
  return {
    write(name, contents) {
      writeFileSync(join(root, name), contents);
    },
    stage(name, contents) {
      writeFileSync(join(root, name), contents);
      execFileSync('git', ['add', name], { cwd: root });
    },
    check() {
      return checkStagedWithBiome({ root, biomePath });
    },
  };
}

test('the staged version determines formatting regardless of working-tree edits', (t) => {
  const repo = fixture(t);
  repo.stage('example.js', 'const value={answer:42};\n');
  repo.write('example.js', 'const value = { answer: 42 };\n');
  assert.equal(repo.check(), false);
  repo.stage('example.js', 'const value = { answer: 42 };\n');
  repo.write('example.js', 'const value={answer:42};\n');
  assert.equal(repo.check(), true);
});

test('UTF-8 source containing NUL still receives the formatting check', (t) => {
  const repo = fixture(t);
  repo.stage('example.js', Buffer.from('const value={answer:"\0"};\n'));
  assert.equal(repo.check(), false);
});

test('source beyond the default process buffer can pass and fail formatting', (t) => {
  const repo = fixture(t);
  const padding = `// ${'a'.repeat(2 * 1024 * 1024)}\n`;
  repo.stage('large.js', padding + 'const value={answer:42};\n');
  assert.equal(repo.check(), false);
  repo.stage('large.js', padding + 'const value = { answer: 42 };\n');
  assert.equal(repo.check(), true);
});

test('binary assets pass without being decoded as source', (t) => {
  const repo = fixture(t);
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  bytes.write('\x89PNG\r\n\x1a\n', 'latin1');
  bytes.fill(0xff, 64, 96);
  repo.stage('large.png', bytes);
  assert.equal(repo.check(), true);
});

test('files with a disabled formatter preserve their authored bytes', (t) => {
  const repo = fixture(t);
  repo.stage('notes.md', '# Notes\n\n*   loosely   formatted\n');
  assert.equal(repo.check(), true);
});
