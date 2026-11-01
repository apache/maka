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

import { constants } from 'node:fs';
import { release as osRelease } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { cargoBuild } from './cargo.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function rustTarget(platform = process.platform, arch = process.arch) {
  const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  const os = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-msvc' }[
    platform
  ];
  if (!cpu || !os) throw new Error(`Unsupported Maka target: ${platform}/${arch}`);
  return `${cpu}-${os}`;
}

function developmentFeatures(env, platform, release) {
  const mode = env.MAKA_CUA_BUILD_MODE ?? 'auto';
  if (!['auto', 'native', 'bridge'].includes(mode))
    throw new Error('MAKA_CUA_BUILD_MODE must be auto, native, or bridge');
  const bridge =
    mode === 'bridge' ||
    (mode === 'auto' && platform === 'linux' && release.toLowerCase().includes('microsoft'));
  return bridge ? ['--no-default-features'] : [];
}

export async function compileCli({
  release = false,
  target,
  timings = false,
  desktop = true,
  repositoryRoot = root,
  env = process.env,
  platform = process.platform,
  osRelease: releaseName = osRelease(),
} = {}) {
  const host = rustTarget(platform);
  const triple = target ?? host;
  const linuxRelease = release && target !== undefined && triple.includes('-linux-');
  if (linuxRelease && !/^(x86_64|aarch64)-unknown-linux-gnu$/u.test(triple)) {
    throw new Error('Linux releases require an x86_64 or aarch64 GNU target');
  }
  // Explicit Linux release targets use the distribution's glibc floor.
  // Cargo writes the output under the Rust triple, without the glibc suffix.
  const outputTarget = linuxRelease ? triple : target;
  const args = [
    linuxRelease ? 'zigbuild' : 'build',
    '--locked',
    '-p',
    'maka-cli',
    ...(desktop ? ['-p', 'maka-desktop-shell'] : []),
    '-p',
    'maka-python-runtime',
  ];
  if (!release && triple === host) args.push(...developmentFeatures(env, platform, releaseName));
  if (release) args.push('--release');
  if (timings) args.push('--timings');
  if (outputTarget) args.push('--target', linuxRelease ? `${triple}.2.28` : outputTarget);
  // cargo-config2 in zigbuild misreads Cargo's empty wrapper configuration as a program.
  const buildEnv = linuxRelease
    ? {
        ...env,
        RUSTC_WRAPPER: env.RUSTC_WRAPPER ?? '',
        RUSTC_WORKSPACE_WRAPPER: env.RUSTC_WORKSPACE_WRAPPER ?? '',
      }
    : env;
  const result = await cargoBuild(args, { cwd: repositoryRoot, env: buildEnv });
  const artifact = result.executables.get('maka');
  const binary = artifact?.path;
  if (result.code === 0 && !result.signal && !binary)
    throw new Error('Cargo did not report the Maka executable');
  if (result.code === 0 && !result.signal && !artifact.outDir)
    throw new Error('Cargo did not report the Maka build output directory');
  if (result.code === 0 && !result.signal && desktop && triple.includes('-apple-darwin')) {
    const directory = dirname(binary);
    await stageDesktopBundle(
      repositoryRoot,
      join(directory, 'maka-desktop-shell'),
      join(directory, 'Maka.app'),
    );
  }
  return {
    code: result.code,
    signal: result.signal,
    binary,
    bundleInputs: artifact?.outDir && join(artifact.outDir, 'product', 'bundle-inputs.json'),
  };
}

export async function buildCli(options = {}) {
  const { code, signal, binary, bundleInputs } = await compileCli(options);
  if (code !== 0 || signal) throw new Error(`Maka build failed: ${signal ?? code}`);
  return { binary, bundleInputs };
}

/**
 * The desktop shell's path from the directory holding `maka`. macOS shows a
 * process with the name and icon of the bundle its executable is in, so there
 * the shell runs from inside `Maka.app`.
 */
