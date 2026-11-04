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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compileTemplate } from './build.mjs';
import { verifyRuntime, runtimeDirectory, runtimeCargoArgs } from './runtime.mjs';
import { cargoBuild } from '../rust/cargo.mjs';
import { digest } from '../rust/v8-cache.mjs';

const target = 'aarch64-apple-darwin';
const version = '2.9.6';
function machO(suffix = '') {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf);
  header.writeUInt32LE(0x0100000c, 4);
  return Buffer.concat([header, Buffer.from(suffix)]);
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'maka-denort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'denort');
  await writeFile(binary, machO());
  return {
    directory,
    runtime: { binary, receipt: { source: { version }, target, sha256: await digest(binary) } },
  };
}

test('release rejects missing, wrong-version, wrong-target and changed templates', async (t) => {
  const { runtime } = await fixture(t);
  await verifyRuntime(runtime, target, version);
  await assert.rejects(verifyRuntime(undefined, target, version), /requires a controlled/);
  await assert.rejects(verifyRuntime(runtime, target, '2.0.0'), /version mismatch/);
  await assert.rejects(
    verifyRuntime(runtime, 'x86_64-unknown-linux-gnu', version),
    /receipt target/,
  );
  await assert.rejects(
    verifyRuntime(
      { ...runtime, receipt: { ...runtime.receipt, target: 'x86_64-unknown-linux-gnu' } },
      'x86_64-unknown-linux-gnu',
      version,
    ),
    /binary target mismatch/,
  );
  await writeFile(runtime.binary, machO('changed'));
  await assert.rejects(verifyRuntime(runtime, target, version), /SHA-256 mismatch/);
  await rm(runtime.binary);
  await assert.rejects(verifyRuntime(runtime, target, version), { code: 'ENOENT' });
});

test('compilation consumes the controlled bytes each time and records the worker chain', async (t) => {
  const { directory, runtime } = await fixture(t);
  const deno = join(directory, 'compiler.cjs');
  const entry = join(directory, 'bundle.mjs');
  const binary = join(directory, 'worker');
  await writeFile(entry, 'worker JS');
  await writeFile(
    deno,
    `const fs = require('node:fs');
const output = process.argv[process.argv.indexOf('--output') + 1];
fs.writeFileSync(output, process.env.DENORT_BIN ? Buffer.concat([fs.readFileSync(process.env.DENORT_BIN), fs.readFileSync(process.argv.at(-1))]) : 'official');`,
  );
  const options = { directory, deno, entry, binary, target, version, release: true, runtime };
  await assert.rejects(
    compileTemplate({ ...options, runtime: undefined }),
    /requires a controlled/,
  );
  await assert.rejects(readFile(binary), { code: 'ENOENT' });
  await compileTemplate(options);
  const first = JSON.parse(await readFile(join(directory, 'worker-receipt.json')));
  assert.equal(first.worker, await digest(binary));
  assert.equal(first.bundle, await digest(entry));
  assert.deepEqual(first.runtime, runtime.receipt);
  await writeFile(runtime.binary, machO('replacement at same path'));
  runtime.receipt.sha256 = await digest(runtime.binary);
  await compileTemplate(options);
  const second = JSON.parse(await readFile(join(directory, 'worker-receipt.json')));
  assert.notEqual(second.worker, first.worker);
  assert.notEqual(second.runtime.sha256, first.runtime.sha256);
  const ambient = process.env.DENORT_BIN;
  process.env.DENORT_BIN = join(directory, 'missing');
  try {
    await compileTemplate({ ...options, release: false });
    assert.equal(await readFile(binary, 'utf8'), 'official');
  } finally {
    if (ambient === undefined) delete process.env.DENORT_BIN;
    else process.env.DENORT_BIN = ambient;
  }
});

test('runtime cache is independent of Cargo target and the selected Cargo reports its executable', async (t) => {
  const { directory } = await fixture(t);
  assert.equal(
    runtimeDirectory({ XDG_CACHE_HOME: directory, CARGO_TARGET_DIR: '/discardable-target' }),
    join(directory, 'maka/oar-runtime'),
  );
  const script = join(directory, 'cargo.cjs');
  const reported = join(directory, 'actual-artifacts/denort');
  await writeFile(
    script,
    `console.log(JSON.stringify(${JSON.stringify({ reason: 'compiler-artifact', target: { name: 'denort', kind: ['bin'] }, executable: reported })}));`,
  );
  const result = await cargoBuild([script], {
    command: process.execPath,
    cwd: directory,
    env: process.env,
  });
  assert.equal(result.code, 0);
  assert.equal(result.executables.get('denort').path, reported);
});

test('controlled Linux denort uses the existing zigbuild glibc floor', () => {
  for (const target of ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu']) {
    assert.deepEqual(runtimeCargoArgs(target), [
      'zigbuild',
      '--locked',
      '--release',
      '-p',
      'denort',
      '--bin',
      'denort',
      '--target',
      `${target}.2.28`,
    ]);
  }
  for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc']) {
    assert.deepEqual(runtimeCargoArgs(target), [
      'build',
      '--locked',
      '--release',
      '-p',
      'denort',
      '--bin',
      'denort',
      '--target',
      target,
    ]);
  }
  assert.throws(() => runtimeCargoArgs('x86_64-unknown-linux-musl'), /GNU target/);
});
