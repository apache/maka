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
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execTar, verifySourceCandidate } from '../asf-source-release.mjs';
import { npmSpawnOptions } from '../npm-spawn.mjs';
import { readNativePreviewRelease } from './publish-cli.mjs';

const run = promisify(execFile);

/** Package the launcher from the same verified source archive as its executables. */
export async function packLauncher(directory) {
  directory = resolve(directory);
  const platforms = await readNativePreviewRelease(directory);
  const { version, source } = platforms[0];
  const archivePath = join(directory, basename(source.archive));
  const candidate = await verifySourceCandidate({ archivePath });
  if (candidate.digest !== source.sha512 || candidate.version !== source.version) {
    throw new Error('Launcher source differs from its native executables');
  }
  const stage = await mkdtemp(join(tmpdir(), 'maka-launcher-'));
  try {
    execTar(
      archivePath,
      [
        '-xzf',
        '-C',
        stage,
        `${candidate.rootDirectory}/packages/cli`,
        `${candidate.rootDirectory}/DISCLAIMER`,
        `${candidate.rootDirectory}/LICENSE`,
        `${candidate.rootDirectory}/NOTICE`,
      ],
      {
        timeout: 30_000,
      },
    );
    const root = join(stage, candidate.rootDirectory);
    const packageDirectory = join(root, 'packages/cli');
    const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
    if (
      manifest.name !== '@maka-agent/cli' ||
      manifest.version !== source.version ||
      manifest.bin?.maka !== 'bin/maka.mjs'
    ) {
      throw new Error('Source archive does not contain the expected native launcher');
    }
    delete manifest.private;
    manifest.version = version;
    manifest.optionalDependencies = Object.fromEntries(
      platforms.map(({ name }) => [name, version]),
    );
    manifest.makaSource = source;
    manifest.publishConfig = {
      access: 'public',
      registry: 'https://registry.npmjs.org/',
      tag: 'rust-preview',
    };
    await writeFile(
      join(packageDirectory, 'package.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    for (const name of ['DISCLAIMER', 'LICENSE', 'NOTICE'])
      await copyFile(join(root, name), join(packageDirectory, name));
    const disclaimer = await readFile(join(root, 'DISCLAIMER'), 'utf8');
    for (const name of ['README.md', 'README.zh-CN.md'])
      await appendFile(join(packageDirectory, name), '\n\n' + disclaimer);
    const { stdout } = await run(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--offline'],
      npmSpawnOptions({ cwd: packageDirectory, encoding: 'utf8', timeout: 180_000 }),
    );
    const [packed, ...extra] = Object.values(JSON.parse(stdout));
    const archive = `maka-agent-cli-${version}.tgz`;
    if (
      extra.length ||
      packed?.name !== manifest.name ||
      packed.version !== version ||
      packed.filename !== archive
    ) {
      throw new Error('npm pack returned an inconsistent launcher');
    }
    await mkdir(directory, { recursive: true });
    await copyFile(join(packageDirectory, archive), join(directory, archive));
    const receipt = { name: manifest.name, version, archive, integrity: packed.integrity };
    await writeFile(join(directory, 'launcher.json'), JSON.stringify(receipt) + '\n');
    return receipt;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: pack-launcher.mjs <artifact-directory>');
  console.log(JSON.stringify(await packLauncher(process.argv[2])));
}
