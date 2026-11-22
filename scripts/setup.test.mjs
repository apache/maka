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
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setup } from './setup.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'maka-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'patches'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: [] }));
  await writeFile(
    join(root, 'package-lock.json'),
    JSON.stringify({
      packages: { 'node_modules/build-tool': { version: '1.0.0' } },
    }),
  );
  await writeFile(join(root, 'scripts/apply-dependency-patches.mjs'), 'apply reviewed patches');
  await writeFile(join(root, 'patches/build-tool.patch'), 'original patch');
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return root;
}

test('setup preserves a current install and reinstalls changed inputs', async (t) => {
  const root = await fixture(t);
  const invocations = [];
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    invocations.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(async () => {
      await mkdir(join(root, 'node_modules/build-tool'), { recursive: true });
      await writeFile(join(root, 'node_modules/build-tool/package.json'), '{"version":"1.0.0"}');
      await writeFile(join(root, 'node_modules/.package-lock.json'), '{"installed":true}');
      child.emit('exit', 0, null);
    });
    return child;
  });
  syncBuiltinESMExports();
  const env = { SETUP_FIXTURE: 'unchanged environment' };
  await setup(root, env);
  const receipt = join(root, 'node_modules/.maka-setup.json');
  const receiptBytes = await readFile(receipt);
  const installed = join(root, 'node_modules/.package-lock.json');
  const timestamp = (await stat(installed, { bigint: true })).mtimeNs;
  await setup(root, env);
  assert.equal(invocations.length, 1);
  assert.deepEqual(await readFile(receipt), receiptBytes);
  assert.equal((await stat(installed, { bigint: true })).mtimeNs, timestamp);
  assert.equal(invocations[0].command, 'npm');
  assert.deepEqual(invocations[0].args, [
    'ci',
    '--include=dev',
    '--include=optional',
    '--no-audit',
    '--no-fund',
  ]);
  assert.equal(invocations[0].options.cwd, root);
  assert.equal(invocations[0].options.env, env);

  await writeFile(join(root, 'patches/build-tool.patch'), 'updated patch');
  await setup(root, env);
  assert.equal(invocations.length, 2);
  assert.notDeepEqual(await readFile(receipt), receiptBytes);
});

test('an unsuccessful install cannot create a success receipt', async (t) => {
  const root = await fixture(t);
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 17, null));
    return child;
  });
  syncBuiltinESMExports();
  await assert.rejects(setup(root, {}), /npm ci failed: 17/);
  await assert.rejects(readFile(join(root, 'node_modules/.maka-setup.json')), { code: 'ENOENT' });
});
