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

import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import {
  controlledProcessEnvironment,
  execTar,
  verifySourceCandidate,
} from '../asf-source-release.mjs';
import { npmSpawnOptions } from '../npm-spawn.mjs';
import { parseProductReleaseVersion } from '../release-version.mjs';
import { buildCli, desktopShell, rustTarget } from './build-cli.mjs';
import { nativeCliTargets, packNativeCli } from './pack-cli.mjs';
import { verifyNotices } from './notices.mjs';
import { buildV8 } from './build-v8.mjs';

const run = promisify(execFile);

export function previewVersion(sourceVersion, buildId) {
  if (
    parseProductReleaseVersion(sourceVersion).prerelease.length > 0 ||
    typeof buildId !== 'string' ||
    !buildId
  ) {
    throw new Error('A stable source version and a SemVer build-id are required');
  }
  const version = `${sourceVersion}-rust-preview.${buildId}`;
  if (version.length > 256) throw new Error('Native preview version exceeds 256 characters');
  parseProductReleaseVersion(version);
  return version;
}

/** Build only the verified archive, never caller-supplied executable bytes. Does not publish. */
export async function releaseNativeCli({ source, keys, target, validator, output, buildId }) {
  const platform = Object.hasOwn(nativeCliTargets, target) ? nativeCliTargets[target] : undefined;
  if (!platform || !source || !output || !buildId) {
    throw new Error('source, supported target, output, and build-id are required');
  }
  const native = platform.os === process.platform && platform.cpu === process.arch;
  if (!native && !validator) throw new Error('Cross-target packaging requires a local validator');
  const stage = await mkdtemp(join(tmpdir(), 'maka-native-source-'));
  try {
    // Snapshot before validation so later changes to the input cannot change the build.
    const archivePath = join(stage, basename(source));
    for (const suffix of ['', '.sha512', ...(keys ? ['.asc'] : [])]) {
      await copyFile(resolve(source) + suffix, archivePath + suffix, constants.COPYFILE_EXCL);
    }
    const candidate = await verifySourceCandidate({
      archivePath,
      ...(keys ? { keysPath: resolve(keys) } : {}),
    });
    const version = previewVersion(candidate.version, buildId);
    const extraction = join(stage, 'source');
    await mkdir(extraction);
    execTar(archivePath, ['-xzf', '-C', extraction], {
      timeout: 180_000,
      windowsHide: true,
    });
    const repositoryRoot = join(extraction, candidate.rootDirectory);
    // JS must come from this install, not an ambient MAKA_JS_DEPS checkout.
    const env = controlledProcessEnvironment({
      excludedPrefixes: ['BINDGEN_EXTRA_CLANG_ARGS'],
      excludedNames: [
        'MAKA_JS_DEPS',
        'CARGO_BUILD_TARGET',
        'MAKA_NATIVE_PACKAGE_VERSION',
        'RUSTY_V8_ARCHIVE',
        'RUSTY_V8_SRC_BINDING_PATH',
        'RUSTY_V8_MIRROR',
        'V8_FROM_SOURCE',
        'V8_FORCE_DEBUG',
        'GN_ARGS',
        'EXTRA_GN_ARGS',
        'DISABLE_CLANG',
        'CLANG_BASE_PATH',
      ],
      overrides: {
        MAKA_JS_DEPS: repositoryRoot,
        MAKA_NATIVE_PACKAGE_VERSION: version,
        // cargo-config2 (used by zigbuild) treats an empty config wrapper as an
        // executable, but honors Cargo's empty environment override correctly.
        RUSTC_WRAPPER: '',
        RUSTC_WORKSPACE_WRAPPER: '',
      },
    });
    const metadata = JSON.parse(
      (
        await run('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1'], {
          cwd: repositoryRoot,
          env,
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
          timeout: 180_000,
          windowsHide: true,
        })
      ).stdout,
    );
    const cli = metadata.packages.find((pkg) => pkg.name === 'maka-cli');
    if (cli?.version !== candidate.version) {
      throw new Error('Native CLI version does not match the source archive');
    }
    const reviewedNotices = await verifyNotices(repositoryRoot);
    if (platform.os === 'darwin') {
      const sdk = (
        await run('xcrun', ['--sdk', 'macosx', '--show-sdk-version'], { env })
      ).stdout.trim();
      if (!(Number.parseInt(sdk, 10) >= 26))
        throw new Error('Native macOS packaging requires Xcode 26 or newer; selected SDK: ' + sdk);
    }
    // Apply build-time dependency patches without running package lifecycle hooks.
    await execute(
      'npm',
      ['ci', '--include=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund'],
      npmSpawnOptions({ cwd: repositoryRoot, env }),
    );
    await execute(process.execPath, ['scripts/apply-dependency-patches.mjs'], {
      cwd: repositoryRoot,
      env,
    });
    const v8 = await buildV8({
      root: repositoryRoot,
      directory: join(stage, 'v8'),
      cache: resolve(env.CARGO_TARGET_DIR || 'target', 'v8'),
      target: rustTarget(platform.os, platform.cpu),
      env,
      metadata: JSON.parse(
        (
          await run(
            'cargo',
            [
              'metadata',
              '--locked',
              '--format-version',
              '1',
              '--filter-platform',
              rustTarget(platform.os, platform.cpu),
            ],
            {
              cwd: repositoryRoot,
              env,
              maxBuffer: 16 * 1024 * 1024,
              timeout: 600_000,
            },
          )
        ).stdout,
      ),
    });
    const notices = join(stage, 'THIRD_PARTY_NOTICES.txt');
    const sysroot = (
      await run('rustc', ['--print', 'sysroot'], { cwd: repositoryRoot, env })
    ).stdout.trim();
    const rustNotices = await readFile(
      join(sysroot, 'share/doc/rust/COPYRIGHT-library.html'),
      'utf8',
    );
    await writeFile(
      notices,
      [await readFile(reviewedNotices, 'utf8'), v8.notices, rustNotices].join('\n\n'),
    );
    const binary = await buildCli({
      release: true,
      target: rustTarget(platform.os, platform.cpu),
      repositoryRoot,
      env: { ...env, ...v8.environment },
    });
    if (native) {
      const { stdout } = await run(
        join(dirname(binary), desktopShell(platform.os)),
        ['--version'],
        {
          timeout: 15_000,
          windowsHide: true,
        },
      );
      if (stdout.trim() !== 'maka-desktop-shell ' + candidate.version)
        throw new Error('Built desktop shell reports another source version');
      const executables = [
        binary,
        ...(platform.os === 'win32' ? [join(dirname(binary), 'maka-service.exe')] : []),
      ];
      for (const [index, executable] of executables.entries()) {
        const { stdout } = await run(executable, ['--version'], {
          timeout: 15_000,
          windowsHide: true,
        });
        if (stdout.trim() !== 'maka ' + candidate.version)
          throw new Error('Built CLI reports another source version');
        await verifyCode(executable, join(stage, 'smoke-' + index + '.sqlite'));
      }
    }
    return await packNativeCli({
      target,
      version,
      binary,
      notices,
      validator: validator ?? binary,
      output,
      repositoryRoot,
      source: { archive: basename(source), version: candidate.version, sha512: candidate.digest },
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function verifyCode(executable, log) {
  const stdout = await new Promise((resolveOutput, reject) => {
    const child = execFile(
      executable,
      ['code', '--log', log],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolveOutput(stdout)),
    );
    child.stdin.end(
      'if (Math.abs(Math.sin(1) - 0.8414709848078965) > 1e-15 || Math.cos(0) !== 1 || !new Intl.DateTimeFormat("en").format(new Date(0)) || Temporal.PlainDate.from("2026-09-28").year !== 2026) throw new Error("V8 smoke failed");',
    );
    child.stdin.on('error', reject);
  });
  if (JSON.parse(stdout).output?.ok !== true) throw new Error('Built CLI failed its real V8 smoke');
}

async function execute(command, args, options) {
  await new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveCommand();
      else reject(new Error('Native source build failed: ' + command + ' ' + (signal ?? code)));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: Object.fromEntries(
      ['source', 'keys', 'target', 'validator', 'output', 'build-id'].map((name) => [
        name,
        { type: 'string' },
      ]),
    ),
  });
  console.log(JSON.stringify(await releaseNativeCli({ ...values, buildId: values['build-id'] })));
}
