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

import { spawn } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { command } from './command.mjs';
import { manifests, suites, taskHelperBinaries, taskHelperConsumers } from './suites.mjs';

export async function runSuites(ids, execute) {
  const failures = [];
  for (const id of ids) {
    try {
      await execute(id);
    } catch (cause) {
      failures.push(new Error(`CI suite ${id} failed`, { cause }));
    }
  }
  if (failures.length) throw new AggregateError(failures, 'CI suites failed');
}

const buildValues = new Set([
  '-p',
  '--package',
  '--exclude',
  '--bin',
  '--example',
  '--test',
  '--bench',
  '-F',
  '--features',
  '--build-jobs',
  '--cargo-profile',
  '--target',
  '--target-dir',
  '--manifest-path',
  '--cargo-message-format',
  '-Z',
]);
const buildFlags = new Set([
  '--workspace',
  '--all',
  '--lib',
  '--bins',
  '--examples',
  '--tests',
  '--benches',
  '--all-targets',
  '--all-features',
  '--no-default-features',
  '-r',
  '--release',
  '--unit-graph',
  '--timings',
  '--frozen',
  '--locked',
  '--offline',
  '--cargo-quiet',
  '--cargo-verbose',
  '--ignore-rust-version',
  '--future-incompat-report',
]);
const sharedValues = new Set(['--color', '--config', '--user-config-file', '--tool-config-file']);
const sharedFlags = new Set(['--no-pager', '-v', '--verbose', '--override-version-check']);
const filterValues = new Set(['-E', '--filterset', '--filter-expr']);

function rootArguments(extra) {
  const build = [],
    runtime = [],
    filters = [];
  let configFile, profile;
  for (let index = 0; index < extra.length; index++) {
    const argument = extra[index];
    if (argument === '--') {
      runtime.push(...extra.slice(index));
      break;
    }
    const attached = /^-([pFZPE])(.+)$/.exec(argument);
    const name = attached ? `-${attached[1]}` : argument.split('=', 1)[0];
    let value = attached
      ? attached[2].replace(/^=/, '')
      : argument.includes('=')
        ? argument.slice(argument.indexOf('=') + 1)
        : undefined;
    const values = [argument];
    if (
      (buildValues.has(name) ||
        sharedValues.has(name) ||
        filterValues.has(name) ||
        ['--config-file', '--profile', '-P'].includes(name)) &&
      value === undefined
    ) {
      value = extra[++index];
      if (value === undefined) throw new Error(`Missing value for ${name}`);
      values.push(value);
    }
    if (name === '--config-file') configFile = value;
    if (name === '--profile' || name === '-P') profile = value;
    if (
      buildValues.has(name) ||
      buildFlags.has(name) ||
      sharedValues.has(name) ||
      sharedFlags.has(name)
    )
      build.push(...values);
    if (!buildValues.has(name) && !buildFlags.has(name)) runtime.push(...values);
    if (filterValues.has(name)) filters.push(...values);
  }
  return { build, runtime, filters, configFile, profile };
}

function runtimeHelpers(listing, binaries) {
  if (!binaries.some((suite) => taskHelperConsumers.includes(suite['package-name']))) return [];
  const metadata = listing['rust-build-meta'];
  return taskHelperBinaries.map((artifact) => {
    const packages = new Set(
      Object.values(listing['rust-suites'])
        .filter((suite) => suite['package-name'] === artifact.package)
        .map((suite) => suite['package-id']),
    );
    if (packages.size !== 1)
      throw new Error(`Expected one native runtime package in test metadata: ${artifact.package}`);
    const [packageId] = packages;
    const candidates = (metadata['non-test-binaries']?.[packageId] ?? []).filter(
      (binary) =>
        binary.name === artifact.binary &&
        binary.kind === 'bin-exe' &&
        binary['build-platform'] === 'target',
    );
    if (!candidates.length)
      throw new Error(
        `Missing native runtime binary metadata: ${artifact.package}/${artifact.binary}`,
      );
    if (candidates.length !== 1)
      throw new Error(
        `Ambiguous native runtime binary metadata: ${artifact.package}/${artifact.binary}`,
      );
    const [{ path }] = candidates;
    const target = metadata['target-directory'];
    if (typeof path !== 'string' || isAbsolute(path))
      throw new Error(`Native runtime binary path is not target-relative: ${path}`);
    const helper = resolve(target, path);
    const targetPath = relative(target, helper);
    if (
      !targetPath ||
      isAbsolute(targetPath) ||
      targetPath === '..' ||
      targetPath.startsWith(`..${sep}`)
    )
      throw new Error(`Native runtime binary is outside the archive target directory: ${path}`);
    if (!statSync(helper).isFile())
      throw new Error(`Native runtime binary is not a file: ${helper}`);
    return {
      package: artifact.package,
      name: artifact.binary,
      kind: 'bin-exe',
      'build-platform': 'target',
      path: targetPath.replaceAll('\\', '/'),
    };
  });
}

