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
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function fixture(t, nativeVersion = '1.2.3') {
  const root = await mkdtemp(join(tmpdir(), 'maka launcher '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = `${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`;
  const name = '@maka-agent/cli-' + target;
  const native = join(root, 'node_modules', name);
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(native, 'bin'), { recursive: true });
  const launcher = join(root, 'bin/maka.mjs');
  await copyFile(new URL('../bin/maka.mjs', import.meta.url), launcher);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@maka-agent/cli',
      version: '1.2.3',
      optionalDependencies: { [name]: '1.2.3' },
    }),
  );
  const executable = process.platform === 'win32' ? 'maka.exe' : 'maka';
  await writeFile(
    join(native, 'package.json'),
    JSON.stringify({
      name,
      version: nativeVersion,
      bin: { maka: 'bin/' + executable },
    }),
  );
  return { root, native, launcher, executable };
}

test('launcher preserves arguments, input, output and native exit status', {
  skip: process.platform === 'win32',
}, async (t) => {
  const f = await fixture(t);
  const binary = join(f.native, 'bin', f.executable);
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require('node:fs');
console.log(JSON.stringify({args:process.argv.slice(2), input:fs.readFileSync(0,'utf8')}));
console.error('native diagnostic');
process.exitCode = 23;
`,
  );
  await chmod(binary, 0o755);
  const args = ['code', 'space and 中文', '; echo never-executed', '--flag=value'];
  const result = spawnSync(process.execPath, [f.launcher, ...args], {
    input: 'input payload',
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args, input: 'input payload' });
  assert.equal(result.stderr.trim(), 'native diagnostic');
});

test('launcher refuses a mixed native package version and reports missing optional installs', async (t) => {
  const f = await fixture(t, '1.2.2');
  const run = () =>
    spawnSync(process.execPath, [f.launcher], { encoding: 'utf8', timeout: 10_000 });
  const mixed = run();
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /does not match this launcher/);
  await rm(f.native, { recursive: true });
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--include=optional @maka-agent\/cli@1\.2\.3/);
});
