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
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { npmSpawnOptions } from '../npm-spawn.mjs';
import { desktopShell } from './build-cli.mjs';
import { readPreviewRelease } from './publish-cli.mjs';

const run = promisify(execFile);

/** Exercise the actual packaged launcher and this machine's native component. */
export async function verifyRelease(directory) {
  const packages = await readPreviewRelease(directory);
  const target = `${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`;
  const native = packages.find((pkg) => pkg.name === '@maka-agent/cli-' + target);
  if (!native) throw new Error('No native release for this verifier: ' + target);
  const launcher = packages.find((pkg) => pkg.name === '@maka-agent/cli');
  const stage = await mkdtemp(join(tmpdir(), 'maka release verification '));
  try {
    await writeFile(
      join(stage, 'package.json'),
      JSON.stringify({ name: 'maka-release-verification', private: true }),
    );
    for (const pkg of [native, launcher])
      await copyFile(pkg.archive, join(stage, basename(pkg.archive)));
    await run(
      'npm',
      [
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        './' + basename(native.archive),
        './' + basename(launcher.archive),
      ],
      npmSpawnOptions({ cwd: stage, timeout: 180_000, maxBuffer: 1024 * 1024 }),
    );
    const command = join(stage, 'node_modules/@maka-agent/cli/bin/maka.mjs');
    const options = { cwd: stage, timeout: 30_000, maxBuffer: 1024 * 1024, encoding: 'utf8' };
    const { stdout } = await run(process.execPath, [command, '--version'], options);
    if (stdout.trim() !== 'maka ' + native.source.version)
      throw new Error('Installed launcher reports another source version');
    const desktop = await run(
      join(stage, 'node_modules', native.name, 'bin', desktopShell(process.platform)),
      ['--version'],
      options,
    );
    if (desktop.stdout.trim() !== 'maka-desktop-shell ' + native.source.version)
      throw new Error('Installed desktop shell reports another source version');
    const result = await new Promise((resolveResult, reject) => {
      const child = execFile(
        process.execPath,
        [command, 'code', '--log', join(stage, 'code.sqlite')],
        options,
        (error, stdout) => (error ? reject(error) : resolveResult(stdout)),
      );
      child.stdin.end(
        'if (Math.abs(Math.sin(1) - 0.8414709848078965) > 1e-15 || Math.cos(0) !== 1 || !new Intl.DateTimeFormat("en").format(new Date(0)) || Temporal.PlainDate.from("2026-09-28").year !== 2026) throw new Error("V8 smoke failed");',
      );
      child.stdin.on('error', reject);
    });
    if (JSON.parse(result).output?.ok !== true)
      throw new Error('Installed launcher failed its V8 smoke');
    return { target, version: native.version };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: verify-release.mjs <artifact-directory>');
  console.log(JSON.stringify(await verifyRelease(process.argv[2])));
}
