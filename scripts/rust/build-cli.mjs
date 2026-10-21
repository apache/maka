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
import { constants } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function rustTarget(platform = process.platform, arch = process.arch) {
  const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  const os = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-msvc' }[
    platform
  ];
  if (!cpu || !os) throw new Error(`Unsupported Maka target: ${platform}/${arch}`);
  return `${cpu}-${os}`;
}

export async function buildCli({
  release = false,
  target,
  repositoryRoot = root,
  env = process.env,
} = {}) {
  const triple = target ?? rustTarget();
  const linuxRelease = release && triple.includes('-linux-');
  if (linuxRelease && !/^(x86_64|aarch64)-unknown-linux-gnu$/u.test(triple)) {
    throw new Error('Linux releases require an x86_64 or aarch64 GNU target');
  }
  // Zig is only used with an explicit target, including native Linux builds.
  // Cargo writes the output under the Rust triple, without the glibc suffix.
  const outputTarget = linuxRelease ? triple : target;
  // Development builds use the repository target/debug path.
  const targetDirectory = resolve(repositoryRoot, (release && env.CARGO_TARGET_DIR) || 'target');
  const args = [
    linuxRelease ? 'zigbuild' : 'build',
    '--locked',
    '-p',
    'maka-cli',
    '-p',
    'maka-desktop-shell',
    '--target-dir',
    targetDirectory,
  ];
  if (release) args.push('--release');
  if (outputTarget) args.push('--target', linuxRelease ? `${triple}.2.28` : outputTarget);
  await new Promise((resolveBuild, reject) => {
    const child = spawn('cargo', args, {
      cwd: repositoryRoot,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveBuild();
      else reject(new Error(`Maka build failed: ${signal ?? code}`));
    });
  });
  const windows = triple.includes('-windows-');
  const binary = join(
    targetDirectory,
    ...(outputTarget ? [outputTarget] : []),
    release ? 'release' : 'debug',
    windows ? 'maka.exe' : 'maka',
  );
  const directory = dirname(binary);
  if (triple.includes('-apple-darwin')) {
    await stageDesktopBundle(
      repositoryRoot,
      join(directory, 'maka-desktop-shell'),
      join(directory, 'Maka.app'),
    );
    // The app now lives only in the bundle; drop an earlier build's sidecar.
    await rm(join(directory, 'app'), { recursive: true, force: true });
  } else {
    await stageDesktopApp(repositoryRoot, join(directory, 'app'));
  }
  return binary;
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

/**
 * Stage `Maka.app`: the shell, the authored app in `Contents/Resources/app`
 * where the shell looks for it, and the Info.plist and icon macOS reads.
 */
export async function stageDesktopBundle(repositoryRoot, shell, destination) {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, 'products/maka/desktop-shell/app/gpui-shell.json'), 'utf8'),
  );
  for (const key of ['id', 'name', 'version']) {
    if (typeof manifest[key] !== 'string' || !manifest[key]) {
      throw new Error(`Desktop app manifest has no ${key}`);
    }
  }
  const icon = icns(await readFile(join(repositoryRoot, 'assets/logo.png')));
  const metadata = await lstat(shell);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`Desktop shell is not a regular file: ${shell}`);
  }
  // Replace the previous bundle only once the new one is complete.
  const stage = await mkdtemp(join(dirname(destination), '.Maka.app-'));
  try {
    const contents = join(stage, 'Contents');
    await stageDesktopApp(repositoryRoot, join(contents, 'Resources', 'app'));
    await writeFile(join(contents, 'Resources', 'Maka.icns'), icon);
    await writeFile(join(contents, 'Info.plist'), infoPlist(manifest));
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
  // As gpui-shell's own bundles: `CFBundleVersion` takes up to three integers,
  // so a pre-release or build suffix stays in the short version only.
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

/** Stage only regular authored app files; executable lookup is independent of cwd. */
export async function stageDesktopApp(repositoryRoot, destination) {
  const source = join(repositoryRoot, 'products/maka/desktop-shell/app');
  // Validate before replacing a previous successful development sidecar.
  const files = [];
  async function collect(directory, relative = '') {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory())
      throw new Error('Desktop app directory must not be a symlink or special file');
    for (const name of await readdir(directory)) {
      const file = join(directory, name);
      const path = join(relative, name);
      const metadata = await lstat(file);
      if (metadata.isDirectory()) await collect(file, path);
      else if (metadata.isFile()) files.push(path);
      else throw new Error('Desktop app contains a non-regular file');
    }
  }
  await collect(source);
  if (!files.includes('gpui-shell.json') || !files.includes('main.js')) {
    throw new Error('Desktop app manifest and main.js are required');
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    await mkdir(dirname(join(destination, file)), { recursive: true });
    await copyFile(join(source, file), join(destination, file));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { release: { type: 'boolean' }, target: { type: 'string' } },
  });
  console.log(await buildCli(values));
}
