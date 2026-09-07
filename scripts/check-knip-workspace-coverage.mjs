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

// Run by .github/workflows/ci.yml before `npx knip`.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Unconfigured workspace = knip's weak defaults; stale key = a gate that guards nothing. */
export function evaluateWorkspaceCoverage({ knipKeys, packageWorkspaces }) {
  const memberKeys = knipKeys.filter((key) => key !== '.');
  const missing = packageWorkspaces.filter((dir) => !memberKeys.includes(dir));
  const stale = memberKeys.filter((key) => !packageWorkspaces.includes(key));
  return { ok: missing.length === 0 && stale.length === 0, missing, stale };
}

function main() {
  const readJson = (path) => JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
  const { ok, missing, stale } = evaluateWorkspaceCoverage({
    knipKeys: Object.keys(readJson('knip.json').workspaces ?? {}),
    packageWorkspaces: readJson('package.json').workspaces ?? [],
  });
  if (missing.length > 0) {
    console.error(`package.json workspaces missing from knip.json: ${missing.join(', ')}`);
  }
  if (stale.length > 0) {
    console.error(`knip.json workspaces without a package.json entry: ${stale.join(', ')}`);
  }
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