function archiveConfiguration(config, listing, binaries, profile = 'ci', inherits) {
  const runtimePackages = new Set(
    binaries
      .filter((suite) => ['maka-cli', 'maka-terminal-shell'].includes(suite['package-name']))
      .map((suite) => suite['package-id']),
  );
  const metadata = listing['rust-build-meta'];
  const resources = [];
  for (const [id, path] of Object.entries(metadata['build-script-out-dirs'])) {
    if (runtimePackages.has(id)) resources.push(`${path}/product`);
  }
  const includes = new Set(resources);
  const helpers = runtimeHelpers(listing, binaries);
  for (const helper of helpers) {
    includes.add(helper.path);
  }
  const parent =
    inherits === undefined
      ? ''
      : `\n[profile.${JSON.stringify(profile)}]\ninherits = ${JSON.stringify(inherits)}\n`;
  return {
    contents: `${config}\n${parent}[profile.${JSON.stringify(profile)}.archive]\ninclude = [\n${[...includes].map((path) => `{ path = ${JSON.stringify(path)}, relative-to = "target", depth = "infinite", on-missing = "error" },`).join('\n')}\n]\n`,
    resources,
    helpers,
  };
}

async function archiveLock(target) {
  await using cleanup = new AsyncDisposableStack();
  const temporary = mkdtempSync(join(tmpdir(), 'maka-ci-archive-lock-'));
  cleanup.defer(() => rmSync(temporary, { recursive: true, force: true }));
  const executable = join(
    temporary,
    process.platform === 'win32' ? 'archive-lock.exe' : 'archive-lock',
  );
  await command('rustc', [
    '--edition=2024',
    '--crate-name=maka_ci_archive_lock',
    join(import.meta.dirname, 'archive-lock.rs'),
    '-o',
    executable,
  ]);
  const child = spawn(executable, [`${target}.maka-ci.lock`], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const errors = [];
  child.on('error', (error) => errors.push(error));
  child.stdin.on('error', (error) => errors.push(error));
  const closed = new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  cleanup.defer(async () => {
    try {
      child.stdin.end();
    } catch (error) {
      errors.push(error);
    }
    const { code, signal } = await closed;
    if (code !== 0 && !errors.length)
      errors.push(new Error(`Archive lock failed: ${signal ?? code}`));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Archive lock failed');
  });
  const lines = createInterface({ input: child.stdout });
  cleanup.defer(() => lines.close());
  await Promise.race([
    (async () => {
      for await (const line of lines) {
        if (line !== 'acquired') throw new Error(`Unexpected archive lock response: ${line}`);
        return;
      }
      throw new Error('Archive lock closed before acquisition');
    })(),
    closed.then(() => {
      throw errors[0] ?? new Error('Archive lock exited before acquisition');
    }),
  ]);
  return cleanup.move();
}

async function withArchiveResources(listing, resources, create) {
  const metadata = listing['rust-build-meta'];
  const target = metadata['target-directory'];
  const build = metadata['build-directory'] ?? target;
  if (build === target || !resources.length) return await create();
  await using lock = await archiveLock(target);
  await using owned = new AsyncDisposableStack();
  for (const path of resources) {
    const destination = join(target, path);
    mkdirSync(dirname(destination), { recursive: true });
    mkdirSync(destination);
    owned.defer(() => rmSync(destination, { recursive: true, force: true }));
    cpSync(join(build, path), destination, { recursive: true, dereference: true });
  }
  return await create();
}

export function executor(
  root,
  worker = {},
  { env: baseEnv = process.env, run: runCommand = command } = {},
) {
  const target = resolve(root, baseEnv.CARGO_TARGET_DIR ?? 'target');
  const env = { ...baseEnv, CARGO_TARGET_DIR: target };
  if (worker.workspace === 'nsh' || worker.id?.startsWith('native-')) {
    Object.assign(env, {
      CARGO_BUILD_JOBS: '2',
      CARGO_INCREMENTAL: '0',
      CARGO_PROFILE_DEV_DEBUG: '0',
    });
    if (worker.workspace === 'nsh') env.CARGO_PROFILE_TEST_DEBUG = '0';
  }
  const programFiles = baseEnv.ProgramFiles ?? baseEnv.PROGRAMFILES;
  const run = (exe, args, options = {}) => runCommand(exe, args, { cwd: root, env, ...options });
  const node = (args) => run(process.execPath, args);
  const cargo = (args, options) => run('cargo', args, options);
  const suiteEnv = (id) => ({
    ...env,
    ...(id === 'windows-shell'
      ? {
          LIBCLANG_PATH: env.LIBCLANG_PATH ?? join(programFiles, 'LLVM', 'bin'),
          MAKA_TEST_GIT_BASH:
            env.MAKA_TEST_GIT_BASH ?? join(programFiles, 'Git', 'bin', 'bash.exe'),
        }
      : {}),
  });
  const nextest = async (id, noRun = false, filter = suites[id].filter ?? 'all()', extra = []) => {
    const environment = suiteEnv(id);
    if (id === 'windows-shell') {
      for (const artifact of taskHelperBinaries) {
        const output = await cargo(
          [
            'build',
            '--locked',
            '-p',
            artifact.package,
            '--bin',
            artifact.binary,
            ...artifact.cargoArgs,
            '--message-format=json-render-diagnostics',
          ],
          { env: suiteEnv(id), capture: true },
        );
        const candidates = output
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line))
          .filter(
            (record) =>
              record.reason === 'compiler-artifact' &&
              record.target?.name === artifact.binary &&
              record.target.kind?.includes('bin') &&
              record.profile?.test === false &&
              record.executable != null,
          );
        if (candidates.length !== 1)
          throw new Error(
            `Expected one Cargo runtime executable: ${artifact.package}/${artifact.binary}`,
          );
        const [{ executable }] = candidates;
        if (typeof executable !== 'string' || !isAbsolute(executable))
          throw new Error(`Cargo runtime executable is not absolute: ${executable}`);
        if (!statSync(executable).isFile())
          throw new Error(`Cargo runtime executable is not a file: ${executable}`);
        environment[`CARGO_BIN_EXE_${artifact.binary}`] = executable;
      }
    }
    return cargo(
      [
        'nextest',
        'run',
        ...suites[id].cargoArgs,
        ...(filter === 'all()' ? [] : ['-E', filter]),
        ...(noRun ? ['--no-run'] : ['--no-fail-fast']),
        ...extra,
      ],
      {
        env: {
          ...environment,
          NEXTEST_PROFILE: suites[id].profile ?? 'default',
        },
      },
    );
  };

  async function check(id) {
    if (id === 'format') {
      await cargo(['fmt', '--all', '--', '--check']);
      await run('rustfmt', ['--check', '--edition', '2024', 'scripts/ci/archive-lock.rs']);
      await node(['node_modules/@biomejs/biome/bin/biome', 'format', '.']);
    } else if (id === 'tooling-tests') {
      await node([
        '--test',
        ...globSync(
          [
            'scripts/**/*.test.mjs',
            'products/maka/workbench/tests/*.test.mjs',
            'packages/cli/tests/*.test.mjs',
          ],
          { cwd: root },
        ).sort(),
      ]);
    } else if (id === 'licenses') {
      for (const script of ['scripts/asf-license-headers.mjs', 'scripts/rust/dependencies.mjs'])
        await node([script, 'check']);
    } else if (id === 'notices') {
      await node(['scripts/rust/notices.mjs', 'check-reviewed']);
    } else {
      throw new Error(`Unknown check: ${id}`);
    }
  }

  async function prepare(id, filter, extra = []) {
    if (
      [
        'root',
        'desktop',
        'pixels',
        'linux-nsh',
        'linux-desktop',
        'macos-nsh',
        'macos-surface',
        'macos-desktop',
        'windows-desktop',
        'windows-skills',
        'windows-nsh',
        'macos-host',
        'macos-agent-execution',
        'windows-shell',
      ].includes(id)
    ) {
      await nextest(id, true, filter, extra);
      if (id === 'windows-nsh') {
        await cargo([
          'check',
          '--locked',
          '--manifest-path',
          manifests.nsh,
          '-p',
          'nsh-windows-app',
          '-p',
          'nsh-windows-host',
          '-p',
          'gallery-native',
        ]);
      }
    } else if (id === 'bridge') {
      await node(['scripts/rust/check-cua-build.mjs']);
      await cargo(['build', '--locked', '-p', 'maka-cli', '--no-default-features']);
      mkdirSync(join(target, 'ci'), { recursive: true });
      copyFileSync(join(target, 'debug/maka'), join(target, 'ci/maka-bridge'));
      await nextest(id, true);
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
      await runSuites(['native', 'web-text', 'wasm'], async (stage) => {
        if (stage === 'native') await nextest(id, true);
        else if (stage === 'web-text') await cargo(['nextest', 'run', ...webTextArgs, '--no-run']);
        else {
          await run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
          await cargo(
            [
              'check',
              '--locked',
              '-p',
              'nsh-platform-web',
              '--target',
              'wasm32-unknown-unknown',
              '--no-default-features',
              '--features',
              'browser,linkable,dev,compiler,browser-tests',
            ],
            { cwd: join(root, 'third-party/nsh') },
          );
        }
      });
    } else if (id === 'native') {
      if (process.platform === 'darwin') await nextest(id, true, filter, extra);
      else await cargo(['check', ...suites.native.cargoArgs]);
    } else if (!['tooling', 'windows-ci'].includes(id)) {
      throw new Error(`Unknown suite: ${id}`);
    }
  }

  async function verify(id, filter, extra = []) {
    if (id === 'tooling') {
      for (const name of ['format', 'tooling-tests', 'licenses']) await check(name);
    } else if (id === 'windows-ci') {
      await node(['--test', 'scripts/ci.test.mjs']);
    } else if (id === 'macos-agent-execution') {
      await verifyRoot(filter ?? suites[id].filter, ['--test-threads', '1', ...extra], id);
    } else if (id === 'desktop') {
      await verifyRoot(filter ?? suites[id].filter, ['--test-threads', '1', ...extra], id);
    } else if (id === 'macos-host') {
      await nextest(id);
      await node([
        '--test',
        'scripts/rust/build-cli.test.mjs',
        'scripts/rust/pack-cli.test.mjs',
        'scripts/rust/run-cli.test.mjs',
      ]);
    } else if (id === 'root') {
      await verifyRoot(filter ?? 'all()', extra);
    } else if (id === 'windows-shell') {
      await nextest(id, false, filter, extra);
    } else if (id === 'bridge') {
      await run(join(target, 'ci/maka-bridge'), ['--version']);
      await nextest(id);
    } else if (
      [
        'desktop',
        'pixels',
        'macos-desktop',
        'macos-nsh',
        'macos-surface',
        'windows-desktop',
        'windows-skills',
        'windows-nsh',
      ].includes(id)
    ) {
      await nextest(id, false, filter, ['--no-tests=fail', '-j', '1', ...extra]);
    } else if (id === 'linux-desktop') {
      await run('xvfb-run', [
        '-a',
        'dbus-run-session',
        '--',
        'cargo',
        'nextest',
        'run',
        ...suites[id].cargoArgs,
        '--no-tests=fail',
        '--no-fail-fast',
        '--run-ignored=all',
        '-j',
        '1',
        ...extra,
      ]);
    } else if (id === 'linux-nsh') {
      await run('xvfb-run', [
        '-a',
        'cargo',
        'nextest',
        'run',
        ...suites[id].cargoArgs,
        '--no-tests=fail',
        '--no-fail-fast',
        '-j',
        '1',
      ]);
    } else if (id === 'termina') {
      await nextest(id);
    } else if (id === 'native' && process.platform === 'darwin') {
      await nextest(id, false, filter, extra);
    } else if (id === 'contracts') {
      await node(['packages/plugin-sdk/scripts/generate.mjs', 'check']);
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
      await check('notices');
    } else if (id === 'nsh') {
      await runSuites(['native', 'docs', 'web-text', 'bootstrap', 'browser'], async (stage) => {
        if (stage === 'native') await nextest(id);
        else if (stage === 'docs')
          await cargo(['test', ...suites.nsh.cargoArgs, '--doc', '--no-fail-fast']);
        else if (stage === 'web-text')
          await cargo(['nextest', 'run', ...webTextArgs, '--no-fail-fast']);
        else if (stage === 'bootstrap')
          await cargo([
            'run',
            '--locked',
            '--manifest-path',
            manifests.nsh,
            '-p',
            'nsh-bundler',
            '--example',
            'browser_bootstrap',
            '--',
            '--check',
          ]);
        else
          await node([
            '--test',
            'third-party/nsh/crates/nsh-platform-web/web/nsh.test.mjs',
            'third-party/nsh/crates/nsh-platform-web/web/browser/dom.test.mjs',
          ]);
      });
    } else if (!['native', 'native-build'].includes(id)) {
      throw new Error(`Unknown suite: ${id}`);
    }
  }

  async function prepareRuntimeHelpers(listing, binaries, args) {
    if (!binaries.some((suite) => taskHelperConsumers.includes(suite['package-name']))) return;
    const metadata = listing['rust-build-meta'];
    const missing = taskHelperBinaries.flatMap((artifact) => {
      const packages = new Set(
        Object.values(listing['rust-suites'])
          .filter((suite) => suite['package-name'] === artifact.package)
          .map((suite) => suite['package-id']),
      );
      if (packages.size !== 1)
        throw new Error(
          `Expected one native runtime package in test metadata: ${artifact.package}`,
        );
      const [packageId] = packages;
      const found = (metadata['non-test-binaries']?.[packageId] ?? []).filter(
        (binary) =>
          binary.name === artifact.binary &&
          binary.kind === 'bin-exe' &&
          binary['build-platform'] === 'target',
      );
      if (found.length > 1)
        throw new Error(
          `Ambiguous native runtime binary metadata: ${artifact.package}/${artifact.binary}`,
        );
      return found.length ? [] : [{ artifact, packageId }];
    });
    if (!missing.length) return;
    // Non-test workers are not emitted by cargo test. Build the real programs
    // with the consumer's workspace feature selection and retain Cargo evidence.
    const output = await cargo(
      ['build', ...args, '--bins', '--message-format=json-render-diagnostics'],
      { capture: true },
    );
    const artifacts = output
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    for (const { artifact, packageId } of missing) {
      const candidates = artifacts.filter(
        (built) =>
          built.reason === 'compiler-artifact' &&
          built.package_id === packageId &&
          built.target?.name === artifact.binary &&
          built.target.kind.includes('bin') &&
          !built.profile.test &&
          typeof built.executable === 'string',
      );
      if (candidates.length !== 1)
        throw new Error(
          `Missing or ambiguous compiled runtime helper: ${artifact.package}/${artifact.binary}`,
        );
      const [{ executable }] = candidates;
      const path = relative(metadata['target-directory'], executable);
      if (
        !isAbsolute(executable) ||
        !path ||
        isAbsolute(path) ||
        path === '..' ||
        path.startsWith(`..${sep}`)
      )
        throw new Error(
          `Compiled runtime helper is outside the archive target directory: ${executable}`,
        );
      metadata['non-test-binaries'] ??= {};
      metadata['non-test-binaries'][packageId] ??= [];
      metadata['non-test-binaries'][packageId].push({
        name: artifact.binary,
        kind: 'bin-exe',
        'build-platform': 'target',
        path: path.replaceAll('\\', '/'),
      });
    }
  }

  async function verifyRoot(filter, extra, id = 'root') {
    const separator = extra.indexOf('--');
    if (
      extra
        .slice(0, separator < 0 ? extra.length : separator)
        .some((arg) => ['--help', '-h', '--no-run'].includes(arg))
    ) {
      await nextest(id, false, filter, extra);
      return;
    }
    const {
      build,
      runtime,
      filters,
      configFile,
      profile = suites[id].profile ?? suites.root.profile,
    } = rootArguments(extra);
    const temporary = mkdtempSync(join(tmpdir(), 'maka-ci-run-'));
    try {
      const listing = JSON.parse(
        await cargo(
          [
            'nextest',
            'list',
            ...suites[id].cargoArgs,
            ...build,
            ...(filter === 'all()' ? [] : ['-E', filter]),
            ...filters,
            '--config-file',
            resolve(root, configFile ?? '.config/nextest.toml'),
            '--profile',
            profile,
            '--message-format',
            'json',
          ],
          { capture: true },
        ),
      );
      const binaries = Object.values(listing['rust-suites']).filter((suite) =>
        Object.values(suite.testcases).some(
          (entry) => !entry.ignored && entry['filter-match'].status === 'matches',
        ),
      );
      if (!binaries.length)
        throw new Error(`The planned ${id} test selection was unexpectedly empty: ${filter}`);
      const archiveFilter = binaries
        .map((suite) => `binary_id(=${suite['binary-id']})`)
        .join(' | ');
      const config = join(temporary, 'nextest.toml');
      const archiveProfile = basename(temporary);
      await prepareRuntimeHelpers(listing, binaries, [...suites[id].cargoArgs, ...build]);
      const generated = archiveConfiguration(
        readFileSync(resolve(root, configFile ?? '.config/nextest.toml'), 'utf8'),
        listing,
        binaries,
        archiveProfile,
        profile,
      );
      writeFileSync(config, generated.contents);
      const archive = join(temporary, 'tests.tar.zst');
      await withArchiveResources(listing, generated.resources, () =>
        cargo([
          'nextest',
          'archive',
          ...suites[id].cargoArgs,
          ...build,
          '-E',
          archiveFilter,
          '--profile',
          archiveProfile,
          '--config-file',
          config,
          '--archive-file',
          archive,
        ]),
      );
      const extraction = join(temporary, 'run');
      await replay(archive, extraction, generated.helpers, [
        ...(filter === 'all()' ? [] : ['-E', filter]),
        ...runtime,
      ]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  async function replay(archive, extraction, helpers, extra = []) {
    if (!Array.isArray(helpers)) throw new Error('Missing archive runtime helper metadata');
    mkdirSync(extraction, { recursive: true });
    const reuse = [
      '--archive-file',
      archive,
      '--extract-to',
      extraction,
      '--extract-overwrite',
      '--workspace-remap',
      root,
    ];
    const listing = JSON.parse(
      await cargo(['nextest', 'list', ...reuse, '--message-format', 'json'], { capture: true }),
    );
    const metadata = listing['rust-build-meta'];
    const required = Object.values(listing['rust-suites']).some((suite) =>
      taskHelperConsumers.includes(suite['package-name']),
    )
      ? taskHelperBinaries
      : [];
    if (helpers.length !== required.length)
      throw new Error('Runtime helper metadata differs from archive consumers');
    const target = metadata['target-directory'];
    const helperEnv = {};
    for (const artifact of required) {
      const candidates = helpers.filter(
        (helper) =>
          helper?.package === artifact.package &&
          helper.name === artifact.binary &&
          helper.kind === 'bin-exe' &&
          helper['build-platform'] === 'target',
      );
      if (candidates.length !== 1)
        throw new Error(
          `Invalid archive runtime helper metadata: ${artifact.package}/${artifact.binary}`,
        );
      const [{ path }] = candidates;
      if (typeof path !== 'string' || isAbsolute(path))
        throw new Error(`Native runtime binary path is not target-relative: ${path}`);
      const executable = resolve(target, path);
      const targetPath = relative(target, executable);
      if (
        !targetPath ||
        isAbsolute(targetPath) ||
        targetPath === '..' ||
        targetPath.startsWith(`..${sep}`)
      )
        throw new Error(`Native runtime binary is outside the archive target directory: ${path}`);
      if (!statSync(executable).isFile())
        throw new Error(`Native runtime binary is not a file: ${executable}`);
      helperEnv[`CARGO_BIN_EXE_${artifact.binary}`] = executable;
    }
    mkdirSync(join(metadata['target-directory'], 'tmp'), { recursive: true });
    await cargo(['nextest', 'run', ...reuse, ...extra], {
      env: { ...env, NEXTEST_PROFILE: suites.root.profile, ...helperEnv },
    });
  }

  async function archive(plan, output, id = 'root') {
    const args = suites[id].cargoArgs;
    const listing = JSON.parse(
      await cargo(
        ['nextest', 'list', ...args, '-E', plan.suites[id].filter, '--message-format', 'json'],
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
    console.log(`Selected ${count} ${id} tests for archive replay`);
    if (!count)
      throw new Error(
        `The planned ${id} test selection was unexpectedly empty: ${plan.suites[id].filter}`,
      );
    await prepareRuntimeHelpers(listing, selected, args);
    const config = readFileSync(join(root, '.config/nextest.toml'), 'utf8');
    const groups = [];
    for (const [group, shards, name] of [
      ['native', 8, 'maka-agent-native'],
      ['cli', 6, 'maka-cli'],
    ]) {
      groups.push({
        group,
        shards,
        binaries: selected.filter((suite) => suite['package-name'] === name),
      });
    }
    const remaining = selected
      .filter((binary) => !['maka-agent-native', 'maka-cli'].includes(binary['package-name']))
      .map((binary) => ({ binary, bytes: statSync(binary['binary-path']).size }))
      .sort(
        (a, b) => b.bytes - a.bytes || a.binary['binary-id'].localeCompare(b.binary['binary-id']),
      );
    const buckets = Array.from({ length: Math.min(4, remaining.length) }, () => ({
      bytes: 0,
      binaries: [],
    }));
    for (const entry of remaining) {
      const bucket = buckets.reduce((a, b) => (a.bytes <= b.bytes ? a : b));
      bucket.bytes += entry.bytes;
      bucket.binaries.push(entry.binary);
    }
    groups.push(
      ...buckets.map((bucket, index) => ({
        group: `rest-${index + 1}`,
        shards: 2,
        binaries: bucket.binaries,
      })),
    );
    const temporary = mkdtempSync(join(tmpdir(), 'maka-ci-archive-'));
    const partitions = [];
    try {
      // Balance the binaries each machine must download
      // and extract, instead of sending their entire archive to every shard.
      for (const { group, shards, binaries } of groups) {
        if (!binaries.length) continue;
        // Archives select binaries; the consumers retain the original test filter.
        const filter = binaries.map((suite) => `binary_id(=${suite['binary-id']})`).join(' | ');
        const configFile = join(temporary, 'nextest.toml');
        const generated = archiveConfiguration(config, listing, binaries);
        writeFileSync(configFile, generated.contents);
        mkdirSync(dirname(output), { recursive: true });
        await withArchiveResources(listing, generated.resources, () =>
          cargo([
            'nextest',
            'archive',
            ...args,
            '--profile',
            'ci',
            '--config-file',
            configFile,
            '-E',
            filter,
            '--archive-file',
            join(dirname(output), `root-tests-${group}.tar.zst`),
          ]),
        );
        const tests = binaries
          .flatMap((suite) => Object.values(suite.testcases))
          .filter((entry) => !entry.ignored && entry['filter-match'].status === 'matches').length;
        const total = Math.min(shards, tests);
        for (let index = 1; index <= total; index++)
          partitions.push({
            group,
            partition: `slice:${index}/${total}`,
            helpers: generated.helpers,
          });
        console.log(`Archived ${tests} ${group} tests for ${total} partitions`);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    return partitions;
  }

  return { prepare, verify, check, archive, replay, run, target };
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
