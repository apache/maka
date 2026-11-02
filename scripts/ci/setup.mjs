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
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { command } from './command.mjs';
import { manifests } from './suites.mjs';

const role = process.env.MAKA_CI_ROLE;
const workspace = process.env.MAKA_CI_WORKSPACE;
const version = process.env.MAKA_CI_NEXTEST;
const tools =
  role === 'tooling'
    ? ['cargo-deny']
    : ['root', 'replay', 'bridge', 'desktop', 'termina', 'nsh', 'gpui'].includes(role)
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
    await command('cargo', ['binstall', '--no-confirm', '--force', ...tools]);
  } else if (action === 'keys') {
    const hash = (input) => createHash('sha256').update(input).digest('hex');
    const compiler = await command('rustc', ['-vV'], { capture: true });
    const manifest = manifests[workspace];
    const lock = hash(readFileSync(join(dirname(manifest), 'Cargo.lock')));
    const configuration = hash(
      Buffer.concat([readFileSync(manifest), readFileSync('.cargo/config.toml')]),
    );
    const compiled = `rust-deps-${process.env.RUNNER_OS}-${process.env.RUNNER_ARCH}-${hash(compiler)}-${role}-${configuration}`;
    output({
      compiled: `${compiled}-${lock}`,
      compiled_prefix: `${compiled}-`,
      downloads: `cargo-sources-${workspace}-${lock}`,
      downloads_prefix: `cargo-sources-${workspace}-`,
      downloads_writer: role === 'tooling' || workspace !== 'root',
    });
  } else if (action === 'prune') {
    const metadata = JSON.parse(
      await command(
        'cargo',
        [
          'metadata',
          '--locked',
          '--no-deps',
          '--format-version',
          '1',
          '--manifest-path',
          manifests[workspace],
        ],
        { capture: true },
      ),
    );
    // Checkout gives workspace sources new mtimes, so their outputs rebuild on
    // the next runner anyway. Keep dependencies, not those large local outputs.
    await command('cargo', [
      'clean',
      '--manifest-path',
      manifests[workspace],
      '--target-dir',
      'target',
      ...metadata.packages.flatMap((pkg) => ['--package', pkg.name]),
    ]);
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
