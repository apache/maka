#!/usr/bin/env node
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

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDirectory, '..');
const defaultBiomePath = join(
  defaultRepoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'biome.cmd' : 'biome',
);

export function checkStagedWithBiome({
  root = defaultRepoRoot,
  biomePath = defaultBiomePath,
} = {}) {
  const output = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    { cwd: root },
  );
  const paths = output.toString('utf8').split('\0').filter(Boolean);

  for (const path of paths) {
    const contents = execFileSync('git', ['show', `:${path}`], { cwd: root });
    const result = spawnSync(
      biomePath,
      [
        'check',
        '--write',
        `--stdin-file-path=${path}`,
        '--files-ignore-unknown=true',
        '--no-errors-on-unmatched',
      ],
      { cwd: root, input: contents },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      if (result.stdout.length > 0) process.stdout.write(result.stdout);
      if (result.stderr.length > 0) process.stderr.write(result.stderr);
      return false;
    }
    if (!result.stdout.equals(contents)) {
      process.stderr.write(`${path}: staged content is not formatted by Biome\n`);
      return false;
    }
  }

  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!checkStagedWithBiome()) process.exitCode = 1;
}