export function desktopShell(platform) {
  if (platform === 'darwin') return join('Maka.app', 'Contents', 'MacOS', 'maka-desktop-shell');
  return platform === 'win32' ? 'maka-desktop-shell.exe' : 'maka-desktop-shell';
}

/** The desktop's identity; the shell gives its window the same application id. */
const desktopApp = { id: 'org.apache.maka.desktop', name: 'Maka' };

/** `[workspace.package] version`, which every Maka crate takes. */
export function workspaceVersion(manifest) {
  const section = /^\[workspace\.package\]$([^]*?)(?=^\[|(?![^]))/mu.exec(manifest)?.[1];
  const version = section && /^version\s*=\s*"([^"]+)"\s*$/mu.exec(section)?.[1];
  if (!version) throw new Error('Cargo.toml has no [workspace.package] version');
  return version;
}

/**
 * Stage `Maka.app`: the shell, which carries the workbench, and the
 * Info.plist and icon macOS reads.
 */
export async function stageDesktopBundle(repositoryRoot, shell, destination) {
  const version = workspaceVersion(await readFile(join(repositoryRoot, 'Cargo.toml'), 'utf8'));
  const icon = icns(await readFile(join(repositoryRoot, 'assets/logo.png')));
  const metadata = await lstat(shell);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`Desktop shell is not a regular file: ${shell}`);
  }
  // Replace the previous bundle only once the new one is complete.
  const stage = await mkdtemp(join(dirname(destination), '.Maka.app-'));
  try {
    const contents = join(stage, 'Contents');
    await mkdir(join(contents, 'Resources'), { recursive: true });
    await writeFile(join(contents, 'Resources', 'Maka.icns'), icon);
    await writeFile(join(contents, 'Info.plist'), infoPlist({ ...desktopApp, version }));
    await mkdir(join(contents, 'MacOS'));
    const executable = join(contents, 'MacOS', 'maka-desktop-shell');
    await copyFile(shell, executable, constants.COPYFILE_FICLONE);
    await chmod(executable, 0o755);
    await chmod(stage, 0o755);
    await rm(destination, { recursive: true, force: true });
    await rename(stage, destination);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

function infoPlist({ id, name, version }) {
  // `CFBundleVersion` takes up to three integers, so a pre-release or build
  // suffix stays in the short version only.
  const build = /^[0-9]+\.[0-9]+\.[0-9]+/u.exec(version)?.[0] ?? version;
  const escape = (value) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...[
      ['CFBundleDevelopmentRegion', 'en'],
      ['CFBundleDisplayName', name],
      ['CFBundleExecutable', 'maka-desktop-shell'],
      ['CFBundleIconFile', 'Maka'],
      ['CFBundleIdentifier', id],
      ['CFBundleInfoDictionaryVersion', '6.0'],
      ['CFBundleName', name],
      ['CFBundlePackageType', 'APPL'],
      ['CFBundleShortVersionString', version],
      ['CFBundleVersion', build],
      ['LSMinimumSystemVersion', '11.0'],
    ].map(([key, value]) => `  <key>${key}</key>\n  <string>${escape(value)}</string>`),
    '  <key>NSHighResolutionCapable</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** One 1024-pixel PNG entry; macOS scales it to the smaller sizes. */
function icns(png) {
  if (
    png.length < 24 ||
    png.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n' ||
    png.toString('latin1', 12, 16) !== 'IHDR' ||
    png.readUInt32BE(16) !== 1024 ||
    png.readUInt32BE(20) !== 1024
  ) {
    throw new Error('assets/logo.png must be a 1024x1024 PNG');
  }
  const header = Buffer.alloc(16);
  header.write('icns', 0, 'latin1');
  header.writeUInt32BE(header.length + png.length, 4);
  header.write('ic10', 8, 'latin1');
  header.writeUInt32BE(8 + png.length, 12);
  return Buffer.concat([header, png]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      release: { type: 'boolean' },
      target: { type: 'string' },
      timings: { type: 'boolean' },
    },
  });
  console.log((await buildCli(values)).binary);
}
