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
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { command } from './command.mjs';
import { manifests } from './suites.mjs';

const hash = (input) => createHash('sha256').update(input).digest('hex');
const cargoHome = () => process.env.CARGO_HOME || join(homedir(), '.cargo');
const role = process.env.MAKA_CI_ROLE;
const workspace = process.env.MAKA_CI_WORKSPACE;
const version = process.env.MAKA_CI_NEXTEST;
const selectedManifests = ['native-windows', 'native-macos'].includes(role)
  ? [manifests.root, manifests.nsh]
  : [manifests[workspace]];
const tools =
  role === 'tooling'
    ? ['cargo-deny']
    : [
          'root',
          'replay',
          'bridge',
          'desktop',
          'termina',
          'nsh',
          'linux-nsh',
          'native-ubuntu',
          'native-windows',
          'native-macos',
        ].includes(role)
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

function hostCpu(arch = process.arch) {
  const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  if (!cpu) throw new Error(`Unsupported CI architecture: ${arch}`);
  return cpu;
}

async function fetchGitHub(url, accept) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const retryBaseMs = Number(process.env.MAKA_CI_RETRY_DELAY_MS ?? 1000);
  const headers = {
    Accept: accept,
    'User-Agent': 'maka-ci',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await delay(retryBaseMs * 2 ** (attempt - 1));
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return response;
      lastError = new Error(`GitHub API ${url} failed: HTTP ${response.status}`);
      if (response.status !== 429 && response.status < 500) throw lastError;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /^GitHub API .* failed: HTTP 4(?!29)\d\d$/u.test(error.message))
        throw error;
    }
  }
  throw lastError;
}

async function downloadReleaseAsset(releasePath, matchAsset) {
  const apiBase = (process.env.MAKA_CI_GITHUB_API ?? 'https://api.github.com').replace(/\/+$/u, '');
  const metadata = await (
    await fetchGitHub(`${apiBase}${releasePath}`, 'application/vnd.github+json')
  ).json();
  const asset = metadata.assets?.find(matchAsset);
  if (!asset) throw new Error(`Release ${releasePath} has no matching asset`);
  const bytes = Buffer.from(
    await (await fetchGitHub(asset.url, 'application/octet-stream')).arrayBuffer(),
  );
  if (asset.digest) {
    if (!asset.digest.startsWith('sha256:'))
      throw new Error(`Unsupported digest format for ${asset.name}: ${asset.digest}`);
    const actual = `sha256:${hash(bytes)}`;
    if (actual !== asset.digest)
      throw new Error(`Digest mismatch for ${asset.name}: expected ${asset.digest}, got ${actual}`);
  }
  return { asset, bytes };
}

function toolRelease(spec, platform = process.platform, arch = process.arch) {
  const [name, pin] = spec.split('@');
  const cpu = hostCpu(arch);
  const exe = platform === 'win32' ? `${name}.exe` : name;
  if (name === 'cargo-nextest') {
    const target =
      platform === 'darwin'
        ? 'universal-apple-darwin'
        : platform === 'linux'
          ? `${cpu}-unknown-linux-gnu`
          : platform === 'win32'
            ? `${cpu}-pc-windows-msvc`
            : null;
    if (!target) throw new Error(`Unsupported platform for ${name}: ${platform}`);
    return {
      name,
      exe,
      releasePath: pin
        ? `/repos/nextest-rs/nextest/releases/tags/cargo-nextest-${pin}`
        : '/repos/nextest-rs/nextest/releases/latest',
      suffix: `-${target}.tar.gz`,
    };
  }
  if (name === 'cargo-deny') {
    const target =
      platform === 'darwin'
        ? `${cpu}-apple-darwin`
        : platform === 'linux'
          ? `${cpu}-unknown-linux-musl`
          : platform === 'win32'
            ? `${cpu}-pc-windows-msvc`
            : null;
    if (!target) throw new Error(`Unsupported platform for ${name}: ${platform}`);
    return {
      name,
      exe,
      releasePath: pin
        ? `/repos/EmbarkStudios/cargo-deny/releases/tags/${pin}`
        : '/repos/EmbarkStudios/cargo-deny/releases/latest',
      suffix: `-${target}.tar.gz`,
    };
  }
  throw new Error(`Unsupported CI tool: ${spec}`);
}

