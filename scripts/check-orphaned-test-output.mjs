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

/**
 * Detect tests left behind by incremental compilation after their source was
 * removed or renamed. The repository's TypeScript workspaces preserve src paths
 * under dist; timestamps cannot detect a source that no longer exists.
 *
 * Fail before the root build instead of deleting individual compiler outputs:
 * `npm run rebuild` also resets incremental build info and dependent artifacts.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { workspaces } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const sourceExtensions = {
  js: ['ts', 'tsx', 'js', 'jsx'],
  jsx: ['tsx', 'jsx'],
  mjs: ['mts', 'mjs'],
  cjs: ['cts', 'cjs'],
};
const orphaned = [];

for (const workspace of workspaces) {
  const dist = join(repoRoot, workspace, 'dist');
  if (!statSync(dist, { throwIfNoEntry: false })?.isDirectory()) continue;
  const pending = [dist];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const output = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(output);
        continue;
      }
      const match = entry.name.match(/\.test\.(js|jsx|mjs|cjs)$/u);
      if (!entry.isFile() || !match) continue;
      const sourceStem = join(repoRoot, workspace, 'src', relative(dist, output)).slice(
        0,
        -match[1].length,
      );
      const hasSource = sourceExtensions[match[1]].some((extension) =>
        statSync(sourceStem + extension, { throwIfNoEntry: false })?.isFile(),
      );
      if (!hasSource) orphaned.push(relative(repoRoot, output));
    }
  }
}

if (orphaned.length > 0) {
  console.error('Compiled tests have no matching source:');
  for (const output of orphaned.sort()) console.error(`  - ${output}`);
  console.error('Run `npm run rebuild` to remove stale output before running tests.');
  process.exitCode = 1;
}
