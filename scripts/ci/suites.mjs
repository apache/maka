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
  gpui: 'third-party/nsh/crates/gpui/Cargo.toml',
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
  'plugins/shared',
  'scripts/plugins',
  'scripts/rust/product.mjs',
];
const embeddedInputs = [
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
    extraInputs: embeddedInputs,
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
      'integration',
    ],
    filter: 'test(terminal::desktop_new_session)',
    extraInputs: embeddedInputs,
  },
  clippy: {
    workspace: 'root',
    packages: 'workspace',
    extraInputs: embeddedInputs,
  },
  contracts: {
    workspace: 'root',
    packages: ['maka-schema', 'maka-workbench'],
    extraInputs: [...productInputs, 'skills/maka-plugin-authoring/assets'],
  },
  product: {
    workspace: 'root',
    packages: ['maka-ui-build'],
    extraInputs: productInputs,
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
      'nsh-base',
      'nsh-engine',
      'nsh-js',
      'nsh-testing',
      'nsh-platform-tui',
      'nsh-dev',
      'nsh-bundler',
      'nsh-platform-web',
    ],
    cargoArgs: [
      '--locked',
      '--manifest-path',
      manifests.nsh,
      '-p',
      'nsh-core',
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
      'nsh-dev',
      '-p',
      'nsh-bundler',
      '--features',
      'nsh-testing/agent,nsh-dev/client,nsh-dev/server',
    ],
    extraInputs: ['third-party/nsh/crates/nsh-platform-web/web'],
  },
  gpui: {
    workspace: 'gpui',
    packages: ['nsh-platform-gpui', 'nsh-gpui-terminal'],
    cargoArgs: [
      '--locked',
      '--manifest-path',
      manifests.gpui,
      '-p',
      'nsh-platform-gpui',
      '-p',
      'nsh-gpui-terminal',
      '--no-default-features',
      '--features',
      'nsh-platform-gpui/js,nsh-platform-gpui/shot',
      '--lib',
    ],
    filter:
      'test(native::tests::animated_props_) | test(=input::tests::nonpressable_focusable_views_join_native_stops_without_stealing_presses) | test(=tests::windows) | test(kitty::tests::)',
  },
  native: {
    workspace: 'root',
    packages: ['maka-computer-use'],
  },
};

export const workers = [
  {
    id: 'variants',
    suites: ['bridge', 'desktop'],
    runner: 'ubuntu-latest',
    workspace: 'root',
    dependencies: 'headless',
    javascript: true,
    compile: true,
  },
  {
    id: 'clippy',
    suites: ['clippy'],
    runner: 'ubuntu-latest',
    workspace: 'root',
    dependencies: 'headless',
    javascript: true,
    compile: true,
  },
  {
    id: 'product',
    suites: ['contracts', 'product'],
    runner: 'ubuntu-latest',
    workspace: 'root',
    dependencies: 'headless',
    javascript: true,
    compile: true,
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
    id: 'gpui',
    suites: ['gpui'],
    runner: 'ubuntu-latest',
    workspace: 'gpui',
    dependencies: 'gpui',
    javascript: false,
    compile: true,
  },
  ...['ubuntu', 'macos', 'windows'].map((os) => ({
    id: `native-${os}`,
    suites: ['native'],
    runner: `${os}-latest`,
    workspace: 'root',
    dependencies: os === 'ubuntu' ? 'computer-use' : '',
    javascript: false,
    compile: true,
  })),
];
