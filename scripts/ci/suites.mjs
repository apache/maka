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

import { readFileSync } from 'node:fs';

export const manifests = {
  root: 'Cargo.toml',
  termina: 'third-party/termina/Cargo.toml',
  nsh: 'third-party/nsh/Cargo.toml',
};

const bundledPackages = Object.values(
  JSON.parse(
    readFileSync(new URL('../../products/maka/bundle/package-inputs.json', import.meta.url)),
  ),
);

export const productInputs = [
  ...bundledPackages,
  'products/maka/bundle',
  'packages/plugin-sdk',
  'patches',
  'plugins/shared',
  'plugins/application/quick-tools',
  'scripts/quick-tools',
  'scripts/plugins',
  'scripts/rust/product.mjs',
];
const distributionInputs = [
  'scripts/asf-source-release.mjs',
  'scripts/rust/build-v8.mjs',
  'scripts/rust/cargo.mjs',
  'scripts/rust/v8-source.json',
  'scripts/rust/v8-prebuilts.json',
  'scripts/rust/v8-cache.mjs',
  'scripts/rust/v8-prebuilt.mjs',
  'scripts/rust/compile-v8.mjs',
  'scripts/rust/v8-notices.mjs',
  'scripts/rust/license-files.mjs',
  'scripts/rust/license-source.mjs',
  'scripts/rust/notices.mjs',
  'scripts/rust/notices-sources.json',
  'scripts/rust/licenses',
];
const embeddedInputs = [
  'products/maka/terminal-shell/tests/support/external-agent-cli.mjs',
  ...productInputs,
  'skills/maka-plugin-authoring',
  'platform/computer-use/skills',
];

