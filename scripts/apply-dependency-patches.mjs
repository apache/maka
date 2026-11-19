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

// Apply the exact-version dependency patches used by product bundles.
// Release builds install the complete locked dependency tree. A types-only
// workspace install may omit some of the patched dependencies.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const patchesDirectory = join(repoRoot, 'patches');

for (const patch of readdirSync(patchesDirectory)
  .filter((name) => name.endsWith('.patch'))
  .sort()) {
  const [name, version] = patch.slice(0, -'.patch'.length).split('+');
  const manifest = join(repoRoot, 'node_modules', name, 'package.json');
  if (!existsSync(manifest)) continue;
  const installed = JSON.parse(readFileSync(manifest, 'utf8')).version;
  if (installed !== version)
    throw new Error(`Patch ${patch} expects ${version}, installed ${installed}`);
  const file = join(patchesDirectory, patch);
  const apply = (...args) =>
    spawnSync('git', ['apply', '--ignore-space-change', ...args, file], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  if (apply('--reverse', '--check').status === 0) continue;
  const result = apply();
  if (result.status !== 0) throw result.error ?? new Error(result.stderr);
}
