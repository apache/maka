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
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { buildCli, rustTarget, stageDesktopBundle, workspaceVersion } from './build-cli.mjs';

const manifest = [
  '[workspace]',
  'members = ["products/maka/cli"]',
  '',
  '[workspace.package]',
  'edition = "2024"',
  'version = "1.2.3-beta.1"',
  '',
  '[workspace.dependencies]',
  'version = "9.9.9"',
  '',
].join('\n');

// A PNG signature and IHDR are all the icon staging reads.
function logo(size = 1024) {
  const png = Buffer.alloc(33);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(size, 16);
  png.writeUInt32BE(size, 20);
  return png;
}

async function repository(root) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'Cargo.toml'), manifest);
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'assets/logo.png'), logo());
}

test('CLI builds use the requested target and artifact path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-build-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'extracted-source');
  for (const directory of [root, sourceRoot]) await repository(directory);
  const previous = process.env.CARGO_TARGET_DIR;
  process.env.CARGO_TARGET_DIR = 'target/isolated release';
  let invocation;
  let exitCode = 0;
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', exitCode, null));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = previous;
  });
  for (const target of [
    undefined,
    'x86_64-unknown-linux-gnu',
    'aarch64-unknown-linux-gnu',
    'aarch64-apple-darwin',
    'x86_64-pc-windows-msvc',
  ]) {
    const triple = target ?? rustTarget();
    const linux = triple.includes('-linux-');
    const directory = join(root, process.env.CARGO_TARGET_DIR);
    const binaryDirectory = join(directory, ...(linux || target ? [triple] : []), 'release');
    const macos = triple.includes('-apple-darwin');
    await mkdir(binaryDirectory, { recursive: true });
    await writeFile(join(binaryDirectory, 'maka-desktop-shell'), 'shell bytes');
    const output = await buildCli({ release: true, target, repositoryRoot: root });
    // The workbench is compiled into the shell: nothing is staged beside it.
    await assert.rejects(lstat(join(dirname(output), 'app')), { code: 'ENOENT' });
    if (macos) {
      const contents = join(dirname(output), 'Maka.app/Contents');
      assert.equal(
        await readFile(join(contents, 'MacOS/maka-desktop-shell'), 'utf8'),
        'shell bytes',
      );
      if (process.platform !== 'win32')
        assert.equal((await lstat(join(contents, 'MacOS/maka-desktop-shell'))).mode & 0o777, 0o755);
      const plist = await readFile(join(contents, 'Info.plist'), 'utf8');
      for (const [key, value] of [
        ['CFBundleDisplayName', 'Maka'],
        ['CFBundleExecutable', 'maka-desktop-shell'],
        ['CFBundleIconFile', 'Maka'],
        ['CFBundleIdentifier', 'org.apache.maka.desktop'],
        ['CFBundleName', 'Maka'],
        ['CFBundleShortVersionString', '1.2.3-beta.1'],
        ['CFBundleVersion', '1.2.3'],
      ])
        assert.ok(plist.includes(`<key>${key}</key>\n  <string>${value}</string>`), key);
      if (process.platform === 'darwin')
        childProcess.execFileSync('plutil', ['-lint', join(contents, 'Info.plist')]);
      const icon = await readFile(join(contents, 'Resources/Maka.icns'));
      assert.equal(icon.toString('latin1', 0, 4), 'icns');
      assert.equal(icon.readUInt32BE(4), icon.length);
      assert.equal(icon.toString('latin1', 8, 12), 'ic10');
      assert.equal(icon.readUInt32BE(12), icon.length - 8);
      assert.deepEqual(icon.subarray(16), logo());
      assert.deepEqual(await readdir(join(contents, 'Resources')), ['Maka.icns']);
    }
    assert.equal(invocation.command, 'cargo');
    assert.equal(invocation.options.cwd, root);
    assert.deepEqual(invocation.args, [
      linux ? 'zigbuild' : 'build',
      '--locked',
      '-p',
      'maka-cli',
      '-p',
      'maka-desktop-shell',
      '-p',
      'maka-python-runtime',
      '--target-dir',
      directory,
      '--release',
      ...(linux ? ['--target', triple + '.2.28'] : target ? ['--target', target] : []),
    ]);
    assert.equal(
      output,
      join(
        directory,
        ...(linux || target ? [triple] : []),
        'release',
        triple.includes('-windows-') ? 'maka.exe' : 'maka',
      ),
    );
  }
  await mkdir(join(root, 'target/debug'), { recursive: true });
  await writeFile(join(root, 'target/debug/maka-desktop-shell'), 'shell bytes');
  assert.equal(
    await buildCli({ repositoryRoot: root }),
    join(root, 'target/debug', process.platform === 'win32' ? 'maka.exe' : 'maka'),
  );
  assert.deepEqual(invocation.args, [
    'build',
    '--locked',
    '-p',
    'maka-cli',
    '-p',
    'maka-desktop-shell',
    '-p',
    'maka-python-runtime',
    '--target-dir',
    join(root, 'target'),
  ]);
  const sourceEnv = { MAKA_JS_DEPS: sourceRoot };
  await mkdir(join(sourceRoot, 'target/aarch64-apple-darwin/release'), { recursive: true });
  await writeFile(
    join(sourceRoot, 'target/aarch64-apple-darwin/release/maka-desktop-shell'),
    'shell bytes',
  );
  assert.equal(
    await buildCli({
      release: true,
      target: 'aarch64-apple-darwin',
      repositoryRoot: sourceRoot,
      env: sourceEnv,
    }),
    join(sourceRoot, 'target/aarch64-apple-darwin/release/maka'),
  );
  assert.equal(invocation.options.cwd, sourceRoot);
  assert.equal(invocation.options.env, sourceEnv);
  exitCode = 1;
  await assert.rejects(buildCli({ release: true, repositoryRoot: root }), /Maka build failed: 1/u);
});

test('a failed bundle staging keeps the previous Maka.app', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-bundle-staging-'));
  try {
    await repository(root);
    const shell = join(root, 'maka-desktop-shell');
    await writeFile(shell, 'original shell');
    const destination = join(root, 'bin/Maka.app');
    await mkdir(dirname(destination));
    await stageDesktopBundle(root, shell, destination);
    await writeFile(shell, 'replacement shell');
    await writeFile(join(root, 'assets/logo.png'), logo(512));
    await assert.rejects(stageDesktopBundle(root, shell, destination), /1024x1024 PNG/);
    await writeFile(join(root, 'assets/logo.png'), logo());
    await writeFile(join(root, 'Cargo.toml'), '[workspace]\nversion = "1.0.0"\n');
    await assert.rejects(stageDesktopBundle(root, shell, destination), /no \[workspace.package\]/);
    assert.equal(
      await readFile(join(destination, 'Contents/MacOS/maka-desktop-shell'), 'utf8'),
      'original shell',
    );
    assert.deepEqual(await readdir(dirname(destination)), ['Maka.app']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the bundle version is the workspace package version', () => {
  assert.equal(workspaceVersion(manifest), '1.2.3-beta.1');
  assert.equal(workspaceVersion('[workspace.package]\nversion = "0.2.0"'), '0.2.0');
  assert.throws(() => workspaceVersion('[package]\nversion = "0.2.0"\n'), /no \[workspace/);
});