export const suites = {
  tooling: { always: true },
  root: {
    workspace: 'root',
    packages: 'workspace',
    cargoArgs: ['--locked', '--workspace'],
    profile: 'ci',
    extraInputs: [
      ...embeddedInputs,
      'plugins/agent/native/tests/support',
      ...distributionInputs,
      'products/maka/workbench/tests/fonts',
    ],
    affectedFilter: true,
  },
  bridge: {
    workspace: 'root',
    packages: ['maka-cli', 'maka-computer-use'],
    cargoArgs: [
      '--locked',
      '-p',
      'maka-computer-use',
      '--no-default-features',
      '--lib',
      '--test',
      'integration',
    ],
    extraInputs: embeddedInputs,
  },
  desktop: {
    workspace: 'root',
    packages: ['maka-cli'],
    cargoArgs: [
      '--locked',
      '-p',
      'maka-cli',
      '--no-default-features',
      '--features',
      'desktop-tests',
      '--test',
      'native-desktop',
    ],
    filter: 'test(terminal::desktop_new_session)',
    extraInputs: embeddedInputs,
  },
  'native-build': {
    workspace: 'root',
    packages: ['maka-cli', 'maka-desktop-shell', 'maka-python-runtime'],
    extraInputs: [...embeddedInputs, ...distributionInputs, 'scripts/rust/build-cli.mjs'],
  },
  contracts: {
    workspace: 'root',
    packages: ['maka-schema', 'maka-workbench'],
    extraInputs: [
      ...productInputs,
      'products/maka/terminal-shell/tests/fixtures',
      'products/maka/terminal-shell/tests/real_host',
      'skills/maka-plugin-authoring/assets',
    ],
  },
  product: {
    workspace: 'root',
    packages: ['maka-ui-build', 'maka-cli', 'maka-desktop-shell', 'maka-python-runtime'],
    extraInputs: [...productInputs, ...distributionInputs],
  },
  termina: {
    workspace: 'termina',
    packages: ['termina'],
    cargoArgs: ['--locked', '--manifest-path', manifests.termina, '--lib'],
    profile: 'default',
  },
  nsh: {
    workspace: 'nsh',
    packages: [
      'nsh-core',
      'nsh-macros',
      'nsh-i18n',
      'nsh-updater',
      'nsh-base',
      'nsh-engine',
      'nsh-js',
      'nsh-testing',
      'nsh-platform-tui',
      'nsh-tui-host',
      'nsh-terminal',
      'nsh-cli',
      'nsh-dev',
      'nsh-bundler',
      'nsh-package',
      'nsh-platform-web',
    ],
    cargoArgs: [
      '--locked',
      '--manifest-path',
      manifests.nsh,
      '-p',
      'nsh-core',
      '-p',
      'nsh-macros',
      '-p',
      'nsh-i18n',
      '-p',
      'nsh-updater',
      '-p',
      'nsh-base',
      '-p',
      'nsh-engine',
      '-p',
      'nsh-js',
      '-p',
      'nsh-testing',
      '-p',
      'nsh-platform-tui',
      '-p',
      'nsh-tui-host',
      '-p',
      'nsh-terminal',
      '-p',
      'nsh-cli',
      '-p',
      'nsh-dev',
      '-p',
      'nsh-bundler',
      '-p',
      'nsh-package',
      '--features',
      'nsh-testing/agent,nsh-dev/client,nsh-dev/server',
    ],
    extraInputs: ['third-party/nsh/crates/nsh-platform-web/web'],
  },
  pixels: {
    workspace: 'root',
    packages: ['maka-terminal-shell'],
    cargoArgs: ['--locked', '-p', 'maka-terminal-shell', '--test', 'native-pixels'],
    extraInputs: embeddedInputs,
  },
  'linux-nsh': {
    workspace: 'nsh',
    packages: ['nsh-platform-linux'],
    cargoArgs: ['--locked', '--manifest-path', manifests.nsh, '-p', 'nsh-platform-linux', '--lib'],
  },
  'macos-nsh': {
    workspace: 'nsh',
    packages: ['nsh-platform-apple', 'nsh-platform-macos'],
    cargoArgs: [
      '--locked',
      '--manifest-path',
      manifests.nsh,
      '-p',
      'nsh-platform-apple',
      '-p',
      'nsh-platform-macos',
      '--features',
      'nsh-platform-macos/terminal',
      '--lib',
    ],
  },
  'macos-surface': {
    workspace: 'nsh',
    packages: ['nsh-platform-macos'],
    cargoArgs: [
      '--locked',
      '--manifest-path',
      manifests.nsh,
      '-p',
      'nsh-platform-macos',
      '--features',
      'terminal',
      '--test',
      'terminal_native',
    ],
  },
  'macos-desktop': {
    workspace: 'root',
    packages: ['maka-desktop-shell'],
    cargoArgs: ['--locked', '-p', 'maka-desktop-shell'],
    extraInputs: embeddedInputs,
  },
  'windows-desktop': {
    workspace: 'root',
    packages: ['maka-desktop-shell'],
    cargoArgs: ['--locked', '-p', 'maka-desktop-shell'],
    extraInputs: embeddedInputs,
  },
  'windows-skills': {
    workspace: 'root',
    packages: ['maka-skills-native'],
    cargoArgs: ['--locked', '-p', 'maka-skills-native', '--lib'],
  },
  'windows-ci': {
    workspace: 'root',
    packages: [],
    cargoArgs: [],
    extraInputs: ['scripts/ci', 'scripts/ci.mjs', 'scripts/ci.test.mjs'],
  },
  'windows-nsh': {
    workspace: 'nsh',
    packages: ['nsh-platform-windows', 'nsh-windows-app', 'nsh-windows-host', 'gallery-native'],
    cargoArgs: [
      '--locked',
      '--manifest-path',
      manifests.nsh,
      '-p',
      'nsh-platform-windows',
      '--features',
      'terminal',
      '--lib',
    ],
    extraInputs: ['third-party/nsh/crates/nsh-cli/src/templates/rust/main.rs'],
  },
  'macos-host': {
    workspace: 'root',
    packages: ['maka-cli', 'maka-host-shell'],
    cargoArgs: ['--locked', '-p', 'maka-cli', '--bin', 'maka', '--no-default-features'],
    filter: 'test(deployment::host_identity::tests::)',
    extraInputs: [
      ...embeddedInputs,
      'scripts/rust/build-cli.mjs',
      'scripts/rust/build-cli.test.mjs',
      'scripts/rust/pack-cli.mjs',
      'scripts/rust/pack-cli.test.mjs',
      'scripts/rust/run-cli.mjs',
      'scripts/rust/run-cli.test.mjs',
    ],
  },
  'macos-terminal': {
    workspace: 'root',
    packages: ['maka-agent-native'],
    cargoArgs: ['--locked', '-p', 'maka-agent-native', '--lib'],
    filter:
      'test(=owner::tests::terminal::terminal_raw_bytes_full_resize_replay_and_observer_cancellation_preserve_native_owner)',
    extraInputs: [
      'plugins/agent/native/src/owner/tests/terminal.rs',
      'plugins/agent/native/src/owner/tests/processes.rs',
      'plugins/agent/native/src/owner/tests/service_tools',
      'plugins/workspace/workspace-processes/native',
      'platform/process',
      'platform/sandbox/src/seatbelt',
      'plugins/agent/providers/data',
    ],
  },
  'windows-shell': {
    workspace: 'root',
    packages: ['maka-process', 'maka-settings-native', 'maka-agent-native'],
    cargoArgs: [
      '--locked',
      '-p',
      'maka-process',
      '-p',
      'maka-settings-native',
      '-p',
      'maka-agent-native',
    ],
    filter:
      'test(git_bash) | test(shell_setting_rejects_invalid_bash_and_persists_valid_host_choice)',
  },
  native: {
    workspace: 'root',
    packages: ['maka-computer-use'],
    cargoArgs: ['--locked', '-p', 'maka-computer-use', '--lib', '--features', 'native-desktop'],
    filter: [
      'test(macos::controller::tests::)',
      'test(macos::tcc::tests::)',
      'test(system_permission::process::tests::)',
      'test(desktop::worker::macos::tests::)',
      'test(desktop::worker::native_owner::tests::)',
      'test(driver::tests::fresh_binding_replaces_failed_controller_without_restarting_old_owner)',
    ].join(' | '),
  },
};

