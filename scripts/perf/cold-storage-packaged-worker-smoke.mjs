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

import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPackage } from '@electron/asar';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const base = await mkdtemp(join(tmpdir(), 'maka-cold-asar-'));
try {
  const source = join(base, 'source');
  await mkdir(source);
  await writeFile(join(source, 'package.json'), '{"type":"module"}\n');
  for (const name of ['storage', 'runtime-host']) {
    const directory = join(source, 'node_modules', '@maka', name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'package.json'),
      await readFile(join(repo, 'packages', name, 'package.json')),
    );
    const origin = join(repo, 'packages', name, 'dist');
    await cp(origin, join(directory, 'dist'), {
      recursive: true,
      filter: async (path) => {
        const parts = relative(origin, path).split(sep);
        return (
          !parts.includes('__tests__') &&
          !parts.includes('test-only') &&
          ((await stat(path)).isDirectory() || path.endsWith('.js'))
        );
      },
    });
  }
  // Production workspace modules are inside ASAR; their ordinary dependency
  // closure is supplied by the existing checkout, without copying user state.
  await symlink(join(repo, 'node_modules'), join(base, 'node_modules'), 'dir');
  const archive = join(base, 'app.asar');
  await createPackage(source, archive);
  const { stdout, stderr } = await promisify(execFile)(
    require('electron'),
    [
      join(repo, 'scripts/perf/cold-storage-packaged-worker-runner.mjs'),
      archive,
      join(base, 'state'),
    ],
    {
      cwd: repo,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  const evidence = { ...result, stderr };
  const output = join(repo, 'artifacts', 'cold-storage-packaged-worker-20261015.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, report: output }));
} finally {
  await rm(base, { recursive: true, force: true });
}
