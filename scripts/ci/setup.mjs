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

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { command } from './command.mjs';
import { manifests } from './suites.mjs';

const role = process.env.MAKA_CI_ROLE;
const workspace = process.env.MAKA_CI_WORKSPACE;
const hash = (input) => createHash('sha256').update(input).digest('hex');
const version = process.env.MAKA_CI_NEXTEST;
const tools =
  role === 'tooling'
    ? ['cargo-deny']
    : ['root', 'replay', 'variants', 'termina', 'nsh', 'gpui'].includes(role)
      ? [`cargo-nextest${version ? `@${version}` : ''}`]
      : [];

function output(values) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}

async function main(action) {
  if (action === 'tool-list') {
    output({ tools: tools.join(' ') });
  } else if (action === 'tools') {
    await command('cargo', ['binstall', '--no-confirm', '--force', 'cargo-binstall']);
    await command('cargo', ['binstall', '--no-confirm', '--force', ...tools]);
  } else if (action === 'keys') {
    const lock = readFileSync(join(dirname(manifests[workspace]), 'Cargo.lock'));
    const compiler = await command('rustc', ['-vV'], { capture: true });
    const sharedRoot = ['root', 'variants', 'clippy', 'product'].includes(role);
    const base = `rust-target-${process.env.RUNNER_OS}-${process.env.RUNNER_ARCH}-${hash(compiler)}-${sharedRoot ? 'root' : role}`;
    const downloads = `cargo-${process.env.RUNNER_OS}-${workspace}-${hash(lock)}`;
    const writer =
      workspace !== 'root' ||
      role === 'root' ||
      (process.env.RUNNER_OS !== 'Linux' && role.startsWith('native-'));
    output({
      compiled: `${base}-${hash(lock)}`,
      compiled_prefix: base,
      compiled_writer: !sharedRoot || role === 'root',
      downloads,
      downloads_prefix: `cargo-${process.env.RUNNER_OS}-${workspace}`,
      downloads_writer: writer,
    });
  } else if (action === 'mbx') {
    const release = JSON.parse(
      await command('gh', ['api', 'repos/jdx/mr-boxington/releases/latest'], { capture: true }),
    );
    if (!release.immutable) throw new Error('The mbx release must be immutable');
    const asset = release.assets.find(
      (entry) => entry.name === 'mbx-x86_64-unknown-linux-gnu.tar.gz',
    );
    if (!asset) throw new Error('The mbx Linux release asset is missing');
    const temporary = process.env.RUNNER_TEMP;
    const archive = join(temporary, 'mbx.tar.gz');
    const bin = join(temporary, 'mbx-bin');
    const data = join(temporary, 'mbx-data');
    mkdirSync(bin, { recursive: true });
    await command('curl', [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--retry',
      '3',
      asset.browser_download_url,
      '--output',
      archive,
    ]);
    if (asset.digest !== `sha256:${hash(readFileSync(archive))}`)
      throw new Error('mbx release asset digest mismatch');
    await command('tar', ['-xzf', archive, '-C', bin]);
    await command(join(bin, 'mbx'), ['--version']);
    await command(join(bin, 'mbx'), ['setup', '--yes'], {
      env: { ...process.env, XDG_DATA_HOME: data },
    });
    appendFileSync(process.env.GITHUB_PATH, `${bin}\n${join(data, 'mbx/bin')}\n`);
  } else if (action === 'native') {
    const dependencies = process.env.MAKA_CI_DEPENDENCIES;
    const shared = [
      'clang',
      'libclang-dev',
      'pkg-config',
      'libfontconfig1-dev',
      'libfreetype6-dev',
      'libssl-dev',
    ];
    const headless = [
      'bubblewrap',
      'ripgrep',
      'libx11-dev',
      'libxi-dev',
      'libxtst-dev',
      'libxext-dev',
      'libxcb1-dev',
      'libxkbcommon-dev',
      'libxkbcommon-x11-dev',
      'libwayland-dev',
      'libvulkan1',
      'mesa-vulkan-drivers',
    ];
    const packages =
      dependencies === 'computer-use'
        ? [
            ...shared,
            'libx11-dev',
            'libxi-dev',
            'libxtst-dev',
            'libxext-dev',
            'libxrandr-dev',
            'libxfixes-dev',
            'libxkbcommon-dev',
            'libwayland-dev',
          ]
        : [
            ...shared,
            ...headless,
            ...(dependencies === 'gpui'
              ? ['build-essential', 'libasound2-dev', 'libx11-xcb-dev', 'libzstd-dev']
              : []),
          ];
    await command('sudo', ['apt-get', 'update']);
    await command('sudo', ['apt-get', 'install', '-y', ...packages]);
    if (dependencies !== 'computer-use')
      await command('sudo', ['sysctl', '-w', 'kernel.apparmor_restrict_unprivileged_userns=0']);
  } else {
    throw new Error(`Unknown CI setup action: ${action}`);
  }
}

main(process.argv[2]).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
