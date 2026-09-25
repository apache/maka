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

// electron-builder ships the production dependency closure of `package.json`
// whether or not anything loads it. That is how #3146 happened: `@maka/ui`
// was a production dependency, so `mermaid`, `lucide-react` and
// `@astryxdesign/*` shipped whole -- about 183 MB of renderer sources that
// vite had already bundled into `dist-renderer`. Each author saw only their
// own slice and nothing reported the step change.
//
// This check makes the closure a reviewed list. `artifact-budget.json` records
// exactly which packages ship; adding a production dependency changes that
// file, so the cost lands in the diff of the pull request that causes it.
//
// It tracks the set of package instances rather than bytes on purpose. The bytes that reach
// `app.asar` are what survives the `files` globs -- on this checkout the
// closure is 241 MiB on disk and 142 MiB in the archive -- and reproducing
// those globs here would be the same hand-written exclude list that
// `electron-builder.config.mjs` already records as unable to hold. The set is
// exact, and it is the thing that regressed.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const LEDGER_PATH = join(DESKTOP_ROOT, 'artifact-budget.json');

function readPackageJson(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Node's own resolution: walk up `node_modules` directories from the dependent.
export function resolvePackageDirectory(name, fromDirectory) {
  let directory = fromDirectory;
  for (;;) {
    const candidate = join(directory, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = resolve(directory, '..');
    if (parent === directory) return null;
    directory = parent;
  }
}

// Visited is keyed by resolved directory, not by package name. A nested
// `node_modules` copy is a different package with different dependencies, and
// keying by name lets the hoisted copy win and hides the nested subtree --
// which is how `proxy-agent-negotiate` (reached only through
// `packages/runtime/node_modules/https-proxy-agent`) goes missing.
//
// The result lists resolved instances, `<path relative to root>@<version>`,
// not names: a version replacement or a second copy of the same name changes
// what electron-builder ships and must change the ledger too.
export function collectClosure(rootDirectory = DESKTOP_ROOT) {
  const manifest = readPackageJson(rootDirectory);
  if (!manifest) throw new Error(`no package.json at ${rootDirectory}`);

  const visited = new Map();
  const walk = (name, fromDirectory) => {
    const directory = resolvePackageDirectory(name, fromDirectory);
    if (!directory || visited.has(directory)) return;
    const pkg = readPackageJson(directory);
    const path = relative(rootDirectory, directory).split(sep).join('/');
    visited.set(directory, `${path}@${pkg?.version ?? 'unknown'}`);
    if (!pkg) return;
    // Optional dependencies ship when they install, so they count.
    for (const dependency of Object.keys(pkg.dependencies ?? {})) walk(dependency, directory);
    for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) walk(dependency, directory);
  };

  for (const dependency of Object.keys(manifest.dependencies ?? {})) walk(dependency, rootDirectory);
  return [...visited.values()].sort();
}

export function readLedger(path = LEDGER_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function compare(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    added: actual.filter((name) => !expectedSet.has(name)),
    removed: expected.filter((name) => !actualSet.has(name)),
  };
}

export function formatFailure({ added, removed }) {
  const lines = ['The packaged production dependency closure changed.', ''];
  if (added.length) {
    lines.push(`  ships now, did not before (${added.length}):`);
    for (const name of added) lines.push(`    + ${name}`);
  }
  if (removed.length) {
    lines.push(`  shipped before, does not now (${removed.length}):`);
    for (const name of removed) lines.push(`    - ${name}`);
  }
  lines.push(
    '',
    'Every package here is copied into app.asar whether or not anything loads it.',
    'If the change is intended, refresh the ledger so the cost is reviewable:',
    '',
    '  npm --workspace @maka/desktop run check:artifact-budget -- --write',
    '',
    'If it is not, a renderer-only package probably reached `dependencies`;',
    'those belong in `devDependencies`, where vite bundles them instead.',
  );
  return lines.join('\n');
}

function main() {
  const write = process.argv.includes('--write');
  const actual = collectClosure();

  if (write) {
    writeFileSync(LEDGER_PATH, `${JSON.stringify({ packages: actual }, null, 2)}\n`);
    console.log(`Wrote ${actual.length} package instances to artifact-budget.json`);
    return;
  }

  const difference = compare(readLedger().packages, actual);
  if (difference.added.length || difference.removed.length) {
    console.error(formatFailure(difference));
    process.exitCode = 1;
    return;
  }
  console.log(`Artifact budget OK — ${actual.length} packages ship in app.asar.`);
}

if (process.argv[1] === SCRIPT_PATH) main();
