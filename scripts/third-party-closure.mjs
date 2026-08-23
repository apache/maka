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

// The dependency closure a packaged artifact actually ships: the Node
// production closure that lands in `app.asar/node_modules`, plus everything
// reachable from the workspace's declared renderer roots, which vite bundles
// into `dist-renderer`. The notice generator writes from this closure and the
// packaged-artifact verifier checks against it, so both must read the same
// definition — this module is that single definition.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { npmSpawnOptions } from './npm-spawn.mjs';

const repoRoot = resolve(import.meta.dirname, '..');

export const WORKSPACE_PREFIX = '@maka/';

export function npmWorkspaceTree(workspaceName, omitDev) {
  const tree = JSON.parse(
    execFileSync(
      'npm',
      ['ls', '--workspace', workspaceName, ...(omitDev ? ['--omit=dev'] : []), '--all', '--json'],
      npmSpawnOptions({
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      }),
    ),
  );
  const workspace = tree.dependencies?.[workspaceName];
  if (!workspace) throw new Error(`npm ls did not return the ${workspaceName} workspace`);
  return workspace;
}

function collectInto(packages, dependencies) {
  for (const [name, dependency] of Object.entries(dependencies ?? {})) {
    if (!dependency || typeof dependency !== 'object') continue;
    if (!name.startsWith(WORKSPACE_PREFIX) && typeof dependency.version === 'string') {
      packages.set(`${name}@${dependency.version}`, { name, version: dependency.version });
    }
    collectInto(packages, dependency.dependencies);
  }
}

/**
 * Packages the workspace declares as bundled into the renderer.
 *
 * They live in `devDependencies` so electron-builder keeps a second, unread
 * copy of their sources out of `app.asar` — but vite bundles them into
 * `dist-renderer`, which the archive does carry. So they ship, and their
 * notices have to ship with them. Reading the list from the manifest keeps the
 * notice generator and the packaged-artifact verifier from drifting apart.
 */
export function rendererBundledRoots(manifestPath) {
  if (!manifestPath) return [];
  const declared = JSON.parse(readFileSync(manifestPath, 'utf8'))?.maka
    ?.rendererBundledDependencies;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(
      `${manifestPath}: maka.rendererBundledDependencies must list the renderer roots`,
    );
  }
  return declared;
}

/**
 * Renderer-bundled packages whose license ships as a vendored file in the
 * artifact instead of an entry in the generated npm notices. The Geist fonts
 * are OFL-1.1 — carried as their own license files next to the other renderer
 * asset notices — so the notice generator skips them while the security audit
 * and the bundle-graph check still cover them as shipped packages.
 */
export const ASSET_LICENSED_RENDERER_PACKAGES = new Map([
  ['@fontsource-variable/geist', join('licenses', 'renderer', 'GEIST_LICENSE.txt')],
  ['@fontsource-variable/geist-mono', join('licenses', 'renderer', 'GEIST_MONO_LICENSE.txt')],
]);

/**
 * Every third-party `{ name, version }` the workspace ships, sorted. Pass
 * `manifestPath` only for a workspace that bundles a renderer; without it the
 * closure is the production closure alone.
 */
export function collectWorkspaceClosure({ workspaceName, manifestPath }) {
  const packages = new Map();
  collectInto(packages, npmWorkspaceTree(workspaceName, true).dependencies);

  const roots = new Set(rendererBundledRoots(manifestPath));
  if (roots.size > 0) {
    const full = npmWorkspaceTree(workspaceName, false).dependencies ?? {};
    for (const [name, dependency] of Object.entries(full)) {
      if (!roots.has(name) || !dependency || typeof dependency !== 'object') continue;
      if (name.startsWith(WORKSPACE_PREFIX)) {
        // A workspace root's slot in the full tree carries its dev edges too
        // (`@maka/ui` declares @types/* and linkedom for its tests), and none
        // of those are bundle inputs. Its own production closure is what the
        // renderer can actually reach through it.
        collectInto(packages, npmWorkspaceTree(name, true).dependencies);
        continue;
      }
      if (typeof dependency.version === 'string') {
        packages.set(`${name}@${dependency.version}`, { name, version: dependency.version });
      }
      collectInto(packages, dependency.dependencies);
    }
    // Every declared root must be reachable, the workspace ones included: a
    // workspace root (`@maka/ui`) carries no notice of its own — it is first
    // party — but its third-party dependencies are only collected through it,
    // so its absence from the tree would silently drop their notices.
    const missing = [...roots].filter((root) => !Object.hasOwn(full, root));
    if (missing.length > 0) {
      throw new Error(`renderer roots absent from the dependency tree: ${missing.join(', ')}`);
    }
  }

  return [...packages.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  );
}

/**
 * Every package name that may legitimately appear under the workspace's
 * packaged `node_modules` — the production closure, workspace packages
 * included. electron-builder walks exactly this graph, so anything in the
 * archive outside it is a leak regardless of how it got there.
 */
export function collectProductionNames(workspaceName) {
  return new Set(collectProductionClosure(workspaceName).keys());
}

/**
 * The same closure as `collectProductionNames`, keyed by name with the exact
 * versions npm resolved. Verifying by name alone accepted an archive carrying
 * a different version of a permitted package, which is the shape a
 * substitution attack takes: a name that belongs, at a version that does not.
 *
 * A workspace package has no version in the tree; it maps to `undefined`, and
 * the archive's own manifest is compared against that the same way.
 */
export function collectProductionClosure(workspaceName) {
  const closure = new Map();
  const walk = (dependencies) => {
    for (const [name, dependency] of Object.entries(dependencies ?? {})) {
      if (!dependency || typeof dependency !== 'object') continue;
      if (!closure.has(name)) closure.set(name, new Set());
      closure
        .get(name)
        .add(typeof dependency.version === 'string' ? dependency.version : undefined);
      walk(dependency.dependencies);
    }
  };
  walk(npmWorkspaceTree(workspaceName, true).dependencies);
  return closure;
}

/**
 * Package names a stylesheet imports by name. Vite inlines a CSS `@import` at
 * transform time, so the imported file never becomes a module and a package of
 * pure rules leaves no trace in the bundle record — reading the source is what
 * finds it. Relative, absolute, remote and data URLs are first-party or
 * already-resolved and are not package references.
 */
export function bareCssImportSpecifiers(css) {
  // `@import "pkg"`, `@import url("pkg")` and the unquoted `@import url(pkg)`
  // Vite also accepts, with or without a layer/media suffix. Relative and
  // absolute URLs are first-party or already-resolved assets, so only bare
  // specifiers are of interest here.
  //
  // Unquoted is matched only inside `url()`. CSS has no bare `@import pkg`,
  // and accepting one would read the `layer`/`supports` keyword of a
  // quoted import as a package name.
  const names = new Set();
  const specifiers = [
    ...css.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g),
    ...css.matchAll(/@import\s+url\(\s*([^'")\s][^)]*?)\s*\)/g),
  ];
  for (const [, specifier] of specifiers) {
    if (/^[./]|^https?:|^data:/.test(specifier)) continue;
    const segments = specifier.split('/');
    names.add(specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]);
  }
  return [...names];
}
