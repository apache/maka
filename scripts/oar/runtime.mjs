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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { cargoBuild } from '../rust/cargo.mjs';
import { fileURLToPath } from 'node:url';
import { buildV8 } from '../rust/build-v8.mjs';
import { digest } from '../rust/v8-cache.mjs';
import { execTar } from '../asf-source-release.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Runtime sources must not live in another Cargo workspace's disposable target.
export function runtimeDirectory(env = process.env) {
  return resolve(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'maka/oar-runtime');
}

async function sourceTree(directory, source) {
  const destination = join(directory, source.sha256);
  try {
    if ((await readFile(join(destination, 'source.sha256'), 'utf8')).trim() === source.sha256)
      return join(destination, 'deno');
    throw new Error('Deno source cache identity differs');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(directory, { recursive: true });
  const stage = await mkdtemp(join(directory, '.source-'));
  try {
    const archive = join(stage, 'source.tar.gz');
    const response = await fetch(source.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body)
      throw new Error(`Deno source download failed: ${response.status}`);
    const file = await open(archive, 'wx');
    let bytes = 0;
    const hash = createHash('sha256');
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 128 * 1024 * 1024) throw new Error('Deno source archive exceeds 128 MiB');
        hash.update(chunk);
        await file.writeFile(chunk);
      }
    } finally {
      await file.close();
    }
    if (hash.digest('hex') !== source.sha256) throw new Error('Deno source SHA-256 mismatch');
    execTar(archive, ['-xzf', '-C', stage], { timeout: 120_000 });
    await writeFile(join(stage, 'source.sha256'), source.sha256 + '\n');
    await rename(stage, destination);
    return join(destination, 'deno');
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export function runtimeCargoArgs(target) {
  const linux = target.includes('-linux-');
  if (linux && !/^(x86_64|aarch64)-unknown-linux-gnu$/.test(target))
    throw new Error('Linux releases require an x86_64 or aarch64 GNU target');
  return [
    linux ? 'zigbuild' : 'build',
    '--locked',
    '--release',
    '-p',
    'denort',
    '--bin',
    'denort',
    '--target',
    linux ? `${target}.2.28` : target,
  ];
}

