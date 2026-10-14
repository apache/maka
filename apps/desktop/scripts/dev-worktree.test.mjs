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
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { test } from 'node:test';
import { createDevelopmentEnvironmentFile, startDevelopmentApp } from './dev-app-runtime.mjs';
import { worktreeDevelopmentLaunch } from './dev-worktree.mjs';

function worktreeFixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'maka-worktree-profile-'));
  const first = join(parent, 'first', 'checkout with spaces');
  const second = join(parent, 'second', 'checkout with spaces');
  for (const directory of [first, second]) mkdirSync(directory, { recursive: true });
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { parent, first, second };
}

test('worktree profiles are stable across launches and distinct for identically named checkouts', (t) => {
  const { parent, first, second } = worktreeFixture(t);
  const home = posix.join('/test-homes', posix.basename(parent.replaceAll('\\', '/')));
  const options = { platform: 'darwin', home, env: {}, repoRoot: first };
  const one = worktreeDevelopmentLaunch([], options);
  assert.equal(one.userDataDir, worktreeDevelopmentLaunch([], options).userDataDir);
  assert.notEqual(
    one.userDataDir,
    worktreeDevelopmentLaunch([], { ...options, repoRoot: second }).userDataDir,
  );
  assert.equal(
    posix.dirname(one.userDataDir),
    posix.join(home, 'Library', 'Application Support', 'Maka Dev Worktrees'),
  );
  assert.equal(
    existsSync(one.userDataDir),
    false,
    'selection does not copy or initialize user data',
  );
});

test('a symlink to a worktree uses the same data directory', {
  skip: process.platform === 'win32',
}, (t) => {
  const { parent, first } = worktreeFixture(t);
  const alias = join(parent, 'alias');
  symlinkSync(first, alias, 'dir');
  assert.equal(
    worktreeDevelopmentLaunch([], { repoRoot: first }).userDataDir,
    worktreeDevelopmentLaunch([], { repoRoot: alias }).userDataDir,
  );
});

test('worktree profiles use the platform data location and ignore relative config roots', (t) => {
  const { first } = worktreeFixture(t);
  for (const [platform, home, env, expected] of [
    ['win32', 'C:\\Users\\dev', { APPDATA: 'D:\\Roaming' }, 'D:\\Roaming\\Maka Dev Worktrees'],
    ['win32', 'C:\\Users\\dev', {}, 'C:\\Users\\dev\\AppData\\Roaming\\Maka Dev Worktrees'],
    [
      'linux',
      '/home/dev',
      { XDG_CONFIG_HOME: '/custom/config' },
      '/custom/config/Maka Dev Worktrees',
    ],
    ['linux', '/home/dev', { XDG_CONFIG_HOME: 'relative' }, '/home/dev/.config/Maka Dev Worktrees'],
    ['linux', '/home/dev', {}, '/home/dev/.config/Maka Dev Worktrees'],
  ]) {
    const result = worktreeDevelopmentLaunch([], { platform, home, env, repoRoot: first });
    const paths = platform === 'win32' ? win32 : posix;
    assert.equal(paths.dirname(result.userDataDir), expected);
    assert.ok(paths.isAbsolute(result.userDataDir));
  }
});

test('an explicit data directory overrides automatic selection and survives plain and TCC forwarding', async (t) => {
  const { first } = worktreeFixture(t);
  const override = join(first, 'explicit data');
  for (const flags of [[`--user-data-dir=${override}`], ['--user-data-dir', override]]) {
    const result = worktreeDevelopmentLaunch(['--inspect=0', ...flags, '--runtime-host-peer'], {
      repoRoot: first,
    });
    assert.equal(result.userDataDir, override);
    assert.deepEqual(result.argv, [
      '--inspect=0',
      '--runtime-host-peer',
      `--user-data-dir=${override}`,
    ]);
    const calls = [];
    const child = new EventEmitter();
    await startDevelopmentApp({
      argv: result.argv,
      prepareMacosDevelopmentLaunch: async () => null,
      devSingleInstanceConstants: async () => ({}),
      spawn: (command, args) => {
        calls.push(args);
        return child;
      },
    });
    assert.deepEqual(calls[0].slice(1), result.argv);
    const tcc = createDevelopmentEnvironmentFile({
      argv: result.argv,
      env: {},
      viteUrl: 'http://localhost:5173',
    });
    assert.equal(tcc.userDataDir, override);
    assert.deepEqual(tcc.electronArgs, ['--inspect=0', '--runtime-host-peer']);
  }
});

test('invalid profile overrides cannot fall back to the shared profile', (t) => {
  const { first } = worktreeFixture(t);
  for (const argv of [
    ['--user-data-dir='],
    ['--user-data-dir'],
    ['--user-data-dir', '--inspect=0'],
    ['--user-data-dir=/one', '--user-data-dir=/two'],
  ])
    assert.throws(() => worktreeDevelopmentLaunch(argv, { repoRoot: first }), /--user-data-dir/);
});

test('relative profile overrides resolve from the checkout rather than the caller directory', (t) => {
  const { first } = worktreeFixture(t);
  const result = worktreeDevelopmentLaunch(['--user-data-dir', 'local profile'], {
    repoRoot: first,
  });
  assert.equal(result.userDataDir, join(realpathSync(first), 'local profile'));
});