export const workers = [
  {
    id: 'bridge',
    suites: ['bridge'],
    runner: 'ubuntu-latest',
    workspace: 'root',
    dependencies: 'headless',
    javascript: true,
    compile: true,
  },
  {
    id: 'packaging',
    suites: ['native-build'],
    runner: 'ubuntu-latest',
    workspace: 'root',
    dependencies: 'headless',
    javascript: true,
    compile: false,
  },
  {
    id: 'product',
    suites: ['contracts', 'product'],
    runner: 'ubuntu-latest',
    workspace: 'root',
    dependencies: 'headless',
    javascript: true,
    compile: false,
  },
  {
    id: 'termina',
    suites: ['termina'],
    runner: 'ubuntu-latest',
    workspace: 'termina',
    dependencies: '',
    javascript: false,
    compile: true,
  },
  {
    id: 'nsh',
    suites: ['nsh'],
    runner: 'ubuntu-latest',
    workspace: 'nsh',
    dependencies: 'headless',
    javascript: false,
    compile: true,
  },
  {
    id: 'linux-nsh',
    suites: ['linux-nsh'],
    runner: 'ubuntu-latest',
    workspace: 'nsh',
    dependencies: 'headless',
    javascript: false,
    compile: true,
  },
  ...['ubuntu', 'macos', 'windows'].map((os) => ({
    id: `native-${os}`,
    suites:
      os === 'windows'
        ? [
            'native',
            'windows-shell',
            'windows-desktop',
            'windows-skills',
            'windows-nsh',
            'windows-ci',
            'desktop',
            'pixels',
          ]
        : os === 'macos'
          ? [
              'native',
              'macos-host',
              'macos-terminal',
              'macos-desktop',
              'macos-nsh',
              'macos-surface',
              'desktop',
              'pixels',
            ]
          : ['native'],
    runner: `${os}-latest`,
    workspace: 'root',
    dependencies: os === 'ubuntu' ? 'computer-use' : '',
    javascript: os === 'windows' || os === 'macos',
    compile: true,
  })),
];
