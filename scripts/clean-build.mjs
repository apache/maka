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
 * PR-BUILD-HYGIENE-0: remove every workspace's `dist` and incremental
 * tsbuildinfo so the next `npm run build` is forced to recompile from
 * source. Solves the recurring "tests pass on stale dist" foot-gun
 * that kept biting us during Phase 3 P0 fixups — every time we
 * removed/renamed an export, the old dist would survive and tests
 * would lie.
 *
 * Workspace list is derived from root package.json so it cannot drift
 * from npm workspaces (e.g. packages/computer-use). Desktop keeps a
 * few extra outputs (renderer bundle + multi-tsconfig build info).
 *
 * Idempotent; missing paths are silently ignored.
 *
 * Run via `npm run clean` at the repo root.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const workspaceDirs = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];

const targets = [];
for (const dir of workspaceDirs) {
  targets.push(`${dir}/dist`, `${dir}/tsconfig.tsbuildinfo`);
}

// Desktop has additional build outputs beyond the standard package layout.
targets.push(
  'apps/desktop/dist-renderer',
  'apps/desktop/tsconfig.main.tsbuildinfo',
  'apps/desktop/tsconfig.renderer.tsbuildinfo',
);

let removed = 0;
for (const rel of targets) {
  const full = join(repoRoot, rel);
  if (existsSync(full)) {
    rmSync(full, { recursive: true, force: true });
    console.log(`cleaned ${rel}`);
    removed++;
  }
}

console.log(removed === 0 ? 'nothing to clean.' : `cleaned ${removed} path(s).`);
