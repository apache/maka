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

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = new URL('./check-allow-scripts.mjs', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

function writeFixture({ allowScripts, lockPackages }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'allow-scripts-'));
  const packageJsonPath = path.join(dir, 'package.json');
  const lockfilePath = path.join(dir, 'package-lock.json');
  writeFileSync(packageJsonPath, JSON.stringify({ allowScripts }));
  writeFileSync(lockfilePath, JSON.stringify({ packages: lockPackages }));
  return { packageJsonPath, lockfilePath };
}

async function runCheck(fixture) {
  try {
    const { stdout } = await run(process.execPath, [
      script,
      '--package',
      fixture.packageJsonPath,
      '--lock',
      fixture.lockfilePath,
    ]);
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code, stdout: '', stderr: String(error.stderr) };
  }
}

const BASE_LOCK = {
  '': { name: 'maka', version: '0.2.0', hasInstallScript: true },
  'node_modules/esbuild': { version: '0.28.2', hasInstallScript: true },
  'node_modules/fsevents': {
    version: '2.3.3',
    hasInstallScript: true,
    optional: true,
    os: ['darwin'],
  },
  'node_modules/node-pty': { version: '1.2.0-beta.15', hasInstallScript: true },
};

test('a synced map passes', async () => {
  const fixture = writeFixture({
    allowScripts: {
      'esbuild@0.28.2': true,
      'fsevents@2.3.3': true,
      'node-pty@1.2.0-beta.15': true,
    },
    lockPackages: BASE_LOCK,
  });
  const result = await runCheck(fixture);
  if (result.code !== 0) throw new Error(`expected exit 0, got ${result.code}: ${result.stderr}`);
});

test('an unkeyed optional darwin-only package fails (the fsevents case)', async () => {
  const fixture = writeFixture({
    allowScripts: { 'esbuild@0.28.2': true, 'node-pty@1.2.0-beta.15': true },
    lockPackages: BASE_LOCK,
  });
  const result = await runCheck(fixture);
  if (result.code !== 1) throw new Error(`expected exit 1, got ${result.code}`);
  if (!result.stderr.includes('fsevents@2.3.3 (optional, os: darwin)'))
    throw new Error(`missing fsevents note: ${result.stderr}`);
});

test('a map key trailing a lockfile bump fails (the stale-version case)', async () => {
  const fixture = writeFixture({
    allowScripts: {
      'esbuild@0.27.7': true,
      'fsevents@2.3.3': true,
      'node-pty@1.2.0-beta.15': true,
    },
    lockPackages: BASE_LOCK,
  });
  const result = await runCheck(fixture);
  if (result.code !== 1) throw new Error(`expected exit 1, got ${result.code}`);
  if (!result.stderr.includes('stale: "esbuild@0.27.7"'))
    throw new Error(`missing stale entry: ${result.stderr}`);
  if (!result.stderr.includes('missing: esbuild@0.28.2'))
    throw new Error(`missing missing-entry: ${result.stderr}`);
});

test('a non-boolean value fails', async () => {
  const fixture = writeFixture({
    allowScripts: {
      'esbuild@0.28.2': 'yes',
      'fsevents@2.3.3': true,
      'node-pty@1.2.0-beta.15': true,
    },
    lockPackages: BASE_LOCK,
  });
  const result = await runCheck(fixture);
  if (result.code !== 1) throw new Error(`expected exit 1, got ${result.code}`);
  if (!result.stderr.includes('"esbuild@0.28.2" maps to "yes"'))
    throw new Error(`missing invalid value: ${result.stderr}`);
});
