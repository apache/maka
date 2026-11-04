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
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packNativeCli } from './pack-cli.mjs';

test('native archives carry the CLI and desktop shell without a terminal sidecar', async (t) => {
  if (process.platform !== 'darwin') {
    const execute = childProcess.execFileSync;
    t.mock.method(childProcess, 'execFileSync', (command, args, options) =>
      command === '/usr/bin/codesign' ? Buffer.alloc(0) : execute(command, args, options),
    );
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
  }
  const root = await mkdtemp(join(tmpdir(), 'maka-shell-package-'));
  const previous = process.cwd();
  try {
    await writeFile(join(root, 'Cargo.toml'), '[workspace.package]\nversion = "0.2.0"\n');
    const png = Buffer.alloc(33);
    Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(png);
    png.write('IHDR', 12, 'latin1');
    png.writeUInt32BE(1024, 16);
    png.writeUInt32BE(1024, 20);
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets/logo.png'), png);
    await mkdir(join(root, 'packages/cli'), { recursive: true });
    for (const name of ['DISCLAIMER', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt'])
      await writeFile(join(root, name), 'reviewed ' + name);
    for (const name of ['README.md', 'README.zh-CN.md'])
      await writeFile(join(root, 'packages/cli', name), 'package documentation');
    await mkdir(join(root, 'build/app'), { recursive: true });
    await writeFile(join(root, 'build/app/main.js'), 'stale generated application');
    for (const name of [
      'maka',
      'maka.exe',
      'maka-desktop-shell',
      'maka-desktop-shell.exe',
      'maka-host-shell',
      'maka-service.exe',
      'maka-python-worker',
      'maka-python-worker.exe',
      'maka-oar-worker',
      'maka-oar-worker.exe',
    ])
      await writeFile(join(root, 'build', name), name + ' bytes');
    // Exercise the actual external validator call without executing foreign-target
    // stub bytes. Distribution's real archive/PE parser has its own Rust tests.
    await writeFile(
      join(root, 'host'),
      String.raw`
      const assert = require('node:assert/strict');
      const { execFileSync } = require('node:child_process');
      const args = process.argv.slice(2);
      assert.equal(args[0], 'fetch');
      const value = (name) => args[args.indexOf(name) + 1];
      const archive = value('--archive');
      const files = execFileSync('tar', ['-tzf', archive], {encoding:'utf8'}).trim().split('\n');
      const windows = value('--target') === 'win32-x64';
      assert.ok(!files.includes('package/bin/maka-terminal-shell'));
      assert.ok(!files.includes('package/bin/maka-terminal-shell.exe'));
      const macos = value('--target') === 'darwin-arm64';
      const bundle = 'package/bin/Maka.app/Contents/';
      const shell = macos ? bundle + 'MacOS/maka-desktop-shell' : 'package/bin/' + (windows ? 'maka-desktop-shell.exe' : 'maka-desktop-shell');
      if (!macos || process.platform !== 'darwin') assert.equal(execFileSync('tar', ['-xOf', archive, shell], {encoding:'utf8'}), shell.split('/').pop() + ' bytes');
      if (process.platform !== 'win32') assert.match(execFileSync('tar', ['-tvzf', archive, shell], {encoding:'utf8'}), /^-rwx/);
      assert.equal(files.includes('package/bin/maka-service.exe'), windows);
      assert.ok(files.includes('package/bin/' + (windows ? 'maka-python-worker.exe' : 'maka-python-worker')));
      const oar = 'package/bin/' + (windows ? 'maka-oar-worker.exe' : 'maka-oar-worker');
      assert.equal(execFileSync('tar', ['-xOf', archive, oar], {encoding:'utf8'}), oar.split('/').pop() + ' bytes');
      if (process.platform !== 'win32') assert.match(execFileSync('tar', ['-tvzf', archive, oar], {encoding:'utf8'}), /^-rwx/);
      assert.equal(files.some((file) => file.startsWith('package/bin/Maka.app/')), macos);
      assert.ok(!files.some((file) => file.includes('/app/')));
      assert.equal(files.includes('package/bin/maka-desktop-shell'), !macos && !windows);
      assert.ok(!files.includes('package/bin/maka-desktop'));
      if (macos) {
        const plist = execFileSync('tar', ['-xOf', archive, bundle + 'Info.plist'], {encoding:'utf8'});
        assert.match(plist, /<key>CFBundleIdentifier<\/key>\n  <string>org.apache.maka.desktop<\/string>/);
        assert.match(plist, /<key>CFBundleShortVersionString<\/key>\n  <string>0.2.0<\/string>/);
        assert.equal(execFileSync('tar', ['-xOf', archive, bundle + 'Resources/Maka.icns']).subarray(0, 4).toString(), 'icns');
        if (process.platform !== 'darwin') {
          assert.equal(execFileSync('tar', ['-xOf', archive, bundle + 'Helpers/Maka Host.app/Contents/MacOS/maka-host-shell'], {encoding:'utf8'}), 'maka-host-shell bytes');
        } else {
          const fs = require('node:fs');
          const path = require('node:path');
          const unpacked = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'maka-signed-archive-'));
          try {
            execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
            const app = path.join(unpacked, 'package/bin/Maka.app');
            for (const [bundle, id] of [[app, 'org.apache.maka.desktop'], [path.join(app, 'Contents/Helpers/Maka Host.app'), 'org.apache.maka.host']]) {
              execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement', '=identifier "' + id + '"', bundle]);
            }
          } finally { fs.rmSync(unpacked, {recursive: true, force: true}); }
        }
      }
      for (const name of ['DISCLAIMER', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt']) {
        assert.equal(execFileSync('tar', ['-xOf', archive, 'package/' + name], {encoding:'utf8'}), 'reviewed ' + name);
        if (macos) assert.equal(execFileSync('tar', ['-xOf', archive, bundle + 'Resources/' + name], {encoding:'utf8'}), 'reviewed ' + name);
      }
      for (const name of ['README.md', 'README.zh-CN.md']) assert.ok(execFileSync('tar', ['-xOf', archive, 'package/' + name], {encoding:'utf8'}).includes('reviewed DISCLAIMER'));
    `,
    );
    process.chdir(root);
    for (const target of ['darwin-arm64', 'linux-x64-gnu', 'win32-x64']) {
      for (const name of ['maka-desktop-shell', 'maka-host-shell']) {
        await writeFile(
          join(root, 'build', name),
          process.platform === 'darwin' && target === 'darwin-arm64'
            ? await readFile('/usr/bin/true')
            : name + ' bytes',
        );
      }

      const result = await packNativeCli({
        target,
        version: '0.2.0-rust-preview.fixture',
        binary: join(root, 'build', target === 'win32-x64' ? 'maka.exe' : 'maka'),
        notices: join(root, 'THIRD_PARTY_NOTICES.txt'),
        validator: process.execPath,
        output: join(root, 'output'),
        repositoryRoot: root,
      });
      const receipt = JSON.parse(await readFile(join(root, 'output', target + '.json'), 'utf8'));
      assert.equal(receipt.integrity, result.integrity);
    }
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});
