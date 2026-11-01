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

import {
  copyFileSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { command } from './command.mjs';
import { manifests, suites } from './suites.mjs';

export function executor(root, worker = {}) {
  const target = resolve(root, process.env.CARGO_TARGET_DIR ?? 'target');
  const env = { ...process.env, CARGO_TARGET_DIR: target };
  if (['nsh', 'gpui'].includes(worker.workspace) || worker.id?.startsWith('native-')) {
    Object.assign(env, {
      CARGO_BUILD_JOBS: '2',
      CARGO_INCREMENTAL: '0',
      CARGO_PROFILE_DEV_DEBUG: '0',
    });
    if (['nsh', 'gpui'].includes(worker.workspace)) env.CARGO_PROFILE_TEST_DEBUG = '0';
  }
  const run = (exe, args, options = {}) => command(exe, args, { cwd: root, env, ...options });
  const node = (args) => run(process.execPath, args);
  const cargo = (args, options) => run('cargo', args, options);
  const nextest = (id, noRun = false, filter = suites[id].filter ?? 'all()', extra = []) =>
    cargo(
      [
        'nextest',
        'run',
        ...suites[id].cargoArgs,
        ...(filter === 'all()' ? [] : ['-E', filter]),
        ...(noRun ? ['--no-run'] : []),
        ...extra,
      ],
      { env: { ...env, NEXTEST_PROFILE: suites[id].profile ?? 'default' } },
    );

  async function check(id) {
    if (id === 'format') {
      await cargo(['fmt', '--all', '--', '--check']);
      await node(['node_modules/@biomejs/biome/bin/biome', 'format', '.']);
    } else if (id === 'lint-js') {
      await node(['node_modules/@biomejs/biome/bin/biome', 'lint', '.']);
    } else if (id === 'tooling-tests') {
      await node([
        '--test',
        ...globSync(
          [
            'scripts/*.test.mjs',
            'scripts/rust/*.test.mjs',
            'products/maka/workbench/tests/*.test.mjs',
            'packages/cli/tests/*.test.mjs',
          ],
          { cwd: root },
        ).sort(),
      ]);
    } else if (id === 'licenses') {
      for (const script of [
        'scripts/asf-license-headers.mjs',
        'scripts/rust/dependencies.mjs',
        'scripts/rust/notices.mjs',
      ])
        await node([script, 'check']);
    } else {
      throw new Error(`Unknown check: ${id}`);
    }
  }

  async function prepare(id, filter, extra = []) {
    if (['root', 'desktop', 'gpui'].includes(id)) {
      await nextest(id, true, filter, extra);
    } else if (id === 'bridge') {
      await node(['scripts/rust/check-cua-build.mjs']);
      await cargo(['build', '--locked', '-p', 'maka-cli', '--no-default-features']);
      mkdirSync(join(target, 'ci'), { recursive: true });
      copyFileSync(join(target, 'debug/maka'), join(target, 'ci/maka-bridge'));
      await nextest(id, true);
    } else if (id === 'clippy') {
      await cargo([
        'clippy',
        '--config',
        'build.warnings="deny"',
        '--locked',
        '--workspace',
        '--all-targets',
      ]);
    } else if (id === 'native-build') {
      await node(['scripts/rust/build-cli.mjs']);
      await run(join(target, 'debug/maka'), ['--version']);
      await run(join(target, 'debug/maka'), ['desktop', '--version']);
      await run(join(target, 'debug/maka-desktop-shell'), ['--version']);
    } else if (id === 'contracts') {
      await cargo(['build', '--locked', '-p', 'maka-schema']);
      await cargo(['build', '--locked', '-p', 'maka-workbench', '--example', 'ui_types']);
    } else if (id === 'product') {
      await cargo(['build', '--locked', '-p', 'maka-ui-build', '--bin', 'maka-ui-build']);
    } else if (id === 'termina') {
      await run('rustup', ['target', 'add', 'x86_64-pc-windows-msvc']);
      const args = [
        'check',
        '--locked',
        '--manifest-path',
        manifests.termina,
        '--lib',
        '--target',
        'x86_64-pc-windows-msvc',
      ];
      await cargo(args);
      await cargo([...args, '--features', 'windows-legacy']);
      await nextest(id, true);
    } else if (id === 'nsh') {
      await nextest(id, true);
      await cargo(['nextest', 'run', ...webTextArgs, '--no-run']);
    } else if (id === 'native') {
      await cargo([
        'check',
        '--locked',
        '-p',
        'maka-computer-use',
        '--lib',
        '--features',
        'native-desktop',
      ]);
    } else if (id !== 'tooling') {
      throw new Error(`Unknown suite: ${id}`);
    }
  }

  async function verify(id, filter, extra = []) {
    if (id === 'tooling') {
      for (const name of ['format', 'lint-js', 'tooling-tests', 'licenses']) await check(name);
    } else if (id === 'root') {
      await nextest(id, false, filter, extra);
    } else if (id === 'bridge') {
      await run(join(target, 'ci/maka-bridge'), ['--version']);
      await nextest(id);
    } else if (id === 'desktop' || id === 'gpui') {
      await nextest(id, false, filter, ['-j', '1', ...extra]);
    } else if (id === 'termina') {
      await nextest(id);
    } else if (id === 'contracts') {
      await node(['packages/plugin-sdk/scripts/generate.mjs', 'check']);
      await node([
        'node_modules/typescript/bin/tsc',
        '-p',
        'packages/plugin-sdk/tsconfig.json',
        '--noEmit',
      ]);
      await node([
        'node_modules/typescript/bin/tsc',
        '-p',
        'packages/plugin-sdk/tsconfig.acceptance.json',
      ]);
      await node(['node_modules/typescript/bin/tsc', '-p', 'products/maka/bundle/tsconfig.json']);
      const temporary = mkdtempSync(join(tmpdir(), 'maka-ci-types-'));
      try {
        const output = join(temporary, 'ui-types');
        await cargo([
          'run',
          '--locked',
          '-q',
          '-p',
          'maka-workbench',
          '--example',
          'ui_types',
          '--',
          output,
        ]);
        await node(['node_modules/typescript/bin/tsc', '-p', join(output, 'tsconfig.json')]);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    } else if (id === 'product') {
      await node(['scripts/rust/product.mjs', 'test']);
    } else if (id === 'nsh') {
      await nextest(id);
      await cargo(['test', ...suites.nsh.cargoArgs, '--doc']);
      await cargo(['nextest', 'run', ...webTextArgs]);
      const chrome = (
        await run(
          'sh',
          ['-c', 'command -v google-chrome || command -v chromium || command -v chromium-browser'],
          { capture: true },
        )
      ).trim();
      await run(chrome, ['--version']);
      await node(['--test', 'third-party/nsh/crates/nsh-platform-web/web/nsh.test.mjs']);
      await run(
        process.execPath,
        ['--test', 'third-party/nsh/crates/nsh-platform-web/web/shader-browser.test.mjs'],
        { env: { ...env, CHROME: chrome } },
      );
    } else if (!['clippy', 'native', 'native-build'].includes(id)) {
      throw new Error(`Unknown suite: ${id}`);
    }
  }

  async function archive(plan, output) {
    const args = suites.root.cargoArgs;
    const listing = JSON.parse(
      await cargo(
        ['nextest', 'list', ...args, '-E', plan.suites.root.filter, '--message-format', 'json'],
        { capture: true },
      ),
    );
    const selected = Object.values(listing['rust-suites']).filter((suite) =>
      Object.values(suite.testcases).some(
        (entry) => !entry.ignored && entry['filter-match'].status === 'matches',
      ),
    );
    const count = selected
      .flatMap((suite) => Object.values(suite.testcases))
      .filter((entry) => !entry.ignored && entry['filter-match'].status === 'matches').length;
    if (!count && plan.suites.root.filter === 'all()')
      throw new Error('The full root test selection was unexpectedly empty');
    const config = readFileSync(join(root, '.config/nextest.toml'), 'utf8');
    const runtimePackages = new Set(
      selected
        .filter((suite) => ['maka-cli', 'maka-terminal-shell'].includes(suite['package-name']))
        .map((suite) => suite['package-id']),
    );
    const includes = [];
    for (const [id, path] of Object.entries(listing['rust-build-meta']['build-script-out-dirs'])) {
      if (runtimePackages.has(id)) includes.push(`${path}/product`);
    }
    const temporary = mkdtempSync(join(tmpdir(), 'maka-ci-archive-'));
    try {
      const configFile = join(temporary, 'nextest.toml');
      writeFileSync(
        configFile,
        `${config}\n[profile.ci.archive]\ninclude = [\n${includes.map((path) => `{ path = ${JSON.stringify(path)}, relative-to = "target", depth = "infinite", on-missing = "error" },`).join('\n')}\n]\n`,
      );
      mkdirSync(dirname(output), { recursive: true });
      await cargo([
        'nextest',
        'archive',
        ...args,
        '--profile',
        'ci',
        '--config-file',
        configFile,
        '-E',
        plan.suites.root.filter,
        '--archive-file',
        output,
      ]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    // Two runners remove the existing single-runner heavy-fixture bottleneck.
    const partitions = Math.min(2, count);
    return Array.from({ length: partitions }, (_, index) => ({
      partition: `slice:${index + 1}/${partitions}`,
    }));
  }

  return { prepare, verify, check, archive, run, target };
}

const webTextArgs = [
  '--locked',
  '--manifest-path',
  manifests.nsh,
  '-p',
  'nsh-platform-web',
  '--no-default-features',
  '--test',
  'text',
];