async function installTool(spec) {
  const { name, exe, releasePath, suffix } = toolRelease(spec);
  const { asset, bytes } = await downloadReleaseAsset(
    releasePath,
    (entry) => entry.name.startsWith(`${name}-`) && entry.name.endsWith(suffix),
  );
  const scratch = mkdtempSync(join(tmpdir(), 'maka-ci-tool-'));
  try {
    writeFileSync(join(scratch, 'tool.tar.gz'), bytes);
    mkdirSync(join(scratch, 'out'));
    await command('tar', ['-xzf', 'tool.tar.gz', '-C', 'out'], { cwd: scratch });
    const match = readdirSync(join(scratch, 'out'), { recursive: true }).find(
      (entry) => basename(entry) === exe,
    );
    if (!match) throw new Error(`Archive ${asset.name} did not contain ${exe}`);
    const binDir = join(cargoHome(), 'bin');
    mkdirSync(binDir, { recursive: true });
    const destination = join(binDir, exe);
    const staged = `${destination}.tmp-${process.pid}`;
    copyFileSync(join(scratch, 'out', match), staged);
    if (process.platform !== 'win32') chmodSync(staged, 0o755);
    renameSync(staged, destination);
    console.log(`Installed ${asset.name} to ${destination}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const TARGET_ROOT = 'target';
const CACHEDIR_TAG = [
  'Signature: 8a477f597d28d172789f06886806bc55',
  '# This file is a cache directory tag created by cargo.',
  '# For information about cache directory tags see https://bford.info/cachedir/',
  '',
].join('\n');

function writeAtomic(destination, contents) {
  mkdirSync(dirname(destination), { recursive: true });
  const staged = `${destination}.tmp-${process.pid}`;
  writeFileSync(staged, contents);
  renameSync(staged, destination);
}

function ensureCargoTargetTag() {
  const tagPath = join(TARGET_ROOT, 'CACHEDIR.TAG');
  if (!existsSync(tagPath)) writeAtomic(tagPath, CACHEDIR_TAG);
}

async function stageV8() {
  const lockfile = readFileSync(join(dirname(manifests.root), 'Cargo.lock'), 'utf8');
  const match = /^\[\[package\]\]\r?\nname = "v8"\r?\nversion = "([^"]+)"/mu.exec(lockfile);
  if (!match) return;
  const v8Version = match[1];
  const cpu = hostCpu();
  const os = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-msvc' }[
    process.platform
  ];
  if (!os) throw new Error(`Unsupported platform for V8 archive: ${process.platform}`);
  const target = `${cpu}-${os}`;
  const assetName =
    process.platform === 'win32'
      ? `rusty_v8_simdutf_release_${target}.lib.gz`
      : `librusty_v8_simdutf_release_${target}.a.gz`;
  const url = `https://github.com/denoland/rusty_v8/releases/download/v${v8Version}/${assetName}`;
  const cachePath = join(cargoHome(), '.rusty_v8', url.replace(/[^0-9A-Za-z]/gu, '_'));
  const libDir = join(TARGET_ROOT, 'debug', 'gn_out', 'obj');
  const libPath = join(libDir, process.platform === 'win32' ? 'rusty_v8.lib' : 'librusty_v8.a');
  const sumPath = join(libDir, process.platform === 'win32' ? 'rusty_v8.sum' : 'librusty_v8.sum');
  if (existsSync(libPath) && existsSync(sumPath) && readFileSync(sumPath, 'utf8') === url) {
    ensureCargoTargetTag();
    return;
  }
  let archive;
  if (existsSync(cachePath)) {
    try {
      archive = gunzipSync(readFileSync(cachePath));
    } catch {
      rmSync(cachePath, { force: true });
    }
  }
  if (!archive) {
    const { bytes } = await downloadReleaseAsset(
      `/repos/denoland/rusty_v8/releases/tags/v${v8Version}`,
      (entry) => entry.name === assetName,
    );
    archive = gunzipSync(bytes);
    writeAtomic(cachePath, bytes);
  }
  // Cargo only writes CACHEDIR.TAG when creating `target/` itself; creating
  // `target/debug/gn_out/obj` beforehand without it breaks `cargo clean`.
  ensureCargoTargetTag();
  // v8's build.rs skips writing `.sum` when reading `.cargo/.rusty_v8`, causing
  // parallel host/target build scripts to truncate the shared static library.
  writeAtomic(libPath, archive);
  writeAtomic(sumPath, url);
  console.log(`Staged ${assetName} to ${libPath}`);
}

async function main(action) {
  if (action === 'tool-list') {
    output({ tools: tools.join(' ') });
  } else if (action === 'tools') {
    for (const spec of tools) await installTool(spec);
  } else if (action === 'v8') {
    await stageV8();
  } else if (action === 'keys') {
    const compiler = await command('rustc', ['-vV'], { capture: true });
    const lock = hash(
      Buffer.concat(
        selectedManifests.map((manifest) => readFileSync(join(dirname(manifest), 'Cargo.lock'))),
      ),
    );
    const configuration = hash(
      Buffer.concat([
        ...selectedManifests.map((manifest) => readFileSync(manifest)),
        readFileSync('.cargo/config.toml'),
        readFileSync('.github/actions/ci-setup/action.yml'),
        readFileSync('.github/actions/ci-cache/action.yml'),
      ]),
    );
    const compiled = `rust-deps-${process.env.RUNNER_OS}-${process.env.RUNNER_ARCH}-${hash(compiler)}-${role}-${configuration}`;
    output({
      compiled: `${compiled}-${lock}-${hash(readFileSync(new URL(import.meta.url)))}`,
      compiled_prefix: `${compiled}-`,
      downloads: `cargo-sources-${workspace}-${lock}`,
      downloads_prefix: `cargo-sources-${workspace}-`,
      downloads_writer: role === 'tooling' || workspace !== 'root',
    });
  } else if (action === 'prune') {
    if (existsSync(TARGET_ROOT)) ensureCargoTargetTag();
    for (const manifest of selectedManifests) {
      const packages = JSON.parse(
        await command(
          process.platform === 'win32' ? 'python' : 'python3',
          [
            '-c',
            'import json, sys, tomllib; print(json.dumps([pkg["name"] for pkg in tomllib.load(open(sys.argv[1], "rb"))["package"] if "source" not in pkg]))',
            join(dirname(manifest), 'Cargo.lock'),
          ],
          { capture: true },
        ),
      );
      // Local path dependencies rebuild after checkout just like workspace members.
      // Keep the immutable registry/Git dependencies instead of those large outputs.
      await command('cargo', [
        'clean',
        '--manifest-path',
        manifest,
        '--target-dir',
        TARGET_ROOT,
        ...packages.flatMap((name) => ['--package', name]),
      ]);
    }
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
      'libgtk-4-dev',
      'libgstreamer1.0-dev',
      'libgstreamer-plugins-base1.0-dev',
      'gstreamer1.0-plugins-base',
      'gstreamer1.0-plugins-good',
      'xvfb',
      'ripgrep',
      'libx11-dev',
      'libxi-dev',
      'libxtst-dev',
      'libxext-dev',
      'libxcb1-dev',
      'libxrandr-dev',
      'libxfixes-dev',
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
        : [...shared, ...headless];
    await command('sudo', ['apt-get', '-o', 'APT::Update::Error-Mode=any', 'update']);
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