/** Release-only: compile the pinned runtime against the product's reviewed V8. */
export async function buildRuntime(target, env = process.env) {
  const cargoArgs = runtimeCargoArgs(target);
  const source = JSON.parse(await readFile(join(root, 'scripts/oar/runtime-source.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.devDependencies.deno !== source.version)
    throw new Error('Deno source pin differs from the product dependency');
  const directory = runtimeDirectory(env);
  const checkout = await sourceTree(join(directory, 'source'), source);
  const cargoTarget = join(directory, 'cargo', source.sha256);
  const toolchain = env.RUSTUP_TOOLCHAIN ?? 'stable';
  const cargo = execFileSync('rustup', ['which', '--toolchain', toolchain, 'cargo'], {
    env,
    encoding: 'utf8',
  }).trim();
  const rustc = execFileSync('rustup', ['which', '--toolchain', toolchain, 'rustc'], {
    env,
    encoding: 'utf8',
  }).trim();
  const buildEnv = {
    ...env,
    // This is an independent Cargo workspace; use the product's Rust toolchain.
    RUSTUP_TOOLCHAIN: toolchain,
    RUSTC: rustc,
    CARGO_TARGET_DIR: cargoTarget,
    RUSTC_WRAPPER: '',
    RUSTC_WORKSPACE_WRAPPER: '',
  };
  const metadata = JSON.parse(
    execFileSync(
      cargo,
      [
        'metadata',
        '--locked',
        '--format-version',
        '1',
        '--manifest-path',
        'cli/rt/Cargo.toml',
        '--filter-platform',
        target,
      ],
      { cwd: checkout, env: buildEnv, maxBuffer: 32 * 1024 * 1024 },
    ),
  );
  if (resolve(metadata.target_directory) !== cargoTarget)
    throw new Error(`Cargo target directory differs: ${metadata.target_directory}`);
  const pkg = metadata.packages.find((pkg) => pkg.name === 'denort');
  if (pkg?.version !== source.version)
    throw new Error('Deno source contains another denort version');
  // Source builds and ambient V8 overrides must not replace the reviewed archive.
  for (const name of [
    'RUSTY_V8_ARCHIVE',
    'RUSTY_V8_SRC_BINDING_PATH',
    'V8_FROM_SOURCE',
    'V8_FORCE_DEBUG',
    'RUSTY_V8_MIRROR',
    'GN_ARGS',
    'EXTRA_GN_ARGS',
  ])
    delete buildEnv[name];
  const v8 = await buildV8({
    root,
    directory: join(directory, 'v8-build', target),
    cache: join(directory, 'v8'),
    target,
    env: buildEnv,
    metadata,
  });
  const { RUSTY_V8_ARCHIVE, RUSTY_V8_SRC_BINDING_PATH } = v8.environment;
  Object.assign(buildEnv, { RUSTY_V8_ARCHIVE, RUSTY_V8_SRC_BINDING_PATH });
  const output = join(directory, target);
  await mkdir(output, { recursive: true });
  const inputs = {
    source,
    target,
    checkout: await realpath(checkout),
    cargoTarget,
    toolchain: {
      cargo,
      rustc,
      version: execFileSync(rustc, ['--version', '--verbose'], {
        env: buildEnv,
        encoding: 'utf8',
      }).trim(),
    },
    v8: {
      source: JSON.parse(await readFile(join(root, 'scripts/rust/v8-source.json'), 'utf8')),
      features: metadata.resolve.nodes.find(
        (node) => node.id === metadata.packages.find((pkg) => pkg.name === 'v8').id,
      ).features,
      archive: await digest(RUSTY_V8_ARCHIVE),
      bindings: await digest(RUSTY_V8_SRC_BINDING_PATH),
    },
  };
  await writeFile(join(output, 'build-inputs.json'), JSON.stringify(inputs, null, 2) + '\n');
  await writeFile(join(output, 'metadata.json'), JSON.stringify(metadata));
  await writeFile(join(output, 'V8_NOTICES.txt'), v8.notices);
  console.error(
    `Building controlled denort ${source.version} for ${target}\n${JSON.stringify(inputs, null, 2)}`,
  );
  const started = Date.now();
  const result = await cargoBuild(cargoArgs, {
    command: cargo,
    cwd: checkout,
    env: buildEnv,
  });
  if (result.code !== 0 || result.signal)
    throw new Error(`denort build failed: ${result.signal ?? result.code}`);
  const binary = result.executables.get('denort')?.path;
  if (!binary) throw new Error('Cargo did not report the denort executable');
  const receipt = {
    ...inputs,
    binary,
    sha256: await digest(binary),
    elapsedSeconds: (Date.now() - started) / 1000,
  };
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.error(`Controlled denort ready: ${binary} (${receipt.elapsedSeconds}s)`);
  return { binary, receipt, directory: output, checkout, metadata, v8Notices: v8.notices };
}

/** Validate the output architecture, not the machine running Deno compile. */
export async function verifyBinaryTarget(binary, target) {
  const file = await open(binary, 'r');
  const header = Buffer.alloc(4096);
  let size;
  try {
    size = (await file.read(header, 0, header.length, 0)).bytesRead;
  } finally {
    await file.close();
  }
  let actual;
  if (
    size >= 20 &&
    header.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70])) &&
    header[4] === 2 &&
    header[5] === 1
  ) {
    actual = { 62: 'x86_64', 183: 'aarch64' }[header.readUInt16LE(18)];
    if (actual) actual += '-unknown-linux-gnu';
  } else if (size >= 12 && header.readUInt32LE(0) === 0xfeedfacf) {
    actual = { 0x01000007: 'x86_64', 0x0100000c: 'aarch64' }[header.readUInt32LE(4)];
    if (actual) actual += '-apple-darwin';
  } else if (size >= 64 && header.toString('ascii', 0, 2) === 'MZ') {
    const offset = header.readUInt32LE(60);
    if (offset + 6 <= size && header.readUInt32LE(offset) === 0x00004550) {
      actual = { 0x8664: 'x86_64', 0xaa64: 'aarch64' }[header.readUInt16LE(offset + 4)];
      if (actual) actual += '-pc-windows-msvc';
    }
  }
  if (actual !== target)
    throw new Error(
      `Runtime binary target mismatch: expected ${target}, found ${actual ?? 'unknown'}`,
    );
}

export async function verifyRuntime(runtime, target, version) {
  if (!runtime) throw new Error('Release requires a controlled denort template');
  if (runtime.receipt.source.version !== version)
    throw new Error('Runtime template version mismatch');
  if (runtime.receipt.target !== target) throw new Error('Runtime receipt target mismatch');
  await verifyBinaryTarget(runtime.binary, target);
  if ((await digest(runtime.binary)) !== runtime.receipt.sha256)
    throw new Error('Runtime template SHA-256 mismatch');
}
