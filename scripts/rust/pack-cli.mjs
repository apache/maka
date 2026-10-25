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

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { npmSpawnOptions } from '../npm-spawn.mjs';
import { stageDesktopApp, stageDesktopBundle } from './build-cli.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
export const nativeCliTargets = {
  'darwin-arm64': { os: 'darwin', cpu: 'arm64' },
  'darwin-x64': { os: 'darwin', cpu: 'x64' },
  'linux-arm64-gnu': { os: 'linux', cpu: 'arm64', libc: ['glibc'] },
  'linux-x64-gnu': { os: 'linux', cpu: 'x64', libc: ['glibc'] },
  'win32-x64': { os: 'win32', cpu: 'x64' },
};

/** Pack prebuilt native bytes; never publish, execute the target, or run npm scripts. */
export async function packNativeCli({
  target,
  version,
  binary,
  notices,
  validator,
  output,
  repositoryRoot = root,
  source,
}) {
  const platform = Object.hasOwn(nativeCliTargets, target) ? nativeCliTargets[target] : undefined;
  if (!platform) throw new Error('Unsupported native CLI target');
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('An exact npm release version is required');
  }
  if (!binary || !notices || !validator || !output) {
    throw new Error('binary, notices, validator, and output are required');
  }
  const stage = await mkdtemp(join(tmpdir(), 'maka-native-package-'));
  try {
    const directory = join(stage, 'package');
    await mkdir(join(directory, 'bin'), { recursive: true });
    const executable = platform.os === 'win32' ? 'maka.exe' : 'maka';
    await copyRegular(resolve(binary), join(directory, 'bin', executable), 512 * 1024 * 1024);
    await chmod(join(directory, 'bin', executable), 0o755);
    const worker = platform.os === 'win32' ? 'maka-python-worker.exe' : 'maka-python-worker';
    await copyRegular(
      join(dirname(resolve(binary)), worker),
      join(directory, 'bin', worker),
      512 * 1024 * 1024,
    );
    await chmod(join(directory, 'bin', worker), 0o755);
    const desktop = platform.os === 'win32' ? 'maka-desktop-shell.exe' : 'maka-desktop-shell';
    if (platform.os === 'darwin') {
      await stageDesktopBundle(
        repositoryRoot,
        join(dirname(resolve(binary)), desktop),
        join(directory, 'bin', 'Maka.app'),
      );
    } else {
      await copyRegular(
        join(dirname(resolve(binary)), desktop),
        join(directory, 'bin', desktop),
        512 * 1024 * 1024,
      );
      await chmod(join(directory, 'bin', desktop), 0o755);
      await stageDesktopApp(repositoryRoot, join(directory, 'bin', 'app'));
    }
    if (platform.os === 'win32') {
      await copyRegular(
        join(dirname(resolve(binary)), 'maka-service.exe'),
        join(directory, 'bin', 'maka-service.exe'),
        512 * 1024 * 1024,
      );
      await chmod(join(directory, 'bin', 'maka-service.exe'), 0o755);
    }
    for (const name of ['LICENSE', 'NOTICE']) {
      await copyRegular(join(repositoryRoot, name), join(directory, name), 16 * 1024 * 1024);
    }
    for (const name of ['README.md', 'README.zh-CN.md']) {
      await copyRegular(
        join(repositoryRoot, 'packages/cli', name),
        join(directory, name),
        1024 * 1024,
      );
    }
    // Release owners supply the reviewed Rust/V8/embedded-JS notice closure.
    // The old Node CLI notice file alone is not sufficient for this binary.
    await copyRegular(
      resolve(notices),
      join(directory, 'THIRD_PARTY_NOTICES.txt'),
      16 * 1024 * 1024,
    );
    const name = `@maka-agent/cli-${target}`;
    await writeFile(
      join(directory, 'package.json'),
      `${JSON.stringify(
        {
          name,
          version,
          description: `Unofficial experimental Maka Rust preview for ${target}; not an ASF release`,
          license: 'Apache-2.0',
          repository: { type: 'git', url: 'https://github.com/M4n5ter/maka-agent.git' },
          ...(source ? { makaSource: source } : {}),
          os: [platform.os],
          cpu: [platform.cpu],
          ...(platform.libc ? { libc: platform.libc } : {}),
          bin: { maka: `bin/${executable}` },
          files: [
            'bin',
            'LICENSE',
            'NOTICE',
            'THIRD_PARTY_NOTICES.txt',
            'README.md',
            'README.zh-CN.md',
          ],
          publishConfig: {
            access: 'public',
            registry: 'https://registry.npmjs.org/',
            tag: 'rust-preview',
          },
        },
        null,
        2,
      )}\n`,
    );
    // No dynamic shell arguments on Windows: npm.cmd needs a shell, but its
    // package paths live in cwd and never become command-line syntax.
    const packed = await run(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--offline'],
      npmSpawnOptions({
        cwd: directory,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 180_000,
      }),
    );
    const results = Object.values(JSON.parse(packed.stdout));
    if (results.length !== 1 || results[0].name !== name || results[0].version !== version) {
      throw new Error('npm pack returned an inconsistent native package');
    }
    const result = results[0];
    if (basename(result.filename) !== result.filename || !result.filename.endsWith('.tgz')) {
      throw new Error('npm pack returned an invalid archive filename');
    }
    const archive = join(directory, result.filename);
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    const integrity = `sha512-${hash.digest('base64')}`;
    if (integrity !== result.integrity) throw new Error('npm pack archive integrity mismatch');
    // Cross-target verification uses the local CLI's parser, never the packaged
    // executable. Verify actual npm tar output, including platform and PE role.
    await run(
      resolve(validator),
      [
        'host',
        'fetch',
        '--target',
        target,
        '--version',
        version,
        '--cache',
        join(stage, 'verified'),
        '--archive',
        archive,
        '--integrity',
        integrity,
      ],
      { encoding: 'utf8', maxBuffer: 256 * 1024, timeout: 180_000, windowsHide: true },
    );
    const destination = resolve(output);
    await mkdir(destination, { recursive: true });
    const path = join(destination, result.filename);
    await copyFile(archive, path, constants.COPYFILE_EXCL);
    const receipt = { name, version, target, archive: result.filename, integrity };
    try {
      await writeFile(join(destination, target + '.json'), JSON.stringify(receipt) + '\n', {
        flag: 'wx',
      });
    } catch (error) {
      await rm(path);
      throw error;
    }
    return { ...receipt, archive: path };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function copyRegular(source, destination, maximum) {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > maximum) {
    throw new Error(`Native package source is not a bounded regular file: ${source}`);
  }
  await copyFile(source, destination, constants.COPYFILE_EXCL);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: Object.fromEntries(
      ['target', 'version', 'binary', 'notices', 'validator', 'output'].map((name) => [
        name,
        { type: 'string' },
      ]),
    ),
  });
  console.log(JSON.stringify(await packNativeCli(values)));
}
