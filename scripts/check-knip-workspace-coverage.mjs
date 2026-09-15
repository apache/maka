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
import { parse } from 'jsonc-parser';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Unconfigured workspace = knip's weak defaults; stale key = a gate that guards nothing. */
export function evaluateWorkspaceCoverage({ knipKeys, packageWorkspaces }) {
  const memberKeys = knipKeys.filter((key) => key !== '.');
  const missing = packageWorkspaces.filter((dir) => !memberKeys.includes(dir));
  const stale = memberKeys.filter((key) => !packageWorkspaces.includes(key));
  return { ok: missing.length === 0 && stale.length === 0, missing, stale };
}

/**
 * Root scripts import hoisted tooling, so the root declares it too. A nested copy means a
 * workspace pin drifted away from the root one and npm stopped deduping.
 */
export function findNestedRootDependencies({ rootDependencies, packageWorkspaces, lockPaths }) {
  return lockPaths.filter((path) =>
    packageWorkspaces.some((dir) => {
      const prefix = `${dir}/node_modules/`;
      return path.startsWith(prefix) && rootDependencies.includes(path.slice(prefix.length));
    }),
  );
}

function main() {
  const read = (path) => readFileSync(resolve(repoRoot, path), 'utf8');
  const rootPackage = JSON.parse(read('package.json'));
  const packageWorkspaces = rootPackage.workspaces ?? [];
  const { ok, missing, stale } = evaluateWorkspaceCoverage({
    knipKeys: Object.keys(parse(read('knip.jsonc')).workspaces ?? {}),
    packageWorkspaces,
  });
  const nested = findNestedRootDependencies({
    rootDependencies: Object.keys({ ...rootPackage.dependencies, ...rootPackage.devDependencies }),
    packageWorkspaces,
    lockPaths: Object.keys(JSON.parse(read('package-lock.json')).packages ?? {}),
  });
  if (missing.length > 0) {
    console.error(`package.json workspaces missing from knip.jsonc: ${missing.join(', ')}`);
  }
  if (stale.length > 0) {
    console.error(`knip.jsonc workspaces without a package.json entry: ${stale.join(', ')}`);
  }
  if (nested.length > 0) {
    console.error(`root dependencies duplicated under a workspace: ${nested.join(', ')}`);
  }
  if (!ok || nested.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
