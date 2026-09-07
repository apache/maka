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

import { existsSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';

const defaultRepoRoot = resolve(import.meta.dirname, '..');
const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];

export const windowsPackageSourceEntrypoints = [
  'packages/runtime/src/filesystem-worker/index.ts',
  'packages/runtime/src/filesystem-worker/worker-entry.ts',
  'packages/runtime/src/sandbox/index.ts',
];

/**
 * Workspace sources `entryPoints` reach, transitively, resolved through the
 * workspace `exports` map back to `src` rather than to built `dist`. Two lanes
 * derive a path filter from this instead of maintaining one by hand, so a
 * dependency added anywhere under an entry point cannot escape the filter that
 * is supposed to schedule the runner able to observe it.
 *
 * Static imports only, which is the limit of what "generated, not curated"
 * buys here: a process boundary is invisible to it. `root-authority.test.ts`
 * forks `fixtures/root-initialization-race.js` and
 * `filesystem-worker/worker-entry.ts` is bundled rather than imported, so
 * neither appears in a closure that starts from them. Both are free of `win32`
 * today, which is why the filters derived from this are complete — not because
 * the derivation guarantees it.
 */
export async function collectWorkspaceSourceClosure(entryPoints, repoRoot = defaultRepoRoot) {
  const workspaces = loadWorkspacePackages(repoRoot);
  const result = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints,
    format: 'esm',
    logLevel: 'silent',
    metafile: true,
    outdir: 'workspace-source-closure',
    packages: 'external',
    platform: 'node',
    plugins: [workspaceSourcePlugin(repoRoot, workspaces)],
    treeShaking: false,
    write: false,
  });
  return Object.keys(result.metafile.inputs)
    .map(normalize)
    .filter((path) => path.startsWith('packages/'))
    .sort();
}

export function windowsReleasePatternCoversSource(path, pattern) {
  if (path === pattern) return true;
  return pattern.endsWith('/**') && path.startsWith(pattern.slice(0, -2));
}

function workspaceSourcePlugin(repoRoot, workspaces) {
  return {
    name: 'maka-workspace-source',
    setup(esbuild) {
      esbuild.onResolve({ filter: /^@maka\// }, ({ path: specifier }) => {
        const workspace = [...workspaces.values()].find(
          ({ name }) => specifier === name || specifier.startsWith(`${name}/`),
        );
        if (!workspace) return undefined;
        const subpath =
          specifier === workspace.name ? '.' : `.${specifier.slice(workspace.name.length)}`;
        const exported = exportTarget(workspace.manifest.exports?.[subpath]);
        const candidate = exported
          ? resolve(workspace.directory, exported.replace(/^\.\/dist\//u, './src/'))
          : resolve(workspace.directory, 'src', specifier.slice(workspace.name.length + 1));
        return { path: resolveSourceCandidate(candidate, repoRoot, specifier) };
      });
    },
  };
}

function resolveSourceCandidate(candidate, repoRoot, specifier) {
  const extension = extname(candidate);
  const candidates = [candidate];
  if (['.js', '.mjs', '.cjs'].includes(extension)) {
    const stem = candidate.slice(0, -extension.length);
    candidates.push(...sourceExtensions.map((sourceExtension) => `${stem}${sourceExtension}`));
  } else if (!extension) {
    candidates.push(...sourceExtensions.map((sourceExtension) => `${candidate}${sourceExtension}`));
    candidates.push(
      ...sourceExtensions.map((sourceExtension) => join(candidate, `index${sourceExtension}`)),
    );
  }
  const resolved = candidates.find((path) => existsSync(path));
  if (!resolved || !normalize(relative(repoRoot, resolved)).startsWith('packages/')) {
    throw new Error(
      `Unable to resolve local Windows package import ${specifier} from ${candidate}`,
    );
  }
  return resolved;
}

function exportTarget(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  for (const condition of ['types', 'import', 'default']) {
    const target = exportTarget(value[condition]);
    if (target) return target;
  }
  return undefined;
}

function loadWorkspacePackages(repoRoot) {
  const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const result = new Map();
  for (const workspacePath of rootManifest.workspaces ?? []) {
    const directory = resolve(repoRoot, workspacePath);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    result.set(manifest.name, { directory, manifest, name: manifest.name });
  }
  return result;
}

function normalize(path) {
  return path.split(sep).join('/');
}
