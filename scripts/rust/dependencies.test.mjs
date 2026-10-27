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
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const inventory = 'crate\tApache-2.0\tMIT\na@1\tX\t\nb@1\t\tX\n';
const policy = ['deny', '--locked', '--config', 'deny.toml'];

async function fixture(t, existing = inventory) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-dependencies-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts/rust');
  const product = join(root, 'products/maka/cli');
  await mkdir(scripts, { recursive: true });
  await mkdir(product, { recursive: true });
  const entry = join(scripts, 'dependencies.mjs');
  await copyFile(new URL('./dependencies.mjs', import.meta.url), entry);
  const output = join(product, 'DEPENDENCIES.rust.tsv');
  await writeFile(output, existing);
  const calls = join(root, 'calls.jsonl');
  const preload = join(root, 'checker.mjs');
  await writeFile(
    preload,
    `import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
childProcess.execFileSync = (command, args, options) => {
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ command, args, options }) + '\\n');
  if (args.includes(process.env.CHECKER_FAILURE)) throw new Error('fixture checker rejection');
  if (args.includes('check')) return;
  return args.includes('products/maka/cli/Cargo.toml')
    ? 'crate\\tMIT\\nb@1\\tX\\n'
    : ${JSON.stringify(inventory)};
};
syncBuiltinESMExports();
`,
  );
  return {
    root,
    output,
    async run(mode, failure) {
      await writeFile(calls, '');
      // Exercise the public entrypoint, replacing only the external checker.
      const result = spawnSync(
        process.execPath,
        ['--import', pathToFileURL(preload).href, entry, mode],
        {
          encoding: 'utf8',
          env: { ...process.env, CHECKER_FAILURE: failure ?? '' },
        },
      );
      const invocations = (await readFile(calls, 'utf8'))
        .trimEnd()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      return { ...result, invocations };
    },
  };
}

test('license checks and native inventories invoke the checker directly with the full policy', async (t) => {
  const repo = await fixture(t);
  const expected = [
    {
      command: 'cargo-deny',
      args: [...policy, 'check', 'licenses'],
      options: { cwd: `${repo.root}${sep}`, stdio: 'inherit' },
    },
    ...['cli', 'desktop-shell'].map((crate) => ({
      command: 'cargo-deny',
      args: [
        ...policy,
        '--manifest-path',
        `products/maka/${crate}/Cargo.toml`,
        '--exclude-dev',
        'list',
        '--format',
        'tsv',
      ],
      options: { cwd: `${repo.root}${sep}`, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    })),
  ];
  for (const mode of ['check', 'generate']) {
    const result = await repo.run(mode);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.invocations, expected);
    assert.equal(await readFile(repo.output, 'utf8'), inventory);
  }
});

test('checker rejection stops before later inventory commands and never changes the inventory', async (t) => {
  const repo = await fixture(t);
  for (const [failure, count] of [
    ['check', 1],
    ['list', 2],
  ]) {
    const result = await repo.run('generate', failure);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fixture checker rejection/);
    assert.equal(result.invocations.length, count);
    assert.equal(await readFile(repo.output, 'utf8'), inventory);
  }
});

test('a successful checker does not allow a stale native dependency inventory', async (t) => {
  const repo = await fixture(t, 'stale inventory\n');
  const result = await repo.run('check');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Rust dependency inventory is stale/);
  assert.equal(result.invocations.length, 3);
  assert.equal(await readFile(repo.output, 'utf8'), 'stale inventory\n');
});
