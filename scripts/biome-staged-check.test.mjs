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

test('skips a staged binary larger than the default child-process buffer', () => {
  const root = fixture();
  try {
    const binary = Buffer.alloc(2 * 1024 * 1024);
    binary.write('\x89PNG\r\n\x1a\n', 'latin1');
    binary.fill(0xff, 64, 96);
    writeFileSync(join(root, 'large.png'), binary);
    execFileSync('git', ['add', 'large.png'], { cwd: root });

    assert.equal(checkStagedWithBiome({ root, biomePath }), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checks a staged source file that holds a NUL byte', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'valid.js'), Buffer.from('const value={answer:"\0"};\n', 'utf8'));
    execFileSync('git', ['add', 'valid.js'], { cwd: root });

    assert.equal(checkStagedWithBiome({ root, biomePath }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checks a staged source file larger than the default child-process buffer', () => {
  const root = fixture();
  try {
    const padding = `// ${'a'.repeat(2 * 1024 * 1024)}\n`;
    writeFileSync(join(root, 'large.js'), `${padding}const value={answer:42};\n`);
    execFileSync('git', ['add', 'large.js'], { cwd: root });

    assert.equal(checkStagedWithBiome({ root, biomePath }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a staged source file over the ceiling instead of skipping it', () => {
  const root = fixture();
  try {
    // Formatted, so only the ceiling can reject it.
    writeFileSync(join(root, 'huge.js'), `// ${'a'.repeat(2048)}\nconst value = { answer: 42 };\n`);
    execFileSync('git', ['add', 'huge.js'], { cwd: root });

    assert.equal(checkStagedWithBiome({ root, biomePath, maxBytes: 1024 }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skips a staged binary over the ceiling', () => {
  const root = fixture();
  try {
    const binary = Buffer.alloc(2048);
    binary.write('\x89PNG\r\n\x1a\n', 'latin1');
    writeFileSync(join(root, 'huge.png'), binary);
    execFileSync('git', ['add', 'huge.png'], { cwd: root });

    assert.equal(checkStagedWithBiome({ root, biomePath, maxBytes: 1024 }), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skips a small staged binary Biome cannot decode', () => {
  const root = fixture();
  try {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xff]);
    writeFileSync(join(root, 'icon.png'), binary);
    execFileSync('git', ['add', 'icon.png'], { cwd: root });

    assert.equal(checkStagedWithBiome({ root, biomePath }), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('passes a language Biome parses but does not format', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'notes.md'), '# Notes\n\n*   loosely   formatted\n');
    execFileSync('git', ['add', 'notes.md'], { cwd: root });

    assert.equal(checkStagedWithBiome({ root, biomePath }), true);
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
