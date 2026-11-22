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
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const inventory = 'crate\tApache-2.0\tMIT\na@1\tX\t\nb@1\t\tX\nc@1\t\tX\n';

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
  const preload = join(root, 'checker.mjs');
  await writeFile(
    preload,
    `import childProcess from 'node:child_process';
import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { parseArgs } from 'node:util';
childProcess.execFileSync = (command, args) => {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    locked: { type: 'boolean' }, config: { type: 'string' },
    'manifest-path': { type: 'string' }, 'exclude-dev': { type: 'boolean' },
    format: { type: 'string' },
  }});
  assert.equal(command, 'cargo-deny', 'invoke the policy checker without a Cargo wrapper');
  assert.equal(values.locked, true);
  assert.equal(values.config, 'deny.toml');
  let inventory;
  if (positionals[1] === 'check') {
    assert.deepEqual(positionals, ['deny', 'check', 'licenses']);
  } else {
    assert.deepEqual(positionals, ['deny', 'list']);
    assert.equal(values.format, 'tsv');
    assert.equal(values['exclude-dev'], true);
    const inventories = {
      'products/maka/cli/Cargo.toml': 'crate\\tMIT\\nb@1\\tX\\nc@1\\tX\\n',
      'products/maka/desktop-shell/Cargo.toml': 'crate\\tApache-2.0\\tMIT\\na@1\\tX\\t\\nb@1\\t\\tX\\n',
    };
    assert.ok(Object.hasOwn(inventories, values['manifest-path']), 'unexpected product manifest');
    inventory = inventories[values['manifest-path']];
  }
  if (positionals.includes(process.env.CHECKER_FAILURE)) throw new Error('fixture checker rejection');
  return inventory;
};
syncBuiltinESMExports();
`,
  );
  return {
    output,
    run(mode, failure) {
      // Exercise the public entrypoint, replacing only the external checker.
      return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, entry, mode], {
        encoding: 'utf8',
        env: { ...process.env, CHECKER_FAILURE: failure ?? '' },
      });
    },
  };
}

test('native inventory generation merges both products and passes the resulting check', async (t) => {
  const repo = await fixture(t, 'stale inventory\n');
  for (const mode of ['generate', 'check']) {
    const result = await repo.run(mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(repo.output, 'utf8'), inventory);
  }
});

test('checker rejection fails generation without changing the inventory', async (t) => {
  const repo = await fixture(t);
  for (const failure of ['check', 'list']) {
    const result = await repo.run('generate', failure);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fixture checker rejection/);
    assert.equal(await readFile(repo.output, 'utf8'), inventory);
  }
});

test('a successful checker does not allow a stale native dependency inventory', async (t) => {
  const repo = await fixture(t, 'stale inventory\n');
  const result = await repo.run('check');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Rust dependency inventory is stale/);
  assert.equal(await readFile(repo.output, 'utf8'), 'stale inventory\n');
});
