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
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runCli } from './run-cli.mjs';

const launcher = fileURLToPath(new URL('./run-cli.mjs', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));

test('development builds select capabilities once for the CLI and worker, then run the Cargo artifact', async (t) => {
  const invocations = [];
  const executable = join(tmpdir(), 'maka artifacts', 'maka');
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    invocations.push({ command, args, options });
    const child = new EventEmitter();
    if (command === 'cargo') child.stdout = new PassThrough();
    queueMicrotask(() => {
      if (child.stdout) {
        child.stdout.end(
          JSON.stringify({
            reason: 'compiler-artifact',
            target: { name: 'maka', kind: ['bin'] },
            executable,
          }) + '\n',
        );
      }
      child.emit('exit', 0, null);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (const [mode, platform, osRelease, bridge] of [
    [undefined, 'linux', '6.8.0-generic', false],
    [undefined, 'linux', '6.6.87.2-microsoft-standard-WSL2', true],
    ['auto', 'linux', '4.4.0-Microsoft', true],
    ['auto', 'darwin', 'Microsoft', false],
    ['auto', 'win32', 'Microsoft', false],
    ['native', 'linux', '6.6.87.2-microsoft-standard-WSL2', false],
    ['bridge', 'linux', '6.8.0-generic', true],
  ]) {
    invocations.length = 0;
    const env = mode === undefined ? {} : { MAKA_CUA_BUILD_MODE: mode };
    assert.deepEqual(
      await runCli(['code', '--log', 'a b.sqlite'], {
        env,
        platform,
        osRelease,
        repositoryRoot: '/source checkout',
      }),
      { code: 0, signal: null },
    );
    assert.deepEqual(invocations, [
      {
        command: 'cargo',
        args: [
          'build',
          '--locked',
          '-p',
          'maka-cli',
          '-p',
          'maka-python-runtime',
          ...(bridge ? ['--no-default-features'] : []),
          '--message-format=json',
        ],
        options: {
          cwd: '/source checkout',
          env,
          stdio: ['inherit', 'pipe', 'inherit'],
          windowsHide: true,
        },
      },
      {
        command: executable,
        args: ['code', '--log', 'a b.sqlite'],
        options: { cwd: '/source checkout', env, stdio: 'inherit', windowsHide: true },
      },
    ]);
  }
});

test('desktop development stages the current macOS shell before starting Maka', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-run-desktop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'assets'));
  await copyFile(
    new URL('../../assets/logo.png', import.meta.url),
    join(directory, 'assets/logo.png'),
  );
  await writeFile(join(directory, 'Cargo.toml'), '[workspace.package]\nversion = "0.2.0"\n');
  const output = join(directory, 'custom-target/debug');
  const app = join(output, 'Maka.app/Contents/MacOS');
  await mkdir(app, { recursive: true });
  await writeFile(join(app, 'maka-desktop-shell'), 'previous desktop');
  await writeFile(join(output, 'maka-desktop-shell'), 'current desktop');
  const executable = join(output, 'maka');
  const launched = [];
  t.mock.method(childProcess, 'spawn', (command, args) => {
    const child = new EventEmitter();
    if (command === 'cargo') {
      assert.ok(args.includes('maka-desktop-shell'));
      child.stdout = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end(
          JSON.stringify({
            reason: 'compiler-artifact',
            target: { name: 'maka', kind: ['bin'] },
            executable,
          }) + '\n',
        );
        child.emit('exit', 0, null);
      });
    } else {
      assert.equal(readFileSync(join(app, 'maka-desktop-shell'), 'utf8'), 'current desktop');
      launched.push([command, args]);
      queueMicrotask(() => child.emit('exit', 0, null));
    }
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.deepEqual(
    await runCli(['--timeout-ms', '5000', 'desktop'], {
      repositoryRoot: directory,
      env: {},
      platform: 'darwin',
      osRelease: 'Darwin',
    }),
    { code: 0, signal: null },
  );
  assert.deepEqual(launched, [[executable, ['--timeout-ms', '5000', 'desktop']]]);
});

// Run the public Node entrypoint while replacing only its external Cargo process.
function invokeLauncher(event, env = {}) {
  const preload = `
    import childProcess from 'node:child_process';
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    import { syncBuiltinESMExports } from 'node:module';
    childProcess.spawn = (command, args, options) => {
      process.stdout.write(JSON.stringify({ command, args, cwd: options.cwd }) + '\\n');
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => { child.stdout.end(); ${event}; });
      return child;
    };
    syncBuiltinESMExports();
  `;
  return childProcess.spawnSync(
    process.execPath,
    ['--import', 'data:text/javascript,' + encodeURIComponent(preload), launcher, '--help'],
    {
      env: { ...process.env, MAKA_CUA_BUILD_MODE: 'bridge', ...env },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    },
  );
}

test('the launcher preserves Cargo failures and invokes Cargo from the repository', () => {
  const result = invokeLauncher("child.emit('exit', 29, null)");
  assert.equal(result.status, 29);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    command: 'cargo',
    args: [
      'build',
      '--locked',
      '-p',
      'maka-cli',
      '-p',
      'maka-python-runtime',
      '--no-default-features',
      '--message-format=json',
    ],
    cwd: root,
  });
});

test('the launcher reports a Cargo spawn error', () => {
  const result = invokeLauncher("child.emit('error', new Error('Cargo could not start'))");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Cargo could not start\n');
});

test('the launcher rejects unknown build modes before starting Cargo', () => {
  const result = invokeLauncher("child.emit('exit', 0, null)", { MAKA_CUA_BUILD_MODE: 'typo' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'MAKA_CUA_BUILD_MODE must be auto, native, or bridge\n');
});

test('the launcher preserves Cargo termination signals', {
  skip: process.platform === 'win32',
}, () => {
  const result = invokeLauncher("child.emit('exit', null, 'SIGTERM')");
  assert.equal(result.status, null);
  assert.equal(result.signal, 'SIGTERM');
});
